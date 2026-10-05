import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openFolderDialog, packs, type PackListEntry, type PackListView } from '@/ipc';
import { notifyPacksChanged } from '@/lib/packEvents';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsSection';

type Notice = 'installed' | 'replaceNeeded' | 'installFailed' | 'changeFailed' | null;

export function PackSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  // null = not read yet (or unreadable): never present a pack as active before we know.
  const [view, setView] = useState<PackListView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [detail, setDetail] = useState('');
  const [pendingReplace, setPendingReplace] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await packs.list());
    } catch (error) {
      console.error('Failed to load vertical packs:', error);
      setNotice('changeFailed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<PackListView>) {
    setNotice(null);
    try {
      setView(await action());
      notifyPacksChanged();
    } catch (error) {
      console.error('Failed to change the vertical pack:', error);
      setNotice('changeFailed');
    }
  }

  async function install(folder: string, allowReplace: boolean) {
    setNotice(null);
    setDetail('');
    try {
      const outcome = await packs.install(folder, allowReplace);
      if (outcome.installed) {
        setPendingReplace(null);
        setNotice('installed');
        await load();
        notifyPacksChanged();
        return;
      }
      if (outcome.existingVersion) {
        setPendingReplace(folder);
        setDetail(outcome.existingVersion);
        setNotice('replaceNeeded');
        return;
      }
      setDetail(outcome.error);
      setNotice('installFailed');
    } catch (error) {
      console.error('Failed to install the vertical pack:', error);
      setNotice('changeFailed');
    }
  }

  async function chooseFolderAndInstall() {
    const result = await openFolderDialog();
    const folder = result.canceled ? undefined : result.filePaths[0];
    if (folder) await install(folder, false);
  }

  function packLabel(entry: PackListEntry): string {
    return entry.version ? `${entry.name} · ${entry.version}` : entry.name;
  }

  return (
    <>
      <SettingsRow
        label={t('settings.packs.title')}
        description={t('settings.packs.description')}
      >
        <Button variant="outline" size="sm" onClick={() => { void chooseFolderAndInstall(); }}>
          {t('settings.packs.install')}
        </Button>
      </SettingsRow>
      {view !== null && view.packs.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('settings.packs.none')}</p>
      )}
      {view?.packs.map((entry) => (
        <SettingsRow
          key={`${entry.source}:${entry.id ?? entry.name}`}
          label={packLabel(entry)}
          description={entry.error
            ? t('settings.packs.invalid', { reason: entry.error })
            : [entry.description, entry.requiresSafe ? t('settings.packs.requiresSafe') : '']
              .filter(Boolean)
              .join(' ')}
        >
          <div className="flex items-center gap-2">
            {entry.id !== null && entry.id === view.activeId ? (
              <span className="text-sm text-muted-foreground">{t('settings.packs.active')}</span>
            ) : entry.id !== null ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void run(() => packs.setActive(entry.id)); }}
              >
                {t('settings.packs.use')}
              </Button>
            ) : null}
            {entry.source === 'installed' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void run(() => packs.remove(entry.id ?? entry.name)); }}
              >
                {t('settings.packs.remove')}
              </Button>
            )}
          </div>
        </SettingsRow>
      ))}
      {view?.chosenId != null && (
        <Button
          variant="ghost"
          className="justify-start px-0 text-sm"
          onClick={() => { void run(() => packs.setActive(null)); }}
        >
          {t('settings.packs.useDefault')}
        </Button>
      )}
      {notice === 'installed' && (
        <p role="status" className="text-sm text-muted-foreground">{t('settings.packs.installed')}</p>
      )}
      {notice === 'replaceNeeded' && pendingReplace && (
        <div role="alert" className="flex flex-col gap-2 text-sm">
          <p>{t('settings.packs.replaceBody', { version: detail })}</p>
          <div>
            <Button size="sm" onClick={() => { void install(pendingReplace, true); }}>
              {t('settings.packs.replaceConfirm')}
            </Button>
          </div>
        </div>
      )}
      {notice === 'installFailed' && (
        <p role="alert" className="text-sm text-destructive">{t('settings.packs.installFailed', { reason: detail })}</p>
      )}
      {notice === 'changeFailed' && (
        <p role="alert" className="text-sm text-destructive">{t('settings.packs.changeFailed')}</p>
      )}
    </>
  );
}
