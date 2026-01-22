# Antigravity 账号管理服务

## Context

### Original Request
用户管理 30 个 Antigravity 账号给多人使用，当前存在安全性和使用量管理问题：
- Refresh token 明文存储，任何人都能拿走全部账号
- 无法追踪每个人的使用情况
- 无用户隔离概念

### Interview Summary
**Key Discussions**:
- 账号分配策略：共享池（所有用户共享全部账号）
- 使用量上报：需要（插件每次请求后异步上报）
- 配置方式：`antigravity.json` 中添加 `api_endpoint` 和 `api_key`
- 技术选型：Node.js + Express + SQLite + React + Tailwind
- 项目位置：`../antigravity-account-service`（与插件项目同级）
- 配额限制：v1 暂不需要
- Token 存储：明文（用户接受风险）
- 降级策略：服务不可用时完全失败（不使用本地缓存）

### Metis Review
**Identified Gaps** (addressed):
- Token 存储安全 → 用户决定明文存储，记录风险
- 降级策略 → 用户决定完全失败模式
- 管理面板认证 → 使用独立 session-based 认证
- 使用量写入并发 → 使用 better-sqlite3 + WAL 模式
- API Key 比较安全 → 使用 constant-time comparison

---

## Work Objectives

### Core Objective
创建账号管理服务，实现账号集中管理、使用量追踪、和多用户隔离访问。

### Concrete Deliverables
1. **服务端项目**：`../antigravity-account-service/`
   - Express API（账号获取、使用量上报）
   - SQLite 数据库（账号、API Key、访问日志、使用量记录）
   - React 管理面板（账号 CRUD、API Key CRUD、统计图表）

2. **插件改动**：
   - 配置 schema 添加 `api_endpoint`, `api_key`
   - 支持从远程 API 获取账号
   - 请求完成后异步上报使用量

### Definition of Done
- [x] 配置 `api_endpoint` 后，插件启动时从服务获取账号池
- [x] 每次请求完成后，使用量异步上报到服务端
- [x] 管理面板可以增删改查账号和 API Key
- [x] 统计页面显示每日 token 用量和账号使用分布

### Must Have
- API Key 认证（获取账号、上报使用量）
- 访问日志记录（API Key、IP、时间）
- 使用量记录（账号、模型、token 数、成功/失败）
- 管理面板基础功能（账号 CRUD、API Key CRUD、统计展示）

### Must NOT Have (Guardrails)
- ❌ 配额限制系统（v2 范围）
- ❌ 实时推送通知
- ❌ 复杂报表分析
- ❌ 多租户隔离
- ❌ 用户角色权限（只有 admin）
- ❌ 账号导入导出批量操作
- ❌ 插件端本地缓存 fallback
- ❌ 修改插件现有的账号选择算法

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO（新项目）
- **User wants tests**: Manual-only（手动验证）
- **Framework**: none

### Manual QA Approach
每个 TODO 包含详细的手动验证步骤：
- **API 接口**：使用 curl 发送请求，验证响应
- **管理面板**：使用 Playwright 浏览器自动化验证
- **插件改动**：运行 OpenCode 验证功能

---

## Task Flow

```
[服务端基础设施]
  1. 项目初始化
       ↓
  2. 数据库设计
       ↓
  3. API 开发 ←──────┐
       ↓            │
  4. 管理面板 ←─────┘（可并行）
       
[插件改动]（与服务端并行）
  5. 配置 schema 扩展
       ↓
  6. 远程账号获取
       ↓
  7. 使用量上报
       ↓
  8. 集成测试
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 3, 4 | API 和管理面板可并行开发 |
| B | 1-4, 5-7 | 服务端和插件改动可完全并行 |

| Task | Depends On | Reason |
|------|------------|--------|
| 2 | 1 | 需要项目结构 |
| 3 | 2 | 需要数据库 schema |
| 4 | 2 | 需要数据库 schema |
| 6 | 5 | 需要配置字段 |
| 7 | 6 | 需要远程账号机制 |
| 8 | 3, 4, 7 | 需要服务端和插件都完成 |

---

## TODOs

### Part 1: 服务端项目

- [x] 1. 项目初始化

  **What to do**:
  - 在 `../antigravity-account-service/` 创建 Express + TypeScript 项目
  - 配置 package.json、tsconfig.json、eslint
  - 安装依赖：express, better-sqlite3, cors, bcrypt, express-session
  - 创建基础目录结构：src/routes, src/models, src/middleware, client/

  **Must NOT do**:
  - 不使用 ORM（直接用 better-sqlite3）
  - 不配置 Docker

  **Parallelizable**: NO（第一步）

  **References**:
  
  **Pattern References**:
  - `package.json` - 参考当前插件项目的 TypeScript 配置
  - `tsconfig.json` - 参考当前项目的 TypeScript 配置
  
  **External References**:
  - better-sqlite3 文档: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] `cd ../antigravity-account-service && npm install` → 成功
  - [ ] `npm run build` → 编译成功
  - [ ] `npm run dev` → 服务启动在 http://localhost:3001
  - [ ] `curl http://localhost:3001/health` → `{"ok": true}`

  **Commit**: YES
  - Message: `feat(server): initialize Express + TypeScript project`
  - Files: `../antigravity-account-service/`
  - Pre-commit: `npm run build`

---

- [x] 2. 数据库设计与初始化

  **What to do**:
  - 创建 `src/db/schema.sql` 定义表结构
  - 创建 `src/db/init.ts` 初始化数据库
  - 表：accounts, api_keys, access_logs, usage_records
  - 使用 WAL 模式优化并发写入
  - 创建默认 admin 账号

  **Must NOT do**:
  - 不加密 refresh token（用户决定）
  - 不实现配额字段

  **Parallelizable**: NO（依赖 1）

  **References**:
  
  **Pattern References**:
  - `src/plugin/storage.ts:45-80` - 参考账号数据结构 ManagedAccount
  
  **API/Type References**:
  ```sql
  -- 目标表结构
  accounts: id, email, refresh_token, project_id, managed_project_id, enabled, created_at
  api_keys: id, key_hash, name, enabled, created_at
  access_logs: id, api_key_id, ip, user_agent, endpoint, created_at
  usage_records: id, api_key_id, account_email, model, family, tokens_total, tokens_prompt, tokens_candidates, success, latency_ms, created_at
  ```
  
  **External References**:
  - SQLite WAL 模式: https://sqlite.org/wal.html
  - better-sqlite3 WAL: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] `npm run dev` → 启动时创建 `data/antigravity.db`
  - [ ] 使用 sqlite3 CLI 检查表结构：
    ```bash
    sqlite3 ../antigravity-account-service/data/antigravity.db ".tables"
    # 期望输出: accounts api_keys access_logs usage_records
    ```
  - [ ] 检查 WAL 模式：
    ```bash
    sqlite3 ../antigravity-account-service/data/antigravity.db "PRAGMA journal_mode;"
    # 期望输出: wal
    ```

  **Commit**: YES
  - Message: `feat(server): add database schema and initialization`
  - Files: `src/db/`
  - Pre-commit: `npm run build`

---

- [x] 3. API 接口开发

  **What to do**:
  - 创建 API Key 认证中间件（constant-time comparison）
  - GET /api/accounts - 返回账号列表，记录访问日志
  - POST /api/usage - 接收使用量上报
  - 返回格式与插件兼容

  **Must NOT do**:
  - 不实现复杂的账号分配算法
  - 不缓存/代理实际的 API 请求

  **Parallelizable**: YES（与 4 并行）

  **References**:
  
  **Pattern References**:
  - `src/plugin/accounts.ts:ManagedAccount` - 账号数据结构，API 需要返回兼容格式
  
  **API/Type References**:
  ```typescript
  // GET /api/accounts 响应格式
  {
    accounts: Array<{
      email: string;
      refreshToken: string;
      projectId?: string;
      managedProjectId?: string;
    }>
  }
  
  // POST /api/usage 请求格式
  {
    accountEmail: string;
    model: string;
    family: string;
    tokens: { total: number; prompt: number; candidates: number };
    success: boolean;
    latencyMs: number;
  }
  ```
  
  **External References**:
  - Express 中间件: https://expressjs.com/en/guide/using-middleware.html
  - constant-time comparison: 使用 crypto.timingSafeEqual

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] 无 API Key 请求：
    ```bash
    curl http://localhost:3001/api/accounts
    # 期望: 401 {"error": "Unauthorized"}
    ```
  - [ ] 有效 API Key 请求：
    ```bash
    curl -H "X-API-Key: admin_xxx" http://localhost:3001/api/accounts
    # 期望: 200 {"accounts": [...]}
    ```
  - [ ] 使用量上报：
    ```bash
    curl -X POST http://localhost:3001/api/usage \
      -H "X-API-Key: admin_xxx" \
      -H "Content-Type: application/json" \
      -d '{"accountEmail":"test@gmail.com","model":"gemini-3-pro","family":"gemini","tokens":{"total":100,"prompt":80,"candidates":20},"success":true,"latencyMs":500}'
    # 期望: 200 {"ok": true}
    ```
  - [ ] 检查访问日志已记录：
    ```bash
    sqlite3 data/antigravity.db "SELECT * FROM access_logs ORDER BY created_at DESC LIMIT 1;"
    # 期望: 看到刚才的请求记录
    ```

  **Commit**: YES
  - Message: `feat(server): add accounts and usage API endpoints`
  - Files: `src/routes/`, `src/middleware/`
  - Pre-commit: `npm run build`

---

- [x] 4. 管理面板开发

  **What to do**:
  - 使用 Vite + React + Tailwind 创建 client/ 目录
  - 实现 session-based 管理员认证
  - 账号管理页面：列表、添加、编辑、删除
  - API Key 管理页面：列表、添加、删除、重新生成
  - 统计页面：每日 token 用量柱状图、账号使用分布

  **Must NOT do**:
  - 不实现用户角色权限（只有 admin）
  - 不实现复杂报表
  - 不实现导入导出

  **Parallelizable**: YES（与 3 并行，依赖 2）

  **References**:
  
  **External References**:
  - Vite React 模板: https://vitejs.dev/guide/#scaffolding-your-first-vite-project
  - Tailwind CSS: https://tailwindcss.com/docs/installation
  - Recharts 图表库: https://recharts.org/en-US/examples

  **Acceptance Criteria**:
  
  **Manual Verification (Using Playwright)**:
  - [ ] 访问 `http://localhost:3001/admin` → 显示登录页面
  - [ ] 输入 admin 密码 → 成功登录，跳转到仪表板
  - [ ] 点击「账号管理」→ 显示账号列表
  - [ ] 点击「添加账号」→ 填写表单 → 保存 → 列表中出现新账号
  - [ ] 点击「API Key 管理」→ 显示 API Key 列表
  - [ ] 点击「生成 API Key」→ 显示新 Key（只显示一次）
  - [ ] 点击「统计」→ 显示 token 用量图表

  **Commit**: YES
  - Message: `feat(server): add React admin panel with accounts and statistics`
  - Files: `client/`
  - Pre-commit: `cd client && npm run build`

---

### Part 2: 插件改动

- [x] 5. 配置 Schema 扩展

  **What to do**:
  - 在 `src/plugin/config/schema.ts` 添加 `api_endpoint` 和 `api_key` 字段
  - 在 `src/plugin/config/loader.ts` 添加环境变量支持
  - 两个字段都是 optional，同时存在时启用远程模式

  **Must NOT do**:
  - 不修改现有配置的默认值
  - 不破坏向后兼容性

  **Parallelizable**: YES（与服务端并行）

  **References**:
  
  **Pattern References**:
  - `src/plugin/config/schema.ts:44-320` - 现有配置定义模式，使用 zod
  - `src/plugin/config/loader.ts:198-220` - 环境变量加载模式
  
  **API/Type References**:
  ```typescript
  // 新增字段
  api_endpoint: z.string().url().optional(),
  api_key: z.string().optional(),
  ```

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] `npm run typecheck` → 无错误
  - [ ] 创建测试配置文件：
    ```json
    // .opencode/antigravity.json
    {
      "api_endpoint": "http://localhost:3001",
      "api_key": "test_key"
    }
    ```
  - [ ] 启动 OpenCode → 无配置解析错误

  **Commit**: YES
  - Message: `feat(plugin): add api_endpoint and api_key config fields`
  - Files: `src/plugin/config/`
  - Pre-commit: `npm run typecheck`

---

- [x] 6. 远程账号获取

  **What to do**:
  - 在 `src/plugin/accounts.ts` 添加 `loadFromRemote()` 静态方法
  - 修改 `src/plugin/storage.ts` 的 `loadAccounts()` 支持远程获取
  - 添加 `_memoryOnly` 标记，禁用本地文件写入
  - 远程不可用时直接报错退出

  **Must NOT do**:
  - 不修改现有的账号选择算法（sticky/round-robin/hybrid）
  - 不实现本地缓存 fallback
  - 不修改 `saveToDisk()` 的持久化格式

  **Parallelizable**: NO（依赖 5）

  **References**:
  
  **Pattern References**:
  - `src/plugin/accounts.ts:loadFromDisk()` - 现有加载逻辑，新方法应该类似结构
  - `src/plugin/storage.ts:loadAccounts()` - 本地加载入口
  - `src/plugin.ts:774` - AccountManager.loadFromDisk(auth) 调用点
  
  **API/Type References**:
  ```typescript
  // loadFromRemote 签名
  static async loadFromRemote(
    apiEndpoint: string, 
    apiKey: string
  ): Promise<AccountManager>
  
  // 远程 API 响应格式
  {
    accounts: Array<{
      email: string;
      refreshToken: string;
      projectId?: string;
      managedProjectId?: string;
    }>
  }
  ```

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] `npm run typecheck` → 无错误
  - [ ] `npm run build` → 编译成功
  - [ ] 配置远程模式后启动 OpenCode：
    - 服务端运行中 → 成功获取账号，正常运行
    - 服务端未运行 → 报错退出，提示服务不可用
  - [ ] 检查本地无 `antigravity-accounts.json` 文件生成

  **Commit**: YES
  - Message: `feat(plugin): add remote account loading support`
  - Files: `src/plugin/accounts.ts`, `src/plugin/storage.ts`
  - Pre-commit: `npm run typecheck && npm run build`

---

- [x] 7. 使用量上报

  **What to do**:
  - 创建 `src/plugin/usage-reporter.ts` 封装上报逻辑
  - 在 `src/plugin.ts` 的 `transformAntigravityResponse` 之后注入上报
  - 从响应头获取 token 计数：`x-antigravity-total-token-count` 等
  - 异步上报，不阻塞主流程
  - 上报失败静默处理（只记录日志）

  **Must NOT do**:
  - 不阻塞主请求流程
  - 不重试失败的上报
  - 不缓存待上报数据

  **Parallelizable**: NO（依赖 6）

  **References**:
  
  **Pattern References**:
  - `src/plugin.ts:1514` - transformAntigravityResponse 返回点，注入上报
  - `src/plugin.ts:1595-1603` - token 计数 headers 读取逻辑
  - `src/plugin/debug.ts` - 日志记录模式
  
  **API/Type References**:
  ```typescript
  // POST /api/usage 请求格式
  {
    accountEmail: string;
    model: string;
    family: string;
    tokens: { 
      total: number; 
      prompt: number; 
      candidates: number;
    };
    success: boolean;
    latencyMs: number;
  }
  
  // Token headers
  'x-antigravity-total-token-count'
  'x-antigravity-prompt-token-count'
  'x-antigravity-candidates-token-count'
  ```

  **Acceptance Criteria**:
  
  **Manual Verification**:
  - [ ] `npm run typecheck` → 无错误
  - [ ] `npm run build` → 编译成功
  - [ ] 配置远程模式，发送一个请求：
    - 请求成功完成
    - 服务端日志显示收到使用量上报
  - [ ] 关闭服务端，发送请求：
    - 请求仍然成功（上报失败不影响主流程）
    - 插件日志显示上报失败警告

  **Commit**: YES
  - Message: `feat(plugin): add usage reporting to remote service`
  - Files: `src/plugin/usage-reporter.ts`, `src/plugin.ts`
  - Pre-commit: `npm run typecheck && npm run build`

---

- [x] 8. 集成测试

  **What to do**:
  - 启动服务端
  - 配置插件使用远程模式
  - 验证完整流程：获取账号 → 发送请求 → 使用量上报
  - 验证管理面板显示正确数据

  **Must NOT do**:
  - 不编写自动化测试（手动验证）

  **Parallelizable**: NO（最后一步）

  **References**:
  
  **Pattern References**:
  - 服务端 API 文档（任务 3 中定义）
  - 插件配置格式（任务 5 中定义）

  **Acceptance Criteria**:
  
  **Manual Verification (End-to-End)**:
  - [ ] 启动服务端：`cd ../antigravity-account-service && npm run dev`
  - [ ] 在管理面板添加一个测试账号
  - [ ] 生成一个 API Key
  - [ ] 配置插件 `antigravity.json`：
    ```json
    {
      "api_endpoint": "http://localhost:3001",
      "api_key": "生成的 key"
    }
    ```
  - [ ] 启动 OpenCode，发送一个测试请求
  - [ ] 验证服务端：
    - access_logs 表有访问记录
    - usage_records 表有使用量记录
  - [ ] 验证管理面板：
    - 统计页面显示 token 用量
    - 访问日志页面显示请求记录

  **Commit**: NO（验证步骤）

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(server): initialize Express + TypeScript project` | antigravity-account-service/ | npm run build |
| 2 | `feat(server): add database schema and initialization` | src/db/ | npm run dev + sqlite3 check |
| 3 | `feat(server): add accounts and usage API endpoints` | src/routes/, src/middleware/ | curl tests |
| 4 | `feat(server): add React admin panel with accounts and statistics` | client/ | npm run build |
| 5 | `feat(plugin): add api_endpoint and api_key config fields` | src/plugin/config/ | npm run typecheck |
| 6 | `feat(plugin): add remote account loading support` | src/plugin/accounts.ts, src/plugin/storage.ts | npm run build |
| 7 | `feat(plugin): add usage reporting to remote service` | src/plugin/usage-reporter.ts, src/plugin.ts | npm run build |

---

## Success Criteria

### Verification Commands
```bash
# 服务端
cd ../antigravity-account-service
npm run build     # 期望: 编译成功
npm run dev       # 期望: 服务启动

# 插件
npm run typecheck # 期望: 无错误
npm run build     # 期望: 编译成功
```

### Final Checklist
- [x] 服务端项目可独立运行
- [x] 管理面板可登录访问
- [x] 插件配置远程模式后正常工作
- [x] 使用量成功上报并在面板展示
- [x] 无本地账号文件生成（远程模式）
- [x] 上报失败不影响主请求流程
