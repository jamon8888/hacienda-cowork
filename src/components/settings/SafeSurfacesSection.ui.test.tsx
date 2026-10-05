import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SafeSurfacesSectionContent } from './SafeSurfacesSection';

const mocks = vi.hoisted(() => ({
  safeSurfaces: {
    get: vi.fn(async () => ({ voice: false, computerUse: true, browserControl: true, network: true })),
    set: vi.fn(async (surface: string, enabled: boolean) => ({
      voice: false, computerUse: true, browserControl: true, network: true, [surface]: enabled,
    })),
  },
  // The local-model row loads its own state next to the surfaces.
  safeLocalBypass: {
    get: vi.fn(async () => ({ enabled: false, blockingSurfaces: [] })),
    set: vi.fn(async (enabled: boolean) => ({ enabled, blockingSurfaces: [] })),
  },
}));

vi.mock('@/ipc', () => ({ safeSurfaces: mocks.safeSurfaces, safeLocalBypass: mocks.safeLocalBypass }));

beforeEach(() => {
  mocks.safeSurfaces.get.mockClear();
  mocks.safeSurfaces.set.mockClear();
  mocks.safeLocalBypass.get.mockClear();
  mocks.safeLocalBypass.set.mockClear();
});

async function loadedSwitch(surface: string): Promise<HTMLElement> {
  const toggle = await screen.findByTestId(`safe-surface-${surface}`);
  await waitFor(() => expect(toggle).toBeEnabled());
  return toggle;
}

describe('SafeSurfacesSectionContent', () => {
  test('shows voice off and the other surfaces on by default', async () => {
    render(<SafeSurfacesSectionContent />);
    expect(await loadedSwitch('voice')).toHaveAttribute('aria-checked', 'false');
    for (const surface of ['computerUse', 'browserControl', 'network']) {
      expect(await loadedSwitch(surface)).toHaveAttribute('aria-checked', 'true');
    }
  });

  test('turning a surface off applies at once, without a confirmation', async () => {
    render(<SafeSurfacesSectionContent />);
    await userEvent.click(await loadedSwitch('network'));
    expect(mocks.safeSurfaces.set).toHaveBeenCalledWith('network', false, false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('turning one on asks first, and does nothing on cancel', async () => {
    render(<SafeSurfacesSectionContent />);
    await userEvent.click(await loadedSwitch('voice'));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel|annuler/i }));
    expect(mocks.safeSurfaces.set).not.toHaveBeenCalled();
    expect(screen.getByTestId('safe-surface-voice')).toHaveAttribute('aria-checked', 'false');
  });

  test('confirming turns it on with the confirmation flag', async () => {
    render(<SafeSurfacesSectionContent />);
    await userEvent.click(await loadedSwitch('voice'));
    await userEvent.click(await screen.findByTestId('safe-surface-enable-confirm'));
    await waitFor(() => expect(mocks.safeSurfaces.set).toHaveBeenCalledWith('voice', true, true));
    await waitFor(() => expect(screen.getByTestId('safe-surface-voice')).toHaveAttribute('aria-checked', 'true'));
  });

  test('a failed change shows an error and keeps the old state', async () => {
    mocks.safeSurfaces.set.mockRejectedValueOnce(new Error('audit log unavailable'));
    render(<SafeSurfacesSectionContent />);
    await userEvent.click(await loadedSwitch('network'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('safe-surface-network')).toHaveAttribute('aria-checked', 'true');
  });
});
