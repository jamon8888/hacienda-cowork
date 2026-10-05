import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PackSectionContent } from './PackSection';

const mocks = vi.hoisted(() => {
  const view = (activeId: string | null, chosenId: string | null = activeId) => ({
    activeId,
    chosenId,
    packs: [
      { id: 'droit', name: 'Droit des affaires', version: '1.0.0', description: '', source: 'installed' as const, requiresSafe: true, hasSkills: true, error: null },
      { id: 'sante', name: 'Santé', version: '2.0.0', description: '', source: 'installed' as const, requiresSafe: true, hasSkills: false, error: null },
      { id: null, name: 'broken', version: null, description: '', source: 'installed' as const, requiresSafe: false, hasSkills: false, error: 'pack.json not found' },
    ],
  });
  return {
    view,
    packs: {
      list: vi.fn(async () => view('droit')),
      setActive: vi.fn(async (id: string | null) => view(id)),
      install: vi.fn(async () => ({ installed: true as const, packId: 'droit', replaced: false })),
      remove: vi.fn(async () => ({ activeId: null, chosenId: null, packs: [] })),
    },
    openFolderDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/my-pack'] })),
  };
});

vi.mock('@/ipc', () => ({ packs: mocks.packs, openFolderDialog: mocks.openFolderDialog }));

beforeEach(() => {
  Object.values(mocks.packs).forEach((fn) => fn.mockClear());
  mocks.openFolderDialog.mockClear();
});

describe('PackSectionContent', () => {
  test('lists the packs, marks the one in use and shows why a broken one cannot be used', async () => {
    render(<PackSectionContent />);
    expect(await screen.findByText(/Droit des affaires/)).toBeInTheDocument();
    expect(screen.getByText(/pack\.json not found/)).toBeInTheDocument();
    // Only the other valid pack can be switched to; the broken one offers no "use".
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^use$|^utiliser$/i })).toHaveLength(1));
  });

  test('using another pack saves the choice', async () => {
    render(<PackSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: /^use$|^utiliser$/i }));
    expect(mocks.packs.setActive).toHaveBeenCalledWith('sante');
  });

  test('installing picks a folder and installs from it without replacing', async () => {
    render(<PackSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: /install|installer/i }));
    await waitFor(() => expect(mocks.packs.install).toHaveBeenCalledWith('/tmp/my-pack', false));
  });

  test('a different installed version asks before replacing it', async () => {
    mocks.packs.install.mockResolvedValueOnce({ installed: false, error: 'x', existingVersion: '1.0.0' } as never);
    render(<PackSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: /install|installer/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1.0.0');
    await userEvent.click(screen.getByRole('button', { name: /replace|remplacer/i }));
    await waitFor(() => expect(mocks.packs.install).toHaveBeenLastCalledWith('/tmp/my-pack', true));
  });

  test('cancelling the folder dialog installs nothing', async () => {
    mocks.openFolderDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    render(<PackSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: /install|installer/i }));
    expect(mocks.packs.install).not.toHaveBeenCalled();
  });
});
