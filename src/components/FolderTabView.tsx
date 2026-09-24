import { Explorer } from './Explorer';
import { useTranslation } from 'react-i18next';
import { useLayoutActions } from '../hooks/useLayout';

export function FolderTabView({ rootPath }: { rootPath: string }) {
  const { t } = useTranslation();
  const { openFile } = useLayoutActions();
  const canListFolder = typeof window !== 'undefined' && Boolean(window.electron?.files?.listDirectory);

  if (!canListFolder) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-ui-sm text-[#6b7280] dark:text-[#b4b4b4]">
        {t('folder.onlyDesktop')}
      </div>
    );
  }

  return (
    <Explorer
      onFileOpen={openFile}
      rootPath={rootPath}
      hideSearchBar
    />
  );
}
