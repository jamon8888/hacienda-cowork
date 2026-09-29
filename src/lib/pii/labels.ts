import { PII_COLORS } from './colors';
import type { PiiDetection } from './regex-detector';

export interface RedactedToken {
  token: string;
  category: string;
  start: number;
  end: number;
}

/**
 * i18n key for the marker shown when a token has no rehydration map to
 * resolve it against — a turn sent before vault persistence existed, whose
 * original was never stored anywhere. The gap is permanent by construction
 * (there is nothing to migrate or backfill), so the copy states that plainly
 * rather than reading like a transient error.
 *
 * One key, three surfaces (#151 / #167): the viewer uses it today; the
 * composer reveal popover and the chat detokenization plugin should import
 * this constant when they land (#162, #164) rather than writing their own
 * copy for the same state.
 */
export const PII_UNRESTORABLE_MARKER_KEY = 'basemind.pii.unrestorable';

const TOKEN_RE = /\[([A-Za-z][A-Za-z0-9_]*)_(\d+)\]/g;

const CATEGORY_ALIASES: Record<string, string> = {
  person: 'person_full_name',
  name: 'person_full_name',
  full_name: 'person_full_name',
  firstname: 'person_first_name',
  first_name: 'person_first_name',
  lastname: 'person_last_name',
  last_name: 'person_last_name',
  phone_number: 'phone_number',
  phone: 'phone_number',
  ip: 'ip_address',
  ip_address: 'ip_address',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
  creditcard: 'credit_card',
  credit_card: 'credit_card',
};

export function normalizePiiCategory(label: string): string {
  const key = label.toLowerCase();
  // PII_COLORS is a plain object, so `constructor`, `toString` and friends read
  // back truthy and would be accepted as supported categories. Same guard as
  // getPiiColor in colors.ts.
  if (Object.prototype.hasOwnProperty.call(PII_COLORS, key)) return key;
  // CATEGORY_ALIASES needs the same guard: `constructor` resolves to the Object
  // constructor and `__proto__` to Object.prototype, neither of which is null
  // or undefined, so `?? key` would never fire and the caller would receive an
  // object where it expects a category name.
  if (Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, key)) return CATEGORY_ALIASES[key];
  return key;
}

const TOKEN_LABELS: Record<string, string> = {
  email: 'EMAIL',
  phone: 'PHONE',
  phone_number: 'PHONE',
  iban: 'IBAN',
  credit_card: 'CREDIT_CARD',
  person_full_name: 'NAME',
  person_first_name: 'FIRST_NAME',
  person_last_name: 'LAST_NAME',
  organization: 'ORGANIZATION',
  location: 'LOCATION',
  address: 'ADDRESS',
  city: 'CITY',
  ipv4: 'IP',
  ipv6: 'IP',
  ip_address: 'IP',
};

export function tokenLabelForCategory(category: string): string {
  const normalized = normalizePiiCategory(category);
  return TOKEN_LABELS[normalized] ?? normalized.toUpperCase();
}

export function findRedactedTokens(text: string): RedactedToken[] {  const tokens: RedactedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    tokens.push({
      token: match[0],
      category: normalizePiiCategory(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

const EMPTY_RESERVED_TOKENS: ReadonlySet<string> = new Set();

export function buildRedactedText(
  text: string,
  detections: PiiDetection[],
  reservedTokens: ReadonlySet<string> = EMPTY_RESERVED_TOKENS,
): { redactedText: string; rehydrationMap: Record<string, string> } {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: PiiDetection[] = [];
  for (const detection of sorted) {
    const overlaps = accepted.some((other) => detection.start < other.end && other.start < detection.end);
    if (!overlaps) accepted.push(detection);
  }
  accepted.sort((a, b) => a.start - b.start);

  // The source can already contain something shaped like a placeholder. Emitting
  // that same literal as a generated token would leave two indistinguishable
  // tokens in the output for a single rehydration entry, and rehydration would
  // then overwrite the pre-existing literal with the detected value.
  const taken = new Set(findRedactedTokens(text).map((existing) => existing.token));
  // Reserved tokens (e.g. a thread's existing rehydration map) win the same
  // way, so repeated redactions never re-emit a live token for new content.
  for (const reserved of reservedTokens) taken.add(reserved);

  const counters = new Map<string, number>();
  const rehydrationMap: Record<string, string> = {};
  let redactedText = '';
  let cursor = 0;
  for (const detection of accepted) {
    const category = normalizePiiCategory(detection.category);
    const label = tokenLabelForCategory(category);
    let index = counters.get(category) ?? 0;
    let token = `[${label}_${index}]`;
    while (taken.has(token)) {
      index += 1;
      token = `[${label}_${index}]`;
    }
    counters.set(category, index + 1);
    taken.add(token);
    redactedText += text.slice(cursor, detection.start) + token;
    cursor = detection.end;
    rehydrationMap[token] = detection.text;
  }
  redactedText += text.slice(cursor);
  return { redactedText, rehydrationMap };
}

/**
 * Merge full NER detections over instant regex detections. NER wins on any
 * overlap; regex fills the gaps. Guarantees the composer never drops a span
 * either detector found.
 */
export function mergeDetections(
  primary: PiiDetection[],
  fallback: PiiDetection[],
): PiiDetection[] {
  const merged = [...primary];
  for (const detection of fallback) {
    const overlaps = merged.some(
      (other) => detection.start < other.end && other.start < detection.end,
    );
    if (!overlaps) merged.push(detection);
  }
  return merged.sort((a, b) => a.start - b.start);
}

export function buildPiiLabelAttributes(
  match: { category: string; token: string },
  range: { from: number; to: number },
  formatAriaLabel?: (categoryLabel: string) => string,
): Record<string, string> {
  const category = normalizePiiCategory(match.category);
  const color = PII_COLORS[category];
  const categoryLabel = color?.label ?? category;
  return {
    class: 'oa-pii-label',
    style: `--pii-category-color:${color?.light ?? '#6b7280'};--pii-category-color-dark:${color?.dark ?? '#4b5563'}`,
    'data-pii-label': 'true',
    'data-pii-category': category,
    'data-pii-token': match.token,
    'data-from': String(range.from),
    'data-to': String(range.to),
    tabindex: '0',
    role: 'button',
    // Default-locale fallback for callers with no translator (tests); the
    // viewer injects basemind.pii.tokenAriaLabel via the third argument.
    'aria-label': formatAriaLabel
      ? formatAriaLabel(categoryLabel)
      : `Redacted ${categoryLabel}. Activate to reveal.`,
  };
}
