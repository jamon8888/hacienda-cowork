/**
 * McpServerForm - Form for configuring MCP servers
 *
 * Extracted from ToolsSection for reusability.
 * Uses useMcpServerForm hook for state management.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from '../ui/field';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import type { useMcpServerForm } from '../../hooks/useMcpServerForm';
import type { LocaleKey } from '../../i18n';

export interface McpServerFormProps {
  /** Form hook instance from useMcpServerForm */
  form: ReturnType<typeof useMcpServerForm>;
  /** Whether this is a new server (vs editing existing) */
  isNew: boolean;
  /** Called when delete button is clicked */
  onDelete?: () => void;
  /** Whether delete confirmation is active */
  confirmingDelete?: boolean;
  /** Auto-focus name field for new servers */
  autoFocus?: boolean;
  /** Called when cancel button is clicked (for new servers) */
  onCancel?: () => void;
}

export function McpServerForm({
  form,
  isNew,
  onDelete,
  confirmingDelete,
  autoFocus = true,
  onCancel,
}: McpServerFormProps) {
  const { formState, isSaving, saveServer } = form;
  const [saved, setSaved] = useState(false);
  const [showStdioWarning, setShowStdioWarning] = useState(false);
  const { t } = useTranslation();
  const translate = useCallback((key: LocaleKey) => t(key), [t]);

  const handleSave = async () => {
    // Show warning dialog for stdio transport when adding new server
    if (isNew && formState.transport === 'stdio') {
      setShowStdioWarning(true);
      return;
    }
    await doSave();
  };

  const doSave = async () => {
    const success = await saveServer();
    if (success) {
      setSaved(true);
      // Brief delay to show checkmark before any navigation
      setTimeout(() => {
        setSaved(false);
      }, 300);
    }
  };

  return (
    <>
      {/* Warning dialog for local/stdio servers */}
      <AlertDialog open={showStdioWarning} onOpenChange={setShowStdioWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>{translate('tools.mcpForm.stdioTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {translate('tools.mcpForm.stdioDescription1')}
              {translate('tools.mcpForm.stdioDescription2')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{translate('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setShowStdioWarning(false);
              doSave();
            }}>
              {translate('tools.mcpForm.addServer')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FieldGroup>
      <Field>
        <FieldLabel htmlFor="mcp-server-name">{translate('tools.mcpForm.serverName')}</FieldLabel>
        <Input
          id="mcp-server-name"
          type="text"
          value={formState.name}
          onChange={(e) => form.setName(e.target.value)}
          placeholder="My Tool Server"
          autoFocus={isNew && autoFocus}
        />
      </Field>

      <FieldSet>
        <FieldLegend variant="label">{translate('tools.mcpForm.transport')}</FieldLegend>
        <div className="flex gap-1 p-1 rounded-control bg-muted">
          {(['stdio', 'http', 'sse', 'websocket'] as const).map((t) => (
            <Button
              key={t}
              type="button"
              onClick={() => form.setTransport(t)}
              variant={formState.transport === t ? 'secondary' : 'ghost'}
              className={cn(
                'flex-1 text-ui-sm',
                formState.transport === t
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              size="sm"
            >
              {t === 'stdio' ? 'Stdio' : t === 'http' ? 'HTTP' : t === 'sse' ? 'SSE' : 'WebSocket'}
            </Button>
          ))}
        </div>
      </FieldSet>

      {formState.transport === 'stdio' && (
        <>
          <Field>
            <FieldLabel htmlFor="mcp-command">{translate('tools.mcpForm.command')}</FieldLabel>
            <Input
              id="mcp-command"
              type="text"
              value={formState.command}
              onChange={(e) => form.setCommand(e.target.value)}
              placeholder="node, npx, python, etc."
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-args">{translate('tools.mcpForm.arguments')}</FieldLabel>
            <Input
              id="mcp-args"
              type="text"
              value={formState.args}
              onChange={(e) => form.setArgs(e.target.value)}
              placeholder="path/to/server.js --option value"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-env">{translate('tools.mcpForm.envVars')}</FieldLabel>
            <Textarea
              id="mcp-env"
              value={formState.env}
              onChange={(e) => form.setEnv(e.target.value)}
              placeholder={"API_KEY=your-key\nOTHER_VAR=value"}
              rows={3}
              className="font-mono resize-none"
            />
            <FieldDescription>{translate('tools.mcpForm.envHint')}</FieldDescription>
          </Field>
        </>
      )}

      {formState.transport !== 'stdio' && (
        <Field>
            <FieldLabel htmlFor="mcp-url">
              {formState.transport === 'websocket' ? translate('tools.mcpForm.wsUrl') : translate('tools.mcpForm.url')}
            </FieldLabel>
          <Input
            id="mcp-url"
            type="text"
            value={formState.url}
            onChange={(e) => form.setUrl(e.target.value)}
            placeholder={formState.transport === 'websocket' ? 'ws://localhost:3000/mcp' : 'http://localhost:3000/mcp'}
          />
        </Field>
      )}

      {(formState.transport === 'http' || formState.transport === 'sse') && (
        <Field>
            <FieldLabel htmlFor="mcp-headers">{translate('tools.mcpForm.httpHeaders')}</FieldLabel>
          <Textarea
            id="mcp-headers"
            value={formState.headers}
            onChange={(e) => form.setHeaders(e.target.value)}
            placeholder={"Authorization: Bearer <token>\nX-Custom-Header: value"}
            rows={4}
            className="font-mono resize-none"
          />
            <FieldDescription>{translate('tools.mcpForm.headersHint')}</FieldDescription>
        </Field>
      )}

      <FieldSet>
        <FieldLegend variant="label">{translate('tools.mcpForm.approval')}</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ['auto', 'tools.mcpForm.approvalAuto', 'tools.mcpForm.approvalAutoDesc'],
            ['prompt', 'tools.mcpForm.approvalPrompt', 'tools.mcpForm.approvalPromptDesc'],
            ['approve', 'tools.mcpForm.approvalApprove', 'tools.mcpForm.approvalApproveDesc'],
          ] as const).map(([mode, labelKey, descriptionKey]) => (
            <button
              key={mode}
              type="button"
              onClick={() => form.setDefaultToolsApprovalMode(mode)}
              className={cn(
                'rounded-control border px-3 py-2 text-left transition-colors',
                formState.defaultToolsApprovalMode === mode
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="block text-ui-sm font-medium">{translate(labelKey)}</span>
              <span className="mt-1 block text-ui-xs leading-5">{translate(descriptionKey)}</span>
            </button>
          ))}
        </div>
        <FieldDescription>
          {translate('tools.mcpForm.approvalNote')}
        </FieldDescription>
      </FieldSet>

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={!formState.name.trim() || isSaving || saved}
            size="sm"
          >
            {saved ? <Check className="size-4" /> : isSaving ? translate('tools.mcpForm.saving') : isNew ? translate('tools.mcpForm.add') : translate('common.save')}
          </Button>
          {onCancel && (
            <Button
              type="button"
              onClick={onCancel}
              variant="outline"
              size="sm"
              disabled={isSaving || saved}
            >
              {translate('common.cancel')}
            </Button>
          )}
        </div>

        {/* Delete button - only for existing servers */}
        {!isNew && onDelete && (
          <Button
            type="button"
            onClick={onDelete}
            variant="destructive"
            size="sm"
            disabled={isSaving || saved}
          >
            {confirmingDelete ? translate('tools.mcpForm.confirmDelete') : translate('common.delete')}
          </Button>
        )}
      </div>
    </FieldGroup>
    </>
  );
}
