# Learnings - Account Management Service

## 项目初始化 (2026-01-21)

### ESM 模式配置
- `package.json` 需设置 `"type": "module"`
- `tsconfig.json` 使用 `module: "NodeNext"` 和 `moduleResolution: "NodeNext"`
- Express + TypeScript 项目在 ESM 模式下运行良好

### 开发依赖
- `tsx` 用于开发模式热重载 (`tsx watch src/index.ts`)
- better-sqlite3 需要本地编译，安装时会有一些 deprecated 警告（可忽略）

### 端口注意
- 3001 端口可能被其他进程占用，启动前检查 `lsof -ti:3001`

## 数据库设计 (2026-01-21)

### SQLite WAL 模式
- `db.pragma('journal_mode = WAL')` 启用 WAL 模式优化并发写入
- 会创建 `.db-wal` 和 `.db-shm` 辅助文件

### API Key 生成
- 使用 `ak_` 前缀 + 24 字节 base64url 编码
- bcrypt 哈希存储（rounds=10）
- 仅在创建时显示一次完整 key

### 文件结构
- `schema.sql` 存放表定义，通过 `readFileSync` 加载
- `init.ts` 负责初始化逻辑，生成默认 admin key
- `index.ts` 导出单例数据库实例

### 注意事项
- ESM 模式需要 `import.meta.url` 获取 `__dirname`
- 内部导入需要 `.js` 扩展名（如 `./init.js`）

## 远程账号获取 (2026-01-21)

### AccountManager 远程模式
- `loadFromRemote(apiEndpoint, apiKey)` 静态方法从远程 API 获取账号
- 使用 `_memoryOnly = true` 标记禁用本地文件写入
- `saveToDisk()` 在 memory-only 模式下直接 return

### 远程 API 格式
```typescript
{
  accounts: Array<{
    email: string;
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
  }>
}
```

### 集成点
- `plugin.ts` 根据 `config.api_endpoint` + `config.api_key` 决定加载模式
- 远程模式绕过 OAuth auth 检查，直接使用远程账号
- 远程服务不可用时抛出错误，不提供 fallback
