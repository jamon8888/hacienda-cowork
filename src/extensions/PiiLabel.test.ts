import { describe, expect, test } from 'bun:test';

import { piiSpansForText } from './PiiLabel';

describe('piiSpansForText', () => {
  test('view mode returns only stored tokens', () => {
    const spans = piiSpansForText('Mail [EMAIL_0] at john@example.com', 'view');
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe('[EMAIL_0]');
    expect(spans[0].category).toBe('email');
  });

  test('compose mode merges existing tokens with new regex PII', () => {
    const spans = piiSpansForText('[EMAIL_0] and jane@example.com', 'compose');
    expect(spans.map((span) => span.token)).toEqual(['[EMAIL_0]', 'jane@example.com']);
    expect(spans.map((span) => span.from)).toEqual([0, '[EMAIL_0] and '.length]);
  });

  test('compose mode drops regex spans that overlap a token', () => {
    // Token text should never be re-labelled as cleartext PII.
    const spans = piiSpansForText('[EMAIL_0]', 'compose');
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe('[EMAIL_0]');
  });
});
