/**
 * Name consistency across a send. NER reads one window of a few hundred
 * characters at a time, and whether it flags a name depends on the words around
 * it: "Dubreuil" is caught in a sentence and missed in a file name, a URL or a
 * bare "Mme Dubreuil". Once a name is detected anywhere in the send, every other
 * mention of the same string is masked too. It can only over-mask, never leak.
 */

import type { PiiDetection } from '../../src/lib/pii/regex-detector';

const PERSON_CATEGORIES = new Set(['person', 'full_name', 'first_name', 'middle_name', 'last_name']);

/** Shorter values ("Li", "Jo") would match inside too many ordinary words. */
const MIN_LETTERS = 3;

export interface NameValue {
  value: string;
  category: string;
}

const lettersIn = (value: string) => (value.match(/\p{L}/gu) ?? []).length;

/** Distinct person names NER found in the batch, longest first. */
export function collectNameValues(detectionsByEntry: PiiDetection[][]): NameValue[] {
  const seen = new Map<string, NameValue>();
  for (const detections of detectionsByEntry) {
    for (const detection of detections) {
      if (!PERSON_CATEGORIES.has(detection.category)) continue;
      const value = detection.text.trim();
      if (lettersIn(value) < MIN_LETTERS) continue;
      const key = value.toLowerCase();
      if (!seen.has(key)) seen.set(key, { value, category: detection.category });
    }
  }
  return [...seen.values()].sort((a, b) => b.value.length - a.value.length);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The detections of one text plus the other mentions of the given names. A
 * mention is a whole word (an underscore, slash, dot or dash is a separator, so
 * `Dubreuil_Hélène.pdf` and `/dubreuil/` count) and is skipped where another
 * detection already covers it.
 */
export function propagateNames(text: string, detections: PiiDetection[], names: NameValue[]): PiiDetection[] {
  if (names.length === 0) return detections;
  const result = [...detections];
  const overlapsResult = (start: number, end: number) =>
    result.some((other) => start < other.end && other.start < end);
  for (const { value, category } of names) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsResult(start, end)) continue;
      result.push({ category, start, end, text: match[0], confidence: 0.5 });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}
