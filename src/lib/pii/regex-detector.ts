export interface PiiDetection {
  category: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

/**
 * Individual patterns — kept readable for maintenance. Combined into a single
 * alternation at module init so `detectRegex` makes one pass over the input.
 *
 * IBAN comes first: it matches the same digit runs as credit_card, and the
 * alternation order lets it win ties at the same position.
 */
const PATTERNS = {
  email: /[\w.+-]+@[\w-]+\.[\w.]+/g,
  iban: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
  // E.164 first (`+` + 8–15 digits, separators allowed): the international
  // form wins over the US-centric fallback below (+33 …, +1-800-…).
  phone: /\+\d(?:[ .-]?\d){7,14}|(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  ipv4: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  credit_card: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
} as const;

/**
 * Single alternation regex built at module load. Named groups identify which
 * pattern matched. IBAN is first so it wins digit-run ties with credit_card.
 */
const COMBINED = (() => {
  const parts: string[] = [];
  for (const [category, regex] of Object.entries(PATTERNS)) {
    parts.push(`(?<${category}>${regex.source})`);
  }
  return new RegExp(parts.join('|'), 'g');
})();

export function detectRegex(text: string): PiiDetection[] {
  const detections: PiiDetection[] = [];
  // Regex objects with the `g` flag carry mutable state across calls; reset it
  // so a throw mid-scan on a previous call can't leave a stale lastIndex here.
  COMBINED.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COMBINED.exec(text)) !== null) {
    const m = match;
    // Find which named group matched.
    let category: string | null = null;
    for (const name of Object.keys(PATTERNS)) {
      if (m.groups?.[name] !== undefined) { category = name; break; }
    }
    if (!category) { COMBINED.lastIndex = m.index + 1; continue; }

    const start = m.index;
    const end = start + m[0].length;

    // Matches arrive in increasing `start` order, and accepted detections are
    // kept disjoint by this same check — so their `end` values are
    // non-decreasing and the last accepted detection always has the greatest
    // `end` seen so far. Comparing against it alone is enough; no need to
    // scan the whole accepted list.
    const last = detections[detections.length - 1];
    if (last && last.start < end && start < last.end) {
      COMBINED.lastIndex = m.index + 1;
      continue;
    }

    detections.push({
      category,
      start,
      end,
      text: m[0],
      confidence: 1.0,
    });

    // Skip straight past the accepted span: anything the regex would find
    // inside it necessarily overlaps and would be rejected above anyway.
    COMBINED.lastIndex = end;
  }

  // Merge overlapping/adjacent detections within the same category
  const merged: PiiDetection[] = [];
  for (const d of detections) {
    const last = merged[merged.length - 1];
    if (last && last.category === d.category && last.end >= d.start) {
      merged[merged.length - 1] = {
        category: last.category,
        start: last.start,
        end: Math.max(last.end, d.end),
        text: text.substring(last.start, Math.max(last.end, d.end)),
        confidence: 1.0,
      };
    } else {
      merged.push(d);
    }
  }

  return merged;
}
