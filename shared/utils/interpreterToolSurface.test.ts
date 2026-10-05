import { describe, expect, test } from 'bun:test';
import {
  isInterpreterCliServerVisible,
  isInterpreterCliToolVisible,
  isServerHiddenInSafeWorkspace,
} from './interpreterToolSurface';

describe('interpreter tool surface', () => {
  test('hides basemind plumbing (vault, redact_text, admin) from the model', () => {
    expect(isInterpreterCliServerVisible('basemind')).toBe(false);
    for (const toolName of ['vault', 'redact_text', 'admin', 'memory', 'code']) {
      expect(isInterpreterCliToolVisible({ serverId: 'basemind', toolName })).toBe(false);
    }
  });

  test('keeps ordinary servers visible', () => {
    expect(isInterpreterCliServerVisible('builtin-interpreter')).toBe(true);
  });

  test('names the outbound-send servers hidden in a Safe workspace', () => {
    for (const id of ['builtin-nylas', 'builtin-whatsapp', 'builtin-telegram']) {
      expect(isServerHiddenInSafeWorkspace(id)).toBe(true);
    }
    // Web search is not an outbound-send channel and stays available.
    expect(isServerHiddenInSafeWorkspace('builtin-google')).toBe(false);
    expect(isServerHiddenInSafeWorkspace('builtin-docx')).toBe(false);
  });
});
