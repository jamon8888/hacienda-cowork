/**
 * Surfaces that stay available in a Safe workspace.
 *
 * Safe pseudonymizes what the app sends and confines what the agent reads, but
 * some channels carry content the app cannot redact: a realtime voice session,
 * the pixels of a screen, a browser page, network traffic. Each is a surface
 * the user can leave on or off in Safe folders. Voice is off by default (audio
 * goes to the provider as spoken); the others are on, because switching them
 * off makes the agent much less useful and the user may rely on them.
 *
 * Every change is written to the cabinet audit log first: no trace, no change.
 * The agent can neither read this as a choice to make nor change it.
 */

import { getSafeSurfacesConfig, getSafeSurfacesConfigSync, setSafeSurfaceInConfig } from '../configStore';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';
import { findSafeWorkspaceForCwd, isSafeWorkspace } from '../utils/safeWorkspace';
import { SAFE_HIDDEN_SERVER_IDS } from '../../shared/utils/interpreterToolSurface';
import type { BrowserAccessPolicy } from '../../shared/browserAccessPolicy';
import type { CuaAccessPolicy } from '../../shared/cuaAccessPolicy';

export const SAFE_SURFACES = ['voice', 'computerUse', 'browserControl', 'network'] as const;
export type SafeSurface = (typeof SAFE_SURFACES)[number];
export type SafeSurfaces = Record<SafeSurface, boolean>;

export const DEFAULT_SAFE_SURFACES: SafeSurfaces = {
  voice: false,
  computerUse: true,
  browserControl: true,
  network: true,
};

export function isSafeSurface(value: unknown): value is SafeSurface {
  return typeof value === 'string' && (SAFE_SURFACES as readonly string[]).includes(value);
}

/** Stored values over defaults; anything that is not a boolean is ignored. */
export function resolveSafeSurfaces(stored: Partial<Record<string, unknown>> | null | undefined): SafeSurfaces {
  const resolved = { ...DEFAULT_SAFE_SURFACES };
  for (const surface of SAFE_SURFACES) {
    const value = stored?.[surface];
    if (typeof value === 'boolean') resolved[surface] = value;
  }
  return resolved;
}

export async function getSafeSurfaces(): Promise<SafeSurfaces> {
  return resolveSafeSurfaces(await getSafeSurfacesConfig());
}

export function getSafeSurfacesSync(): SafeSurfaces {
  return resolveSafeSurfaces(getSafeSurfacesConfigSync());
}

/**
 * Whether `surface` is switched off for this work: only inside a Safe
 * workspace, and only when the user left it off. Several paths may be given
 * (a voice session has a current folder and an action folder); any Safe one
 * counts. No path at all is not Safe.
 */
export function isSurfaceBlockedInSafe(
  surface: SafeSurface,
  workspacePaths: Array<string | null | undefined>,
  surfaces: SafeSurfaces = getSafeSurfacesSync(),
): boolean {
  if (surfaces[surface]) return false;
  return workspacePaths.some((path) => findSafeWorkspaceForCwd(path) !== null);
}

export interface SafeSurfaceDeps {
  audit?: (entry: CabinetAuditEntry) => Promise<void>;
  read?: () => Promise<SafeSurfaces>;
  write?: (surface: SafeSurface, enabled: boolean) => Promise<void>;
}

/**
 * Switch a surface. Turning one ON widens what can leave the machine, so it
 * needs `confirmed: true` (set only by the confirm dialog); turning one off
 * does not. The audit entry is written first: if it cannot be, nothing
 * changes. A change that does not change anything records nothing.
 */
export async function setSafeSurface(
  surface: unknown,
  enabled: unknown,
  options: { confirmed?: boolean } = {},
  deps: SafeSurfaceDeps = {},
): Promise<SafeSurfaces> {
  // The IPC layer forwards untyped values.
  if (!isSafeSurface(surface) || typeof enabled !== 'boolean') {
    throw new Error('A Safe surface and an on/off value are required.');
  }
  if (options.confirmed !== undefined && typeof options.confirmed !== 'boolean') {
    throw new Error('Confirmation must be boolean.');
  }
  const read = deps.read ?? getSafeSurfaces;
  const current = await read();
  if (current[surface] === enabled) return current;
  if (enabled && options.confirmed !== true) {
    throw new Error('Turning a surface on in Safe folders requires explicit confirmation.');
  }
  await (deps.audit ?? appendCabinetAudit)({ event: 'safe_surface_changed', surface, enabled });
  await (deps.write ?? setSafeSurfaceInConfig)(surface, enabled);
  return { ...current, [surface]: enabled };
}

/**
 * The effective browser policy for `workspace`: everything denied when the
 * workspace is Safe and the browser surface is off. Applied where policy is
 * enforced, never to what the settings screen shows or stores.
 */
export function applySafeBrowserSurface(
  policy: BrowserAccessPolicy,
  workspace: string | null | undefined,
  surfaces?: SafeSurfaces,
): BrowserAccessPolicy {
  return isSurfaceBlockedInSafe('browserControl', [workspace], surfaces) ? denyAllBrowserAccess(policy) : policy;
}

/** Same for Computer Use, behind the `computerUse` surface. */
export function applySafeCuaSurface(
  policy: CuaAccessPolicy,
  workspace: string | null | undefined,
  surfaces?: SafeSurfaces,
): CuaAccessPolicy {
  return isSurfaceBlockedInSafe('computerUse', [workspace], surfaces) ? denyAllCuaAccess(policy) : policy;
}

/** Servers hidden from the model in a Safe workspace because their surface is off. */
export function surfaceHiddenServerIds(surfaces: SafeSurfaces): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!surfaces.computerUse) {
    hidden.add('builtin-cua-driver');
    hidden.add('builtin-interpreter-overlay');
  }
  if (!surfaces.network) {
    // Web search is the agent's own network client.
    hidden.add('builtin-google');
  }
  return hidden;
}

const NO_HIDDEN_SERVERS: ReadonlySet<string> = new Set();

/**
 * Servers the model cannot see for work in `workspacePath`: none outside a
 * Safe workspace; inside one, the send channels (mail, messaging) and every
 * server whose surface the user left off.
 */
export function getSafeHiddenServerIds(
  workspacePath: string | null | undefined,
  surfaces: SafeSurfaces = getSafeSurfacesSync(),
): ReadonlySet<string> {
  if (!isSafeWorkspace(workspacePath)) return NO_HIDDEN_SERVERS;
  return new Set([...SAFE_HIDDEN_SERVER_IDS, ...surfaceHiddenServerIds(surfaces)]);
}

const DENY = { mode: 'deny' as const, allowedPatterns: [] as string[] };

/** Browser access with every permission denied: no profile or grant reopens it. */
export function denyAllBrowserAccess(policy: BrowserAccessPolicy): BrowserAccessPolicy {
  return {
    permissions: { read: { ...DENY }, write: { ...DENY }, action: { ...DENY } },
    profilePolicies: policy.profilePolicies.map((profile) => ({
      profileId: profile.profileId,
      permissions: { read: { ...DENY }, write: { ...DENY }, action: { ...DENY } },
    })),
  };
}

/** Computer Use with inspect and control denied everywhere, per-app rules included. */
export function denyAllCuaAccess(policy: CuaAccessPolicy): CuaAccessPolicy {
  return {
    permissions: { inspect: { mode: 'deny' }, control: { mode: 'deny' } },
    appPolicies: policy.appPolicies.map((app) => ({
      ...app,
      permissions: { inspect: { mode: 'deny' }, control: { mode: 'deny' } },
    })),
  };
}

/**
 * The sentence shown when a switched-off surface refuses, in the user's
 * language (the refusal reaches the screen as a raw error message).
 */
export async function getSafeSurfaceBlockedMessage(surface: 'voice'): Promise<string> {
  const { getLanguage } = await import('../configStore');
  const { resources, supportedLanguages } = await import('../../shared/locales');
  const language = await getLanguage();
  const locale = language && (supportedLanguages as readonly string[]).includes(language)
    ? (language as keyof typeof resources)
    : 'en';
  return resources[locale].translation[`safe.surface.${surface}Blocked`];
}
