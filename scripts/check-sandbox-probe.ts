/**
 * Runs the Safe-workspace sandbox probe against the real bundled engine, on
 * the machine it is run on (CI runs it on Linux, macOS and Windows).
 *
 * - the probe must report "enforced" under the engine's read-only policy;
 * - the same probe must report "not enforced" when the policy is swapped for
 *   full access, so a probe that always answers yes cannot pass.
 *
 * Needs `pnpm run download:oix -- --current-platform` first.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeSandboxEnforced, resetSandboxProbeCacheForTests, type SandboxProbeExec } from '../server/utils/sandboxProbe';
import {
  INTERPRETER_APP_SERVER_TEST_BINARY,
  interpreterAppServerTestBinaryAvailable,
} from '../src/lib/codex/test-fixtures/interpreter-app-server-test-binary';

if (!interpreterAppServerTestBinaryAvailable) {
  console.error(`[sandbox-probe] engine not found at ${INTERPRETER_APP_SERVER_TEST_BINARY}; run download:oix first`);
  process.exit(2);
}

const log = (message: string) => console.log(`[sandbox-probe] ${message}`);
const home = mkdtempSync(join(tmpdir(), 'sandbox-probe-home-'));
const probeRoot = join(process.cwd(), 'test-runs', `sandbox-probe-${process.pid}`);
mkdirSync(probeRoot, { recursive: true });

type Engine = {
  child: ChildProcessWithoutNullStreams;
  notifications: Array<{ method: string; params?: any }>;
  stderr: () => string;
  call: (method: string, params: unknown) => Promise<any>;
  stop: () => void;
};

async function startEngine(): Promise<Engine> {
  const child = spawn(INTERPRETER_APP_SERVER_TEST_BINARY, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let buffer = '';
  let nextId = 0;
  const pending = new Map<number, (message: any) => void>();
  const notifications: Engine['notifications'] = [];
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) pending.get(message.id)?.(message);
        else if (message.method) notifications.push(message);
      } catch {
        // not a JSON-RPC line
      }
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  await call('initialize', { clientInfo: { name: 'sandbox-probe-check', title: null, version: '0' }, capabilities: null });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  return { child, notifications, stderr: () => stderr, call, stop: () => child.kill() };
}

function execOn(engine: Engine, label: string, override?: unknown): SandboxProbeExec {
  return async (params) => {
    const sent = override ? { ...params, sandboxPolicy: override } : params;
    const response = await engine.call('command/exec', sent);
    if (response.error) {
      log(`  ${label} ${params.sandboxPolicy.type}: RPC error ${JSON.stringify(response.error).slice(0, 300)}`);
      throw new Error(JSON.stringify(response.error));
    }
    const { exitCode, stderr } = response.result;
    log(`  ${label} ${params.sandboxPolicy.type}: exit=${exitCode} stderr=${JSON.stringify(String(stderr).slice(0, 200))}`);
    return response.result;
  };
}

async function probe(engine: Engine, label: string, networkAccess: boolean, override?: unknown): Promise<boolean> {
  resetSandboxProbeCacheForTests();
  return probeSandboxEnforced(execOn(engine, label, override), { dir: join(probeRoot, label), networkAccess });
}

let engine: Engine | null = null;
function finish(code: number): never {
  engine?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(probeRoot, { recursive: true, force: true });
  process.exit(code);
}

try {
  engine = await startEngine();

  if (process.platform === 'win32') {
    // On Windows the engine confines nothing until its sandbox is set up once
    // (the app offers this in a banner and does exactly this).
    const started = await engine.call('windowsSandbox/setupStart', { mode: 'elevated', cwd: probeRoot });
    log(`windows setupStart: ${JSON.stringify(started.error ?? started.result).slice(0, 300)}`);
    const deadline = Date.now() + 180_000;
    let completed: any;
    while (!completed && Date.now() < deadline) {
      completed = engine.notifications.find((n) => n.method === 'windowsSandbox/setupCompleted');
      if (!completed) await new Promise((r) => setTimeout(r, 1_000));
    }
    log(`windows setupCompleted: ${JSON.stringify(completed?.params ?? 'no notification within 180s').slice(0, 300)}`);
    const configPath = join(home, 'config.toml');
    log(`windows config.toml after setup: ${existsSync(configPath) ? JSON.stringify(readFileSync(configPath, 'utf8').slice(0, 600)) : 'absent'}`);
  }

  const control = await probe(engine, 'control', true, { type: 'dangerFullAccess' });
  let enforced = await probe(engine, 'real', true);

  if (!enforced && process.platform === 'win32') {
    // Does the setup only take effect for a freshly started engine?
    log('windows: not enforced; restarting the engine to see whether the setup needs it');
    engine.stop();
    engine = await startEngine();
    enforced = await probe(engine, 'real-after-restart', true);
  }
  log(`platform=${process.platform}-${process.arch} enforced=${enforced} control(unenforced)=${control}`);

  // A Safe thread runs with no network unless the user turned it on. Report that
  // configuration too, without failing on it: some hosts cannot create the
  // network namespace it needs, which only means Safe turns are refused there.
  const noNetwork = await probe(engine, 'no-network', false);
  log(`info: with no network (the Safe default) enforced=${noNetwork}`);

  const problems: string[] = [];
  if (control) problems.push('the probe reported "enforced" with the sandbox switched off: it cannot be trusted');
  if (!enforced) problems.push('the probe reported "not enforced" under the engine read-only policy: Safe turns would be refused on this system');
  const leftovers = ['control', 'real', 'real-after-restart', 'no-network'].some((d) =>
    ['probe-target', 'probe-control'].some((f) => existsSync(join(probeRoot, d, f))),
  );
  if (leftovers) problems.push('the probe left its target file behind');
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[sandbox-probe] FAIL: ${problem}`);
    if (engine.stderr().trim()) console.error(`[sandbox-probe] engine stderr:\n${engine.stderr().trim().slice(-1500)}`);
    finish(1);
  }
  finish(0);
} catch (error) {
  console.error(`[sandbox-probe] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  if (engine?.stderr().trim()) console.error(`[sandbox-probe] engine stderr:\n${engine.stderr().trim().slice(-1500)}`);
  finish(1);
}
