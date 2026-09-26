import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

import { resolveInterpreterHome } from '../../shared/interpreterHome';

// Cargo emits `basemind.exe` on Windows, so every candidate path below has to
// carry the platform suffix, not just the ones that go through PATH or npm.
const BINARY_NAME = process.platform === 'win32' ? 'basemind.exe' : 'basemind';

/**
 * True when the CPU reports AVX2. Only linux-x64 ships a noavx2 variant, so
 * every other platform short-circuits to true. Unknown state (unreadable
 * cpuinfo, no flags lines) fails CLOSED to false: the noavx2 build runs on
 * any x86_64 CPU (SSE2 baseline + runtime dispatch), so preferring it when
 * in doubt is safe, while the stock build SIGILL-crashes on AVX2-less CPUs.
 * Callers always fall through to the stock binary when no noavx2 build is
 * staged, so fail-closed only ever adds a preference, never removes one.
 */
export function cpuHasAvx2(): boolean {
  if (process.platform !== 'linux' || process.arch !== 'x64') return true;
  try {
    const text = readFileSync('/proc/cpuinfo', 'utf8');
    // x86 reports `flags:`, ARM reports `Features:` — match both for
    // consistency with the cpuFeatures handler (unreachable on ARM here
    // given the short-circuit above, but harmless if platforms expand).
    const flagLines = text.split('\n').filter((line) => line.startsWith('flags') || line.startsWith('Features'));
    if (flagLines.length === 0) return false;
    return flagLines.every((line) => (line.split(':')[1] ?? '').trim().split(/\s+/).includes('avx2'));
  } catch {
    return false;
  }
}

/**
 * True when the path is the SSE2-baseline build: a `basemind-noavx2` or
 * `linux-x64-noavx2` path segment (packaged vs staged layout).
 * Segment-boundary-aware on normalized slashes so similarly named paths
 * (e.g. `my-linux-x64-noavx2-project/`) never match.
 */
export function isNoAvx2BasemindBinary(binaryPath: string): boolean {
  const normalized = binaryPath.replace(/\\/g, '/');
  return /(^|\/)(basemind-noavx2|linux-x64-noavx2)(\/|$)/.test(normalized);
}

function findBasemindBinary(): string {
  const projectRoot = process.cwd();
  const needsNoAvx2 = !cpuHasAvx2();

  // Packaged app: electron-builder extraResources places basemind at
  // <resourcesPath>/basemind/basemind. Check this first so installed
  // users get the bundled binary without needing a local Rust toolchain.
  if (process.resourcesPath) {
    // On AVX2-less linux-x64 prefer the SSE2-baseline build when packaged
    // alongside (linux extraResources ships both).
    if (needsNoAvx2) {
      const packagedNoAvx2 = resolve(process.resourcesPath, 'basemind-noavx2', BINARY_NAME);
      if (existsSync(packagedNoAvx2)) return packagedNoAvx2;
    }
    const packaged = resolve(process.resourcesPath, 'basemind', BINARY_NAME);
    if (existsSync(packaged)) return packaged;
  }

  // Dev checkout and CI: `pnpm download:basemind` stages the binary at
  // resources/basemind/<platform>-<arch>/ (the layout `download-basemind.mjs`
  // writes and `extraResources` reads for packaging). Checked before PATH for
  // the same reason as the packaged path above: a stray basemind on a
  // developer's PATH should not silently take the place of the pinned build.
  // On AVX2-less linux-x64 the stock ONNX Runtime SIGILL-crashes, so prefer
  // the staged noavx2 variant when present.
  if (needsNoAvx2) {
    const devNoAvx2 = resolve(projectRoot, 'resources', 'basemind', 'linux-x64-noavx2', BINARY_NAME);
    if (existsSync(devNoAvx2)) return devNoAvx2;
  }
  const devPlatformKey = `${process.platform}-${process.arch}`;
  const devStaged = resolve(projectRoot, 'resources', 'basemind', devPlatformKey, BINARY_NAME);
  if (existsSync(devStaged)) return devStaged;

  const pathBin = process.env.PATH?.split(process.platform === 'win32' ? ';' : ':')
    .map(p => resolve(p, BINARY_NAME))
    .find(p => { try { return existsSync(p); } catch { return false; } }) ?? '';
  if (pathBin) return pathBin;

  const localDebug = resolve(projectRoot, 'submodules', 'basemind', 'target', 'debug', BINARY_NAME);
  if (existsSync(localDebug)) return localDebug;

  const localRelease = resolve(projectRoot, 'submodules', 'basemind', 'target', 'release', BINARY_NAME);
  if (existsSync(localRelease)) return localRelease;

  const cargoBin = resolve(homedir(), '.cargo', 'bin', BINARY_NAME);
  if (existsSync(cargoBin)) return cargoBin;

  try {
    // The server entrypoints run as ESM, where the CommonJS `require` binding
    // does not exist. Calling it here threw a ReferenceError that this catch
    // swallowed, so npm-installed binaries were never discovered.
    const npmPackageJson = createRequire(import.meta.url).resolve('basemind/package.json');
    const npmBin = resolve(npmPackageJson, '..', 'bin', BINARY_NAME);
    if (existsSync(npmBin)) return npmBin;
  } catch {
    // intentionally empty
  }

  return '';
}

/**
 * OIX hosts MCP servers with a sandboxed HOME (<OIX home>/home), so the
 * daemon basemind's `serve` spawns lives under that home, while a manually
 * started daemon uses the real one. Check both; a daemon counts as running
 * only when its pid file exists and the process is alive.
 */
function basemindCommsDirs(): string[] {
  return [
    resolve(resolveInterpreterHome(), 'home', '.local', 'share', 'basemind', 'comms'),
    resolve(homedir(), '.local', 'share', 'basemind', 'comms'),
  ];
}

function basemindCommsDir(): string {
  const dirs = basemindCommsDirs();
  return dirs.find(dir =>
    existsSync(resolve(dir, 'comms.sock')) && existsSync(resolve(dir, 'daemon.pid')),
  ) ?? dirs[0];
}

export { basemindCommsDir };

export function isDaemonRunning(): boolean {
  return basemindCommsDirs().some(baseDir => {
    if (!existsSync(resolve(baseDir, 'comms.sock'))) return false;
    const pidFile = resolve(baseDir, 'daemon.pid');
    if (!existsSync(pidFile)) return false;
    try {
      const content = readFileSync(pidFile, 'utf8').trim();
      const parsed = JSON.parse(content);
      const pid = typeof parsed === 'object' && parsed !== null && 'pid' in parsed ? Number(parsed.pid) : Number(parsed);
      if (!Number.isFinite(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

let _cachedBinary: string | null = null;

export function resolveBasemindBinary(): string {
  if (_cachedBinary === null) {
    _cachedBinary = findBasemindBinary();
  }
  return _cachedBinary;
}

/**
 * Call a basemind MCP tool.
 *
 * The comms UDS speaks length-delimited msgpack frames (basemind
 * `frontend_uds.rs`), so the raw JSON-RPC-over-socket client this used to be
 * never got an answer from the pinned daemon: every scan/search failed at
 * frame decode and the connection dropped. Route through the MCP server
 * instead — the same path `piiDetection` already uses successfully.
 */
export async function mcpRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (method !== 'tools/call') {
    throw new Error(`Unsupported basemind MCP method: ${method}`);
  }
  const name = String(params.name ?? '');
  if (!name) throw new Error('mcpRequest tools/call requires params.name');
  const { getToolManager } = await import('../tools/toolManagerAccessor');
  const { getAppMcpOwnerThreadId } = await import('../services/appMcpThread');
  const result = await getToolManager().callTool(
    'basemind',
    name,
    (params.arguments ?? {}) as Record<string, unknown>,
    undefined,
    undefined,
    { threadId: await getAppMcpOwnerThreadId() },
  );
  // CallToolResult with isError is a tool-level rejection. Callers treat a
  // resolved value as a successful scan/search (see runAdminRescan), so an
  // error result must reject here, not resolve.
  if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
    const blocks = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    const detail = blocks?.map(block => block.text).filter(Boolean).join('\n') || 'tool reported an error';
    throw new Error(`MCP request failed: ${method}: ${detail}`);
  }
  return result;
}

/**
 * Pin 10cc546: incremental/full re-index is the `admin` tool in `rescan` mode.
 * The fork's `{ name: 'code', arguments: { subcommand: 'files', root, paths } }`
 * shape has no fields on this pin's CodeParams and would be rejected.
 * Paths are repo-relative to the daemon workspace root (no per-call root).
 */
export function adminRescanToolCall(opts: { paths?: string[]; full?: boolean } = {}): {
  name: 'admin';
  arguments: Record<string, unknown>;
} {
  const arguments_: Record<string, unknown> = { mode: 'rescan' };
  if (opts.paths?.length) arguments_.paths = opts.paths;
  if (opts.full) arguments_.full = true;
  return { name: 'admin', arguments: arguments_ };
}

async function runAdminRescan(opts: { paths?: string[]; full?: boolean }) {
  if (!isDaemonRunning()) return { success: false, exitCode: null, stdout: '', stderr: '', error: 'daemon not running' };
  try {
    await mcpRequest('tools/call', adminRescanToolCall(opts));
    return { success: true, exitCode: 0, stdout: '', stderr: '', error: undefined };
  } catch (err) {
    return { success: false, exitCode: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Initial pass: full re-index when no paths, otherwise incremental paths. */
export async function basemindScan(opts: { root?: string; paths?: string[]; json?: boolean }) {
  return runAdminRescan(opts.paths?.length ? { paths: opts.paths } : { full: true });
}

/** Incremental re-index of specific paths only — never a full scan. */
export async function basemindRescan(opts: { root?: string; paths?: string[]; json?: boolean }) {
  return runAdminRescan({ paths: opts.paths });
}

/**
 * Normalize the persisted basemind MCP entry (fills gaps; an explicit choice
 * already on file wins):
 *
 * - Approval modes: redaction, vault, rescan and semantic search run as
 *   programmatic `callTool` calls with no user tab to attach an approval to,
 *   and `resolveMcpToolApprovalMode` falls back to `prompt` with no recorded
 *   mode — each background call would hang awaiting an approval the renderer
 *   cannot route (it toasts "not attached to an agent thread"). The four tools
 *   those flows use are auto-approved: basemind is a local, workspace-scoped
 *   indexer — no network side effects, and the only destructive mode
 *   (`admin cache_clear`) deletes a rebuildable index.
 * - `--root <workspace>`: cwd discovery would land on the app's repo in dev or
 *   a filesystem root when packaged — neither is the workspace the safe/
 *   mirror lives in. Non-git workspaces also need the `basemind.toml` marker
 *   (armSafeWorkspace writes it) or the root guard refuses the serve.
 * - `BASEMIND_COMMS_DIR`: OIX sandboxes MCP spawns with a HOME override, which
 *   would fork a second daemon that fights the user's daemon over the single
 *   global per-root workspace-store lock (host_build_failed). Pinning the real
 *   home makes the app and any CLI share one daemon.
 * - `startupTimeoutSec`: first boot opens the workspace store and hosts the
 *   read stack; the 30 s default times out before initialize on this class of
 *   machine, and OIX then marks the whole server failed.
 */
const AUTO_APPROVED_TOOLS = ['redact_text', 'vault', 'admin', 'code'] as const;

export async function ensureBasemindServerConfig(serverId: string): Promise<void> {
  try {
    const configStore = await import('../configStore');
    const { getCurrentWorkspace } = await import('./workspace');
    const existing = await configStore.getMcpServer(serverId);
    if (!existing) return;

    const updates: Partial<import('../configStore').McpServerConfig> = {};

    const tools = { ...(existing.tools ?? {}) };
    let toolsChanged = false;
    for (const tool of AUTO_APPROVED_TOOLS) {
      if (tools[tool]?.approvalMode) continue;
      tools[tool] = { ...(tools[tool] ?? {}), approvalMode: 'auto' };
      toolsChanged = true;
    }
    if (toolsChanged) updates.tools = tools;

    const workspacePath = getCurrentWorkspace();
    const args = ['serve', '--no-watch', ...(workspacePath ? ['--root', workspacePath] : [])];
    if (JSON.stringify(existing.args) !== JSON.stringify(args)) updates.args = args;
    if (workspacePath) {
      // Same root the serve is about to use: marker first, reload after.
      (await import('./safeArm')).ensureBasemindRootMarker(workspacePath);
    }

    const commsDir = resolve(homedir(), '.local', 'share', 'basemind', 'comms');
    if (existing.env?.BASEMIND_COMMS_DIR !== commsDir) {
      updates.env = { ...(existing.env ?? {}), BASEMIND_COMMS_DIR: commsDir };
    }

    if (existing.startupTimeoutSec == null) updates.startupTimeoutSec = 60;

    if (Object.keys(updates).length > 0) {
      // toolManager.updateServer persists AND mcpServerReload()es, so args/env
      // changes (workspace switch) hot-swap the running serve without a restart.
      const { getToolManager } = await import('../tools/toolManagerAccessor');
      await getToolManager().updateServer(serverId, updates);
    }
  } catch {
    // A missing entry or an unwritable config must not fail registration; the
    // values stay settable from MCP settings.
  }
}

export async function registerBasemindServer(): Promise<string> {
  const { getToolManager } = await import('../tools/toolManagerAccessor');
  const binary = resolveBasemindBinary();
  if (!binary) return '';
  let serverId: string;
  try {
    serverId = await getToolManager().addServer({
      name: 'Basemind',
      description: 'Local code search and semantic graph engine',
      transport: 'stdio',
      command: binary,
      args: ['serve', '--no-watch'],
      enabled: true,
    });
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('already exists'))) return '';
    // An existing registration still needs the normalized config applied: a
    // server added before this ran has none of the ensure values on file.
    serverId = 'basemind';
  }
  await ensureBasemindServerConfig(serverId);
  return serverId;
}

export async function unregisterBasemindServer(): Promise<void> {
  const { getToolManager } = await import('../tools/toolManagerAccessor');
  try {
    await getToolManager().removeServer('basemind');
  } catch {
    // intentionally empty
  }
}

export async function getBasemindServerStatus(): Promise<{ status: string }> {
  if (isDaemonRunning()) return { status: 'connected' };
  return { status: 'disconnected' };
}
