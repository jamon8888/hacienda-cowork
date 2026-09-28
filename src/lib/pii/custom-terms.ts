import { PII_COLORS } from './colors';
import type { PiiDetection } from './regex-detector';

/** A literal the user pinned as PII with the manual gesture (#11). */
export interface CustomTerm {
  label: string;
  value: string;
}

/**
 * Category a pinned term redacts under: the palette category whose key or
 * display label matches the term's label (a category pick), else `custom`
 * (a free-text label, which is not token-safe as a category).
 */
export function customTermCategory(label: string): string {
  const wanted = label.trim().toLowerCase();
  for (const [key, entry] of Object.entries(PII_COLORS)) {
    if (key === wanted || entry.label.toLowerCase() === wanted) return key;
  }
  return 'custom';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive literal matches of pinned terms, so a term redacts even
 * when NER is unavailable. Overlaps are resolved later by buildRedactedText.
 */
export function detectCustomTerms(text: string, terms: readonly CustomTerm[]): PiiDetection[] {
  const detections: PiiDetection[] = [];
  for (const term of terms) {
    const value = term.value.trim();
    if (!value) continue;
    const pattern = new RegExp(escapeRegExp(value), 'gi');
    const category = customTermCategory(term.label);
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      detections.push({ category, start, end: start + match[0].length, text: match[0], confidence: 1 });
    }
  }
  return detections;
}
