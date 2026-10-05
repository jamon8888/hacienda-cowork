export interface PiiDetection {
  category: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

// Between IBAN groups: a space, a no-break or narrow no-break space (French
// typography, copy-paste from PDFs), or a line break with its indentation
// (an IBAN wrapped by a document extractor).
const IBAN_SEPARATOR = String.raw`(?:[ \u00a0\u202f]|\r?\n[ \t]*)?`;

// Between the digits of a phone number: a space, a no-break or narrow no-break
// space (French typography), `.` or `-`.
const PHONE_SEPARATOR = String.raw`[ \u00a0\u202f.-]?`;

// IPv6 in full (eight groups) or compressed (`::`, which every shortened form
// needs). A leading `::` (`::1`, `::ffff`) is left out and so is a bare `::`:
// they read as C++/Rust paths (`std::vector`). The lookahead asks for a digit
// somewhere, so `Dead::beef` stays alone; times (`09:41:00`) and MAC addresses
// (six groups) have no `::` and too few groups.
const IPV6_GROUP = '[A-Fa-f0-9]{1,4}';
const IPV6 = [
  `(?:${IPV6_GROUP}:){7}${IPV6_GROUP}`,
  `(?:${IPV6_GROUP}:){1,7}:`,
  `(?:${IPV6_GROUP}:){1,6}:${IPV6_GROUP}`,
  `(?:${IPV6_GROUP}:){1,5}(?::${IPV6_GROUP}){1,2}`,
  `(?:${IPV6_GROUP}:){1,4}(?::${IPV6_GROUP}){1,3}`,
  `(?:${IPV6_GROUP}:){1,3}(?::${IPV6_GROUP}){1,4}`,
  `(?:${IPV6_GROUP}:){1,2}(?::${IPV6_GROUP}){1,5}`,
  `${IPV6_GROUP}:(?::${IPV6_GROUP}){1,6}`,
].join('|');

// A number as written in French or English: groups of three digits split by a
// space, no-break space, `.` or `,`, then optional decimals (125 000, 1.250,50,
// $1,250.50), or plain digits with optional decimals (125000, 1,2). The groups
// are capped at six (up to 10^18): unbounded, a long run of numbers with no
// currency was rescanned from every group start, quadratic time on any text.
const AMOUNT_NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f.,]\d{3}){1,6}(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const AMOUNT_CURRENCY = String.raw`(?:€|EUR\b|USD\b|GBP\b|CHF\b|[Ee]uros?\b|[Dd]ollars?\b)`;
const AMOUNT_MAGNITUDE = String.raw`(?:\s?(?:k|K|M|Md|mille|millions?|milliards?)(?:\s?d['’]\s?)?)?`;

/**
 * Individual patterns — kept readable for maintenance. Combined into a single
 * alternation at module init so `detectRegex` makes one pass over the input.
 *
 * IBAN comes first: it matches the same digit runs as credit_card, and the
 * alternation order lets it win ties at the same position. An IBAN written with
 * a lowercase letter must also pass the mod-97 check: lowercase words such as
 * `en10 mots dans` otherwise fit the shape. `amount` follows it, ahead of the
 * digit-based patterns: no NER label covers money, and a number is only an
 * amount next to a currency, so bare numbers stay alone.
 */
const PATTERNS = {
  email: /[\w.+-]+@[\w-]+\.[\w.]+/g,
  iban: new RegExp(
    String.raw`\b[A-Za-z]{2}\d{2}(?:${IBAN_SEPARATOR}[A-Za-z0-9]{4}){2,7}(?:${IBAN_SEPARATOR}[A-Za-z0-9]{1,3})?\b`,
    'g',
  ),
  amount: new RegExp(
    String.raw`(?<![\d.,])(?:[$£€]\s?(?:${AMOUNT_NUMBER})|(?:${AMOUNT_NUMBER})${AMOUNT_MAGNITUDE}\s?${AMOUNT_CURRENCY})`,
    'g',
  ),
  // Cards run before `phone`: its 3-3-4 fallback would otherwise take the first
  // ten to thirteen digits of a compact card or of an American Express number
  // (4-6-5, 15 digits) and leave the rest in clear.
  credit_card: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g,
  // E.164 first (`+` + 8–15 digits, separators allowed): the international
  // form wins over the US-centric fallback below (+33 …, +1-800-…). Written
  // with the trunk zero in parentheses (+33 (0)4 65 71 20 45), it is the
  // first alternative, since the plain form stops at the `(`. Then the
  // French national form, ten digits in pairs (06 12 34 56 78, 01.23.45.67.89),
  // which the 3-3-4 fallback never matched; the leading 0 and the word
  // boundaries keep amounts (125 000) and dates (01.02.2024) out.
  phone: new RegExp(
    [
      String.raw`\+\d{1,3}${PHONE_SEPARATOR}\(0\)(?:${PHONE_SEPARATOR}\d){6,12}`,
      String.raw`\+\d(?:${PHONE_SEPARATOR}\d){7,14}`,
      String.raw`\b0[1-9](?:${PHONE_SEPARATOR}\d{2}){4}\b`,
      String.raw`(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}`,
    ].join('|'),
    'g',
  ),
  ipv4: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  ipv6: new RegExp(String.raw`(?<![\w:])(?=[A-Fa-f0-9:]*\d)(?:${IPV6})(?![\w:])`, 'g'),
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

/** ISO 7064 mod-97-10 check of an IBAN, separators ignored. */
function hasValidIbanChecksum(candidate: string): boolean {
  const compact = candidate.replace(/[\s\u00a0\u202f]/g, '').toUpperCase();
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

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

    // Lowercase letters make the IBAN shape ambiguous with ordinary words; an
    // uppercase one keeps matching on shape alone, so a mistyped IBAN is still hidden.
    if (category === 'iban' && /[a-z]/.test(m[0]) && !hasValidIbanChecksum(m[0])) {
      COMBINED.lastIndex = m.index + 1;
      continue;
    }

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
