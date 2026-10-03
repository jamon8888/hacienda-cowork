import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  safeLocalBypass,
  safeSurfaces,
  type SafeLocalBypassState,
  type SafeSurfaceName,
  type SafeSurfaceState,
} from '@/ipc';
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

const SURFACES: SafeSurfaceName[] = ['voice', 'computerUse', 'browserControl', 'network'];

export function SafeSurfacesSectionContent() {
  "use no memo";

  const { t } = useTranslation();
  // null = not read yet (or unreadable): never show "on" for a state we don't know.
  const [state, setState] = useState<SafeSurfaceState | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<SafeSurfaceName | null>(null);
  const [bypass, setBypass] = useState<SafeLocalBypassState | null>(null);
  const [confirmingBypass, setConfirmingBypass] = useState(false);

  useEffect(() => {
    safeSurfaces.get()
      .then(setState)
      .catch((error) => {
        console.error('Failed to load Safe surfaces:', error);
        setFailed(true);
      });
    safeLocalBypass.get()
      .then(setBypass)
      .catch((error) => {
        console.error('Failed to load the local-model setting:', error);
        setFailed(true);
      });
  }, []);

  async function applyBypass(enabled: boolean, confirmed: boolean) {
    setFailed(false);
    try {
      setBypass(await safeLocalBypass.set(enabled, confirmed));
      // Turning it on switches surfaces off: show what they are now.
      setState(await safeSurfaces.get());
    } catch (error) {
      console.error('Failed to change the local-model setting:', error);
      setFailed(true);
    }
  }

  async function apply(surface: SafeSurfaceName, enabled: boolean, confirmed: boolean) {
    setFailed(false);
    try {
      setState(await safeSurfaces.set(surface, enabled, confirmed));
      // A surface switched back on can make the local-model setting inactive.
      setBypass(await safeLocalBypass.get());
    } catch (error) {
      console.error('Failed to change a Safe surface:', error);
      setFailed(true);
    }
  }

  function handleChange(surface: SafeSurfaceName, enabled: boolean) {
    // Turning one off narrows what leaves the machine; turning one on widens it.
    if (!enabled) {
      void apply(surface, false, false);
      return;
    }
    setConfirming(surface);
  }

  return (
    <>
      <SettingsRow
        label={t('settings.safeSurfaces.title')}
        description={t('settings.safeSurfaces.description')}
        layout="wide"
      >
        <span />
      </SettingsRow>
      {SURFACES.map((surface) => (
        <SettingsRow
          key={surface}
          label={t(`settings.safeSurfaces.${surface}`)}
          description={t(`settings.safeSurfaces.${surface}Description`)}
        >
          <Switch
            size="sm"
            checked={state?.[surface] === true}
            disabled={state === null}
            data-testid={`safe-surface-${surface}`}
            onCheckedChange={(enabled) => handleChange(surface, enabled)}
          />
        </SettingsRow>
      ))}
      <SettingsRow
        label={t('settings.safeLocalBypass.title')}
        description={
          bypass?.enabled && bypass.blockingSurfaces.length > 0
            ? `${t('settings.safeLocalBypass.description')} ${t('settings.safeLocalBypass.inactive', {
              surfaces: bypass.blockingSurfaces.map((surface) => t(`settings.safeSurfaces.${surface}`)).join(', '),
            })}`
            : t('settings.safeLocalBypass.description')
        }
      >
        <Switch
          size="sm"
          checked={bypass?.enabled === true}
          disabled={bypass === null}
          data-testid="safe-local-bypass"
          onCheckedChange={(enabled) => {
            if (enabled) setConfirmingBypass(true);
            else void applyBypass(false, false);
          }}
        />
      </SettingsRow>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('settings.safeSurfaces.changeFailed')}
        </p>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.safeSurfaces.enableTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming ? `${t(`settings.safeSurfaces.${confirming}`)} — ` : ''}
              {t('settings.safeSurfaces.enableBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="safe-surface-enable-confirm"
              onClick={() => {
                const surface = confirming;
                setConfirming(null);
                if (surface) void apply(surface, true, true);
              }}
            >
              {t('settings.safeSurfaces.enableConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmingBypass} onOpenChange={setConfirmingBypass}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.safeLocalBypass.enableTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.safeLocalBypass.enableBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="safe-local-bypass-confirm"
              onClick={() => {
                setConfirmingBypass(false);
                void applyBypass(true, true);
              }}
            >
              {t('settings.safeLocalBypass.enableConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
