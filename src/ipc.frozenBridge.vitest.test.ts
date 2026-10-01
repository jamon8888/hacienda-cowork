import { afterEach, describe, expect, test, vi } from 'vitest';

// contextBridge hands the renderer frozen objects. A Proxy over a frozen
// object must return each property's exact value, so wrapping its methods
// (bind, subscription fan-out) throws unless the Proxy targets something else.
function exposeFrozenBridge() {
  const listeners: Array<(data: unknown) => void> = [];
  const unsubscribe = vi.fn();
  const projectRunner = Object.freeze({
    getStatus: vi.fn(async (projectPath: string) => ({ success: true, state: { projectPath } })),
    onChanged: vi.fn((listener: (data: unknown) => void) => {
      listeners.push(listener);
      return unsubscribe;
    }),
  });
  (window as unknown as { electron: unknown }).electron = Object.freeze({
    isPackaged: () => true,
    projectRunner,
  });
  return { projectRunner, listeners, unsubscribe };
}

describe('electron client over a frozen contextBridge object', () => {
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
    vi.resetModules();
  });

  test('calls a bridged method without tripping the Proxy invariant', async () => {
    const bridge = exposeFrozenBridge();
    const { projectRunner } = await import('./ipc');
    await expect(projectRunner.getStatus('/tmp/p')).resolves.toEqual({
      success: true,
      state: { projectPath: '/tmp/p' },
    });
    expect(bridge.projectRunner.getStatus).toHaveBeenCalledWith('/tmp/p');
  });

  test('fans one bridged subscription out to every renderer callback', async () => {
    const bridge = exposeFrozenBridge();
    const { projectRunner } = await import('./ipc');
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = projectRunner.onChanged!(first);
    const stopSecond = projectRunner.onChanged!(second);
    expect(bridge.projectRunner.onChanged).toHaveBeenCalledTimes(1);
    bridge.listeners[0]({ state: 'running' });
    expect(first).toHaveBeenCalledWith({ state: 'running' });
    expect(second).toHaveBeenCalledWith({ state: 'running' });
    stopFirst();
    expect(bridge.unsubscribe).not.toHaveBeenCalled();
    stopSecond();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
