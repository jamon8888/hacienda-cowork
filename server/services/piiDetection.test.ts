import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { isFullDetectionReady, isPiiModelReady, parseRedactTextResult, resolveNerModelDir, sweepResidualPii } from './piiDetection';

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

describe('isFullDetectionReady', () => {
  test('needs the candle safetensors layout, not just any weights', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-full-'));
    try {
      const onnxOnly = path.join(baseDir, 'models--knowledgator--gliner-pii-edge-v1.0');
      mkdirSync(onnxOnly, { recursive: true });
      writeFileSync(path.join(onnxOnly, 'model.onnx'), 'weights');
      // Looks ready to the download UI, but redact_text cannot load it.
      expect(isPiiModelReady(baseDir)).toBe(true);
      expect(isFullDetectionReady([baseDir])).toBe(false);
      writeFastinoSnapshot(baseDir);
      expect(isFullDetectionReady([baseDir])).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('sweepResidualPii', () => {
  const basemindOutput = {
    redacted_text: 'Entre [PERSON_1], joignable au +33 6 12 34 56 78 et à [EMAIL_1].',
    rehydration_map: { '[PERSON_1]': 'Jean Dupond', '[EMAIL_1]': 'jean@example.com' },
    detections: [],
  };

  test('tokenizes a phone number basemind left in the text', () => {
    const swept = sweepResidualPii(basemindOutput);
    expect(swept.redacted_text).not.toContain('+33 6 12 34 56 78');
    const phoneToken = Object.keys(swept.rehydration_map).find(
      (token) => swept.rehydration_map[token] === '+33 6 12 34 56 78',
    );
    expect(phoneToken).toBeDefined();
    expect(swept.redacted_text).toContain(phoneToken!);
  });

  test("keeps basemind's tokens and map entries intact", () => {
    const swept = sweepResidualPii(basemindOutput);
    expect(swept.redacted_text).toContain('[PERSON_1]');
    expect(swept.redacted_text).toContain('[EMAIL_1]');
    expect(swept.rehydration_map['[PERSON_1]']).toBe('Jean Dupond');
    expect(swept.rehydration_map['[EMAIL_1]']).toBe('jean@example.com');
  });

  test('catches a pinned term basemind missed', () => {
    const swept = sweepResidualPii(
      { redacted_text: 'Offre pour Acme Holding', rehydration_map: {}, detections: [] },
      [{ label: 'Client', value: 'Acme Holding' }],
    );
    expect(swept.redacted_text).toBe('Offre pour [CLIENT_0]');
    expect(swept.rehydration_map['[CLIENT_0]']).toBe('Acme Holding');
  });

  test('never rewrites a token basemind already issued', () => {
    const swept = sweepResidualPii(
      { redacted_text: 'Signé par [PERSON_1] pour PERSON Inc', rehydration_map: { '[PERSON_1]': 'Jean' }, detections: [] },
      [{ label: 'Client', value: 'PERSON' }],
    );
    expect(swept.redacted_text).toBe('Signé par [PERSON_1] pour [CLIENT_0] Inc');
    expect(swept.rehydration_map['[PERSON_1]']).toBe('Jean');
  });

  test('returns the result unchanged when nothing is left', () => {
    const clean = { redacted_text: 'Rien à signaler [PERSON_1]', rehydration_map: { '[PERSON_1]': 'x' }, detections: [] };
    expect(sweepResidualPii(clean)).toBe(clean);
  });
});
