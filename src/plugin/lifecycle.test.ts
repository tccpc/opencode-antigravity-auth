import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initLifecycle,
  isShuttingDownNow,
  _resetForTesting,
  _handleShutdownForTesting,
} from './lifecycle.js';

vi.mock('./debug.js', () => ({
  debugLogToFile: vi.fn(),
}));

const createMockLeaseManager = (options: { releaseError?: Error } = {}) => ({
  release: options.releaseError
    ? vi.fn().mockRejectedValue(options.releaseError)
    : vi.fn().mockResolvedValue(undefined),
  hasActiveLease: vi.fn().mockReturnValue(true),
});

describe('lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  describe('initLifecycle', () => {
    it('registers signal handlers', () => {
      const processOnSpy = vi.spyOn(process, 'on');
      const mockLeaseManager = createMockLeaseManager();

      initLifecycle(mockLeaseManager as any);

      expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));

      processOnSpy.mockRestore();
    });

    it('does not re-register if already shutting down', async () => {
      const mockLeaseManager = createMockLeaseManager();
      const processOnSpy = vi.spyOn(process, 'on');

      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');

      processOnSpy.mockClear();
      initLifecycle(mockLeaseManager as any);

      expect(processOnSpy).not.toHaveBeenCalled();

      processOnSpy.mockRestore();
    });
  });

  describe('handleShutdown', () => {
    it('calls release on SIGTERM', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');

      expect(mockLeaseManager.release).toHaveBeenCalledTimes(1);
    });

    it('calls release on SIGINT', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGINT');

      expect(mockLeaseManager.release).toHaveBeenCalledTimes(1);
    });

    it('calls release on SIGHUP', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGHUP');

      expect(mockLeaseManager.release).toHaveBeenCalledTimes(1);
    });

    it('sets isShuttingDown to true', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      expect(isShuttingDownNow()).toBe(false);

      await _handleShutdownForTesting('SIGTERM');

      expect(isShuttingDownNow()).toBe(true);
    });

    it('prevents duplicate handling', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');
      await _handleShutdownForTesting('SIGTERM');
      await _handleShutdownForTesting('SIGINT');

      expect(mockLeaseManager.release).toHaveBeenCalledTimes(1);
    });

    it('clears watchdog after successful release', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');

      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it('does not throw when release fails', async () => {
      const mockLeaseManager = createMockLeaseManager({
        releaseError: new Error('Release failed'),
      });
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');
      expect(isShuttingDownNow()).toBe(true);
    });

    it('works without lease manager', async () => {
      await _handleShutdownForTesting('SIGTERM');
      expect(isShuttingDownNow()).toBe(true);
    });
  });

  describe('watchdog timeout', () => {
    it('sets watchdog timer with unref', async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      const shutdownPromise = _handleShutdownForTesting('SIGTERM');
      await shutdownPromise;

      const watchdogCall = setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 10000,
      );
      expect(watchdogCall).toBeDefined();

      setTimeoutSpy.mockRestore();
    });

    it('force exits on watchdog timeout', async () => {
      const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      
      const mockLeaseManager = {
        release: vi.fn(() => new Promise(() => {})),
        hasActiveLease: vi.fn().mockReturnValue(true),
      };
      initLifecycle(mockLeaseManager as any);

      _handleShutdownForTesting('SIGTERM');

      vi.advanceTimersByTime(10000);

      expect(processExitSpy).toHaveBeenCalledWith(1);

      processExitSpy.mockRestore();
    });
  });

  describe('isShuttingDownNow', () => {
    it('returns false initially', () => {
      expect(isShuttingDownNow()).toBe(false);
    });

    it('returns true after shutdown', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');

      expect(isShuttingDownNow()).toBe(true);
    });

    it('returns false after reset', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      await _handleShutdownForTesting('SIGTERM');
      _resetForTesting();

      expect(isShuttingDownNow()).toBe(false);
    });
  });

  describe('_resetForTesting', () => {
    it('removes signal listeners', () => {
      const processRemoveListenerSpy = vi.spyOn(process, 'removeListener');
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);

      _resetForTesting();

      expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));

      processRemoveListenerSpy.mockRestore();
    });

    it('resets isShuttingDown flag', async () => {
      const mockLeaseManager = createMockLeaseManager();
      initLifecycle(mockLeaseManager as any);
      await _handleShutdownForTesting('SIGTERM');

      expect(isShuttingDownNow()).toBe(true);

      _resetForTesting();

      expect(isShuttingDownNow()).toBe(false);
    });
  });
});
