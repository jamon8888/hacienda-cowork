/**
 * Local-only Safe work: a Safe folder run on its originals, without
 * pseudonymization, because the model runs on this machine.
 *
 * Safe protects confidential files by pseudonymizing what reaches a remote
 * provider. With a local model nothing reaches a provider, so the user may
 * choose (`safeLocalBypass`) to let the agent work on the real files. The
 * guarantee then changes from "pseudonymized" to "nothing leaves the
 * machine", which holds only if:
 * - the endpoint the runtime is sent to is loopback, checked on the resolved
 *   provider config (never on a profile name or a provider label);
 * - no other model reads the conversation's content (the read-tool guard);
 * - the channels that could carry it out are off: network, browser, Computer
 *   Use. Enabling the bypass switches them off; switching one back on makes
 *   the bypass inactive.
 *
 * Every check fails closed: anything unknown is "not local".
 */

import { createHash } from 'node:crypto';

import { isStrictLoopbackHost } from '../../shared/types/provider';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';
import { getSafeSurfaces, setSafeSurface, type SafeSurface, type SafeSurfaces } from './safeSurfaces';
import { findSafeWorkspaceForCwd } from '../utils/safeWorkspace';

/** Model route as the runtime receives it: provider id, model, and its endpoint config. */
export interface ModelRoute {
  modelProvider?: string | null;
  /** Model id. Some names run remotely behind a loopback endpoint (Ollama cloud). */
  model?: string | null;
  providerConfig?: {
    base_url?: unknown;
    requires_openai_auth?: unknown;
  } | null;
}

export type LocalRouteVerdict =
  | { local: true }
  | { local: false; reason: 'hosted' | 'account' | 'no-endpoint' | 'not-loopback' | 'app-proxy' | 'cloud-model' };

/** Providers that always reach a remote service, whatever their config says. */
const HOSTED_PROVIDERS = new Set(['interpreter', 'openai']);

/**
 * Ollama cloud models (`gpt-oss:120b-cloud`, `gpt-oss:cloud`) answer on
 * localhost:11434 but run on ollama.com once the user has signed in. The name
 * is the only sign, so any name whose last segment is `cloud` is refused.
 */
function isOllamaCloudModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /(?:^|[:-])cloud$/i.test(model.trim());
}

/**
 * Whether a route's endpoint is on this machine. The app's own server port is
 * refused: it hosts proxies (Groq) that forward to a remote provider while
 * looking like loopback.
 */
export function verifyLocalRoute(
  route: ModelRoute | null | undefined,
  options: { appServerPort?: number | null } = {},
): LocalRouteVerdict {
  const provider = route?.modelProvider?.trim().toLowerCase();
  if (!provider || HOSTED_PROVIDERS.has(provider)) return { local: false, reason: 'hosted' };
  const config = route?.providerConfig;
  if (config?.requires_openai_auth === true) return { local: false, reason: 'account' };
  if (typeof config?.base_url !== 'string' || !config.base_url.trim()) {
    return { local: false, reason: 'no-endpoint' };
  }
  let url: URL;
  try {
    url = new URL(config.base_url.trim());
  } catch {
    return { local: false, reason: 'no-endpoint' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { local: false, reason: 'no-endpoint' };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isStrictLoopbackHost(hostname)) return { local: false, reason: 'not-loopback' };
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (options.appServerPort != null && port === options.appServerPort) return { local: false, reason: 'app-proxy' };
  if (isOllamaCloudModel(route?.model)) return { local: false, reason: 'cloud-model' };
  return { local: true };
}

/** The route a thread start/resume/fork config selects: `model_providers[modelProvider]`. */
export function routeFromThreadConfig(
  modelProvider: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
  model?: string | null,
): ModelRoute {
  const providers = config?.model_providers;
  const entry = modelProvider && providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)[modelProvider]
    : undefined;
  return {
    modelProvider: modelProvider ?? null,
    ...(model != null ? { model } : {}),
    providerConfig: entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as ModelRoute['providerConfig']
      : null,
  };
}

/** Surfaces that must be off for the bypass to apply: they could carry content out. */
export const LOCAL_BYPASS_SURFACES_OFF: readonly SafeSurface[] = ['network', 'browserControl', 'computerUse'];

export interface LocalBypassDeps {
  enabled?: () => Promise<boolean>;
  surfaces?: () => Promise<SafeSurfaces>;
  /** Route of the read-tool guard model, or null when the guard is off. */
  guardRoute?: () => Promise<ModelRoute | null>;
  appServerPort?: () => number | null;
}

async function defaultEnabled(): Promise<boolean> {
  const { getSafeLocalBypassConfig } = await import('../configStore');
  return getSafeLocalBypassConfig();
}

async function defaultGuardRoute(): Promise<ModelRoute | null> {
  const { resolveReadToolGuardRoute } = await import('../utils/readToolPromptInjectionGuard');
  return resolveReadToolGuardRoute();
}

async function defaultAppServerPort(): Promise<number | null> {
  const { getServerPort } = await import('../utils/serverPort');
  return getServerPort();
}

/**
 * Whether work in `workspacePath` on `route` runs local-only: a Safe folder,
 * the bypass on, the outward channels off, and every model that reads the
 * conversation verified local. False in every other case, including errors.
 */
export async function isLocalOnlyRoute(
  workspacePath: string | null | undefined,
  route: ModelRoute | null | undefined,
  deps: LocalBypassDeps = {},
): Promise<boolean> {
  if (!findSafeWorkspaceForCwd(workspacePath)) return false;
  try {
    if (!(await (deps.enabled ?? defaultEnabled)())) return false;
    const surfaces = await (deps.surfaces ?? getSafeSurfaces)();
    if (LOCAL_BYPASS_SURFACES_OFF.some((surface) => surfaces[surface])) return false;
    const appServerPort = deps.appServerPort ? deps.appServerPort() : await defaultAppServerPort();
    if (!verifyLocalRoute(route, { appServerPort }).local) return false;
    const guard = await (deps.guardRoute ?? defaultGuardRoute)();
    return guard === null || verifyLocalRoute(guard, { appServerPort }).local;
  } catch (error) {
    console.warn('[local-bypass] check failed; keeping Safe pseudonymization.', error instanceof Error ? error.message : error);
    return false;
  }
}

export interface LocalBypassState {
  enabled: boolean;
  /** Surfaces still on that keep the bypass from applying. */
  blockingSurfaces: SafeSurface[];
}

export async function getSafeLocalBypassState(deps: Pick<LocalBypassDeps, 'enabled' | 'surfaces'> = {}): Promise<LocalBypassState> {
  const [enabled, surfaces] = await Promise.all([
    (deps.enabled ?? defaultEnabled)(),
    (deps.surfaces ?? getSafeSurfaces)(),
  ]);
  return { enabled, blockingSurfaces: LOCAL_BYPASS_SURFACES_OFF.filter((surface) => surfaces[surface]) };
}

export interface SetLocalBypassDeps {
  audit?: (entry: CabinetAuditEntry) => Promise<void>;
  read?: () => Promise<boolean>;
  write?: (enabled: boolean) => Promise<void>;
  /** Switch a surface off (audited by the surfaces service). */
  surfaceOff?: (surface: SafeSurface) => Promise<void>;
  state?: () => Promise<LocalBypassState>;
}

/**
 * Turn the bypass on or off. On needs `confirmed: true` (the confirm dialog):
 * it first switches the outward surfaces off, then records the change, then
 * stores it. Off is recorded then stored. No trace, no change.
 */
export async function setSafeLocalBypass(
  enabled: unknown,
  options: { confirmed?: boolean } = {},
  deps: SetLocalBypassDeps = {},
): Promise<LocalBypassState> {
  if (typeof enabled !== 'boolean') throw new Error('An on/off value is required.');
  if (options.confirmed !== undefined && typeof options.confirmed !== 'boolean') {
    throw new Error('Confirmation must be boolean.');
  }
  const state = deps.state ?? (() => getSafeLocalBypassState());
  const current = await (deps.read ?? defaultEnabled)();
  if (current === enabled) return state();
  if (enabled) {
    if (options.confirmed !== true) {
      throw new Error('Working on originals without pseudonymization requires explicit confirmation.');
    }
    const surfaceOff = deps.surfaceOff ?? (async (surface: SafeSurface) => { await setSafeSurface(surface, false); });
    for (const surface of LOCAL_BYPASS_SURFACES_OFF) await surfaceOff(surface);
  }
  await (deps.audit ?? appendCabinetAudit)({ event: enabled ? 'local_bypass_enabled' : 'local_bypass_disabled' });
  const write = deps.write ?? (async (value: boolean) => {
    const { setSafeLocalBypassInConfig } = await import('../configStore');
    await setSafeLocalBypassInConfig(value);
  });
  await write(enabled);
  return state();
}

/** Conversation id as it appears in the audit log: enough to correlate, nothing to read. */
export function auditThreadId(threadId: string): string {
  return createHash('sha256').update(threadId).digest('hex').slice(0, 16);
}
