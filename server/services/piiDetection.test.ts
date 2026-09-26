import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { isPiiModelReady, parseRedactTextResult, resolveNerModelDir } from './piiDetection';

describe('parseRedactTextResult', () => {
  test('maps basemind redact_text output onto the renderer contract', () => {
    const parsed = parseRedactTextResult({
      structuredContent: {
        result: {
          redacted_text: 'Call [EMAIL_0]',
          rehydration_map: { '[EMAIL_0]': 'john@example.com' },
          detections: [
            { category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 0.9 },
          ],
        },
      },
    });
    expect(parsed.redacted_text).toBe('Call [EMAIL_0]');
    expect(parsed.rehydration_map).toEqual({ '[EMAIL_0]': 'john@example.com' });
    expect(parsed.detections).toHaveLength(1);
  });

  test('returns empty detections for unknown shapes instead of throwing', () => {
    expect(parseRedactTextResult(null)).toEqual({
      redacted_text: '',
      rehydration_map: {},
      detections: [],
    });
  });
});

/** Hub layout written by preseedNerModel: models--<repo>/snapshots/<rev>/<file>. */
function writeFastinoSnapshot(baseDir: string): string {
  const rev = '36126f612f1f9e376dc2c25b297d827912effef4';
  const snapshot = path.join(
    baseDir,
    'models--fastino--gliner2-privacy-filter-PII-multi',
    'snapshots',
    rev,
  );
  mkdirSync(path.join(snapshot, 'encoder_config'), { recursive: true });
  writeFileSync(path.join(snapshot, 'model.safetensors'), 'weights');
  writeFileSync(path.join(snapshot, 'tokenizer.json'), '{}');
  writeFileSync(path.join(snapshot, 'encoder_config', 'config.json'), '{}');
  return snapshot;
}

describe('fastino GLiNER2 readiness (candle loader layout)', () => {
  test('isPiiModelReady treats a safetensors snapshot as a downloaded model', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-ready-'));
    try {
      expect(isPiiModelReady(baseDir)).toBe(false);
      writeFastinoSnapshot(baseDir);
      expect(isPiiModelReady(baseDir)).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('resolveNerModelDir returns the candle-ready snapshot dir', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-resolve-'));
    try {
      expect(resolveNerModelDir([baseDir])).toBeNull();
      const snapshot = writeFastinoSnapshot(baseDir);
      expect(resolveNerModelDir([baseDir])).toBe(snapshot);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
