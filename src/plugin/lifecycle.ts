/**
 * Lifecycle management for graceful shutdown.
 * 
 * Handles SIGTERM/SIGINT/SIGHUP signals to release leases before exit.
 * Features:
 * - isShuttingDown flag prevents duplicate handling
 * - Watchdog timeout (10s) prevents hanging
 * - Does not call process.exit() to allow other cleanup handlers
 */

import { debugLogToFile } from './debug.js';
import type { LeaseManager } from './lease-manager.js';

const WATCHDOG_TIMEOUT_MS = 10000;

let isShuttingDown = false;
let leaseManagerRef: LeaseManager | null = null;

/**
 * Initialize lifecycle management.
 * Registers signal handlers for graceful shutdown.
 */
export function initLifecycle(leaseManager: LeaseManager): void {
  leaseManagerRef = leaseManager;
  
  // Only register once
  if (isShuttingDown) return;
  
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  process.on('SIGHUP', handleShutdown);
  
  // Also handle beforeExit for cases where signals aren't received
  process.on('beforeExit', async () => {
    if (!isShuttingDown && leaseManagerRef) {
      isShuttingDown = true;
      try {
        await leaseManagerRef.release();
      } catch {}
    }
  });
  
  debugLogToFile(`[lifecycle] Initialized signal handlers`);
}

/**
 * Handle shutdown signal.
 * Releases lease with watchdog timeout protection.
 */
async function handleShutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    debugLogToFile(`[lifecycle] Already shutting down, ignoring ${signal}`);
    return;
  }
  
  isShuttingDown = true;
  debugLogToFile(`[lifecycle] Received ${signal}, starting graceful shutdown...`);
  
  // Watchdog: force exit after 10 seconds
  const watchdog = setTimeout(() => {
    debugLogToFile(`[lifecycle] Watchdog timeout, forcing exit`);
    process.exit(1);
  }, WATCHDOG_TIMEOUT_MS);
  watchdog.unref();
  
  try {
    if (leaseManagerRef) {
      await leaseManagerRef.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLogToFile(`[lifecycle] Release error during shutdown: ${message}`);
  }
  
  // Don't call process.exit() - let Node.js exit naturally
  // This allows other cleanup handlers to run
  clearTimeout(watchdog);
  debugLogToFile(`[lifecycle] Graceful shutdown complete`);
}

/**
 * Check if shutdown is in progress.
 */
export function isShuttingDownNow(): boolean {
  return isShuttingDown;
}

/**
 * Reset state for testing purposes only.
 */
export function _resetForTesting(): void {
  isShuttingDown = false;
  leaseManagerRef = null;
  process.removeListener('SIGTERM', handleShutdown);
  process.removeListener('SIGINT', handleShutdown);
  process.removeListener('SIGHUP', handleShutdown);
}

/**
 * Export handleShutdown for testing purposes only.
 */
export const _handleShutdownForTesting = handleShutdown;
