import { getCodexClient } from '../../src/lib/codex/service';

/**
 * Owner thread for app-internal MCP calls.
 *
 * `ToolManager.callTool` refuses an MCP call without a thread context, and
 * `McpService.getToolThread` reads that thread to derive the model, provider
 * and cwd of the auxiliary tool thread it binds. Both are load-bearing: the
 * approval gate in `toolManager.ts` is the only execution path for app MCP
 * tools, and this module must not become a way around it.
 *
 * PII redaction and vault access cannot borrow the conversation's thread. They
 * run at the send boundary, before the text leaves the device, and on the first
 * message of a conversation no thread exists yet — the thread is created *by*
 * sending. Binding redaction to that lifecycle would leave the opening message,
 * often the one carrying the most context, unredacted.
 *
 * So these calls get one long-lived thread of their own, created on first use
 * and reused for the life of the process. It never runs a turn; it exists to
 * own the auxiliary MCP tool threads.
 */
let cachedThreadId: string | null = null;
let inflight: Promise<string> | null = null;

export async function getAppMcpOwnerThreadId(): Promise<string> {
  if (cachedThreadId) return cachedThreadId;
  if (inflight) return inflight;

  inflight = (async () => {
    // `startMcpToolThread` lives on the app-server client, not on the service
    // wrapper around it.
    const client = getCodexClient();
    const threadId = await client.startMcpToolThread({});
    cachedThreadId = threadId;
    return threadId;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Drop the cached thread so the next call provisions a fresh one. The app
 * server hands out thread ids that do not survive a runtime restart, and a
 * stale id fails in `threadRead` rather than reconnecting.
 */
export function resetAppMcpOwnerThread(): void {
  cachedThreadId = null;
  inflight = null;
}
