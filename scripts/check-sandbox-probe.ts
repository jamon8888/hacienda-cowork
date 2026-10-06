/**
 * Runs the Safe-workspace sandbox probe against the real bundled engine, on
 * the machine it is run on (CI runs it on Linux, macOS and Windows).
 *
 * - the probe must report "enforced" under the engine's read-only policy;
 * - the same probe must report "not enforced" when the policy is swapped for
 *   full access, so a probe that always says yes cannot pass.
 *
 * Needs `pnpm run download:oix -- --current-platform` first.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

const home = mkdtempSync(join(tmpdir(), 'sandbox-probe-home-'));
const probeRoot = join(process.cwd(), 'test-runs', `sandbox-probe-${process.pid}`);
mkdirSync(probeRoot, { recursive: true });

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
const notifications: Array<{ method: string; params?: any }> = [];
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

function call(method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function finish(code: number): never {
  child.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(probeRoot, { recursive: true, force: true });
  process.exit(code);
}

const exec = (label: string): SandboxProbeExec => async (params) => {
  const response = await call('command/exec', params);
  if (response.error) {
    console.log(`[sandbox-probe]   ${label} ${params.sandboxPolicy.type}: RPC error ${JSON.stringify(response.error).slice(0, 300)}`);
    throw new Error(JSON.stringify(response.error));
  }
  const { exitCode, stderr } = response.result;
  console.log(`[sandbox-probe]   ${label} ${params.sandboxPolicy.type}: exit=${exitCode} stderr=${JSON.stringify(String(stderr).slice(0, 200))}`);
  return response.result;
};
const unenforcedExec = (label: string): SandboxProbeExec => (params) =>
  exec(label)({ ...params, sandboxPolicy: { type: 'dangerFullAccess' } } as unknown as Parameters<SandboxProbeExec>[0]);

try {
  await call('initialize', { clientInfo: { name: 'sandbox-probe-check', title: null, version: '0' }, capabilities: null });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);

  if (process.platform === 'win32') {
    // On Windows the engine confines nothing until its sandbox is set up once
    // (the app offers this in a banner). Do what the app does, then probe.
    const started = await call('windowsSandbox/setupStart', { mode: 'elevated', cwd: probeRoot });
    console.log(`[sandbox-probe] windows setupStart: ${JSON.stringify(started.error ?? started.result).slice(0, 300)}`);
    const deadline = Date.now() + 180_000;
    let completed: any;
    while (!completed && Date.now() < deadline) {
      completed = notifications.find((n) => n.method === 'windowsSandbox/setupCompleted');
      if (!completed) await new Promise((r) => setTimeout(r, 1_000));
    }
    console.log(`[sandbox-probe] windows setupCompleted: ${JSON.stringify(completed?.params ?? 'no notification within 180s').slice(0, 300)}`);
  }

  resetSandboxProbeCacheForTests();
  const control = await probeSandboxEnforced(unenforcedExec('control'), { dir: join(probeRoot, 'control'), networkAccess: true });
  resetSandboxProbeCacheForTests();
  const enforced = await probeSandboxEnforced(exec('real'), { dir: join(probeRoot, 'real'), networkAccess: true });
  console.log(`[sandbox-probe] platform=${process.platform}-${process.arch} enforced=${enforced} control(unenforced)=${control}`);

  // A Safe thread runs with no network unless the user turned it on. Report that
  // configuration too, without failing on it: some hosts (hardened Linux, CI
  // runners) cannot create the network namespace it needs, which only means
  // Safe turns are refused there.
  resetSandboxProbeCacheForTests();
  const noNetwork = await probeSandboxEnforced(exec('no-network'), { dir: join(probeRoot, 'no-network'), networkAccess: false });
  console.log(`[sandbox-probe] info: with no network (the Safe default) enforced=${noNetwork}`);

  const problems: string[] = [];
  if (control) problems.push('the probe reported "enforced" with the sandbox switched off: it cannot be trusted');
  if (!enforced) problems.push('the probe reported "not enforced" under the engine read-only policy: Safe turns would be refused on this system');
  if (['real', 'control', 'no-network'].some((d) => ['probe-target', 'probe-control'].some((f) => existsSync(join(probeRoot, d, f))))) {
    problems.push('the probe left its target file behind');
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[sandbox-probe] FAIL: ${problem}`);
    if (stderr.trim()) console.error(`[sandbox-probe] engine stderr:\n${stderr.trim().slice(-1500)}`);
    finish(1);
  }
  finish(0);
} catch (error) {
  console.error(`[sandbox-probe] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  if (stderr.trim()) console.error(`[sandbox-probe] engine stderr:\n${stderr.trim().slice(-1500)}`);
  finish(1);
}
