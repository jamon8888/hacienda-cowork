import { describe, expect, test } from 'bun:test';
import { isInterpreterCliServerVisible, isInterpreterCliToolVisible } from './interpreterToolSurface';

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
});
