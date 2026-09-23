import { TipTapViewer } from './TipTapViewer';
import { useTranslation } from 'react-i18next';
import { markdownToTiptap } from '../utils/markdown-parser';
import { Button } from './ui/button';

export interface DiffGroup {
  index: number;
  oldContent: string;
  newContent: string;
  lineNumber: number;
  oldLines: number;
  newLines: number;
}

interface MarkdownDiffGroupProps {
  group: DiffGroup;
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
}

/**
 * Component for displaying a single diff group with accept/reject buttons
 * Shows old content (red) and new content (green) with proper markdown rendering
 */
export function MarkdownDiffGroup({
  group,
  onAccept,
  onReject
}: MarkdownDiffGroupProps) {
  // Calculate metadata text
  const { t } = useTranslation();
  const getMetadata = () => {
    if (group.oldContent && group.newContent) {
      const diff = group.newLines - group.oldLines;
      if (diff > 0) {
        return t('mdiff.metaModAdd', { a: group.oldLines, b: diff });
      } else if (diff < 0) {
        return t('mdiff.metaModRemove', { a: group.newLines, b: Math.abs(diff) });
      } else {
        return t('mdiff.metaMod', { a: group.oldLines });
      }
    } else if (group.oldContent) {
      return t('mdiff.metaRemove', { a: group.oldLines });
    } else {
      return t('mdiff.metaAdd', { a: group.newLines });
    }
  };

  return (
    <div className="border-y border-border" style={{ borderWidth: 'var(--border-width)' }}>
      {/* Old content - Red background */}
      {group.oldContent && (
        <div className="bg-red-500/10 px-4 py-2 diff-content">
          <TipTapViewer
            content={markdownToTiptap(group.oldContent.trimEnd())}
          />
        </div>
      )}

      {/* New content - Green background */}
      {group.newContent && (
        <div className="bg-green-500/10 px-4 py-2 diff-content">
          <TipTapViewer
            content={markdownToTiptap(group.newContent.trimEnd())}
          />
        </div>
      )}

      {/* Gray action strip */}
      <div className="bg-muted px-4 py-2 flex justify-between items-center border-t border-border" style={{ borderTopWidth: 'var(--border-width)' }}>
        <div className="text-ui-sm text-muted-foreground">
          {getMetadata()}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => onReject(group.index)}
            variant="outline"
            size="xs"
          >
            {t('mdiff.reject')}
          </Button>
          <Button
            onClick={() => onAccept(group.index)}
            variant="default"
            size="xs"
          >
            {t('mdiff.accept')}
          </Button>
        </div>
      </div>
    </div>
  );
}
