import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';

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

function basemindCommsDir(): string {
  return resolve(homedir(), '.local', 'share', 'basemind', 'comms');
}

export { basemindCommsDir };

export function isDaemonRunning(): boolean {
  const sock = resolve(basemindCommsDir(), 'comms.sock');
  if (!existsSync(sock)) return false;
  const pidFile = resolve(basemindCommsDir(), 'daemon.pid');
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
}

let _cachedBinary: string | null = null;

export function resolveBasemindBinary(): string {
  if (_cachedBinary === null) {
    _cachedBinary = findBasemindBinary();
  }
  return _cachedBinary;
}

export function mcpRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const sockPath = resolve(basemindCommsDir(), 'comms.sock');
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let data = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`MCP request timed out: ${method}`));
    }, 30_000);
    sock.connect(sockPath, () => {
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      sock.write(req + '\n');
    });
    sock.on('data', (chunk) => {
      data += chunk.toString();
      let resp: { result?: unknown; error?: { code?: number; message?: string } };
      try {
        resp = JSON.parse(data);
      } catch {
        return; // Partial frame; wait for the rest.
      }
      clearTimeout(timer);
      sock.destroy();
      // A JSON-RPC rejection is a well-formed response with `error` and no
      // `result`. Resolving it handed callers the error envelope, which they
      // then reported as a successful scan.
      if (resp.error) {
        const { code, message } = resp.error;
        const suffix = code === undefined ? '' : ` (${code})`;
        reject(new Error(`MCP request failed: ${method}${suffix}: ${message ?? 'unknown error'}`));
        return;
      }
      resolve(resp.result ?? resp);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
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
 * PII redaction runs at every send, and `resolveMcpToolApprovalMode` falls back
 * to `prompt` for any tool with no recorded mode. That would put an approval
 * dialog in front of each message and make the redaction path unusable.
 *
 * The exemption is scoped to `redact_text` alone: basemind also exposes `vault`
 * and code-search tools, which keep the default. An explicit choice already on
 * file wins — this only fills the gap.
 */
export async function ensureRedactTextAutoApproval(serverId: string): Promise<void> {
  try {
    const configStore = await import('../configStore');
    const existing = await configStore.getMcpServer(serverId);
    if (existing?.tools?.redact_text?.approvalMode) return;
    await configStore.updateMcpServer(serverId, {
      // updateMcpServer merges one level deep, so the rest of the tools map has
      // to be carried forward or other tools' settings would be dropped.
      tools: {
        ...(existing?.tools ?? {}),
        redact_text: { ...(existing?.tools?.redact_text ?? {}), approvalMode: 'auto' },
      },
    });
  } catch {
    // A missing entry or an unwritable config must not fail registration; the
    // mode stays settable from MCP settings.
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
    // An existing registration still needs the approval mode applied: a server
    // added before this ran has no entry for `redact_text`.
    serverId = 'basemind';
  }
  await ensureRedactTextAutoApproval(serverId);
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
