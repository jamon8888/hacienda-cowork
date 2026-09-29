export { PII_COLORS, getPiiColor } from './colors';
export { detectRegex } from './regex-detector';
export type { PiiDetection } from './regex-detector';
export { shouldBlockAttachmentSend } from './redaction';
export {
  buildPiiLabelAttributes,
  buildRedactedText,
  findRedactedTokens,
  normalizePiiCategory,
  tokenLabelForCategory,
} from './labels';
export type { RedactedToken } from './labels';
export { noteRehydrationKey, threadVaultDocId } from './vaultScope';
export { customTermCategory, detectCustomTerms } from './custom-terms';
export type { CustomTerm } from './custom-terms';
