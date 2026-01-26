# 账号租借分发系统工作计划

## Context

### Original Request
在 sticky 模式下实现账号租借分发系统：
- 插件端：启动时向服务端获取账号，限流/额度不足时换号，20分钟未使用释放，终端关闭释放
- 服务端：账号分发、状态管理、30分钟超时回收、管理界面、操作日志

### Interview Summary

**关键决策**:
- 严格排他性租借（一个账号同时只能被一个终端使用）
- 插件端直接查询 cloudcode-pa API 获取额度
- 短暂限流(≤30秒)等待而非换号，超过阈值才换号
- SIGTERM/SIGINT 主动释放 + 服务端30分钟超时兜底
- 独立 leases 表设计
- 每次启动生成随机 UUID 作为客户端标识
- 完全切换到租借模式，不保留旧的批量获取方式
- 日志保留7天

**研究发现**:
- 插件端有测试基础设施(vitest)，服务端无测试
- 服务端 apiKeyAuth 中间件可复用
- 429处理已有 parseRateLimitReason() 区分限流类型
- better-sqlite3 事务用 db.transaction().immediate()

### Metis Review

**已解决的差距**:
1. 边缘情况处理：租借失败/换号失败/释放失败的降级策略
2. 时序竞争：超时与主动释放竞争用幂等设计解决
3. 开发顺序：服务端优先，再插件端集成

**应用的护栏**:
- 所有租借操作必须有超时设置
- 服务端 API 必须幂等（重复释放不报错）
- 不阻塞主请求流程等待租借
- SQLite 持久化租约状态

---

## Work Objectives

### Core Objective
实现账号租借分发系统，让每个 opencode 终端独立管理一个租借账号，支持自动换号、空闲释放和服务端统一管理。

### Concrete Deliverables

**服务端 (antigravity-account-service)**:
- [x] leases 表和 lease_logs 表
- [x] POST /api/lease/acquire - 获取租约
- [x] POST /api/lease/renew - 续约
- [x] POST /api/lease/release - 释放
- [x] POST /api/lease/report-issue - 上报问题并换号
- [x] cleanupExpiredLeases() 定时任务
- [x] 管理界面租约状态显示和操作按钮
- [x] 租约日志查询接口

**插件端 (opencode-antigravity-auth)**:
- [x] LeaseManager 类 - 租约生命周期管理
- [x] 进程信号处理 (SIGTERM/SIGINT/SIGHUP)
- [x] 空闲检测和自动释放 (20分钟)
- [x] 心跳续约机制
- [x] 主动额度查询 (≤20%换号，5分钟限频)
- [x] 短暂限流等待逻辑 (≤30秒等待，否则换号)
- [x] 配置 schema 扩展

### Definition of Done
- [x] 启动 opencode 时自动获取账号租约
- [x] 429 限流时：≤30秒等待重试，>30秒换号
- [x] 额度不足时自动换号
- [x] 20分钟未使用自动释放账号
- [x] 终端关闭时释放账号
- [x] 服务端30分钟无心跳强制回收
- [x] 管理界面可查看所有租约状态
- [x] 所有操作有日志记录

### Must Have
- 租借操作幂等性
- 进程退出时释放账号
- 服务端超时回收兜底
- 操作日志记录

### Must NOT Have (Guardrails)
- 不保留旧的批量账号获取模式
- 不阻塞主请求流程等待租借操作
- 不使用纯内存存储租约状态（必须 SQLite 持久化）
- 释放失败不阻塞进程退出
- 不过度复杂化配置（使用合理默认值）

---

## Verification Strategy

### Test Decision
- **插件端**: 有测试基础设施 (vitest)，采用 TDD
- **服务端**: 无测试基础设施，采用详细手动验证

### 插件端测试要求
每个核心功能需有测试覆盖：
- LeaseManager 租约获取/释放/续约
- 空闲检测逻辑
- 信号处理（mock process.on）
- 短暂限流等待 vs 换号决策

### 服务端手动验证
使用 curl/httpie 验证 API，检查数据库状态。

---

## Task Flow

```
[Phase 1: 服务端核心]
  1.1 数据库 Schema
       ↓
  1.2 租约 API 路由
       ↓
  1.3 定时清理任务
       ↓
[Phase 2: 插件端集成]
  2.1 LeaseManager 类
       ↓
  2.2 生命周期钩子
       ↓
  2.3 空闲检测
       ↓
  2.4 额度查询集成
       ↓
  2.5 限流处理改造
       ↓
[Phase 3: 管理界面 + 验收]
  3.1 前端租约状态
       ↓
  3.2 日志查询
       ↓
  3.3 端到端验证
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 1.2, 1.3 | 依赖 1.1 完成后可并行 |
| B | 2.2, 2.3 | 依赖 2.1 完成后可并行 |
| C | 3.1, 3.2 | 依赖 Phase 2 完成后可并行 |

---

## TODOs

### Phase 1: 服务端核心 (antigravity-account-service)

- [x] 1.1 创建数据库 Schema

  **What to do**:
  - 在 `src/db/schema.sql` 添加 leases 表和 lease_logs 表
  - 在 `src/db/init.ts` 添加迁移逻辑 (ALTER TABLE 检查)
  - 配置 WAL 模式和 busy_timeout

  **Must NOT do**:
  - 不修改现有的 accounts 表结构
  - 不删除任何现有数据

  **Parallelizable**: NO (基础依赖)

  **References**:
  - `src/db/schema.sql` - 现有表结构模式
  - `src/db/init.ts` - 迁移逻辑模式 (ALTER TABLE IF NOT EXISTS)
  - Draft 中的 leases/lease_logs 表设计

  **Acceptance Criteria**:
  - [ ] leases 表已创建：`sqlite3 data/accounts.db ".schema leases"` → 显示表结构
  - [ ] lease_logs 表已创建：`sqlite3 data/accounts.db ".schema lease_logs"` → 显示表结构
  - [ ] 索引已创建：`.indexes leases` → 显示 idx_leases_expires_at, idx_leases_client_id
  - [ ] 服务端启动无报错：`npm run dev` → 正常启动

  **Commit**: YES
  - Message: `feat(db): add leases and lease_logs tables for account leasing`
  - Files: `src/db/schema.sql`, `src/db/init.ts`

---

- [x] 1.2 实现租约 API 路由

  **What to do**:
  - 创建 `src/routes/lease.ts`
  - 实现 POST /api/lease/acquire - 原子获取租约
  - 实现 POST /api/lease/renew - 续约
  - 实现 POST /api/lease/release - 幂等释放
  - 实现 POST /api/lease/report-issue - 上报问题并换号
  - 在 `src/index.ts` 注册路由
  - 使用 apiKeyAuth 中间件
  - 使用 db.transaction().immediate() 保证原子性
  - 所有操作写入 lease_logs

  **Must NOT do**:
  - 不修改现有的 /api/accounts 路由
  - 释放不存在的租约不应报错（幂等）

  **Parallelizable**: NO (依赖 1.1)

  **References**:
  - `src/routes/accounts.ts` - 路由模式参考
  - `src/middleware/auth.ts` - apiKeyAuth 中间件
  - `src/routes/admin.ts` - 数据库事务使用模式
  - Draft 中的 API 设计表

  **Acceptance Criteria**:
  - [ ] 获取租约：
    ```bash
    curl -X POST http://localhost:3001/api/lease/acquire \
      -H "X-API-Key: YOUR_KEY" \
      -H "Content-Type: application/json" \
      -d '{"client_id": "test-uuid-1234"}'
    ```
    → 返回 `{"lease_id": N, "account": {...}, "expires_at": "...", "ttl_seconds": 1800}`
  - [ ] 续约：
    ```bash
    curl -X POST http://localhost:3001/api/lease/renew \
      -H "X-API-Key: YOUR_KEY" \
      -d '{"lease_id": 1, "client_id": "test-uuid-1234"}'
    ```
    → 返回 `{"expires_at": "...", "ttl_seconds": 1800}`
  - [ ] 释放：
    ```bash
    curl -X POST http://localhost:3001/api/lease/release \
      -H "X-API-Key: YOUR_KEY" \
      -d '{"lease_id": 1, "client_id": "test-uuid-1234"}'
    ```
    → 返回 `{"success": true}`
  - [ ] 重复释放不报错（幂等）
  - [ ] 日志已记录：`sqlite3 data/accounts.db "SELECT * FROM lease_logs"` → 显示操作记录

  **Commit**: YES
  - Message: `feat(api): implement lease acquire/renew/release/report-issue endpoints`
  - Files: `src/routes/lease.ts`, `src/index.ts`

---

- [x] 1.3 实现定时清理任务

  **What to do**:
  - 在 `src/index.ts` 添加 cleanupExpiredLeases() 函数
  - setInterval 每分钟执行
  - 删除 expires_at < NOW() 的租约
  - 记录到 lease_logs (action: 'expire')

  **Must NOT do**:
  - 不影响现有的 checkAndRestoreProtectedAccounts 任务

  **Parallelizable**: YES (与 1.2 并行，依赖 1.1)

  **References**:
  - `src/index.ts:38` - checkAndRestoreProtectedAccounts 定时任务模式

  **Acceptance Criteria**:
  - [ ] 创建过期租约：
    ```sql
    INSERT INTO leases (account_id, api_key_id, client_id, expires_at)
    VALUES (1, 1, 'expired-client', datetime('now', '-1 minute'));
    ```
  - [ ] 等待1分钟或手动触发清理
  - [ ] 验证已清理：`SELECT * FROM leases WHERE client_id = 'expired-client'` → 无结果
  - [ ] 验证日志：`SELECT * FROM lease_logs WHERE action = 'expire'` → 有记录

  **Commit**: YES
  - Message: `feat(scheduler): add expired leases cleanup task`
  - Files: `src/index.ts`

---

### Phase 2: 插件端集成 (opencode-antigravity-auth)

- [x] 2.1 实现 LeaseManager 类

  **What to do**:
  - 创建 `src/plugin/lease-manager.ts`
  - 实现 acquire() - 获取租约
  - 实现 release() - 释放租约 (fire-and-forget)
  - 实现 renew() - 续约
  - 实现 reportIssue() - 上报问题并换号
  - 实现 getAccount() - 获取当前租借的账号
  - 管理 clientId (UUID)
  - 管理心跳定时器 (setInterval, unref())
  - 错误处理和重试逻辑

  **Must NOT do**:
  - 不阻塞主流程（网络失败时降级）
  - 不存储敏感信息到日志

  **Parallelizable**: NO (Phase 2 基础)

  **References**:
  - `src/plugin/accounts.ts` - AccountManager 结构参考
  - `src/plugin/usage-reporter.ts` - fire-and-forget 模式参考
  - `src/antigravity/oauth.ts:fetchWithTimeout` - 超时请求模式

  **Acceptance Criteria**:
  - [ ] 测试文件：`src/plugin/__tests__/lease-manager.test.ts`
  - [ ] `bun test lease-manager` → PASS
  - [ ] 测试覆盖：acquire成功/失败、release幂等、renew续约、心跳启动/停止

  **Commit**: YES
  - Message: `feat(plugin): implement LeaseManager for account leasing`
  - Files: `src/plugin/lease-manager.ts`, `src/plugin/__tests__/lease-manager.test.ts`

---

- [x] 2.2 实现进程信号处理

  **What to do**:
  - 创建 `src/plugin/lifecycle.ts`
  - 监听 SIGTERM/SIGINT/SIGHUP 信号
  - 在信号处理中调用 LeaseManager.release()
  - 设置 watchdog 超时 (10秒) 防止挂起
  - isShuttingDown 防止重复处理
  - 在 plugin.ts 初始化时注册

  **Must NOT do**:
  - 释放失败不阻塞进程退出
  - 不使用 process.exit() 阻止其他清理

  **Parallelizable**: YES (与 2.3 并行，依赖 2.1)

  **References**:
  - `src/plugin/cache/signature-cache.ts:shutdown()` - 现有清理模式参考
  - Distilled: Node.js信号处理最佳实践

  **Acceptance Criteria**:
  - [ ] 测试文件：`src/plugin/__tests__/lifecycle.test.ts`
  - [ ] `bun test lifecycle` → PASS
  - [ ] 手动验证：启动插件 → Ctrl+C → 检查服务端租约已释放

  **Commit**: YES
  - Message: `feat(plugin): add process signal handling for graceful shutdown`
  - Files: `src/plugin/lifecycle.ts`, `src/plugin/__tests__/lifecycle.test.ts`

---

- [x] 2.3 实现空闲检测和自动释放

  **What to do**:
  - 在 LeaseManager 中添加 lastActivity 时间戳
  - 每次 API 调用时更新 lastActivity
  - setInterval 检查空闲时间 (每分钟)
  - 超过 20 分钟未活动则释放账号
  - 定时器必须 unref() 防止阻塞退出
  - 下次请求时重新获取账号

  **Must NOT do**:
  - 不在空闲释放后立即重新获取（等待下次请求）

  **Parallelizable**: YES (与 2.2 并行，依赖 2.1)

  **References**:
  - `src/plugin/accounts.ts:85` - lastUsed 字段参考
  - `src/plugin/accounts.ts:436,459,489` - lastUsed 更新位置参考

  **Acceptance Criteria**:
  - [ ] 测试覆盖：活动更新 lastActivity、空闲检测触发释放
  - [ ] `bun test lease-manager` → PASS (包含空闲检测测试)
  - [ ] 手动验证：设置 idle_timeout 为 1 分钟 → 等待 → 检查服务端租约已释放

  **Commit**: YES
  - Message: `feat(plugin): add idle detection and auto-release`
  - Files: `src/plugin/lease-manager.ts`

---

- [x] 2.4 集成主动额度查询

  **What to do**:
  - 创建 `src/plugin/quota-checker.ts`
  - 实现 checkQuota() - 调用 cloudcode-pa API 获取额度
  - 参考服务端 admin.ts:312-375 实现
  - 额度 ≤20% 时触发换号 (调用 LeaseManager.reportIssue)
  - 限频：最多5分钟查询一次
  - 在请求完成后触发检查

  **Must NOT do**:
  - 不在每次请求都查询额度（有频率限制）
  - 不阻塞主请求流程

  **Parallelizable**: NO (依赖 2.1-2.3)

  **References**:
  - Distilled: cloudcode-pa API 调用方式
  - `src/plugin/accounts.ts` - touchedForQuota 时间戳参考

  **Acceptance Criteria**:
  - [ ] 测试文件：`src/plugin/__tests__/quota-checker.test.ts`
  - [ ] `bun test quota-checker` → PASS
  - [ ] 测试覆盖：额度>20%不换号、额度≤20%换号、5分钟限频

  **Commit**: YES
  - Message: `feat(plugin): add proactive quota checking`
  - Files: `src/plugin/quota-checker.ts`, `src/plugin/__tests__/quota-checker.test.ts`

---

- [x] 2.5 改造限流处理逻辑

  **What to do**:
  - 修改 `src/plugin.ts` 中的 429 处理逻辑
  - 判断 retry-after 时间：
    - ≤30秒：等待后重试（不换号）
    - >30秒：调用 LeaseManager.reportIssue 换号
  - QUOTA_EXHAUSTED 类型直接换号
  - 更新 markRateLimited 调用逻辑

  **Must NOT do**:
  - 不修改 parseRateLimitReason 核心逻辑
  - 不改变现有的重试机制

  **Parallelizable**: NO (依赖 2.1-2.4)

  **References**:
  - `src/plugin.ts:625-700` - 现有 429 处理逻辑
  - `src/plugin/accounts.ts:parseRateLimitReason` - 限流类型识别
  - `src/plugin.ts:retryAfterMsFromResponse` - 获取等待时间

  **Acceptance Criteria**:
  - [ ] 修改现有测试或添加新测试覆盖短暂限流等待逻辑
  - [ ] `bun test` → 全部 PASS
  - [ ] 手动验证：模拟 10秒 429 → 等待重试成功
  - [ ] 手动验证：模拟 60秒 429 → 换号

  **Commit**: YES
  - Message: `feat(plugin): implement smart rate limit handling (wait vs switch)`
  - Files: `src/plugin.ts`

---

- [x] 2.6 集成到插件主流程

  **What to do**:
  - 修改 `src/plugin.ts` 初始化流程
  - 启动时调用 LeaseManager.acquire() 获取账号
  - 移除/替换 loadFromRemote() 调用
  - 使用 LeaseManager.getAccount() 替代 AccountManager.getCurrentOrNextForFamily()
  - 注册生命周期钩子
  - 扩展配置 schema 添加 lease 相关配置

  **Must NOT do**:
  - 不保留旧的批量获取模式（完全切换）
  - 获取失败时应有友好错误提示

  **Parallelizable**: NO (依赖 2.1-2.5)

  **References**:
  - `src/plugin.ts:758-784` - AccountManager 初始化位置
  - `src/plugin/config/schema.ts` - 配置 schema 扩展位置
  - `src/plugin/config/loader.ts` - 配置加载逻辑

  **Acceptance Criteria**:
  - [ ] `bun test` → 全部 PASS
  - [ ] 手动验证：启动插件 → 检查服务端有租约记录
  - [ ] 手动验证：发起请求 → 使用租借账号成功
  - [ ] 手动验证：无可用账号时 → 友好错误提示

  **Commit**: YES
  - Message: `feat(plugin): integrate LeaseManager into main flow`
  - Files: `src/plugin.ts`, `src/plugin/config/schema.ts`

---

### Phase 3: 管理界面 + 验收

- [x] 3.1 管理界面添加租约状态

  **What to do**:
  - 修改 `client/src/pages/Accounts.tsx`
  - 添加租约状态列 (已租借/空闲)
  - 显示租借者 (client_id 前8位)
  - 显示过期时间
  - 添加"强制释放"按钮
  - 实现 POST /admin/api/leases/:id/force-release

  **Must NOT do**:
  - 不改变现有的账号管理功能

  **Parallelizable**: YES (与 3.2 并行)

  **References**:
  - `client/src/pages/Accounts.tsx` - 现有界面结构
  - `client/src/utils/api.ts:fetchApi` - API 调用模式

  **Acceptance Criteria**:
  - [ ] 浏览器访问管理界面 → 账号列表显示租约状态
  - [ ] 点击"强制释放" → 租约被释放
  - [ ] 刷新后状态更新

  **Commit**: YES
  - Message: `feat(admin): add lease status display and force-release button`
  - Files: `client/src/pages/Accounts.tsx`, `src/routes/admin.ts`

---

- [x] 3.2 添加租约日志查询

  **What to do**:
  - 实现 GET /admin/api/lease-logs
  - 支持分页和筛选 (action, account_id, date range)
  - 可选：在管理界面添加日志查看页面

  **Must NOT do**:
  - 不暴露敏感信息 (如完整 client_id)

  **Parallelizable**: YES (与 3.1 并行)

  **References**:
  - `src/routes/admin.ts:283` - GET /access-logs 实现参考

  **Acceptance Criteria**:
  - [ ] API 查询：
    ```bash
    curl http://localhost:3001/admin/api/lease-logs \
      -H "Cookie: session=..."
    ```
    → 返回日志列表
  - [ ] 支持筛选：`?action=acquire&limit=10` → 正确筛选

  **Commit**: YES
  - Message: `feat(admin): add lease logs query endpoint`
  - Files: `src/routes/admin.ts`

---

- [x] 3.3 日志清理任务

  **What to do**:
  - 在 `src/index.ts` 添加日志清理任务
  - 每天清理 7 天前的 lease_logs
  - 可与 cleanupExpiredLeases 合并或独立

  **Must NOT do**:
  - 不清理 access_logs 或 usage_records（保持现有行为）

  **Parallelizable**: NO (依赖 3.1, 3.2)

  **References**:
  - `src/index.ts` - 定时任务模式

  **Acceptance Criteria**:
  - [ ] 创建旧日志：
    ```sql
    INSERT INTO lease_logs (action, created_at)
    VALUES ('test', datetime('now', '-8 days'));
    ```
  - [ ] 等待清理任务执行或手动触发
  - [ ] 验证已清理：`SELECT * FROM lease_logs WHERE action = 'test'` → 无结果

  **Commit**: YES
  - Message: `feat(scheduler): add lease logs cleanup (7 days retention)`
  - Files: `src/index.ts`

---

- [x] 3.4 端到端验证

  **What to do**:
  - 完整流程测试：启动 → 使用 → 空闲释放 → 重新获取
  - 限流测试：短暂限流等待 → 长时限流换号
  - 额度测试：低额度换号
  - 异常测试：强制关闭终端 → 服务端超时回收
  - 并发测试：多终端同时请求

  **Must NOT do**:
  - 不跳过任何关键场景

  **Parallelizable**: NO (最终验收)

  **Acceptance Criteria**:
  - [ ] 完整流程测试通过
  - [ ] 限流处理测试通过
  - [ ] 额度检测测试通过
  - [ ] 异常恢复测试通过
  - [ ] 无内存泄漏（长时间运行稳定）

  **Commit**: NO (验证任务，无代码变更)

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1.1 | `feat(db): add leases and lease_logs tables` | schema.sql, init.ts | sqlite3 .schema |
| 1.2 | `feat(api): implement lease endpoints` | lease.ts, index.ts | curl tests |
| 1.3 | `feat(scheduler): add lease cleanup` | index.ts | manual trigger |
| 2.1 | `feat(plugin): implement LeaseManager` | lease-manager.ts, test | bun test |
| 2.2 | `feat(plugin): add signal handling` | lifecycle.ts, test | bun test |
| 2.3 | `feat(plugin): add idle detection` | lease-manager.ts | bun test |
| 2.4 | `feat(plugin): add quota checking` | quota-checker.ts, test | bun test |
| 2.5 | `feat(plugin): smart rate limit handling` | plugin.ts | bun test |
| 2.6 | `feat(plugin): integrate LeaseManager` | plugin.ts, schema.ts | bun test |
| 3.1 | `feat(admin): add lease status` | Accounts.tsx, admin.ts | browser |
| 3.2 | `feat(admin): add lease logs` | admin.ts | curl |
| 3.3 | `feat(scheduler): lease logs cleanup` | index.ts | manual |

---

## Success Criteria

### Verification Commands

**服务端**:
```bash
# 检查表结构
sqlite3 data/accounts.db ".schema leases"
sqlite3 data/accounts.db ".schema lease_logs"

# 测试租约 API
curl -X POST http://localhost:3001/api/lease/acquire \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"client_id": "test-uuid"}'
```

**插件端**:
```bash
# 运行所有测试
bun test

# 检查测试覆盖
bun test --coverage
```

### Final Checklist
- [x] 所有 "Must Have" 功能完成
- [x] 所有 "Must NOT Have" 约束遵守
- [x] 插件端测试全部通过
- [x] 服务端 API 手动验证通过
- [x] 管理界面功能正常
- [x] 端到端验证通过
