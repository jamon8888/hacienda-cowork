import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { VIDEO_VIEWER_ID } from '../../shared/element-ids';
import { getFileUrl } from '@/ipc';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';
import type { LocaleKey } from '../i18n';

interface VideoViewerProps {
  filePath: string;
}

export function VideoViewer({ filePath }: VideoViewerProps) {
  const { t } = useTranslation();
  const translate = useCallback((key: LocaleKey) => t(key), [t]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  useFileRefresh(filePath, () => setReloadTrigger(t => t + 1));

  useEffect(() => {
    setError(false);
    getFileUrl(filePath).then(setVideoUrl);
  }, [filePath, reloadTrigger]);

  return (
    <div className="flex flex-col h-full">
      {/* Video viewer */}
      <div
        className="voice-focus-content-surface flex-1 flex items-center justify-center bg-background p-4 overflow-auto"
        data-testid={VIDEO_VIEWER_ID}
      >
        {error ? (
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">{translate('viewers.videoError')}</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setReloadTrigger(t => t + 1)}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {translate('common.tryAgain')}
              </button>
              <button
                onClick={() => openFeedbackPopover()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {translate('viewers.videoReport')}
              </button>
            </div>
          </div>
        ) : videoUrl ? (
          <video
            src={videoUrl}
            controls
            className="max-w-full max-h-full"
            onError={() => setError(true)}
          >
            {translate('viewers.videoNoSupport')}
          </video>
        ) : (
          <div className="text-muted-foreground">{translate('common.loading')}</div>
        )}
      </div>
    </div>
  );
}
