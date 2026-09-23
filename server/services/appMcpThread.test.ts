import { afterEach, describe, expect, mock, test } from 'bun:test';

import { getAppMcpOwnerThreadId, resetAppMcpOwnerThread } from './appMcpThread';

let startCalls = 0;

mock.module('../../src/lib/codex/service', () => ({
  getCodexClient: () => ({
    startMcpToolThread: async () => {
      startCalls += 1;
      return `mcp-owner-thread-${startCalls}`;
    },
  }),
}));

afterEach(() => {
  resetAppMcpOwnerThread();
  startCalls = 0;
});

describe('getAppMcpOwnerThreadId', () => {
  test('provisions one thread and reuses it', async () => {
    const first = await getAppMcpOwnerThreadId();
    const second = await getAppMcpOwnerThreadId();

    expect(first).toBe('mcp-owner-thread-1');
    expect(second).toBe(first);
    expect(startCalls).toBe(1);
  });

  test('does not start a second thread for concurrent callers', async () => {
    // The composer redacts on every send, so two sends racing at startup must
    // not each provision their own owner thread.
    const [a, b, c] = await Promise.all([
      getAppMcpOwnerThreadId(),
      getAppMcpOwnerThreadId(),
      getAppMcpOwnerThreadId(),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(startCalls).toBe(1);
  });

  test('provisions again after a reset', async () => {
    // Thread ids do not survive an app-server restart; a stale one fails in
    // threadRead rather than reconnecting.
    const before = await getAppMcpOwnerThreadId();
    resetAppMcpOwnerThread();
    const after = await getAppMcpOwnerThreadId();

    expect(after).not.toBe(before);
    expect(startCalls).toBe(2);
  });
});
