import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { workspaceScan } from '@/ipc';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Switch } from '../ui/switch';
import { SettingsRow } from './SettingsSection';

export function CabinetModeSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  // null = not read yet (or unreadable): never show "on" for a state we don't know.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [auditMissed, setAuditMissed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    workspaceScan.getCabinetMode()
      .then((response) => setEnabled(response.enabled))
      .catch((error) => {
        console.error('Failed to load cabinet mode:', error);
        setFailed(true);
      });
  }, []);

  async function apply(value: boolean, confirmed: boolean) {
    setFailed(false);
    setAuditMissed(false);
    try {
      const response = await workspaceScan.setCabinetMode(value, confirmed);
      setEnabled(response.enabled);
      setAuditMissed(response.auditRecorded === false);
    } catch (error) {
      console.error('Failed to change cabinet mode:', error);
      setFailed(true);
    }
  }

  function handleChange(value: boolean) {
    if (value) {
      void apply(true, false);
      return;
    }
    setConfirmOpen(true);
  }

  return (
    <>
      <SettingsRow
        label={t('basemind.cabinet.title')}
        description={t('basemind.cabinet.description')}
      >
        <Switch
          size="sm"
          checked={enabled === true}
          disabled={enabled === null}
          onCheckedChange={handleChange}
        />
      </SettingsRow>
      {auditMissed && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('basemind.cabinet.auditNotRecorded')}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('basemind.cabinet.changeFailed')}
        </p>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('basemind.cabinet.disableTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('basemind.cabinet.disableBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cabinet-disable-confirm"
              onClick={() => { void apply(false, true); }}
            >
              {t('basemind.cabinet.disableConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
