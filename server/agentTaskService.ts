import { nanoid } from 'nanoid';
import { getDefaultProfile } from './configStore';
import { agentTabManager } from './agentTabManager';
import { broadcastEvent } from './handlers/broadcast';
import { runCodexSubagent } from './tools/builtin-tools/agents/codexSubagentRunnerBridge';
import {
  deleteRuntimeRehydrationMap,
  getRuntimeRehydrationMap,
  redactOutboundTurnInput,
  rekeyRuntimeRehydrationMap,
} from './services/runtimeRedaction';
import { getCodexService } from '../src/lib/codex/service';
import {
  ensureOpenAIOAuthAccountReady,
  resolveAgentInterpreterCliTransport,
  resolveCodexProfileFromModelConfig,
} from './utils/codexRuntime';
import {
  buildInterpreterCliServerConnection,
  buildInterpreterCliShellEnvironmentPolicy,
} from './utils/interpreterCliRuntime';
import { buildGroqProxyBaseUrl, routeGroqProfileThroughProxy } from './utils/groqResponsesProxy';
import { getServerPort } from './utils/serverPort';
import { IPC_CHANNELS } from '../electron/ipc/registry';
import type { AgentModelConfig } from '../shared/types/model';
import type { AgentPermissionOwnerReference } from '../shared/types/approval';
import type { StreamImageAttachment, StreamSkillReference } from '../src/lib/codex/api-types';
import { mapNotificationToUiEvents, type UiStreamEvent } from '../src/lib/codex/event-mapper';
import { getDefaultModelConfig, profileToModelConfig } from '../shared/types/profile';
import type { AgentCompletionDisposition } from './agentTabManager';
import {
  HEADLESS_TASK_WORKSPACE_ERROR,
  normalizeHeadlessTaskWorkspace,
} from './utils/headlessTaskWorkspace';

export type AgentTaskMode = 'headed' | 'headless';

export interface StartAgentTaskOptions {
  agentId?: string;
  callerToken?: string;
  message?: string;
  system?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number | null;
  mode?: AgentTaskMode;
  modelConfig?: AgentModelConfig;
  workspace?: string;
  threadId?: string;
  activate?: boolean;
  targetWindowSessionKey?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
  startupAttachments?: StreamImageAttachment[];
  skills?: StreamSkillReference[];
  completionDisposition?: AgentCompletionDisposition;
  broadcastCreateRequestToAllWindows?: boolean;
  notifyStarted?: boolean;
  onProgress?: (event: AgentTaskProgressEvent) => void;
  createHeadedTask?: typeof agentTabManager.createAgentTask;
}

export interface ResumeAgentTaskThreadOptions {
  threadId: string;
  workspace?: string;
  modelConfig?: AgentModelConfig;
}

export interface ForkAgentTaskThreadOptions extends ResumeAgentTaskThreadOptions {
  lastTurnId: string;
}

export interface AgentTaskResult {
  mode: AgentTaskMode;
  completed: boolean;
  timestamp: string;
  messageCount: number;
  messages: any[];
  error?: string;
  agentId?: string;
  requestId?: string;
  threadId?: string;
  threadPath?: string;
  hitMaxSteps?: boolean;
}

export type AgentTaskProgressEvent =
  | { kind: 'thread'; threadId: string }
  | { kind: 'turn'; threadId: string; turnId: string; status: string }
  | { kind: 'ui'; event: UiStreamEvent };

function buildMessagePreview(message: string | undefined): string {
  if (!message) {
    return '';
  }
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137)}...`;
}

function notifyProgrammaticTaskStarted(options: StartAgentTaskOptions, mode: AgentTaskMode): void {
  const timestamp = new Date().toISOString();
  broadcastEvent(IPC_CHANNELS.PROGRAMMATIC_TASK_STARTED, {
    mode,
    message: options.message,
    messagePreview: buildMessagePreview(options.message),
    timestamp,
  });
}

async function resolveAgentModelConfig(
  explicitModelConfig?: AgentModelConfig,
): Promise<AgentModelConfig> {
  if (explicitModelConfig) {
    return explicitModelConfig;
  }

  const selectedProfile = await getDefaultProfile();
  if (selectedProfile) {
    return profileToModelConfig(selectedProfile, {
      reasoningEffort: selectedProfile.reasoningEffort,
    });
  }

  return getDefaultModelConfig();
}

/** Restore a persisted OIX thread without manufacturing a model turn. */
export async function resumeAgentTaskThread(
  options: ResumeAgentTaskThreadOptions,
): Promise<{ threadId: string }> {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const profile = routeGroqProfileThroughProxy(
    resolveCodexProfileFromModelConfig(modelConfig),
    buildGroqProxyBaseUrl(getServerPort()),
  );
  const service = getCodexService();
  await ensureOpenAIOAuthAccountReady(
    service,
    modelConfig.provider === 'openai-oauth',
  );
  // A resumed thread can outlive this request through native OIX features such
  // as Goal. Provision the provider in OIX first so those later turns retain
  // environment-backed auth after the request-scoped resume overrides are gone.
  await service.ensureProvider(profile, true);
  const callerToken = `agtok_${nanoid()}`;
  const agentId = `resumed-${nanoid()}`;
  const shellEnvironmentPolicy = buildInterpreterCliShellEnvironmentPolicy(
    callerToken,
    process.env,
    process.platform,
    workspace,
    buildInterpreterCliServerConnection(getServerPort(), {
      transport: resolveAgentInterpreterCliTransport(process.platform),
    }),
  );
  agentTabManager.bindThread({
    agentId,
    callerToken,
    threadId: options.threadId,
    workspacePath: workspace,
    modelConfig,
  });
  const threadId = await service.resumeThread({
    threadId: options.threadId,
    model: modelConfig.modelId,
    modelProvider: profile.modelProvider,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    config: {
      ...(modelConfig.reasoningEffort
        ? { model_reasoning_effort: modelConfig.reasoningEffort }
        : {}),
      // A resumed thread may immediately continue an active native Goal without
      // another Workstation request. Reapply the model-facing app-tool bridge
      // here so those autonomous turns retain interpreter-app and js_repl.
      mcp_servers: {},
      shell_environment_policy: shellEnvironmentPolicy,
    },
  });

  return { threadId };
}

/** Preserve the source thread and continue its native OIX state from a completed turn. */
export async function forkAgentTaskThread(
  options: ForkAgentTaskThreadOptions,
): Promise<{ threadId: string }> {
  const workspace = normalizeHeadlessTaskWorkspace(options.workspace);
  if (!workspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const profile = routeGroqProfileThroughProxy(
    resolveCodexProfileFromModelConfig(modelConfig),
    buildGroqProxyBaseUrl(getServerPort()),
  );
  const service = getCodexService();
  await ensureOpenAIOAuthAccountReady(
    service,
    modelConfig.provider === 'openai-oauth',
  );
  await service.ensureProvider(profile, true);
  const threadId = await service.forkThread({
    threadId: options.threadId,
    lastTurnId: options.lastTurnId,
    model: modelConfig.modelId,
    modelProvider: profile.modelProvider,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    ...(modelConfig.reasoningEffort
      ? { config: { model_reasoning_effort: modelConfig.reasoningEffort } }
      : {}),
  });

  return { threadId };
}

async function startHeadedAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  const createHeadedTask = options.createHeadedTask ?? agentTabManager.createAgentTask.bind(agentTabManager);
  const result = await createHeadedTask({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.callerToken ? { callerToken: options.callerToken } : {}),
    initialMessage: options.message,
    systemPrompt: options.system,
    timeout: options.timeoutMs,
    threadId: options.threadId,
    workspacePath: options.workspace,
    modelConfig,
    activate: options.activate,
    ...(options.targetWindowSessionKey ? { targetWindowSessionKey: options.targetWindowSessionKey } : {}),
    ...(options.allowedToolNames ? { allowedToolNames: options.allowedToolNames } : {}),
    ...(options.toolProfileId ? { toolProfileId: options.toolProfileId } : {}),
    ...(options.parentOwner ? { parentOwner: options.parentOwner } : {}),
    ...(options.startupAttachments ? { startupAttachments: options.startupAttachments } : {}),
    completionDisposition: options.completionDisposition,
    ...(options.broadcastCreateRequestToAllWindows !== undefined
      ? { broadcastCreateRequestToAllWindows: options.broadcastCreateRequestToAllWindows }
      : {}),
  });

  return {
    mode: 'headed',
    agentId: result.agentId,
    requestId: result.requestId,
    threadId: result.threadId,
    completed: true,
    timestamp: new Date().toISOString(),
    messageCount: result.messages.length,
    messages: result.messages,
  };
}

/**
 * Best-effort vault write of a thread's rehydration map. Lazy import: the
 * vault pulls in ToolManager, which loads the subagent tools that import
 * this module.
 */
async function persistRehydrationForThread(threadId: string): Promise<void> {
  const map = getRuntimeRehydrationMap(threadId);
  if (Object.keys(map).length === 0) return;
  try {
    const { persistThreadRehydrationMap } = await import('./services/rehydrationPersistence');
    await persistThreadRehydrationMap(threadId, map);
  } catch {
    // Session-only reveal; persistence never fails a task.
  }
}

async function startHeadlessAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const modelConfig = await resolveAgentModelConfig(options.modelConfig);
  // #19: headless tasks and subagents start turns outside /chat/stream, so
  // they redact here under the same workspace safe/ gate. A new thread has no
  // id yet: a provisional key holds the map until the thread event re-keys it.
  const threadKey = options.threadId ?? `pending-task-${nanoid()}`;
  const outbound = await redactOutboundTurnInput(
    { message: options.message ?? '', system: options.system },
    { workspacePath: options.workspace ?? null, threadKey, provisionalKey: !options.threadId },
  );
  if (options.threadId) void persistRehydrationForThread(options.threadId);
  let result: Awaited<ReturnType<typeof runCodexSubagent>>;
  try {
    result = await runCodexSubagent({
      message: outbound.message,
      system: outbound.system,
      customInstructions: outbound.customInstructions,
      skills: options.skills,
      modelConfig,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      workspace: options.workspace,
      allowedToolNames: options.allowedToolNames,
      parentOwner: options.parentOwner,
      threadId: options.threadId,
      onEvent: (event) => {
        if (event.kind === 'thread') {
          const moved = rekeyRuntimeRehydrationMap(threadKey, event.threadId);
          if (Object.keys(moved).length > 0) void persistRehydrationForThread(event.threadId);
          options.onProgress?.({
            kind: 'thread',
            threadId: event.threadId,
          });
          return;
        }

        if (event.kind === 'turn') {
          options.onProgress?.({
            kind: 'turn',
            threadId: event.threadId,
            turnId: event.turnId,
            status: event.status,
          });
          return;
        }

        for (const uiEvent of mapNotificationToUiEvents(event.notification)) {
          options.onProgress?.({
            kind: 'ui',
            event: uiEvent,
          });
        }
      },
    });
  } finally {
    // A task that fails before its thread event would otherwise keep the
    // provisional map (original PII values) in memory for the process lifetime.
    if (threadKey !== options.threadId) deleteRuntimeRehydrationMap(threadKey);
  }

  return {
    mode: 'headless',
    agentId: result.agentId,
    threadId: result.threadId,
    completed: result.completed,
    timestamp: result.timestamp ?? new Date().toISOString(),
    messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
    messages: Array.isArray(result.messages) ? result.messages : [],
    error: result.error,
    hitMaxSteps: result.hitMaxSteps,
    threadPath: result.threadPath,
  };
}

export async function startAgentTask(
  options: StartAgentTaskOptions,
): Promise<AgentTaskResult> {
  const mode = options.mode ?? 'headless';
  const normalizedMessage = typeof options.message === 'string' ? options.message.trim() : '';
  const normalizedWorkspace = normalizeHeadlessTaskWorkspace(options.workspace);

  if (mode === 'headless' && !normalizedWorkspace) {
    throw new Error(HEADLESS_TASK_WORKSPACE_ERROR);
  }

  if (options.notifyStarted === true) {
    notifyProgrammaticTaskStarted(options, mode);
  }

  if (mode === 'headless' && !normalizedMessage) {
    throw new Error('message is required for headless tasks');
  }

  if (mode === 'headed' && !normalizedMessage && !options.threadId) {
    throw new Error('message or threadId is required for headed tasks');
  }

  if (mode === 'headed') {
    return startHeadedAgentTask({
      ...options,
      message: normalizedMessage || undefined,
      workspace: normalizedWorkspace,
    });
  }

  return startHeadlessAgentTask({
    ...options,
    message: normalizedMessage,
    workspace: normalizedWorkspace,
  });
}
