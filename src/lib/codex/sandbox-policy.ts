import type { v2 } from "../../../server/handlers/codex-generated-types/index";

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReadAccessMode = 'workspace-only' | 'full-system';

export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'workspace-write';
export const DEFAULT_CODEX_READ_ACCESS_MODE: CodexReadAccessMode = 'full-system';
export const WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID =
  'interpreter-workspace-scope';

export type CodexWorkspacePermissionSelection = {
  permissionProfileId: string;
  runtimeWorkspaceRoots: string[];
  config: Record<string, unknown>;
  /** Thread config keys the profile requires beside `permissions`. */
  threadConfig?: Record<string, unknown>;
};

/**
 * Confinement for a Safe workspace (`<workspace>/safe/` exists). The runtime
 * root is the redacted mirror, read-only; the agent writes only its drafts
 * directory. Originals sit outside every readable root, so neither the shell
 * nor Python can read them.
 */
export type SafeWorkspaceConfinement = {
  safeRoot: string;
  draftsRoot: string;
  /** Read-only roots outside the mirror the agent still needs (skills). */
  readableRoots?: string[];
};

/**
 * Translate Workstation's persisted access settings into the standard upstream
 * OIX/Codex sandbox policy accepted by `turn/start`.
 *
 * Workstation's own CLI/tool boundary continues to enforce its more detailed
 * file policy. OIX owns shell execution, so the app sends only the upstream
 * sandbox shape instead of the fork-only `PermissionProfile` extension.
 */
export function buildCodexSandboxPolicy(options: {
  sandboxMode: CodexSandboxMode;
  networkAccess: boolean;
  writableRoots?: string[];
  allowTempAccess?: boolean | null;
}): v2.SandboxPolicy {
  if (options.sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (options.sandboxMode === 'read-only') {
    return {
      type: 'readOnly',
      networkAccess: options.networkAccess,
    };
  }

  const writableRoots = Array.from(
    new Set((options.writableRoots ?? []).map((root) => root.trim()).filter(Boolean)),
  );
  const allowTempAccess = options.allowTempAccess ?? true;

  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: options.networkAccess,
    excludeTmpdirEnvVar: !allowTempAccess,
    excludeSlashTmp: !allowTempAccess,
  };
}

/**
 * Build the OIX named-permission profile used when Workstation's read scope is
 * workspace-only. The legacy app-server SandboxPolicy can constrain writes but
 * deliberately grants broad reads; OIX permission profiles are the contract
 * that constrains both.
 *
 * OIX's experimental permission-profile fields are enabled by our initialize
 * handshake. They are present in the pinned public runtime even though its
 * stable generated TypeScript projection omits experimental request fields.
 */
export function buildCodexWorkspacePermissionSelection(options: {
  sandboxMode: CodexSandboxMode;
  readAccessMode: CodexReadAccessMode;
  networkAccess: boolean;
  allowTempAccess?: boolean | null;
  cwd?: string | null;
  additionalReadableRoots?: string[];
  additionalWritableRoots?: string[];
  /** Set in a Safe workspace: overrides the read scope and sandbox mode. */
  safe?: SafeWorkspaceConfinement | null;
}): CodexWorkspacePermissionSelection | null {
  const safe = options.safe ?? null;
  // A Safe workspace is always confined, whatever the persisted read scope:
  // `full-system` uses the legacy sandbox policy, which grants broad reads.
  if (!safe && options.readAccessMode !== 'workspace-only') {
    return null;
  }

  const workspaceAccess = safe || options.sandboxMode === 'read-only' ? 'read' : 'write';
  const filesystem: Record<string, unknown> = {
    ':minimal': 'read',
    ':workspace_roots': {
      '.': workspaceAccess,
    },
  };

  if (options.allowTempAccess ?? true) {
    // Scratch space stays writable in a Safe workspace: it holds no original.
    filesystem[':tmpdir'] = safe ? 'write' : workspaceAccess;
  }

  for (const readableRoot of options.additionalReadableRoots ?? []) {
    const normalizedRoot = readableRoot.trim();
    if (normalizedRoot) {
      filesystem[normalizedRoot] = 'read';
    }
  }

  for (const writableRoot of options.additionalWritableRoots ?? []) {
    const normalizedRoot = writableRoot.trim();
    if (normalizedRoot) {
      filesystem[normalizedRoot] = 'write';
    }
  }

  if (safe) {
    for (const readableRoot of safe.readableRoots ?? []) {
      const normalizedRoot = readableRoot.trim();
      if (normalizedRoot) {
        filesystem[normalizedRoot] = 'read';
      }
    }
    filesystem[safe.draftsRoot] = 'write';
  }

  return {
    permissionProfileId: WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID,
    runtimeWorkspaceRoots: safe
      ? [safe.safeRoot]
      : options.cwd?.trim() ? [options.cwd.trim()] : [],
    config: {
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem,
          network: {
            enabled: options.networkAccess,
          },
        },
      },
    },
    // OIX loads AGENTS.md from the git root down to the cwd, and the root one
    // is an original: a lawyer's notes would reach the provider in clear.
    ...(safe ? { threadConfig: { project_doc_max_bytes: 0 } } : {}),
  };
}
