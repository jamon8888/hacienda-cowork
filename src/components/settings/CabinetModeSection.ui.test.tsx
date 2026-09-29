import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CabinetModeSectionContent } from './CabinetModeSection';

const scanMocks = vi.hoisted(() => ({
  getCabinetMode: vi.fn(async () => ({ enabled: true })),
  setCabinetMode: vi.fn(async (value: boolean) => ({ enabled: value })),
}));

vi.mock('@/ipc', () => ({ workspaceScan: scanMocks }));

beforeEach(() => {
  scanMocks.getCabinetMode.mockClear();
  scanMocks.setCabinetMode.mockClear();
});

describe('CabinetModeSectionContent', () => {
  test('shows cabinet mode on by default', async () => {
    render(<CabinetModeSectionContent />);
    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  test('switching off asks for confirmation and does nothing on cancel', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel|annuler/i }));
    expect(scanMocks.setCabinetMode).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('confirming turns it off with confirmed=true', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await screen.findByRole('switch'));
    await userEvent.click(await screen.findByTestId('cabinet-disable-confirm'));
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(false, true));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  test('switching back on needs no dialog', async () => {
    scanMocks.getCabinetMode.mockResolvedValueOnce({ enabled: false });
    render(<CabinetModeSectionContent />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(true, false));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
