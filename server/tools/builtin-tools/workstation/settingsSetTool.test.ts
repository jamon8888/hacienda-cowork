import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getCabinetModeEnabled, setConfigOverride } from '../../../configStore';
import { settingsSetTool } from './settingsSetTool';

const SAFE_SURFACES_READ_ONLY_TEXT =
  'The safeSurfaces setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > General > Privacy.';
const CABINET_READ_ONLY_TEXT =
  'The cabinetModeEnabled setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > General > Privacy.';

describe('settingsSetTool', () => {
  // A case that gets past the path checks reaches the config write; the
  // override keeps it off the user's real config.
  beforeEach(() => {
    setConfigOverride({ agents: {}, mcpServers: {}, cabinetModeEnabled: true } as any);
  });

  afterEach(() => {
    setConfigOverride(null);
  });

  test('does not let agents change native Computer Use access policy', async () => {
    const result = await settingsSetTool.handler({
      path: 'cuaAccessPolicy.permissions.control.mode',
      value: 'all',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'The cuaAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Permissions.',
    }]);
  });

  test('does not let agents turn cabinet mode off', async () => {
    const result = await settingsSetTool.handler({ path: 'cabinetModeEnabled', value: false });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: CABINET_READ_ONLY_TEXT }]);
  });

  test('does not let a path spelled another way turn cabinet mode off', async () => {
    // The path check only sees the literal spelling; the whole-config
    // comparison is what catches a bracketed path to the same key.
    const result = await settingsSetTool.handler({ path: "['cabinetModeEnabled']", value: false });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: CABINET_READ_ONLY_TEXT }]);
    expect(await getCabinetModeEnabled()).toBe(true);
  });

  test('does not let agents switch a Safe surface on, however the path is spelled', async () => {
    for (const path of ['safeSurfaces.voice', 'safeSurfaces', "['safeSurfaces'].voice"]) {
      const result = await settingsSetTool.handler({ path, value: path === 'safeSurfaces' ? { voice: true } : true });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: SAFE_SURFACES_READ_ONLY_TEXT }]);
    }
  });
});

