/**
 * FeedbackStep Component
 *
 * Final onboarding step: Tell users about the feedback system.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug } from 'lucide-react';
import { getRuntimeSystemInfo } from '@/ipc';
import { flashFeedbackButton } from '../../utils/feedback';
import { Button } from '../ui/button';

interface FeedbackStepProps {
  onComplete: () => void;
  telemetryEnabled: boolean;
}

export function FeedbackStep({ onComplete, telemetryEnabled }: FeedbackStepProps) {
  const { t } = useTranslation();
  const isWindows10Unsupported = useMemo(() => {
    const { platform, osRelease } = getRuntimeSystemInfo();
    if (platform !== 'win32') return false;

    const build = Number.parseInt(osRelease.split('.')[2] ?? '', 10);
    return !Number.isNaN(build) && build < 22000;
  }, []);

  const handleClick = () => {
    onComplete();

    // Flash the feedback button after sidebars have opened and settled
    setTimeout(() => {
      flashFeedbackButton();
    }, 3000);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full px-8 py-12">
      <div className="max-w-lg w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-normal leading-[1.1] text-foreground">
            {t('onboarding.feedback.betaTitle')}
          </h1>
          <p className="text-base text-muted-foreground">
            {telemetryEnabled
              ? t('onboarding.feedback.bodyTelemetry')
              : t('onboarding.feedback.bodyNoTelemetry')}
          </p>
          <p className="text-base text-muted-foreground">
            {t('onboarding.feedback.bodyCta')}
          </p>
        </div>

        {isWindows10Unsupported && (
          <div
            className="rounded-[var(--control-radius-lg)] bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
            style={{ border: 'var(--border-width) solid oklch(from var(--destructive) l c h / 0.4)' }}
          >
            {t('onboarding.feedback.win10')}
          </div>
        )}

        {/* Mock Feedback Button - centered with shadow */}
        <div className="flex justify-center py-4">
          <div
            className="relative rounded-[var(--control-radius-lg)]"
            style={{
              boxShadow: '0 0 80px 30px oklch(from var(--foreground) l c h / 0.12)',
            }}
          >
            <Button
              variant="ghost"
              size="element"
              className="pointer-events-none"
            >
              <Bug />
              {t('onboarding.feedback.feedbackBtn')}
            </Button>
          </div>
        </div>

        {/* Description */}
        <p className="text-ui-sm text-muted-foreground text-center">
          {t('onboarding.feedback.formNote')}
        </p>

        {/* Start button */}
        <button
          onClick={handleClick}
          className="w-full py-2 rounded-control bg-foreground text-background text-ui-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t('onboarding.feedback.start')}
        </button>
      </div>
    </div>
  );
}
