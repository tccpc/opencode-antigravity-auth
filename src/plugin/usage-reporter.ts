import { debugLogToFile } from './debug.js';

export interface UsageReport {
  accountEmail: string;
  model: string;
  family: string;
  tokens: {
    total: number;
    input: number;
    output: number;
    cached: number;
  };
  success: boolean;
  latencyMs: number;
}

let apiEndpoint: string | undefined;
let apiKey: string | undefined;

/**
 * Initialize the usage reporter with remote service config.
 */
export function initUsageReporter(endpoint: string, key: string): void {
  apiEndpoint = endpoint;
  apiKey = key;
  debugLogToFile(`[usage-reporter] Initialized: ${JSON.stringify({ endpoint })}`);
}

/**
 * Report usage to remote service asynchronously.
 * This function returns immediately and does not block.
 * Failures are logged but do not throw.
 */
export function reportUsage(report: UsageReport): void {
  if (!apiEndpoint || !apiKey) {
    return; // Remote mode not configured
  }

  // Fire and forget - do not await
  fetch(`${apiEndpoint}/api/usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'User-Agent': 'opencode-antigravity-auth',
    },
    body: JSON.stringify(report),
  })
    .then((res) => {
      if (!res.ok) {
        debugLogToFile(`[usage-reporter] Report failed: ${res.status} ${JSON.stringify(report)}`);
      } else {
        debugLogToFile(`[usage-reporter] Report sent: ${JSON.stringify(report)}`);
      }
    })
    .catch((err) => {
      debugLogToFile(`[usage-reporter] Report error: ${err.message} ${JSON.stringify(report)}`);
    });
}
