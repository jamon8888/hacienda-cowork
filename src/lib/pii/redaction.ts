/**
 * Send policy for a Safe (armed) workspace: attachments are images, which
 * redaction cannot scan, so any attachment payload blocks the send. Text-only
 * turns go through outbound redaction instead.
 */
export function shouldBlockAttachmentSend(options: {
  armed: boolean;
  hasAttachmentPayload: boolean;
}): boolean {
  return options.armed && options.hasAttachmentPayload;
}
