import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { getWorkspace } from '@/api';
import { useLayoutActions } from '@/hooks/useLayout';
import { basemind, packs, workspace } from '@/ipc';
import { PACKS_CHANGED_EVENT } from '@/lib/packEvents';
import {
  getSafeStatusSnapshot,
  refreshSafeStatus,
  subscribeSafeStatus,
} from '@/stores/safeStatusStore';
import {
  SAFE_BANNER_CTA_BUTTON_ID,
  SAFE_BANNER_ID,
  SAFE_BANNER_LATER_BUTTON_ID,
  SAFE_BANNER_LEARN_MORE_BUTTON_ID,
  SAFE_BANNER_PACK_NOTICE_ID,
  SAFE_BANNER_RETRY_BUTTON_ID,
  SAFE_BANNER_STATUS_ID,
} from '../../../shared/element-ids';

type SafeBannerPhase = 'hidden' | 'proposed' | 'inProgress' | 'active' | 'failed';

const STORAGE_PREFIX = 'interpreter:safe-banner:';
/** Fired by Settings → Privacy when the user asks to re-offer Safe setup. */
export const SAFE_BANNER_REPROPOSE_EVENT = 'safe-banner:repropose';

function storageKey(workspacePath: string): string {
  return `${STORAGE_PREFIX}${workspacePath}`;
}

function readStored(workspacePath: string): 'skipped' | 'safe' | null {
  try {
    const value = window.localStorage.getItem(storageKey(workspacePath));
    if (value === 'skipped' || value === 'safe') return value;
    return null;
  } catch {
    return null;
  }
}

function writeStored(workspacePath: string, value: 'skipped' | 'safe'): void {
  try {
    window.localStorage.setItem(storageKey(workspacePath), value);
  } catch {
    // Storage unavailable — treat as session-only.
  }
}

export function SafeBanner() {
  const { t } = useTranslation();
  const { openSettings } = useLayoutActions();
  const [phase, setPhase] = useState<SafeBannerPhase>('hidden');
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const status = useSyncExternalStore(subscribeSafeStatus, getSafeStatusSnapshot, getSafeStatusSnapshot);
  // The pack in force, when it needs a Safe folder to be used as intended.
  const [safePack, setSafePack] = useState<{ name: string } | null>(null);

  const applyPath = useCallback((path: string | null) => {
    setWorkspacePath(path);
    if (!path) {
      setPhase('hidden');
      return;
    }
    const stored = readStored(path);
    setPhase(stored === 'skipped' ? 'hidden' : stored === 'safe' ? 'active' : 'proposed');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { workspace: path } = await getWorkspace();
        if (!cancelled) applyPath(path);
      } catch {
        if (!cancelled) setPhase('hidden');
      }
    };

    const onRepropose = () => {
      void (async () => {
        try {
          const { workspace: path } = await getWorkspace();
          if (!path || readStored(path) === 'safe') return;
          setWorkspacePath(path);
          setPhase('proposed');
        } catch {
          // Ignore re-propose failures; next mount will retry.
        }
      })();
    };

    const unsubscribeWorkspaceChange = workspace.onChanged((event: { workspacePath: string | null }) => {
      applyPath(event.workspacePath);
    });

    void load();
    window.addEventListener(SAFE_BANNER_REPROPOSE_EVENT, onRepropose);
    return () => {
      cancelled = true;
      window.removeEventListener(SAFE_BANNER_REPROPOSE_EVENT, onRepropose);
      unsubscribeWorkspaceChange();
    };
  }, [applyPath]);

  // Which pack is in force, re-read when the user changes packs or opens a
  // folder. A read that fails leaves the banner as it was: no pack, no notice.
  useEffect(() => {
    let cancelled = false;
    const loadPack = async () => {
      try {
        const view = await packs.list();
        const active = view.packs.find((entry) => entry.id !== null && entry.id === view.activeId);
        if (!cancelled) setSafePack(active?.requiresSafe ? { name: active.name } : null);
      } catch {
        if (!cancelled) setSafePack(null);
      }
    };
    void loadPack();
    window.addEventListener(PACKS_CHANGED_EVENT, loadPack);
    const unsubscribe = workspace.onChanged(() => { void loadPack(); });
    return () => {
      cancelled = true;
      window.removeEventListener(PACKS_CHANGED_EVENT, loadPack);
      unsubscribe();
    };
  }, []);

  const runDownload = useCallback(async () => {
    if (!workspacePath) return;
    setPhase('inProgress');
    try {
      const result = await basemind.download();
      if (!result.success) {
        setPhase('failed');
        return;
      }
      writeStored(workspacePath, 'safe');
      setPhase('active');
      await refreshSafeStatus();
    } catch {
      setPhase('failed');
    }
  }, [workspacePath]);

  const handleCta = useCallback(() => {
    void runDownload();
  }, [runDownload]);

  const handleLater = useCallback(() => {
    if (workspacePath) writeStored(workspacePath, 'skipped');
    setPhase('hidden');
  }, [workspacePath]);

  const handleLearnMore = useCallback(() => {
    openSettings(undefined, 'privacy');
  }, [openSettings]);

  // A pack made for confidential files is in force and this folder is not Safe:
  // keep offering Safe, whatever "Later" the user once chose. Unknown is not
  // "not Safe" (status unread, or no such field): nothing is forced then.
  const packNotice = Boolean(
    workspacePath
    && safePack
    && status?.safeWorkspace === false
    && !status.indexing
    && !status.progress
    && phase !== 'inProgress'
    && phase !== 'failed',
  );

  if ((phase === 'hidden' && !packNotice) || !workspacePath) return null;

  // Story #19: "active" must be earned by files this workspace actually has.
  let displayPhase: SafeBannerPhase = packNotice ? 'proposed' : phase;
  if (phase === 'active' && !packNotice) {
    if (!status) return null;
    if (status.fileCount === 0) {
      displayPhase = status.indexing || status.progress ? 'inProgress' : 'proposed';
    }
  }

  return (
    <div
      data-testid={SAFE_BANNER_ID}
      className="flex items-start justify-between gap-3 px-4 py-3"
      style={{
        borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)',
        background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 46%, transparent)',
      }}
      role="region"
      aria-label={packNotice ? t('basemind.banner.packTitle', { pack: safePack?.name }) : t('basemind.banner.title')}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'color-mix(in srgb, #059669 12%, transparent)' }}
        >
          {displayPhase === 'failed' || packNotice ? (
            <ShieldAlert className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />
          ) : displayPhase === 'active' ? (
            <CheckCircle2 className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />
          ) : (
            <ShieldCheck className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {displayPhase === 'proposed' && (
            <div data-testid={packNotice ? SAFE_BANNER_PACK_NOTICE_ID : undefined}>
              <p className="text-ui-sm text-[var(--oa-text-strong)]">
                {packNotice ? t('basemind.banner.packTitle', { pack: safePack?.name }) : t('basemind.banner.title')}
              </p>
              <p className="text-ui-xs text-[var(--oa-text-faint)]">
                {packNotice ? t('basemind.banner.packMessage', { pack: safePack?.name }) : t('basemind.banner.message')}
              </p>
              <p className="text-ui-xs text-[var(--oa-text-faint)]">
                {t('basemind.banner.cost')}
              </p>
            </div>
          )}
          {displayPhase === 'inProgress' && (
            <div data-testid={SAFE_BANNER_STATUS_ID} role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin text-[var(--oa-text-faint)]" aria-hidden />
                <span className="text-ui-sm text-[var(--oa-text-strong)]">
                  {t('basemind.banner.inProgress')}
                </span>
              </div>
              {status?.progress && (
                <p className="mt-0.5 text-ui-xs text-[var(--oa-text-faint)]">
                  {t('basemind.banner.progress', {
                    done: status.progress.done,
                    total: status.progress.total,
                  })}
                </p>
              )}
            </div>
          )}
          {displayPhase === 'active' && status && (
            <div data-testid={SAFE_BANNER_STATUS_ID} role="status">
              <p className="text-ui-sm text-[var(--oa-text-strong)]">
                {t('basemind.banner.activeCount', { count: status.fileCount })}
              </p>
              {status.entities > 0 && (
                <p className="text-ui-xs text-[var(--oa-text-faint)]">
                  {t('basemind.banner.entities', { count: status.entities })}
                </p>
              )}
              {status.progress && (
                <p className="text-ui-xs text-[var(--oa-text-faint)]">
                  {t('basemind.banner.progress', {
                    done: status.progress.done,
                    total: status.progress.total,
                  })}
                </p>
              )}
            </div>
          )}
          {displayPhase === 'failed' && (
            <div data-testid={SAFE_BANNER_STATUS_ID} role="alert">
              <p className="text-ui-sm text-[var(--oa-text-strong)]">
                {t('basemind.banner.failed')}
              </p>
            </div>
          )}
        </div>
      </div>

      {displayPhase === 'proposed' && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid={SAFE_BANNER_LEARN_MORE_BUTTON_ID}
            onClick={handleLearnMore}
            className="rounded-full px-3 text-ui-sm"
          >
            {t('basemind.banner.learnMore')}
          </Button>
          {!packNotice && (
            <Button
              variant="outline"
              size="sm"
              data-testid={SAFE_BANNER_LATER_BUTTON_ID}
              onClick={handleLater}
              className="rounded-full px-3 text-ui-sm"
            >
              {t('basemind.banner.later')}
            </Button>
          )}
          <Button
            size="sm"
            data-testid={SAFE_BANNER_CTA_BUTTON_ID}
            onClick={handleCta}
            className="rounded-full px-3 text-ui-sm"
          >
            {t('basemind.banner.cta')}
          </Button>
        </div>
      )}

      {displayPhase === 'failed' && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            data-testid={SAFE_BANNER_RETRY_BUTTON_ID}
            onClick={() => void runDownload()}
            className="rounded-full px-3 text-ui-sm"
          >
            {t('basemind.banner.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
