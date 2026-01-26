import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeaseManager } from './lease-manager.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('./debug.js', () => ({
  debugLogToFile: vi.fn(),
}));

const TEST_CONFIG = {
  apiEndpoint: 'https://api.example.com',
  apiKey: 'test-api-key',
};

const MOCK_LEASE_RESPONSE = {
  lease_id: 123,
  account: {
    email: 'test@example.com',
    refreshToken: 'refresh-token-123',
    projectId: 'project-123',
  },
  expires_at: '2025-01-24T12:00:00.000Z',
  ttl_seconds: 1800,
};

const MOCK_RENEW_RESPONSE = {
  expires_at: '2025-01-24T12:30:00.000Z',
  ttl_seconds: 1800,
};

describe('LeaseManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('generates unique clientId', () => {
      const manager1 = new LeaseManager(TEST_CONFIG);
      const manager2 = new LeaseManager(TEST_CONFIG);
      
      expect(manager1.getClientId()).toBeTruthy();
      expect(manager2.getClientId()).toBeTruthy();
      expect(manager1.getClientId()).not.toBe(manager2.getClientId());
    });

    it('initializes with no active lease', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      
      expect(manager.hasActiveLease()).toBe(false);
      expect(manager.getAccount()).toBeNull();
      expect(manager.getLease()).toBeNull();
    });
  });

  describe('acquire', () => {
    it('acquires lease successfully and starts heartbeat', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
      });

      const manager = new LeaseManager(TEST_CONFIG);
      const lease = await manager.acquire();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/lease/acquire',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-api-key',
          }),
        }),
      );

      expect(lease.leaseId).toBe(123);
      expect(lease.account.email).toBe('test@example.com');
      expect(lease.account.refreshToken).toBe('refresh-token-123');
      expect(lease.account.projectId).toBe('project-123');
      expect(lease.expiresAt).toEqual(new Date('2025-01-24T12:00:00.000Z'));

      expect(manager.hasActiveLease()).toBe(true);
      expect(manager.getAccount()).toEqual({
        email: 'test@example.com',
        refreshToken: 'refresh-token-123',
        projectId: 'project-123',
      });
    });

    it('throws error on acquire failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server error'),
      });

      const manager = new LeaseManager(TEST_CONFIG);

      await expect(manager.acquire()).rejects.toThrow('Failed to acquire lease');
      expect(manager.hasActiveLease()).toBe(false);
    });

    it('throws error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const manager = new LeaseManager(TEST_CONFIG);

      await expect(manager.acquire()).rejects.toThrow('Failed to acquire lease: Network error');
    });
  });

  describe('release', () => {
    it('releases lease and stops heartbeat', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();
      
      expect(manager.hasActiveLease()).toBe(true);

      await manager.release();

      expect(manager.hasActiveLease()).toBe(false);
      expect(manager.getAccount()).toBeNull();
    });

    it('is idempotent - calling release twice does not throw', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      await manager.release();
      await manager.release();

      expect(manager.hasActiveLease()).toBe(false);
    });

    it('handles release without active lease', async () => {
      const manager = new LeaseManager(TEST_CONFIG);
      
      await expect(manager.release()).resolves.toBeUndefined();
    });

    it('does not throw on release failure (fire-and-forget)', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      await expect(manager.release()).resolves.toBeUndefined();
      expect(manager.hasActiveLease()).toBe(false);
    });
  });

  describe('renew', () => {
    it('renews lease and updates expiresAt', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_RENEW_RESPONSE),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();
      
      const originalExpiry = manager.getLease()?.expiresAt;

      await manager.renew();

      const newExpiry = manager.getLease()?.expiresAt;
      expect(newExpiry).toEqual(new Date('2025-01-24T12:30:00.000Z'));
      expect(newExpiry).not.toEqual(originalExpiry);
    });

    it('throws error when no active lease', async () => {
      const manager = new LeaseManager(TEST_CONFIG);

      await expect(manager.renew()).rejects.toThrow('No active lease to renew');
    });

    it('throws error on renew failure', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: () => Promise.resolve('Lease not found'),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      await expect(manager.renew()).rejects.toThrow('Failed to renew lease');
    });
  });

  describe('reportIssue', () => {
    it('reports issue and returns new account', async () => {
      const newLeaseResponse = {
        lease_id: 456,
        account: {
          email: 'new@example.com',
          refreshToken: 'new-refresh-token',
          projectId: 'new-project',
        },
        expires_at: '2025-01-24T13:00:00.000Z',
        ttl_seconds: 1800,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newLeaseResponse),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const newLease = await manager.reportIssue('Rate limited');

      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://api.example.com/api/lease/report-issue',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Rate limited'),
        }),
      );

      expect(newLease.leaseId).toBe(456);
      expect(newLease.account.email).toBe('new@example.com');
      expect(manager.getAccount()?.email).toBe('new@example.com');
    });

    it('throws error when no active lease', async () => {
      const manager = new LeaseManager(TEST_CONFIG);

      await expect(manager.reportIssue('test')).rejects.toThrow('No active lease to report issue for');
    });

    it('throws error on report failure', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: () => Promise.resolve('No accounts available'),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      await expect(manager.reportIssue('test')).rejects.toThrow('Failed to report issue');
    });
  });

  describe('getAccount', () => {
    it('returns null when no lease', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      expect(manager.getAccount()).toBeNull();
    });

    it('returns account when lease exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
      });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const account = manager.getAccount();
      expect(account).toEqual({
        email: 'test@example.com',
        refreshToken: 'refresh-token-123',
        projectId: 'project-123',
      });
    });
  });

  describe('heartbeat', () => {
    it('starts heartbeat after acquire at 50% of TTL', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_RENEW_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 800, total: 1000 }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(900000);

      await Promise.resolve();
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.example.com/api/lease/renew',
        expect.any(Object),
      );
    });

    it('stops heartbeat after release', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();
      await manager.release();

      const callCountAfterRelease = mockFetch.mock.calls.length;

      vi.advanceTimersByTime(900000);
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledTimes(callCountAfterRelease);
    });
  });

  describe('updateActivity', () => {
    it('updates lastActivity timestamp', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      const before = manager.getLastActivity();

      vi.advanceTimersByTime(1000);
      manager.updateActivity();

      expect(manager.getLastActivity()).toBeGreaterThan(before);
    });
  });

  describe('idle detection', () => {
    it('starts idle check timer after acquire', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
      });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        idleTimeoutMs: 5 * 60 * 1000,
      });
      await manager.acquire();

      expect(manager.hasActiveLease()).toBe(true);
    });

    it('releases lease when idle timeout exceeded', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        idleTimeoutMs: 5 * 60 * 1000,
      });
      await manager.acquire();

      expect(manager.hasActiveLease()).toBe(true);

      vi.advanceTimersByTime(60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(true);

      vi.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(false);
    });

    it('resets idle timer when updateActivity called', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_RENEW_RESPONSE),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        idleTimeoutMs: 5 * 60 * 1000,
      });
      await manager.acquire();

      vi.advanceTimersByTime(4 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(true);

      manager.updateActivity();

      vi.advanceTimersByTime(4 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(true);
    });

    it('stops idle check timer after release', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        idleTimeoutMs: 5 * 60 * 1000,
      });
      await manager.acquire();
      await manager.release();

      expect(manager.hasActiveLease()).toBe(false);

      vi.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve();

      expect(manager.hasActiveLease()).toBe(false);
    });

    it('uses default timeout when not configured', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(MOCK_RENEW_RESPONSE),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      vi.advanceTimersByTime(19 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(true);

      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(false);
    });

    it('restarts idle check after reportIssue', async () => {
      const newLeaseResponse = {
        lease_id: 456,
        account: {
          email: 'new@example.com',
          refreshToken: 'new-refresh-token',
          projectId: 'new-project',
        },
        expires_at: '2025-01-24T13:00:00.000Z',
        ttl_seconds: 1800,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newLeaseResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        idleTimeoutMs: 5 * 60 * 1000,
      });
      await manager.acquire();

      vi.advanceTimersByTime(4 * 60 * 1000);
      await Promise.resolve();

      await manager.reportIssue('Rate limited');

      vi.advanceTimersByTime(4 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(true);

      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
      expect(manager.hasActiveLease()).toBe(false);
    });
  });

  describe('checkQuota', () => {
    it('returns null when no active lease', async () => {
      const manager = new LeaseManager(TEST_CONFIG);
      
      const result = await manager.checkQuota();
      
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('checks quota successfully and returns data', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 800, total: 1000 }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result = await manager.checkQuota();

      expect(result).toEqual({
        remaining: 800,
        total: 1000,
        percentage: 0.8,
      });
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://api.example.com/api/quota/check',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('lease_id'),
        }),
      );
    });

    it('triggers reportIssue when quota is low (<= 20%)', async () => {
      const newLeaseResponse = {
        lease_id: 456,
        account: {
          email: 'new@example.com',
          refreshToken: 'new-refresh-token',
          projectId: 'new-project',
        },
        expires_at: '2025-01-24T13:00:00.000Z',
        ttl_seconds: 1800,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 150, total: 1000 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newLeaseResponse),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result = await manager.checkQuota();

      expect(result).toEqual({
        remaining: 150,
        total: 1000,
        percentage: 0.15,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/lease/report-issue',
        expect.objectContaining({
          body: expect.stringContaining('quota_low'),
        }),
      );
      expect(manager.getAccount()?.email).toBe('new@example.com');
    });

    it('is rate limited - returns null within 5 minutes', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 800, total: 1000 }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result1 = await manager.checkQuota();
      expect(result1).not.toBeNull();

      const result2 = await manager.checkQuota();
      expect(result2).toBeNull();

      vi.advanceTimersByTime(4 * 60 * 1000);
      const result3 = await manager.checkQuota();
      expect(result3).toBeNull();

      vi.advanceTimersByTime(2 * 60 * 1000);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ remaining: 700, total: 1000 }),
      });
      const result4 = await manager.checkQuota();
      expect(result4).not.toBeNull();
    });

    it('returns null on network failure without throwing', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result = await manager.checkQuota();

      expect(result).toBeNull();
    });

    it('returns null on API error without throwing', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result = await manager.checkQuota();

      expect(result).toBeNull();
    });

    it('handles zero total quota without division by zero', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 0, total: 0 }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const result = await manager.checkQuota();

      expect(result).toEqual({
        remaining: 0,
        total: 0,
        percentage: 1,
      });
    });

    it('uses custom quotaCheckIntervalMs config', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 800, total: 1000 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 700, total: 1000 }),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        quotaCheckIntervalMs: 60 * 1000,
      });
      await manager.acquire();

      await manager.checkQuota();

      vi.advanceTimersByTime(61 * 1000);
      const result = await manager.checkQuota();

      expect(result).not.toBeNull();
    });

    it('uses custom lowQuotaThreshold config', async () => {
      const newLeaseResponse = {
        lease_id: 456,
        account: {
          email: 'new@example.com',
          refreshToken: 'new-refresh-token',
          projectId: 'new-project',
        },
        expires_at: '2025-01-24T13:00:00.000Z',
        ttl_seconds: 1800,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 400, total: 1000 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newLeaseResponse),
        });

      const manager = new LeaseManager({
        ...TEST_CONFIG,
        lowQuotaThreshold: 0.5,
      });
      await manager.acquire();

      await manager.checkQuota();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/lease/report-issue',
        expect.objectContaining({
          body: expect.stringContaining('quota_low'),
        }),
      );
    });
  });

  describe('heartbeat with quota check', () => {
    it('calls checkQuota during heartbeat after renew', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_RENEW_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ remaining: 800, total: 1000 }),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(900000);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.example.com/api/lease/renew',
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        'https://api.example.com/api/quota/check',
        expect.any(Object),
      );
    });
  });

  describe('handleRateLimit', () => {
    it('returns wait action when waitMs <= threshold', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
      });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const decision = await manager.handleRateLimit(10000, 'QUOTA_EXHAUSTED');

      expect(decision.action).toBe('wait');
      expect(decision.waitMs).toBe(10000);
      expect(decision.newAccount).toBeUndefined();
    });

    it('returns switch action with new account when waitMs > threshold', async () => {
      const newLeaseResponse = {
        lease_id: 456,
        account: {
          email: 'new@example.com',
          refreshToken: 'new-refresh-token',
          projectId: 'new-project',
        },
        expires_at: '2025-01-24T13:00:00.000Z',
        ttl_seconds: 1800,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(newLeaseResponse),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const decision = await manager.handleRateLimit(60000, 'RATE_LIMIT_EXCEEDED');

      expect(decision.action).toBe('switch');
      expect(decision.newAccount?.email).toBe('new@example.com');
      expect(decision.newAccount?.refreshToken).toBe('new-refresh-token');
    });

    it('falls back to wait when switch fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: () => Promise.resolve('No accounts available'),
        });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const decision = await manager.handleRateLimit(60000, 'QUOTA_EXHAUSTED');

      expect(decision.action).toBe('wait');
      expect(decision.waitMs).toBe(60000);
    });

    it('updates activity timestamp', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_LEASE_RESPONSE),
      });

      const manager = new LeaseManager(TEST_CONFIG);
      await manager.acquire();

      const beforeActivity = manager.getLastActivity();
      vi.advanceTimersByTime(1000);

      await manager.handleRateLimit(5000);

      expect(manager.getLastActivity()).toBeGreaterThan(beforeActivity);
    });
  });

  describe('shouldSwitchOnRateLimit', () => {
    it('returns false when waitMs <= threshold', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      expect(manager.shouldSwitchOnRateLimit(30000)).toBe(false);
    });

    it('returns true when waitMs > threshold', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      expect(manager.shouldSwitchOnRateLimit(30001)).toBe(true);
    });
  });

  describe('getMaxRateLimitWaitMs', () => {
    it('returns default threshold', () => {
      const manager = new LeaseManager(TEST_CONFIG);
      expect(manager.getMaxRateLimitWaitMs()).toBe(30000);
    });

    it('returns custom threshold', () => {
      const manager = new LeaseManager({
        ...TEST_CONFIG,
        maxRateLimitWaitMs: 60000,
      });
      expect(manager.getMaxRateLimitWaitMs()).toBe(60000);
    });
  });
});
