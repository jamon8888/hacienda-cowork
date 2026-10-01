import { describe, expect, test } from 'bun:test';

import { detectRegex } from './regex-detector';
import { PII_COLORS } from './colors';

import {
  buildPiiLabelAttributes,
  buildRedactedText,
  findRedactedTokens,
  mergeDetections,
  normalizePiiCategory,
} from './labels';

describe('normalizePiiCategory', () => {
  test('lowercases engine labels and maps person aliases', () => {
    expect(normalizePiiCategory('EMAIL')).toBe('email');
    expect(normalizePiiCategory('person')).toBe('person_full_name');
    expect(normalizePiiCategory('Name')).toBe('person_full_name');
    expect(normalizePiiCategory('IBAN')).toBe('iban');
  });

  test('folds GLiNER2 synonyms onto their canonical category', () => {
    expect(normalizePiiCategory('street_address')).toBe('address');
    expect(normalizePiiCategory('payment_card')).toBe('credit_card');
    expect(normalizePiiCategory('card_number')).toBe('credit_card');
    expect(normalizePiiCategory('access_token')).toBe('bearer_token');
  });
});

// Contract with basemind's `GLI_NER2_PII_LABELS` + `AI_ACT_NER_LABELS`
// (submodules/basemind/src/mcp/tools_redact.rs). A label basemind sends that has
// no entry here still redacts — it just renders grey and reads as the raw label,
// so this fails before that ships.
const ENGINE_LABELS = [
  'person', 'full_name', 'first_name', 'middle_name', 'last_name', 'date_of_birth',
  'email', 'phone_number', 'address', 'street_address', 'city', 'state_or_region',
  'postal_code', 'country',
  'government_id', 'national_id_number', 'passport_number', 'drivers_license_number',
  'license_number', 'tax_id', 'tax_number',
  'bank_account', 'account_number', 'routing_number', 'iban', 'payment_card',
  'card_number', 'card_expiry', 'card_cvv',
  'username', 'ip_address', 'account_id', 'sensitive_account_id',
  'password', 'secret', 'api_key', 'access_token', 'recovery_code',
  'sensitive_date', 'document_date', 'expiration_date', 'transaction_date',
  'organization', 'location',
  'ai_act_provider', 'ai_act_deployer', 'ai_act_importer', 'ai_act_distributor',
  'ai_act_notified_body', 'ai_act_authorised_representative',
  'high_risk_ai_system', 'gpai_model', 'ai_act_systemic_risk',
  'ai_act_conformity_assessment', 'ai_act_technical_documentation',
  'ai_act_market_surveillance', 'ai_act_penalty', 'ai_act_citation',
];

describe('engine label palette', () => {
  test('every label basemind can send resolves to a palette colour', () => {
    const uncoloured = ENGINE_LABELS.filter(
      (label) => !Object.prototype.hasOwnProperty.call(PII_COLORS, normalizePiiCategory(label)),
    );
    expect(uncoloured).toEqual([]);
  });
});

describe('findRedactedTokens', () => {
  test('finds stored tokens with document positions', () => {
    const tokens = findRedactedTokens('Contact [EMAIL_0] or [IBAN_1] please');
    expect(tokens.map((t) => t.token)).toEqual(['[EMAIL_0]', '[IBAN_1]']);
    expect(tokens[0].category).toBe('email');
    expect(tokens[1].category).toBe('iban');
    expect(tokens[0].start).toBe('Contact '.length);
  });

  test('ignores non-token brackets', () => {
    expect(findRedactedTokens('see [image: logo] and [link](x)')).toEqual([]);
  });
});

describe('normalizePiiCategory prototype safety', () => {
  test('does not accept inherited object members as categories', () => {
    // PII_COLORS and CATEGORY_ALIASES are plain objects, so these names read
    // back truthy and returned a function or Object.prototype to the caller.
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(typeof normalizePiiCategory(name)).toBe('string');
    }
    expect(normalizePiiCategory('__proto__')).toBe('__proto__');
    expect(normalizePiiCategory('constructor')).toBe('constructor');
  });

  test('still resolves real categories and aliases', () => {
    expect(normalizePiiCategory('EMAIL')).toBe('email');
    expect(normalizePiiCategory('person')).toBe('person_full_name');
    expect(normalizePiiCategory('iban')).toBe('iban');
  });
});

describe('buildRedactedText', () => {
  test('assigns stable per-category tokens in order of appearance', () => {
    const result = buildRedactedText('Call john@example.com or jane@example.com on 415-555-0199', [
      { category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 1 },
      { category: 'email', start: 25, end: 41, text: 'jane@example.com', confidence: 1 },
      { category: 'phone', start: 45, end: 57, text: '415-555-0199', confidence: 1 },
    ]);
    expect(result.redactedText).toBe('Call [EMAIL_0] or [EMAIL_1] on [PHONE_0]');
    expect(result.rehydrationMap).toEqual({
      '[EMAIL_0]': 'john@example.com',
      '[EMAIL_1]': 'jane@example.com',
      '[PHONE_0]': '415-555-0199',
    });
  });

  test('drops overlapping detections instead of corrupting text', () => {
    const result = buildRedactedText('john@example.com', [
      { category: 'email', start: 0, end: 16, text: 'john@example.com', confidence: 1 },
      { category: 'email', start: 5, end: 10, text: 'hn@ex', confidence: 0.4 },
    ]);
    expect(result.redactedText).toBe('[EMAIL_0]');
  });

  test('skips token indices the source text already uses', () => {
    const source = 'Ticket [EMAIL_0] belongs to john@example.com';
    const result = buildRedactedText(source, [
      { category: 'email', start: 28, end: 44, text: 'john@example.com', confidence: 1 },
    ]);

    // Reusing [EMAIL_0] would leave two identical tokens for one map entry, and
    // rehydration would replace the pre-existing literal with the detected value.
    expect(result.redactedText).toBe('Ticket [EMAIL_0] belongs to [EMAIL_1]');
    expect(result.rehydrationMap).toEqual({ '[EMAIL_1]': 'john@example.com' });
  });

  test('redacts PII inside inlined pasted-text attachment bodies', () => {
    // Mirrors the send boundary: serializeEditorWithAttachments inlines
    // pasted-text bodies into submission.text, which handleSend redacts.
    const text = 'see notes\n<pasted-content label="notes">\nCall john@example.com\n</pasted-content>';
    const { redactedText, rehydrationMap } = buildRedactedText(text, detectRegex(text));
    expect(redactedText).toContain('[EMAIL_0]');
    expect(redactedText).not.toContain('john@example.com');
    expect(rehydrationMap['[EMAIL_0]']).toBe('john@example.com');
  });

  test('skips reserved tokens from prior redactions', () => {
    const result = buildRedactedText(
      'mail bob@example.com',
      [{ category: 'email', start: 5, end: 20, text: 'bob@example.com', confidence: 1 }],
      new Set(['[EMAIL_0]']),
    );
    expect(result.redactedText).toBe('mail [EMAIL_1]');
    expect(result.rehydrationMap).toEqual({ '[EMAIL_1]': 'bob@example.com' });
  });
});

describe('mergeDetections', () => {
  test('prefers full NER results and keeps regex-only gaps', () => {
    const merged = mergeDetections(
      [{ category: 'person_full_name', start: 11, end: 15, text: 'John', confidence: 0.8 }],
      [
        { category: 'email', start: 11, end: 15, text: 'John', confidence: 1 },
        { category: 'email', start: 30, end: 46, text: 'john@example.com', confidence: 1 },
      ],
    );
    expect(merged.map((detection) => detection.category)).toEqual([
      'person_full_name',
      'email',
    ]);
  });
});

describe('buildPiiLabelAttributes', () => {
  test('exposes category, positions and accessible label', () => {
    const attributes = buildPiiLabelAttributes(
      { category: 'email', token: '[EMAIL_0]' },
      { from: 8, to: 17 },
    );
    expect(attributes['data-pii-category']).toBe('email');
    expect(attributes['data-pii-token']).toBe('[EMAIL_0]');
    expect(attributes['data-from']).toBe('8');
    expect(attributes['data-to']).toBe('17');
    expect(attributes['aria-label']).toContain('Email');
  });

  test('uses the injected aria-label formatter when provided', () => {
    const attributes = buildPiiLabelAttributes(
      { category: 'email', token: '[EMAIL_0]' },
      { from: 8, to: 17 },
      (label) => `Localized ${label}`,
    );
    expect(attributes['aria-label']).toBe('Localized Email');
  });
});

describe('buildRedactedText token reuse', () => {
  const text = 'Dupont SARL doit 5 € à Dupont SARL, pas à Acme SAS';
  const detections = [
    { category: 'organization', start: 0, end: 11, text: 'Dupont SARL', confidence: 1 },
    { category: 'organization', start: 23, end: 34, text: 'Dupont SARL', confidence: 1 },
    { category: 'organization', start: 42, end: 50, text: 'Acme SAS', confidence: 1 },
  ];

  test('gives every detection a fresh token when no reuse map is passed', () => {
    const { redactedText } = buildRedactedText(text, detections);
    expect(redactedText).toBe('[ORGANIZATION_0] doit 5 € à [ORGANIZATION_1], pas à [ORGANIZATION_2]');
  });

  test('keeps one token per value within a call when a reuse map is passed', () => {
    const { redactedText, rehydrationMap } = buildRedactedText(text, detections, new Set(), {});
    expect(redactedText).toBe('[ORGANIZATION_0] doit 5 € à [ORGANIZATION_0], pas à [ORGANIZATION_1]');
    expect(rehydrationMap).toEqual({ '[ORGANIZATION_0]': 'Dupont SARL', '[ORGANIZATION_1]': 'Acme SAS' });
  });

  test('reuses a token the reuse map already holds and skips live ones for new values', () => {
    const { redactedText } = buildRedactedText(
      text,
      detections,
      new Set(['[ORGANIZATION_0]', '[ORGANIZATION_1]']),
      { '[ORGANIZATION_1]': 'Dupont SARL' },
    );
    expect(redactedText).toBe('[ORGANIZATION_1] doit 5 € à [ORGANIZATION_1], pas à [ORGANIZATION_2]');
  });
});
