import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AgentModelConfig } from '../../../../shared/types/model';
import {
  AGENT_WINDOW_TOOL_NAMES,
  AGENT_WINDOW_TOOL_SERVER_ID,
  CUA_DRIVER_TOOL_SERVER_ID,
  HIDDEN_AGENT_OVERLAY_TOOL_NAMES,
  INTERPRETER_TOOL_SERVER_ID,
  INTERPRETER_OVERLAY_TOOL_SERVER_ID,
  OVERLAY_CUA_TOOL_NAMES,
  OVERLAY_INTERPRETER_TOOL_NAMES,
  OVERLAY_SELECTION_TOOL_NAMES,
  SELECTION_TOOL_SERVER_ID,
} from '../../../../shared/types/overlayToolCatalog';
import { prefixToolName } from '../../../../shared/utils/mcpToolName';
import { approvalManager } from '../../../approvalManager';
import { setConfigOverride } from '../../../configStore';
import { setCabinetAuditFileForTests } from '../../../services/cabinetAudit';
import { resources } from '../../../../shared/locales';
import { agentTabManager } from '../../../agentTabManager';
import {
  createCallHiddenAgentTool,
  overlayHiddenAgentAllowedToolNamesForTest,
  type CallHiddenAgentToolDeps,
} from './hiddenAgentTool';

const modelConfig: AgentModelConfig = {
  provider: 'hosted',
  modelId: 'interpreter-fast',
  profileId: 'interpreter',
};

describe('callHiddenAgentTool', () => {
  beforeEach(() => {
    agentTabManager.clearAll();
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
  });

  test('builds hidden-agent allowed tools from the shared overlay catalog names', () => {
    const allowedToolNames = overlayHiddenAgentAllowedToolNamesForTest();

    for (const toolName of HIDDEN_AGENT_OVERLAY_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of AGENT_WINDOW_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(AGENT_WINDOW_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_CUA_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(CUA_DRIVER_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_SELECTION_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(SELECTION_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_INTERPRETER_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(INTERPRETER_TOOL_SERVER_ID, toolName));
    }
    expect(allowedToolNames).not.toContain(prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, 'call_hidden_agent'));
  });

  test('runs a hidden agent with the overlay tool scope and returns compact metadata', async () => {
    const calls: Record<string, any[]> = {
      createSession: [],
      runSubagent: [],
      closeSession: [],
      attachToOverlaySession: [],
      releaseOverlaySession: [],
    };
    const session = {
      service: {} as any,
      profile: {} as any,
      agentId: 'hidden-agent-1',
      callerToken: 'agtok_hidden_secret',
      allowedToolNames: ['will-be-replaced'],
      modelConfig,
      dispose: () => {},
    };
    const deps: CallHiddenAgentToolDeps = {
      createSession: async (options) => {
        calls.createSession.push(options);
        return session;
      },
      runSubagent: async (options) => {
        calls.runSubagent.push(options);
        return {
          agentId: 'hidden-agent-1',
          threadId: 'thread-hidden',
          completed: true,
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'Done from the hidden agent.' }],
            },
          ],
        };
      },
      closeSession: (closedSession) => {
        calls.closeSession.push(closedSession);
      },
      getOverlaySessionSnapshot: () => ({
        id: 'overlay-session-1',
        agentId: 'overlay-agent-1',
        callerToken: 'agtok_overlay_secret',
        workspacePath: '/workspace',
        windowSessionKey: 'window-1',
        displayId: 'display-1',
        scopeBoundsDIP: null,
        createdAt: 1,
        updatedAt: 1,
        status: 'active',
        initialElementCount: 0,
        latestElementCount: 0,
        initialCaptureBoundsDIP: null,
        latestCaptureBoundsDIP: null,
        hasInitialScreenshot: false,
        hasLatestScreenshot: false,
        initialScreenshotPath: null,
        latestScreenshotPath: null,
      }),
      attachToOverlaySession: (sourceAgentId, delegatedAgentId) => {
        calls.attachToOverlaySession.push({ sourceAgentId, delegatedAgentId });
      },
      releaseOverlaySession: (delegatedAgentId) => {
        calls.releaseOverlaySession.push(delegatedAgentId);
      },
      getAgentBindingForAgentId: (agentId) => agentTabManager.getBindingForAgentId(agentId),
    };
    const tool = createCallHiddenAgentTool(deps);
    agentTabManager.bindThread({
      agentId: 'overlay-agent-1',
      callerToken: 'agtok_overlay_secret',
      threadId: 'thread-overlay-parent',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      toolProfileId: 'interpreter',
    });

    const result = await tool.handler(
      {
        message: 'Use the selected refs and summarize the fields.',
        conversation_context: 'User asked about the selected insurance form.',
        selected_context: {
          selected_context_snapshot_id: 'selected-context-1',
          target_identity_id: 'overlay-target-1',
        },
        target_refs: ['field-1', 'submit-1'],
        system: 'Be brief.',
        timeout_ms: 5000,
      },
      {
        agentId: 'overlay-agent-1',
        threadId: 'thread-overlay-context',
        modelConfig,
        workspace: '/workspace',
      },
    );
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      success: true,
      agent_id: 'hidden-agent-1',
      thread_id: 'thread-hidden',
      completed: true,
      message_count: 1,
      assistant_text: 'Done from the hidden agent.',
      error: null,
    });
    expect(calls.runSubagent[0].message).toContain('Hidden agent handoff context:');
    expect(calls.runSubagent[0].message).toContain('"conversation_context": "User asked about the selected insurance form."');
    expect(calls.runSubagent[0].message).toContain('"selected_context_snapshot_id": "selected-context-1"');
    expect(calls.runSubagent[0].message).toContain('"target_refs":');
    expect(calls.runSubagent[0].message).toContain('Task:\nUse the selected refs and summarize the fields.');
    expect(calls.runSubagent[0].message).not.toContain('agtok_hidden_secret');
    expect(calls.runSubagent[0].message).not.toContain('agtok_overlay_secret');
    expect(text).not.toContain('agtok_hidden_secret');
    expect(text).not.toContain('agtok_overlay_secret');
    expect(calls.createSession[0].parentOwner).toEqual({
      approvalOwnerKind: 'overlay-agent',
      agentId: 'overlay-agent-1',
      threadId: 'thread-overlay-context',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      toolProfileId: 'interpreter',
    });
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter-overlay__computer_batch');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-agent-windows__launch_agent_window');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-cua-driver__set_window_bounds');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter__interpreter_browser_page_inspect');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter__interpreter_browser_page_click');
    expect(calls.runSubagent[0]).toMatchObject({
      modelConfig,
      timeoutMs: 5000,
      workspace: '/workspace',
      session,
      parentOwner: calls.createSession[0].parentOwner,
    });
    expect(calls.runSubagent[0].system).toContain('You are a hidden Interpreter delegate called by the overlay controller.');
    expect(calls.runSubagent[0].system).toContain('builtin-interpreter-overlay__overlay_read_context');
    expect(calls.runSubagent[0].system).toContain('The same live overlay session is attached to you.');
    expect(calls.runSubagent[0].system).toContain('Treat element_id values as snapshot-scoped.');
    expect(calls.runSubagent[0].system).toContain('Be brief.');
    expect(calls.runSubagent[0].system).not.toContain('agtok_hidden_secret');
    expect(calls.runSubagent[0].system).not.toContain('agtok_overlay_secret');
    expect(calls.runSubagent[0].allowedToolNames).toEqual(calls.createSession[0].allowedToolNames);
    expect(approvalManager.getApprovals()).toEqual([]);
    expect(calls.attachToOverlaySession).toEqual([
      { sourceAgentId: 'overlay-agent-1', delegatedAgentId: 'hidden-agent-1' },
    ]);
    expect(calls.releaseOverlaySession).toEqual(['hidden-agent-1']);
    expect(calls.closeSession).toEqual([session]);
  });

  test('fails loudly without an overlay agent context', async () => {
    const tool = createCallHiddenAgentTool({
      createSession: async () => {
        throw new Error('should not create');
      },
      runSubagent: async () => {
        throw new Error('should not run');
      },
      closeSession: () => {},
      getOverlaySessionSnapshot: () => null,
      attachToOverlaySession: () => {},
      releaseOverlaySession: () => {},
      getAgentBindingForAgentId: () => undefined,
    });

    const result = await tool.handler({ message: 'delegate' }, { modelConfig });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('call_hidden_agent requires an overlay agent context.');
  });

  describe('outbound redaction gate', () => {
    const tempDirs: string[] = [];
    // Hermetic config: a fresh one has cabinet mode on and no custom instructions.
    beforeEach(() => setConfigOverride({} as never));
    afterEach(() => {
      setConfigOverride(null);
      while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    });

    function makeDeps(calls: { createSession: unknown[]; runSubagent: any[] }): CallHiddenAgentToolDeps {
      const session = {
        service: {} as any,
        profile: {} as any,
        agentId: 'hidden-agent-1',
        callerToken: 'agtok_hidden_secret',
        allowedToolNames: [],
        modelConfig,
        dispose: () => {},
      };
      return {
        createSession: async (options) => {
          calls.createSession.push(options);
          return session;
        },
        runSubagent: async (options) => {
          calls.runSubagent.push(options);
          return { agentId: 'hidden-agent-1', completed: true, messages: [] };
        },
        closeSession: () => {},
        getOverlaySessionSnapshot: () => null,
        attachToOverlaySession: () => {},
        releaseOverlaySession: () => {},
        getAgentBindingForAgentId: () => undefined,
      };
    }

    test('sends the gated message, system prompt and custom instructions', async () => {
      const calls = { createSession: [] as unknown[], runSubagent: [] as any[] };
      const seen: Array<{ message: string; system?: string; workspacePath?: string | null }> = [];
      const tool = createCallHiddenAgentTool({
        ...makeDeps(calls),
        redactTurnInput: async (input, options) => {
          seen.push({ message: input.message, system: input.system, workspacePath: options.workspacePath });
          return { message: 'GATED MESSAGE', system: 'GATED SYSTEM', customInstructions: 'GATED INSTRUCTIONS' };
        },
      });

      const result = await tool.handler(
        {
          message: 'Jane Doe owes 10 000 EUR',
          conversation_context: 'Jane Doe called',
          selected_context: { note: 'Acme SAS' },
        },
        { agentId: 'overlay-agent-1', threadId: 'thread-x', modelConfig, workspace: '/workspace' },
      );

      expect(result.isError).toBe(false);
      // What the gate saw is the fully built handoff, screen context included.
      expect(seen[0].message).toContain('Jane Doe called');
      expect(seen[0].message).toContain('Acme SAS');
      expect(seen[0].workspacePath).toBe('/workspace');
      expect(calls.runSubagent[0]).toMatchObject({
        message: 'GATED MESSAGE',
        system: 'GATED SYSTEM',
        customInstructions: 'GATED INSTRUCTIONS',
      });
    });

    test('gates the workspace the delegate runs in, not the binding one', async () => {
      const calls = { createSession: [] as unknown[], runSubagent: [] as any[] };
      const gated: Array<string | null | undefined> = [];
      const tool = createCallHiddenAgentTool({
        ...makeDeps(calls),
        getAgentBindingForAgentId: () => ({ agentId: 'overlay-agent-1', workspacePath: '/other' }),
        redactTurnInput: async (input, options) => {
          gated.push(options.workspacePath);
          return { message: input.message, system: input.system };
        },
      });

      await tool.handler(
        { message: 'Jane Doe owes 10 000 EUR' },
        { agentId: 'overlay-agent-1', threadId: 'thread-x', modelConfig, workspace: '/workspace' },
      );

      expect(gated).toEqual(['/workspace']);
      expect(calls.runSubagent[0].workspace).toBe('/workspace');
    });

    test('a refused send starts no session and never reaches the runtime', async () => {
      const calls = { createSession: [] as unknown[], runSubagent: [] as any[] };
      const tool = createCallHiddenAgentTool({
        ...makeDeps(calls),
        redactTurnInput: async () => {
          throw new Error('Cabinet mode: nothing was sent.');
        },
      });

      const result = await tool.handler(
        { message: 'Jane Doe owes 10 000 EUR' },
        { agentId: 'overlay-agent-1', modelConfig, workspace: '/workspace' },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe('Cabinet mode: nothing was sent.');
      expect(calls.createSession).toEqual([]);
      expect(calls.runSubagent).toEqual([]);
    });

    describe('provisional rehydration map', () => {
      const gate: NonNullable<CallHiddenAgentToolDeps['redactTurnInput']> = async (input) => ({
        message: input.message,
        system: input.system,
        customInstructions: null,
      });

      function harness(runSubagent?: CallHiddenAgentToolDeps['runSubagent']) {
        const calls = { createSession: [] as unknown[], runSubagent: [] as any[] };
        const gateOptions: Array<{ threadKey?: string | null; provisionalKey?: boolean }> = [];
        const deleted: string[] = [];
        const base = makeDeps(calls);
        const tool = createCallHiddenAgentTool({
          ...base,
          runSubagent: runSubagent ?? base.runSubagent,
          redactTurnInput: async (input, options) => {
            gateOptions.push(options);
            return gate(input, options);
          },
          deleteRuntimeRehydrationMap: (key) => {
            deleted.push(key);
          },
        });
        return { tool, gateOptions, deleted };
      }

      test('drops the provisional map after a run with no parent thread', async () => {
        const h = harness();

        await h.tool.handler(
          { message: 'Summarize.' },
          { agentId: 'overlay-agent-1', modelConfig, workspace: '/workspace' },
        );

        expect(h.gateOptions[0].provisionalKey).toBe(true);
        expect(h.deleted).toEqual([h.gateOptions[0].threadKey!]);
      });

      test('drops the provisional map when the run fails', async () => {
        const h = harness(async () => {
          throw new Error('runner exploded');
        });

        const result = await h.tool.handler(
          { message: 'Summarize.' },
          { agentId: 'overlay-agent-1', modelConfig, workspace: '/workspace' },
        );

        expect(result.isError).toBe(true);
        expect(h.deleted).toEqual([h.gateOptions[0].threadKey!]);
      });

      test('gives concurrent calls from one agent separate provisional keys', async () => {
        const h = harness();
        const context = { agentId: 'overlay-agent-1', modelConfig, workspace: '/workspace' };

        await Promise.all([
          h.tool.handler({ message: 'One.' }, context),
          h.tool.handler({ message: 'Two.' }, context),
        ]);

        expect(h.gateOptions[0].threadKey).not.toBe(h.gateOptions[1].threadKey);
      });

      test('leaves the map alone when the parent thread owns it', async () => {
        const h = harness();

        await h.tool.handler(
          { message: 'Summarize.' },
          { agentId: 'overlay-agent-1', threadId: 'thread-x', modelConfig, workspace: '/workspace' },
        );

        expect(h.gateOptions[0]).toMatchObject({ threadKey: 'thread-x', provisionalKey: false });
        expect(h.deleted).toEqual([]);
      });
    });

    test('the default gate refuses a Safe workspace when detection is unavailable', async () => {
      // Real gate, isolated machine: no NER model in any hub dir the gate
      // consults, and the block goes to a temp audit log, never the user's.
      const scratch = mkdtempSync(join(tmpdir(), 'hidden-gate-'));
      tempDirs.push(scratch);
      const workspace = join(scratch, 'ws');
      mkdirSync(join(workspace, 'safe'), { recursive: true });
      const auditFile = join(scratch, 'audit.jsonl');
      const saved = { home: process.env.HOME, hub: process.env.HF_HUB_CACHE, xdg: process.env.XDG_DATA_HOME };
      process.env.HOME = scratch;
      process.env.HF_HUB_CACHE = join(scratch, 'hub');
      process.env.XDG_DATA_HOME = join(scratch, 'data');
      setCabinetAuditFileForTests(auditFile);
      try {
        const calls = { createSession: [] as unknown[], runSubagent: [] as any[] };
        const tool = createCallHiddenAgentTool(makeDeps(calls));

        const result = await tool.handler(
          { message: 'Jane Doe owes 10 000 EUR' },
          { agentId: 'overlay-agent-1', modelConfig, workspace },
        );

        expect(result).toEqual({
          content: [{ type: 'text', text: resources.en.translation['basemind.cabinet.blockedSend'] }],
          isError: true,
        });
        expect(calls.createSession).toEqual([]);
        expect(calls.runSubagent).toEqual([]);
        const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(lines.map((line) => [line.event, line.surface])).toEqual([['send_blocked', 'outbound']]);
      } finally {
        setCabinetAuditFileForTests(null);
        for (const [key, value] of [['HOME', saved.home], ['HF_HUB_CACHE', saved.hub], ['XDG_DATA_HOME', saved.xdg]] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
