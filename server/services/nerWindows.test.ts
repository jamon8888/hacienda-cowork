import { describe, expect, test } from 'bun:test';

import {
  mapWindowDetections,
  mergeWindowDetections,
  NER_WINDOW_CHARS,
  NER_WINDOW_OVERLAP_CHARS,
  NER_WINDOW_SEPARATOR,
  planNerWindows,
  splitIntoRanges,
} from './nerWindows';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');

describe('splitIntoRanges', () => {
  test('covers every character, each range within the window', () => {
    const text = words(400); // ~2 600 chars
    const ranges = splitIntoRanges(text);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(text.length);
    for (const [start, end] of ranges) expect(end - start).toBeLessThanOrEqual(NER_WINDOW_CHARS);
    for (let i = 1; i < ranges.length; i++) {
      // consecutive ranges overlap by exactly the overlap
      expect(ranges[i - 1][1] - ranges[i][0]).toBe(NER_WINDOW_OVERLAP_CHARS);
    }
  });

  test('cuts at whitespace when one is in the second half of the window', () => {
    const text = words(400);
    for (const [, end] of splitIntoRanges(text).slice(0, -1)) {
      expect(text[end - 1]).toBe(' ');
    }
  });

  test('cuts a text with no whitespace at the window size', () => {
    const ranges = splitIntoRanges('x'.repeat(1000));
    expect(ranges[0]).toEqual([0, NER_WINDOW_CHARS]);
  });

  test('never splits a surrogate pair', () => {
    const text = '😀'.repeat(600); // 1 200 UTF-16 units, no whitespace
    for (const [start, end] of splitIntoRanges(text)) {
      expect(start % 2).toBe(0);
      expect(end % 2).toBe(0);
    }
  });

  test('refuses an overlap of half the window or more', () => {
    expect(() => splitIntoRanges('abc', 10, 5)).toThrow();
  });

  test('a short text is one range', () => {
    expect(splitIntoRanges('court')).toEqual([[0, 5]]);
  });
});

describe('planNerWindows', () => {
  test('packs short texts into one window with the separator', () => {
    const windows = planNerWindows(['Jane Doe signed', 'nothing here']);
    expect(windows).toHaveLength(1);
    expect(windows[0].text).toBe(`Jane Doe signed${NER_WINDOW_SEPARATOR}nothing here`);
    expect(windows[0].pieces).toEqual([
      { entry: 0, entryStart: 0, windowStart: 0, length: 15 },
      { entry: 1, entryStart: 0, windowStart: 17, length: 12 },
    ]);
  });

  test('starts a new window when the next short text would overflow', () => {
    const a = 'a'.repeat(300);
    const b = 'b'.repeat(300);
    const windows = planNerWindows([a, b]);
    expect(windows.map((w) => w.text)).toEqual([a, b]);
  });

  test('a long text gets windows of its own, never shared', () => {
    const long = words(400);
    const windows = planNerWindows(['avant', long, 'après']);
    expect(windows[0].text).toBe('avant');
    expect(windows[windows.length - 1].text).toBe('après');
    for (const window of windows.slice(1, -1)) {
      expect(window.pieces).toHaveLength(1);
      expect(window.pieces[0].entry).toBe(1);
      expect(window.text.length).toBeLessThanOrEqual(NER_WINDOW_CHARS);
    }
  });

  test('every window is within the size', () => {
    const windows = planNerWindows([words(50), words(400), 'x', words(30)]);
    for (const window of windows) expect(window.text.length).toBeLessThanOrEqual(NER_WINDOW_CHARS);
  });
});

describe('mapWindowDetections', () => {
  test('maps window offsets back onto each text', () => {
    const texts = ['Jane Doe signed', 'Counsel for Jane Doe'];
    const [window] = planNerWindows(texts);
    const at = window.text.lastIndexOf('Jane Doe');
    const found: PiiDetection[] = [
      { category: 'person', start: 0, end: 8, text: 'Jane Doe', confidence: 0.9 },
      { category: 'person', start: at, end: at + 8, text: 'Jane Doe', confidence: 0.9 },
    ];
    const mapped = mapWindowDetections(window, found, texts);
    expect(mapped).toEqual([
      { entry: 0, detection: { category: 'person', start: 0, end: 8, text: 'Jane Doe', confidence: 0.9 } },
      { entry: 1, detection: { category: 'person', start: 12, end: 20, text: 'Jane Doe', confidence: 0.9 } },
    ]);
  });

  test('shifts a split window by its start in the text', () => {
    const text = `${'x '.repeat(300)}Jane Doe`;
    const windows = planNerWindows([text]);
    const last = windows[windows.length - 1];
    const at = last.text.indexOf('Jane Doe');
    const [{ detection }] = mapWindowDetections(last, [
      { category: 'person', start: at, end: at + 8, text: 'Jane Doe', confidence: 0.9 },
    ], [text]);
    expect(text.slice(detection.start, detection.end)).toBe('Jane Doe');
  });

  test('clips a span that crosses the separator', () => {
    const texts = ['Jane', 'Doe'];
    const [window] = planNerWindows(texts);
    const mapped = mapWindowDetections(window, [
      { category: 'person', start: 0, end: window.text.length, text: window.text, confidence: 0.9 },
    ], texts);
    expect(mapped.map((m) => m.detection.text)).toEqual(['Jane', 'Doe']);
  });
});

describe('mergeWindowDetections', () => {
  const text = 'Maître Jane Doe représente Acme SAS';
  const d = (category: string, start: number, end: number, confidence = 0.9): PiiDetection =>
    ({ category, start, end, text: text.slice(start, end), confidence });

  test('drops an identical span found by two windows', () => {
    expect(mergeWindowDetections([d('person', 7, 15), d('person', 7, 15)], text)).toEqual([d('person', 7, 15)]);
  });

  test('merges overlapping spans to their union', () => {
    expect(mergeWindowDetections([d('person', 7, 11), d('person', 9, 15)], text)).toEqual([
      { ...d('person', 7, 15) },
    ]);
  });

  test('overlapping spans of different categories keep the union under the more confident one', () => {
    const merged = mergeWindowDetections([d('person', 7, 15, 0.6), d('organization', 12, 15, 0.8)], text);
    expect(merged).toEqual([{ ...d('organization', 7, 15, 0.8) }]);
  });

  test('keeps touching but separate spans apart', () => {
    expect(mergeWindowDetections([d('person', 7, 15), d('organization', 27, 35)], text)).toHaveLength(2);
  });
});
