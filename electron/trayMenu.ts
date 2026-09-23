import type { MenuItemConstructorOptions } from 'electron';
import type { LocaleKey } from '../shared/locales';

export interface TrayRunningAgent {
  agentId: string;
  label: string;
  latestAction: string | null;
}

export interface InterpreterTrayMenuState {
  overlayEnabled: boolean;
  accelerator: string | null;
  runningAgents: TrayRunningAgent[];
}

function compactAgentLabel(agent: TrayRunningAgent): string {
  const base = agent.latestAction ? `${agent.label} - ${agent.latestAction}` : agent.label;
  return base.length > 84 ? `${base.slice(0, 81)}...` : base;
}

export function buildInterpreterTrayMenuTemplate(options: {
  state: InterpreterTrayMenuState;
  translate: (key: LocaleKey) => string;
  showMainWindow: () => void;
  showOverlay: () => void;
  revealAgent: (agentId: string) => void;
  stopAgent: (agentId: string) => void;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  const menuItems: MenuItemConstructorOptions[] = [
    {
      label: options.translate('tray.show'),
      click: options.showMainWindow,
    },
  ];

  if (options.state.overlayEnabled) {
    menuItems.push({
      label: options.translate('tray.showOverlay'),
      accelerator: options.state.accelerator ?? undefined,
      click: options.showOverlay,
    });
  }

  if (options.state.runningAgents.length > 0) {
    menuItems.push(
      { type: 'separator' },
      {
        label: options.translate('tray.runningAgents'),
        submenu: options.state.runningAgents.map((agent) => ({
          label: compactAgentLabel(agent),
          submenu: [
            {
              label: options.translate('tray.reveal'),
              click: () => options.revealAgent(agent.agentId),
            },
            {
              label: options.translate('tray.stop'),
              click: () => options.stopAgent(agent.agentId),
            },
          ],
        })),
      },
    );
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: options.translate('tray.quit'),
      click: options.quit,
    },
  );

  return menuItems;
}
