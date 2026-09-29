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
  const [enabled, setEnabled] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    workspaceScan.getCabinetMode()
      .then((response) => setEnabled(response.enabled))
      .catch((error) => console.error('Failed to load cabinet mode:', error));
  }, []);

  async function apply(value: boolean, confirmed: boolean) {
    try {
      const response = await workspaceScan.setCabinetMode(value, confirmed);
      setEnabled(response.enabled);
    } catch (error) {
      console.error('Failed to change cabinet mode:', error);
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
        <Switch size="sm" checked={enabled} onCheckedChange={handleChange} />
      </SettingsRow>
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
