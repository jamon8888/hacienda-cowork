import { describe, expect, test } from 'bun:test';

import { shouldBlockAttachmentSend } from './redaction';

describe('shouldBlockAttachmentSend', () => {
  test('blocks attachment payloads when NER failed', () => {
    expect(shouldBlockAttachmentSend({ hasAttachmentPayload: true, nerFailed: true })).toBe(true);
  });

  test('allows text-only sends on regex fallback', () => {
    expect(shouldBlockAttachmentSend({ hasAttachmentPayload: false, nerFailed: true })).toBe(false);
  });

  test('allows attachments when NER succeeded', () => {
    expect(shouldBlockAttachmentSend({ hasAttachmentPayload: true, nerFailed: false })).toBe(false);
  });
});
