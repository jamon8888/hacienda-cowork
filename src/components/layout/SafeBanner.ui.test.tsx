import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  SAFE_BANNER_CTA_BUTTON_ID,
  SAFE_BANNER_ID,
  SAFE_BANNER_LATER_BUTTON_ID,
  SAFE_BANNER_LEARN_MORE_BUTTON_ID,
  SAFE_BANNER_RETRY_BUTTON_ID,
  SAFE_BANNER_STATUS_ID,
} from '../../../shared/element-ids';
import { SafeBanner } from './SafeBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

const layoutMocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ workspace: '/workspace' })),
}));

const ipcMocks = vi.hoisted(() => ({
  basemind: {
    download: vi.fn(async (): Promise<{
      stages: Array<{ stage: string; success: boolean; error?: string }>;
      success: boolean;
    }> => ({
      stages: [{ stage: 'nerModel', success: true }, { stage: 'reranker', success: true }, { stage: 'embeddings', success: true }],
      success: true,
    })),
  },
  workspaceScan: {
    status: vi.fn(async () => ({
      redactionActive: true,
      indexing: false,
      fileCount: 0,
      lastScanAt: null,
      xbergAvailable: true,
      basemindAvailable: true,
      resourcesReady: { nerModel: true, embeddings: true, reranker: true },
    })),
  },
}));

vi.mock('@/hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
}));

vi.mock('@/api', () => apiMocks);

vi.mock('@/ipc', () => ({
  basemind: ipcMocks.basemind,
  workspaceScan: ipcMocks.workspaceScan,
}));

describe('SafeBanner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  test('shows proposed state with cost copy and actions', async () => {
    render(<SafeBanner />);

    expect(await screen.findByTestId(SAFE_BANNER_ID)).toBeInTheDocument();
    expect(screen.getByText('basemind.banner.title')).toBeInTheDocument();
    expect(screen.getByText('basemind.banner.cost')).toBeInTheDocument();
    expect(screen.getByTestId(SAFE_BANNER_CTA_BUTTON_ID)).toBeInTheDocument();
    expect(screen.getByTestId(SAFE_BANNER_LATER_BUTTON_ID)).toBeInTheDocument();
    expect(screen.getByTestId(SAFE_BANNER_LEARN_MORE_BUTTON_ID)).toBeInTheDocument();
    expect(ipcMocks.basemind.download).not.toHaveBeenCalled();
  });

  test('Later skips per workspace and hides the banner', async () => {
    const user = userEvent.setup();
    render(<SafeBanner />);

    await screen.findByTestId(SAFE_BANNER_ID);
    await user.click(screen.getByTestId(SAFE_BANNER_LATER_BUTTON_ID));

    expect(screen.queryByTestId(SAFE_BANNER_ID)).not.toBeInTheDocument();
    expect(window.localStorage.getItem('interpreter:safe-banner:/workspace')).toBe('skipped');
    expect(ipcMocks.basemind.download).not.toHaveBeenCalled();
  });

  test('does not propose when workspace was previously skipped', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'skipped');
    render(<SafeBanner />);
    await waitFor(() => {
      expect(screen.queryByTestId(SAFE_BANNER_ID)).not.toBeInTheDocument();
    });
  });

  test('CTA runs download then shows active count', async () => {
    ipcMocks.workspaceScan.status.mockResolvedValue({
      redactionActive: true,
      indexing: false,
      fileCount: 12,
      lastScanAt: null,
      xbergAvailable: true,
      basemindAvailable: true,
      resourcesReady: { nerModel: true, embeddings: true, reranker: true },
    });
    const user = userEvent.setup();
    render(<SafeBanner />);

    await screen.findByTestId(SAFE_BANNER_ID);
    await user.click(screen.getByTestId(SAFE_BANNER_CTA_BUTTON_ID));

    await waitFor(() => {
      expect(ipcMocks.basemind.download).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:12');
    expect(screen.queryByTestId(SAFE_BANNER_CTA_BUTTON_ID)).not.toBeInTheDocument();
  });

  test('failed download shows failure with retry', async () => {
    ipcMocks.basemind.download.mockResolvedValueOnce({
      stages: [{ stage: 'nerModel', success: false, error: 'boom' }],
      success: false,
    });
    const user = userEvent.setup();
    render(<SafeBanner />);

    await screen.findByTestId(SAFE_BANNER_ID);
    await user.click(screen.getByTestId(SAFE_BANNER_CTA_BUTTON_ID));

    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.failed');
    expect(screen.getByTestId(SAFE_BANNER_RETRY_BUTTON_ID)).toBeInTheDocument();
    // Never surface raw error.message
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  test('learn more opens privacy settings', async () => {
    const user = userEvent.setup();
    render(<SafeBanner />);

    await screen.findByTestId(SAFE_BANNER_ID);
    await user.click(screen.getByTestId(SAFE_BANNER_LEARN_MORE_BUTTON_ID));

    expect(layoutMocks.openSettings).toHaveBeenCalledWith(undefined, 'privacy');
  });

  test('after success, remount stays active without re-proposing', async () => {
    ipcMocks.workspaceScan.status.mockResolvedValue({
      redactionActive: true,
      indexing: false,
      fileCount: 3,
      lastScanAt: null,
      xbergAvailable: true,
      basemindAvailable: true,
      resourcesReady: { nerModel: true, embeddings: true, reranker: true },
    });
    const user = userEvent.setup();
    const first = render(<SafeBanner />);
    await screen.findByTestId(SAFE_BANNER_ID);
    await user.click(screen.getByTestId(SAFE_BANNER_CTA_BUTTON_ID));
    await waitFor(() => {
      expect(screen.getByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:3');
    });
    expect(window.localStorage.getItem('interpreter:safe-banner:/workspace')).toBe('safe');
    first.unmount();

    render(<SafeBanner />);
    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:3');
    expect(screen.queryByTestId(SAFE_BANNER_CTA_BUTTON_ID)).not.toBeInTheDocument();
    expect(ipcMocks.basemind.download).toHaveBeenCalledTimes(1);
  });

  test('settings repropose clears skip and shows proposed again', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'skipped');
    render(<SafeBanner />);
    await waitFor(() => {
      expect(screen.queryByTestId(SAFE_BANNER_ID)).not.toBeInTheDocument();
    });

    window.localStorage.removeItem('interpreter:safe-banner:/workspace');
    window.dispatchEvent(new Event('safe-banner:repropose'));

    expect(await screen.findByTestId(SAFE_BANNER_ID)).toBeInTheDocument();
    expect(screen.getByText('basemind.banner.title')).toBeInTheDocument();
  });

  test('indexing status does not stick or downgrade active phase', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue({
      redactionActive: true,
      indexing: true,
      fileCount: 7,
      lastScanAt: null,
      xbergAvailable: true,
      basemindAvailable: true,
      resourcesReady: { nerModel: true, embeddings: true, reranker: true },
    });
    render(<SafeBanner />);
    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:7');
    expect(screen.queryByTestId(SAFE_BANNER_CTA_BUTTON_ID)).not.toBeInTheDocument();
    expect(screen.queryByText('basemind.banner.inProgress')).not.toBeInTheDocument();
  });
});
