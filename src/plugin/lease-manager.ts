import { debugLogToFile } from './debug.js';
import { decryptData } from './crypto.js';

const FETCH_TIMEOUT_MS = 10000;
const DEFAULT_HEARTBEAT_RATIO = 0.5; // 50% of TTL
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const DEFAULT_QUOTA_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 5 minutes
const DEFAULT_LOW_QUOTA_THRESHOLD = 0.2; // 80%
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 10 * 1000; // 10 seconds - switch faster

export interface LeaseManagerConfig {
  apiEndpoint: string;
  apiKey: string;
  idleTimeoutMs?: number;
  quotaCheckIntervalMs?: number;
  lowQuotaThreshold?: number;
  maxRateLimitWaitMs?: number;
}

/**
 * Account information from a lease
 */
export interface LeaseAccount {
  email: string;
  refreshToken: string;
  projectId?: string;
}

/**
 * State representing an active lease
 */
export interface LeaseState {
  leaseId: number;
  account: LeaseAccount;
  expiresAt: Date;
}

/**
 * Decision returned by handleRateLimit
 */
export interface RateLimitDecision {
  action: 'wait' | 'switch';
  waitMs?: number;
  newAccount?: LeaseAccount;
}

/**
 * Response from acquire/report-issue endpoints (account is encrypted)
 */
interface LeaseAcquireResponse {
  lease_id: number;
  account: string;
  expires_at: string;
  ttl_seconds: number;
}

/**
 * Decrypted account data structure
 */
interface DecryptedAccountData {
  account: {
    email: string;
    refresh_token: string;
    project_id?: string;
  };
}

/**
 * Response from renew endpoint
 */
interface LeaseRenewResponse {
  expires_at: string;
  ttl_seconds: number;
}

/**
 * Response from release endpoint
 */
interface LeaseReleaseResponse {
  success: boolean;
}

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  // Use crypto if available, otherwise fallback to Math.random
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback UUID generation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * LeaseManager handles the lifecycle of account leases from the remote service.
 * 
 * Features:
 * - Acquire leases with automatic heartbeat renewal
 * - Release leases with fire-and-forget pattern
 * - Report issues and get a new account
 * - Graceful error handling without blocking main flow
 */
export class LeaseManager {
  private clientId: string;
  private apiEndpoint: string;
  private apiKey: string;
  private lease: LeaseState | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastActivity: number = Date.now();
  private idleTimeoutMs: number;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private quotaCheckIntervalMs: number;
  private lowQuotaThreshold: number;
  private lastQuotaCheck: number = 0;
  private maxRateLimitWaitMs: number;
  private onReleaseCallback: (() => void) | null = null;

  constructor(config: LeaseManagerConfig) {
    this.clientId = generateUUID();
    this.apiEndpoint = config.apiEndpoint;
    this.apiKey = config.apiKey;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.quotaCheckIntervalMs = config.quotaCheckIntervalMs ?? DEFAULT_QUOTA_CHECK_INTERVAL_MS;
    this.lowQuotaThreshold = config.lowQuotaThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD;
    this.maxRateLimitWaitMs = config.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    debugLogToFile(`[lease-manager] Initialized with clientId=${this.clientId}`);
  }

  onRelease(callback: () => void): void {
    this.onReleaseCallback = callback;
  }

  /**
   * Acquire a lease from the remote service.
   * Starts heartbeat timer on success.
   * 
   * @throws Error if acquire fails
   */
  async acquire(): Promise<LeaseState> {
    debugLogToFile(`[lease-manager] Acquiring lease...`);

    try {
      const response = await fetchWithTimeout(
        `${this.apiEndpoint}/api/lease/acquire`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'User-Agent': 'opencode-antigravity-auth',
          },
          body: JSON.stringify({ client_id: this.clientId }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Acquire failed: ${response.status} ${response.statusText} ${errorText}`);
      }

      const data = (await response.json()) as LeaseAcquireResponse;

      const decrypted = decryptData<DecryptedAccountData>(data.account, this.apiKey);

      this.lease = {
        leaseId: data.lease_id,
        account: {
          email: decrypted.account.email,
          refreshToken: decrypted.account.refresh_token,
          projectId: decrypted.account.project_id,
        },
        expiresAt: new Date(data.expires_at),
      };

      // Start heartbeat based on TTL
      this.startHeartbeat(data.ttl_seconds);

      this.updateActivity();
      this.startIdleCheck();

      debugLogToFile(`[lease-manager] Acquired lease ${data.lease_id} for ${decrypted.account.email}, expires at ${this.lease.expiresAt.toISOString()}`);

      return this.lease;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogToFile(`[lease-manager] Acquire error: ${message}`);
      throw new Error(`Failed to acquire lease: ${message}`);
    }
  }

  /**
   * Release the current lease using fire-and-forget pattern.
   * Does not block or throw on failure.
   */
  async release(): Promise<void> {
    // Stop heartbeat first
    this.stopHeartbeat();
    this.stopIdleCheck();

    if (!this.lease) {
      debugLogToFile(`[lease-manager] Release called but no active lease`);
      return;
    }

    const leaseId = this.lease.leaseId;
    this.lease = null;

    debugLogToFile(`[lease-manager] Releasing lease ${leaseId}...`);

    try {
      const response = await fetch(`${this.apiEndpoint}/api/lease/release`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'User-Agent': 'opencode-antigravity-auth',
        },
        body: JSON.stringify({
          lease_id: leaseId,
          client_id: this.clientId,
        }),
      });

      if (!response.ok) {
        debugLogToFile(`[lease-manager] Release failed: ${response.status}`);
      } else {
        debugLogToFile(`[lease-manager] Released lease ${leaseId}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLogToFile(`[lease-manager] Release error: ${message}`);
    }

    if (this.onReleaseCallback) {
      this.onReleaseCallback();
    }
  }

  /**
   * Renew the current lease.
   * Updates expiresAt on success.
   * 
   * @throws Error if renew fails or no active lease
   */
  async renew(): Promise<void> {
    if (!this.lease) {
      throw new Error('No active lease to renew');
    }

    debugLogToFile(`[lease-manager] Renewing lease ${this.lease.leaseId}...`);

    try {
      const response = await fetchWithTimeout(
        `${this.apiEndpoint}/api/lease/renew`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'User-Agent': 'opencode-antigravity-auth',
          },
          body: JSON.stringify({
            lease_id: this.lease.leaseId,
            client_id: this.clientId,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Renew failed: ${response.status} ${response.statusText} ${errorText}`);
      }

      const data = (await response.json()) as LeaseRenewResponse;

      this.lease.expiresAt = new Date(data.expires_at);

      // Restart heartbeat with new TTL
      this.stopHeartbeat();
      this.startHeartbeat(data.ttl_seconds);

      debugLogToFile(`[lease-manager] Renewed lease, new expiry: ${this.lease.expiresAt.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogToFile(`[lease-manager] Renew error: ${message}`);
      throw new Error(`Failed to renew lease: ${message}`);
    }
  }

  /**
   * Report an issue with the current account and get a new one.
   * 
   * @param reason - Description of the issue
   * @param resetTime - Optional quota reset time (ISO string)
   * @returns New lease state with different account
   * @throws Error if report fails or no active lease
   */
  async reportIssue(reason: string, resetTime?: string): Promise<LeaseState> {
    if (!this.lease) {
      throw new Error('No active lease to report issue for');
    }

    debugLogToFile(`[lease-manager] Reporting issue for lease ${this.lease.leaseId}: ${reason}`);

    try {
      const response = await fetchWithTimeout(
        `${this.apiEndpoint}/api/lease/report-issue`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'User-Agent': 'opencode-antigravity-auth',
          },
          body: JSON.stringify({
            lease_id: this.lease.leaseId,
            client_id: this.clientId,
            issue_type: reason,
            ...(resetTime && { reset_time: resetTime }),
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Report issue failed: ${response.status} ${response.statusText} ${errorText}`);
      }

      const rawData = (await response.json()) as { new_lease?: LeaseAcquireResponse } | LeaseAcquireResponse;
      const data = 'new_lease' in rawData && rawData.new_lease ? rawData.new_lease : rawData as LeaseAcquireResponse;

      if (!data.lease_id || !data.account) {
        throw new Error('No new account available after reporting issue');
      }

      // Stop old heartbeat
      this.stopHeartbeat();

      const decrypted = decryptData<DecryptedAccountData>(data.account, this.apiKey);

      this.lease = {
        leaseId: data.lease_id,
        account: {
          email: decrypted.account.email,
          refreshToken: decrypted.account.refresh_token,
          projectId: decrypted.account.project_id,
        },
        expiresAt: new Date(data.expires_at),
      };

      // Start new heartbeat
      this.startHeartbeat(data.ttl_seconds);

      this.updateActivity();
      this.startIdleCheck();

      debugLogToFile(`[lease-manager] Got new lease ${data.lease_id} for ${decrypted.account.email}`);

      return this.lease;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLogToFile(`[lease-manager] Report issue error: ${message}`);
      throw new Error(`Failed to report issue: ${message}`);
    }
  }

  /**
   * Get the current leased account.
   * 
   * @returns Account info or null if no active lease
   */
  getAccount(): LeaseAccount | null {
    return this.lease?.account ?? null;
  }

  /**
   * Get the current lease state.
   * 
   * @returns Lease state or null if no active lease
   */
  getLease(): LeaseState | null {
    return this.lease;
  }

  updateActivity(): void {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  /**
   * Get the client ID for this manager instance.
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Check if there's an active lease.
   */
  hasActiveLease(): boolean {
    return this.lease !== null;
  }

  async handleRateLimit(waitMs: number, reason?: string, quotaResetTime?: string): Promise<RateLimitDecision> {
    this.updateActivity();

    debugLogToFile(`[lease-manager] Rate limit: waitMs=${waitMs} reason=${reason || 'unknown'} quotaResetTime=${quotaResetTime || 'none'}`);

    if (waitMs <= this.maxRateLimitWaitMs) {
      debugLogToFile(`[lease-manager] Wait time ${waitMs}ms <= threshold ${this.maxRateLimitWaitMs}ms, recommending wait`);
      return {
        action: 'wait',
        waitMs,
      };
    }

    debugLogToFile(`[lease-manager] Wait time ${waitMs}ms > threshold ${this.maxRateLimitWaitMs}ms, switching account`);

    try {
      const resetTime = quotaResetTime || new Date(Date.now() + waitMs).toISOString();
      const newLease = await this.reportIssue(`rate_limit:${reason || 'unknown'}`, resetTime);
      return {
        action: 'switch',
        newAccount: newLease.account,
      };
    } catch (err) {
      debugLogToFile(`[lease-manager] Failed to switch account: ${err}`);
      return {
        action: 'wait',
        waitMs,
      };
    }
  }

  shouldSwitchOnRateLimit(waitMs: number): boolean {
    return waitMs > this.maxRateLimitWaitMs;
  }

  getMaxRateLimitWaitMs(): number {
    return this.maxRateLimitWaitMs;
  }

  async checkQuota(): Promise<{ remaining: number; total: number; percentage: number } | null> {
    if (!this.lease) {
      debugLogToFile('[lease-manager] No active lease, skipping quota check');
      return null;
    }

    const now = Date.now();
    if (now - this.lastQuotaCheck < this.quotaCheckIntervalMs) {
      debugLogToFile('[lease-manager] Quota check rate limited');
      return null;
    }

    this.lastQuotaCheck = now;

    try {
      const tokenResponse = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
          client_secret: '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',
          refresh_token: this.lease.account.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });

      if (!tokenResponse.ok) {
        debugLogToFile(`[lease-manager] Token refresh failed: ${tokenResponse.status}`);
        return null;
      }

      const tokenData = (await tokenResponse.json()) as { access_token: string };
      const accessToken = tokenData.access_token;

      const quotaResponse = await fetchWithTimeout('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.11.3 Darwin/arm64',
        },
        body: JSON.stringify({ project: this.lease.account.projectId || '' }),
      });

      if (!quotaResponse.ok) {
        debugLogToFile(`[lease-manager] Quota API failed: ${quotaResponse.status}`);
        return null;
      }

      const quotaData = (await quotaResponse.json()) as {
        models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
      };

      let minRemainingFraction = 1;
      let earliestResetTime: string | undefined;
      for (const info of Object.values(quotaData.models || {})) {
        const fraction = info.quotaInfo?.remainingFraction ?? 1;
        const resetTime = info.quotaInfo?.resetTime;
        if (fraction < minRemainingFraction) {
          minRemainingFraction = fraction;
          earliestResetTime = resetTime;
        }
      }

      const remaining = Math.round(minRemainingFraction * 100);
      const total = 100;
      const percentage = minRemainingFraction;

      debugLogToFile(
        `[lease-manager] Quota: ${remaining}/${total} (${(percentage * 100).toFixed(1)}%) resetTime=${earliestResetTime || 'none'}`,
      );

      this.reportQuotaToServer(quotaData.models || {}).catch((err: unknown) => {
        debugLogToFile(`[lease-manager] Failed to report quota to server: ${err}`);
      });

      if (percentage <= this.lowQuotaThreshold) {
        debugLogToFile(
          `[lease-manager] Quota low (${(percentage * 100).toFixed(1)}%), disabling account and switching`,
        );
        try {
          const resetTime = earliestResetTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          await this.reportIssue('quota_exhausted', resetTime);
        } catch (err) {
          debugLogToFile(`[lease-manager] Failed to disable and switch account on low quota: ${err}`);
        }
      }

      return { remaining, total, percentage };
    } catch (err) {
      debugLogToFile(`[lease-manager] Quota check error: ${err}`);
      return null;
    }
  }

  private startHeartbeat(ttlSeconds: number): void {
    this.stopHeartbeat();

    const intervalMs = Math.floor(ttlSeconds * DEFAULT_HEARTBEAT_RATIO * 1000);

    debugLogToFile(`[lease-manager] Starting heartbeat with interval ${intervalMs}ms (TTL=${ttlSeconds}s)`);

    this.heartbeatTimer = setInterval(() => {
      this.renew()
        .then(() => this.checkQuota())
        .catch((err) => {
          debugLogToFile(`[lease-manager] Heartbeat renew failed: ${err.message}`);
        });
    }, intervalMs);

    // Prevent timer from blocking process exit
    this.heartbeatTimer.unref();
  }

  /**
   * Stop heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      debugLogToFile(`[lease-manager] Stopped heartbeat`);
    }
  }

  private startIdleCheck(): void {
    this.stopIdleCheck();

    this.idleCheckTimer = setInterval(() => {
      const idleTime = Date.now() - this.lastActivity;
      if (idleTime >= this.idleTimeoutMs && this.lease) {
        debugLogToFile(`[lease-manager] Idle for ${Math.floor(idleTime / 1000)}s, releasing lease`);
        this.release();
      }
    }, IDLE_CHECK_INTERVAL_MS);

    this.idleCheckTimer.unref();
  }

  private stopIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  private async reportQuotaToServer(
    models: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>,
  ): Promise<void> {
    if (!this.lease) return;

    const quotas: Array<{ model_name: string; percentage: number; reset_time?: string }> = [];
    for (const [modelName, info] of Object.entries(models)) {
      const quotaInfo = info.quotaInfo || {};
      quotas.push({
        model_name: modelName,
        percentage: Math.round((quotaInfo.remainingFraction || 0) * 100),
        reset_time: quotaInfo.resetTime,
      });
    }

    if (quotas.length === 0) return;

    try {
      const response = await fetch(`${this.apiEndpoint}/api/quota/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'User-Agent': 'opencode-antigravity-auth',
        },
        body: JSON.stringify({
          account_email: this.lease.account.email,
          quotas,
        }),
      });

      if (response.ok) {
        debugLogToFile(`[lease-manager] Quota reported to server: ${quotas.length} models`);
      } else {
        debugLogToFile(`[lease-manager] Quota report failed: ${response.status}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      debugLogToFile(`[lease-manager] Quota report error: ${message}`);
    }
  }
}
