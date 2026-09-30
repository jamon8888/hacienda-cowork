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

// The switch stays disabled until the real state has been read.
async function findLoadedSwitch(): Promise<HTMLElement> {
  const toggle = await screen.findByRole('switch');
  await waitFor(() => expect(toggle).toBeEnabled());
  return toggle;
}

describe('CabinetModeSectionContent', () => {
  test('shows cabinet mode on by default', async () => {
    render(<CabinetModeSectionContent />);
    const toggle = await findLoadedSwitch();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  test('switching off asks for confirmation and does nothing on cancel', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await findLoadedSwitch());
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel|annuler/i }));
    expect(scanMocks.setCabinetMode).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('confirming turns it off with confirmed=true', async () => {
    render(<CabinetModeSectionContent />);
    await userEvent.click(await findLoadedSwitch());
    await userEvent.click(await screen.findByTestId('cabinet-disable-confirm'));
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(false, true));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  test('switching back on needs no dialog', async () => {
    scanMocks.getCabinetMode.mockResolvedValueOnce({ enabled: false });
    render(<CabinetModeSectionContent />);
    const toggle = await findLoadedSwitch();
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    await waitFor(() => expect(scanMocks.setCabinetMode).toHaveBeenCalledWith(true, false));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('shows an error and locks the switch when the state cannot be loaded', async () => {
    scanMocks.getCabinetMode.mockRejectedValueOnce(new Error('ipc down'));
    render(<CabinetModeSectionContent />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // Never show "on" for a state we could not read.
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  test('says so when re-enabling could not be recorded in the audit log', async () => {
    scanMocks.getCabinetMode.mockResolvedValueOnce({ enabled: false });
    scanMocks.setCabinetMode.mockResolvedValueOnce({ enabled: true, auditRecorded: false } as never);
    render(<CabinetModeSectionContent />);
    const toggle = await findLoadedSwitch();
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    expect(await screen.findByRole('status')).toHaveTextContent(/audit/i);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('surfaces a failed change and keeps the switch where it was', async () => {
    scanMocks.setCabinetMode.mockRejectedValueOnce(new Error('disk full'));
    render(<CabinetModeSectionContent />);
    await userEvent.click(await findLoadedSwitch());
    await userEvent.click(await screen.findByTestId('cabinet-disable-confirm'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
