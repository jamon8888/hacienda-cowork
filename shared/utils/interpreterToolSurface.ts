import { prefixToolName } from './mcpToolName';

const DEFAULT_HIDDEN_SERVER_IDS = new Set<string>([
  'builtin-browser',
  // basemind is app plumbing (redaction, vault, index admin). The model
  // searches through `interpreter_workspace_search`; exposing the server would
  // hand it `vault` decrypt and the raw `redact_text` / `admin` tools.
  'basemind',
]);

/**
 * Servers that can send content out of the app (mail, messaging). In a Safe
 * workspace the model drafts and the lawyer sends: tokenized text would leave
 * as tokens, and these tools' own results are not the lawyer's to review.
 */
export const SAFE_HIDDEN_SERVER_IDS: ReadonlySet<string> = new Set([
  'builtin-nylas',
  'builtin-whatsapp',
  'builtin-telegram',
]);

export function isServerHiddenInSafeWorkspace(serverId: string): boolean {
  return SAFE_HIDDEN_SERVER_IDS.has(serverId);
}

export function isInterpreterCliServerVisible(serverId: string): boolean {
  return !DEFAULT_HIDDEN_SERVER_IDS.has(serverId);
}

export function isInterpreterCliToolVisible(params: {
  serverId: string;
  toolName: string;
  allowedToolNames?: Iterable<string> | null;
}): boolean {
  if (!isInterpreterCliServerVisible(params.serverId)) {
    return false;
  }

  const prefixedToolName = prefixToolName(params.serverId, params.toolName);

  if (params.allowedToolNames) {
    const allowed = params.allowedToolNames instanceof Set
      ? params.allowedToolNames
      : new Set(params.allowedToolNames);
    return allowed.has(prefixedToolName);
  }

  return true;
}
