/**
 * Fail-closed send policy: attachment payloads must never ride on the
 * regex-only fallback. Text-only turns keep the existing fallback so a
 * redaction outage degrades instead of blocking chat.
 */
export function shouldBlockAttachmentSend(options: {
  hasAttachmentPayload: boolean;
  nerFailed: boolean;
}): boolean {
  return options.hasAttachmentPayload && options.nerFailed;
}
