import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { getCurrentWorkspace, setCurrentWorkspace } from '../utils/workspace';
import { getWorkspaceScanStatus, resolveScanPaths } from './workspaceScan';

describe('resolveScanPaths (#13/#18 code-indexing opt-in)', () => {
  test('forces the safe/ mirror corpus when indexing is off (default)', () => {
    expect(resolveScanPaths(['src'], false)).toEqual(['safe']);
    expect(resolveScanPaths(['src', 'docs'], false)).toEqual(['safe']);
    expect(resolveScanPaths(undefined, false)).toEqual(['safe']);
  });

  test('honors requested paths only when the code-indexing opt-in is on', () => {
    expect(resolveScanPaths(['src'], true)).toEqual(['src']);
    expect(resolveScanPaths(['src', 'docs'], true)).toEqual(['src', 'docs']);
    expect(resolveScanPaths(undefined, true)).toEqual(['safe']);
  });
});

describe('getWorkspaceScanStatus entities (GLiNER2 spec #37)', () => {
  test('counts redaction tokens written under safe/', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'scan-entities-'));
    mkdirSync(path.join(ws, 'safe'), { recursive: true });
    writeFileSync(path.join(ws, 'safe', 'a.txt'), 'Hello [PERSON_1] and [EMAIL_0]');
    writeFileSync(path.join(ws, 'safe', 'b.txt'), '[ORGANIZATION_1] met [PERSON_1]');
    const previous = getCurrentWorkspace();
    setCurrentWorkspace(ws);
    try {
      expect(getWorkspaceScanStatus().entities).toBe(4);
    } finally {
      setCurrentWorkspace(previous);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('getWorkspaceScanStatus progress during initial population (spec #37)', () => {
  test('reports done/total while population runs, null after', async () => {
    const { setSafeArmRescanForTests } = await import('../utils/safeArm');
    const { setSafeSyncRedactForTests, setSafeSyncVaultPersistForTests } = await import('../utils/safeSync');
    const ws = mkdtempSync(path.join(tmpdir(), 'scan-progress-'));
    writeFileSync(path.join(ws, 'a.txt'), 'one');
    writeFileSync(path.join(ws, 'b.txt'), 'two');
    const previous = getCurrentWorkspace();
    setCurrentWorkspace(ws);

    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let redactCalls = 0;
    setSafeSyncRedactForTests(async () => {
      redactCalls += 1;
      if (redactCalls === 1) await gate;
      return { redacted_text: 'x', rehydration_map: {} };
    });
    setSafeSyncVaultPersistForTests(() => {});
    setSafeArmRescanForTests(async () => ({ success: true }));

    try {
      const { runInitialPopulation } = await import('../utils/safeArm');
      expect(getWorkspaceScanStatus().progress).toBeNull();

      const population = runInitialPopulation(ws);

      // The first file is held by the gate, so a published total with done 0
      // proves the run reports while in flight, not only at the end.
      let status = getWorkspaceScanStatus();
      for (let i = 0; i < 200 && status.progress?.total !== 2; i++) {
        await new Promise((r) => setTimeout(r, 5));
        status = getWorkspaceScanStatus();
      }
      expect(status.progress).toEqual({ done: 0, total: 2 });
      expect(status.indexing).toBe(true);

      release();
      await population;
      expect(getWorkspaceScanStatus().progress).toBeNull();
      expect(getWorkspaceScanStatus().indexing).toBe(false);
    } finally {
      setSafeSyncRedactForTests(null);
      setSafeSyncVaultPersistForTests(null);
      setSafeArmRescanForTests(null);
      setCurrentWorkspace(previous);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('getWorkspaceScanStatus resourcesReady (GLiNER2 spec #37)', () => {
  test('nerModel is ready for the fastino safetensors layout', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'scan-status-'));
    const snapshot = path.join(
      base,
      'models--fastino--gliner2-privacy-filter-PII-multi',
      'snapshots',
      '36126f612f1f9e376dc2c25b297d827912effef4',
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, 'model.safetensors'), 'weights');
    // Isolate every hub candidate dir — a real ~/.local/share/basemind/hub
    // with cached ONNX would make this pass for the wrong reason.
    const previous = {
      HF_HUB_CACHE: process.env.HF_HUB_CACHE,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
    process.env.HF_HUB_CACHE = base;
    process.env.XDG_DATA_HOME = path.join(base, 'xdg');
    process.env.HOME = path.join(base, 'home');
    try {
      expect(getWorkspaceScanStatus().resourcesReady.nerModel).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
});
