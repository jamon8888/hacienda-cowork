import { prefixToolName } from './mcpToolName';

const DEFAULT_HIDDEN_SERVER_IDS = new Set<string>([
  'builtin-browser',
  // basemind is app plumbing (redaction, vault, index admin). The model
  // searches through `interpreter_workspace_search`; exposing the server would
  // hand it `vault` decrypt and the raw `redact_text` / `admin` tools.
  'basemind',
]);

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
