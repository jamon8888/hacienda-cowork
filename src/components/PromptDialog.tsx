/**
 * PromptDialog
 *
 * Modal text input resolved by `showPrompt()` from @/ipc.
 *
 * Electron does not implement `window.prompt` (it throws "prompt() is not
 * supported"), so any code needing a typed answer routes through this overlay
 * instead. Unlike BrowserSelect/BrowserContextMenu this stays mounted in
 * Electron too — there is no native replacement there.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { resolvePrompt } from '@/ipc';
import { Button } from './ui/button';

interface PromptState {
  message: string;
  defaultValue: string;
}

export function PromptDialog() {
  const { t } = useTranslation();
  const [state, setState] = useState<PromptState | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleShowPrompt = (event: Event) => {
      const detail = (event as CustomEvent<PromptState>).detail;
      setState(detail);
      setValue(detail.defaultValue);
    };

    window.addEventListener('show-prompt', handleShowPrompt);
    return () => window.removeEventListener('show-prompt', handleShowPrompt);
  }, []);

  useEffect(() => {
    if (!state) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state]);

  const dismiss = useCallback(() => {
    setState(null);
    resolvePrompt(null);
  }, []);

  const submit = useCallback(() => {
    setState(null);
    resolvePrompt(value);
  }, [value]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    },
    [dismiss, submit],
  );

  if (!state) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={state.message}
        className="w-full max-w-sm rounded-[20px] p-5"
        style={{
          background: 'color-mix(in oklch, var(--oa-bg-app) 86%, var(--oa-bg-subtle) 14%)',
          border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 82%, transparent)',
          boxShadow: '0 28px 72px rgba(0, 0, 0, 0.24)',
          backdropFilter: 'blur(24px)',
        }}
      >
        <p className="mb-3 text-[13px] leading-5 text-[var(--oa-text-muted)]">{state.message}</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          className="mb-4 h-[var(--oa-control-h-md)] w-full rounded-[var(--oa-radius-md)] border border-[var(--oa-border)] bg-[var(--oa-bg-input)] px-3 text-ui-sm text-[var(--oa-text)] outline-none focus-visible:border-[var(--oa-border-strong)] focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={dismiss}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={submit}>
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
