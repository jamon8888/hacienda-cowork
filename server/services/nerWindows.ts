/**
 * NER windowing (spec 2026-10-07). GLiNER2 reads only the first few hundred
 * characters of one redact_text call and still reports ner_ran (#66 P0), so
 * every text goes to the detector in windows the encoder reads whole. Short
 * texts share a window; a long text is split into windows that overlap, so an
 * entity cut at one boundary is whole in the next window.
 */

import type { PiiDetection } from '../../src/lib/pii/regex-detector';

/** At most 70 % of the lowest cutoff measured by scripts/measure-ner-cutoff.mts. */
export const NER_WINDOW_CHARS = 400;
/** Longest entity guaranteed whole in some window; must stay under half a window. */
export const NER_WINDOW_OVERLAP_CHARS = 100;
/** A paragraph break keeps NER from reading two texts as one sentence. */
export const NER_WINDOW_SEPARATOR = '\n\n';

export interface NerWindowPiece {
  /** Index of the text in the planned array. */
  entry: number;
  /** Where the piece starts in that text. */
  entryStart: number;
  /** Where the piece starts in the window text. */
  windowStart: number;
  length: number;
}

export interface NerWindow {
  text: string;
  pieces: NerWindowPiece[];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Overlapping [start, end) ranges over one text, cut at whitespace when one is in the second half. */
export function splitIntoRanges(
  text: string,
  size = NER_WINDOW_CHARS,
  overlap = NER_WINDOW_OVERLAP_CHARS,
): Array<[number, number]> {
  if (overlap * 2 >= size) throw new Error('NER window overlap must be under half the window');
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      for (let at = end - 1; at > start + size / 2; at--) {
        if (/\s/.test(text[at])) {
          end = at + 1;
          break;
        }
      }
      // A lone surrogate becomes U+FFFD in UTF-8 and shifts basemind's byte offsets.
      if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    ranges.push([start, end]);
    if (end >= text.length) break;
    start = end - overlap;
    if (isLowSurrogate(text.charCodeAt(start))) start -= 1;
  }
  return ranges;
}

/** Windows for a batch: short texts packed with the separator, long texts split alone. */
export function planNerWindows(
  texts: string[],
  size = NER_WINDOW_CHARS,
  overlap = NER_WINDOW_OVERLAP_CHARS,
): NerWindow[] {
  const windows: NerWindow[] = [];
  let packing: NerWindow | null = null;
  for (let entry = 0; entry < texts.length; entry++) {
    const text = texts[entry];
    if (text.length > size) {
      if (packing) windows.push(packing);
      packing = null;
      for (const [start, end] of splitIntoRanges(text, size, overlap)) {
        windows.push({
          text: text.slice(start, end),
          pieces: [{ entry, entryStart: start, windowStart: 0, length: end - start }],
        });
      }
      continue;
    }
    if (packing && packing.text.length + NER_WINDOW_SEPARATOR.length + text.length > size) {
      windows.push(packing);
      packing = null;
    }
    if (!packing) packing = { text: '', pieces: [] };
    if (packing.pieces.length > 0) packing.text += NER_WINDOW_SEPARATOR;
    packing.pieces.push({ entry, entryStart: 0, windowStart: packing.text.length, length: text.length });
    packing.text += text;
  }
  if (packing) windows.push(packing);
  return windows;
}

/** Window offsets mapped onto each piece's own text; a span is clipped to its piece. */
export function mapWindowDetections(
  window: NerWindow,
  found: PiiDetection[],
  texts: string[],
): Array<{ entry: number; detection: PiiDetection }> {
  const mapped: Array<{ entry: number; detection: PiiDetection }> = [];
  for (const piece of window.pieces) {
    const from = piece.windowStart;
    const to = from + piece.length;
    for (const detection of found) {
      const start = Math.max(detection.start, from);
      const end = Math.min(detection.end, to);
      if (start >= end) continue;
      const entryStart = start - from + piece.entryStart;
      const entryEnd = end - from + piece.entryStart;
      mapped.push({
        entry: piece.entry,
        detection: {
          ...detection,
          start: entryStart,
          end: entryEnd,
          text: texts[piece.entry].slice(entryStart, entryEnd),
        },
      });
    }
  }
  return mapped;
}

/**
 * Detections of one text gathered from several windows: overlapping spans
 * become their union, labelled by the more confident one (longer on a tie).
 * Over-masking, never a leak.
 */
export function mergeWindowDetections(detections: PiiDetection[], text: string): PiiDetection[] {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: PiiDetection[] = [];
  for (const detection of sorted) {
    const last = merged[merged.length - 1];
    if (last && detection.start < last.end) {
      const winner =
        detection.confidence > last.confidence
        || (detection.confidence === last.confidence && detection.end - detection.start > last.end - last.start)
          ? detection
          : last;
      const end = Math.max(last.end, detection.end);
      merged[merged.length - 1] = {
        ...winner,
        start: last.start,
        end,
        text: text.slice(last.start, end),
      };
      continue;
    }
    merged.push({ ...detection });
  }
  return merged;
}
