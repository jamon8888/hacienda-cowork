import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  assertMirrorCoverage,
  hasNerCoverageProof,
  isFullDetectionReady,
  isPiiModelReady,
  NerCoverageError,
  originalTextLength,
  parseRedactTextResult,
  resolveNerModelDir,
  sweepResidualPii,
} from './piiDetection';

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
      expect(isPiiModelReady([baseDir])).toBe(false);
      writeFastinoSnapshot(baseDir);
      expect(isPiiModelReady([baseDir])).toBe(true);
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
      expect(isPiiModelReady([baseDir])).toBe(true);
      expect(isFullDetectionReady([baseDir])).toBe(false);
      writeFastinoSnapshot(baseDir);
      expect(isFullDetectionReady([baseDir])).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('isFullDetectionReady after an interrupted download', () => {
  // The preseed lands model.safetensors first and the small configs after it,
  // so a cut download leaves weights with no tokenizer or encoder config.
  test('is not ready while the tokenizer or encoder config is missing', () => {
    for (const missing of ['tokenizer.json', path.join('encoder_config', 'config.json')]) {
      const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-partial-'));
      try {
        const snapshot = writeFastinoSnapshot(baseDir);
        rmSync(path.join(snapshot, missing));
        expect(isFullDetectionReady([baseDir])).toBe(false);
        expect(resolveNerModelDir([baseDir])).toBeNull();
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  });

  test('is not ready when a snapshot entry is a dangling link', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-dangling-'));
    try {
      const snapshot = writeFastinoSnapshot(baseDir);
      rmSync(path.join(snapshot, 'model.safetensors'));
      symlinkSync('../../blobs/gone', path.join(snapshot, 'model.safetensors'));
      expect(isFullDetectionReady([baseDir])).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('prefers a complete snapshot over an interrupted one in the same repo', () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'pii-two-rev-'));
    try {
      const complete = writeFastinoSnapshot(baseDir);
      const partial = path.join(path.dirname(complete), '0000partial');
      mkdirSync(partial, { recursive: true });
      writeFileSync(path.join(partial, 'model.safetensors'), 'weights');
      expect(resolveNerModelDir([baseDir])).toBe(complete);
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

describe('NER coverage (spec 2026-10-07)', () => {
  const result = (over: Partial<ReturnType<typeof parseRedactTextResult>> = {}) => ({
    redacted_text: 'Signed by [PERSON_1].',
    rehydration_map: { '[PERSON_1]': 'Hélène Marchand' },
    detections: [],
    ner_ran: true,
    ...over,
  });

  test('parses the coverage fields basemind may return', () => {
    const parsed = parseRedactTextResult({
      structuredContent: { result: { redacted_text: 'x', rehydration_map: {}, detections: [], ner_ran: true, ner_windows: 3, ner_window_chars: 350, ner_truncated: false } },
    });
    expect(parsed.ner_windows).toBe(3);
    expect(parsed.ner_window_chars).toBe(350);
    expect(parsed.ner_truncated).toBe(false);
  });

  test('omits the coverage fields when basemind does not send them', () => {
    const parsed = parseRedactTextResult({ structuredContent: { result: { redacted_text: 'x', rehydration_map: {}, detections: [] } } });
    expect('ner_windows' in parsed).toBe(false);
    expect('ner_window_chars' in parsed).toBe(false);
    expect('ner_truncated' in parsed).toBe(false);
  });

  test('measures the original length through the rehydration map', () => {
    expect(originalTextLength(result())).toBe('Signed by Hélène Marchand.'.length);
  });

  test('coverage proof needs both fields and a window no larger than ours', () => {
    expect(hasNerCoverageProof(result())).toBe(false);
    expect(hasNerCoverageProof(result({ ner_windows: 2, ner_window_chars: 300 }), 400)).toBe(true);
    expect(hasNerCoverageProof(result({ ner_windows: 2, ner_window_chars: 512 }), 400)).toBe(false);
    expect(hasNerCoverageProof(result({ ner_windows: 2 }), 400)).toBe(false);
  });

  test('a short file passes without proof', () => {
    expect(() => assertMirrorCoverage(result(), 400)).not.toThrow();
  });

  test('a long file without proof is refused', () => {
    const long = result({ redacted_text: 'x'.repeat(401) , rehydration_map: {} });
    expect(() => assertMirrorCoverage(long, 400)).toThrow(NerCoverageError);
  });

  test('a long file with proof passes', () => {
    const long = result({ redacted_text: 'x'.repeat(5_000), rehydration_map: {}, ner_windows: 15, ner_window_chars: 380 });
    expect(() => assertMirrorCoverage(long, 400)).not.toThrow();
  });

  test('a truncated pass is refused even when short', () => {
    expect(() => assertMirrorCoverage(result({ ner_truncated: true }), 400)).toThrow(NerCoverageError);
  });

  test('the error is recognisable by name across module boundaries', () => {
    expect(new NerCoverageError('x').name).toBe('NerCoverageError');
  });
});
