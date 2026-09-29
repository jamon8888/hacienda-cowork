import { render, screen, waitFor, act } from '@testing-library/react';
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
import { Sidebar } from '../Sidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; done?: number; total?: number }) =>
      opts?.count !== undefined
        ? `${key}:${opts.count}`
        : opts?.done !== undefined
          ? `${key}:${opts.done}/${opts.total}`
          : key,
  }),
}));

const layoutMocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ workspace: '/workspace' })),
}));

const ipcMocks = vi.hoisted(() => {
  const workspaceHandlers: Array<(event: { workspacePath: string | null }) => void> = [];
  return {
    workspaceHandlers,
    workspace: {
      onChanged: vi.fn((callback: (event: { workspacePath: string | null }) => void) => {
        workspaceHandlers.push(callback);
        return () => {};
      }),
    },
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
        entities: 0,
        progress: null as { done: number; total: number } | null,
        lastScanAt: null,
        xbergAvailable: true,
        basemindAvailable: true,
        resourcesReady: { nerModel: true, embeddings: true, reranker: true },
      })),
    },
  };
});

vi.mock('@/hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
  useLayout: () => ({
    state: { leftSidebar: { activeTab: 'explorer', isOpen: true } },
    toggleLeftSidebar: vi.fn(),
  }),
}));

vi.mock('@/api', () => apiMocks);

vi.mock('@/ipc', () => ({
  basemind: ipcMocks.basemind,
  workspaceScan: ipcMocks.workspaceScan,
  workspace: ipcMocks.workspace,
}));

vi.mock('@/components/Explorer', () => ({
  Explorer: () => (
    <div data-testid="explorer-surface-stub">
      <input data-testid="explorer-search-stub" data-explorer-search="true" />
    </div>
  ),
}));

vi.mock('@/components/InboxSidebar', () => ({ InboxSidebar: () => null }));
vi.mock('@/components/HelpPanel', () => ({ HelpPanel: () => null }));
vi.mock('@/components/SkillsPanel', () => ({ SkillsPanel: () => null }));

vi.mock('@/contexts/HelpContext', () => ({
  useHelp: () => ({ isHelpPanelOpen: false }),
}));

vi.mock('@/demo/marketingDemo', () => ({
  isMarketingDemoMode: () => false,
}));

function statusFixture(overrides?: {
  fileCount?: number;
  entities?: number;
  indexing?: boolean;
  progress?: { done: number; total: number } | null;
}) {
  return {
    redactionActive: true,
    indexing: false,
    fileCount: 0,
    entities: 0,
    progress: null,
    lastScanAt: null,
    xbergAvailable: true,
    basemindAvailable: true,
    resourcesReady: { nerModel: true, embeddings: true, reranker: true },
    ...overrides,
  };
}

describe('SafeBanner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    ipcMocks.workspaceHandlers.length = 0;
    // vitest's mockReset strips the setup-file stub's implementation.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
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
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ fileCount: 12 }));
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
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ fileCount: 3 }));
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
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ indexing: true, fileCount: 7 }));
    render(<SafeBanner />);
    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:7');
    expect(screen.queryByTestId(SAFE_BANNER_CTA_BUTTON_ID)).not.toBeInTheDocument();
    expect(screen.queryByText('basemind.banner.inProgress')).not.toBeInTheDocument();
  });

  test('refreshes for the workspace the user switches to (#14)', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ fileCount: 3 }));
    render(<SafeBanner />);
    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.activeCount:3');
    const callsAfterMount = ipcMocks.workspaceScan.status.mock.calls.length;

    await act(async () => {
      for (const handler of ipcMocks.workspaceHandlers) {
        handler({ workspacePath: '/other' });
      }
    });

    // /other has no stored decision → back to the proposal, not the old folder's state.
    expect(await screen.findByText('basemind.banner.title')).toBeInTheDocument();
    expect(screen.queryByText('basemind.banner.activeCount:3')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(ipcMocks.workspaceScan.status.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
  });

  test('renders in the sidebar above the explorer search input (#15)', async () => {
    render(<Sidebar onFileOpen={vi.fn()} />);

    const banner = await screen.findByTestId(SAFE_BANNER_ID);
    const search = screen.getByTestId('explorer-search-stub');
    const position = banner.compareDocumentPosition(search);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shows the anonymised entity count (#18)', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ fileCount: 5, entities: 3 }));
    render(<SafeBanner />);

    expect(await screen.findByText('basemind.banner.entities:3')).toBeInTheDocument();
    expect(screen.getByText('basemind.banner.activeCount:5')).toBeInTheDocument();
  });

  test('never claims active when the workspace has no processed files (#19)', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue(statusFixture({ fileCount: 0 }));
    render(<SafeBanner />);

    expect(await screen.findByTestId(SAFE_BANNER_CTA_BUTTON_ID)).toBeInTheDocument();
    expect(screen.queryByText(/basemind\.banner\.activeCount/)).not.toBeInTheDocument();
  });

  test('shows population progress while files are still being processed (#17)', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue(
      statusFixture({ fileCount: 0, indexing: true, progress: { done: 2, total: 9 }, entities: 1 }),
    );
    render(<SafeBanner />);

    expect(await screen.findByTestId(SAFE_BANNER_STATUS_ID)).toHaveTextContent('basemind.banner.inProgress');
    expect(screen.getByText('basemind.banner.progress:2/9')).toBeInTheDocument();
    expect(screen.queryByText(/basemind\.banner\.activeCount/)).not.toBeInTheDocument();
  });

  test('polls the status while population is processing', async () => {
    window.localStorage.setItem('interpreter:safe-banner:/workspace', 'safe');
    ipcMocks.workspaceScan.status.mockResolvedValue(
      statusFixture({ fileCount: 0, indexing: true, progress: { done: 1, total: 5 } }),
    );
    render(<SafeBanner />);

    await screen.findByTestId(SAFE_BANNER_STATUS_ID);
    await waitFor(
      () => {
        expect(ipcMocks.workspaceScan.status.mock.calls.length).toBeGreaterThan(1);
      },
      { timeout: 3500 },
    );
  });
});
