import { describe, expect, test } from 'bun:test';

import { shouldBlockAttachmentSend } from './redaction';

describe('shouldBlockAttachmentSend', () => {
  test('blocks any attachment in a Safe workspace, since images are never scanned', () => {
    expect(shouldBlockAttachmentSend({ armed: true, hasAttachmentPayload: true })).toBe(true);
  });

  test('allows text-only sends in a Safe workspace (they go through redaction)', () => {
    expect(shouldBlockAttachmentSend({ armed: true, hasAttachmentPayload: false })).toBe(false);
  });

  test('allows attachments outside a Safe workspace', () => {
    expect(shouldBlockAttachmentSend({ armed: false, hasAttachmentPayload: true })).toBe(false);
  });
});
