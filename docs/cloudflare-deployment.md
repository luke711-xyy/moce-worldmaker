# 莫测造境 Cloudflare 部署

## 架构

- React/Vite 静态资源由 Cloudflare Workers Static Assets 托管。
- `worker/index.ts` 提供同源 `/api/*` API。
- D1 保存用户隔离后的对象元数据、列表索引和类别索引。
- R2 保存完整场景文件和模板实体 JSON，避免把大体素数据塞进 D1 查询结果。
- Cloudflare Access 负责邮箱一次性验证码登录；Worker 使用 `Cf-Access-Authenticated-User-Email` 做数据隔离。
- 浏览器仍可使用本地草稿；线上云端是明确点击保存后的权威数据。

## 第一次初始化

1. 在 Cloudflare Dashboard 的 R2 页面启用 R2。当前账户若未启用，`wrangler r2 bucket create` 会返回 code `10042`。
2. 创建两个桶：

   ```bash
   npx wrangler r2 bucket create moce-worldmaker-staging
   npx wrangler r2 bucket create moce-worldmaker
   ```

3. `wrangler.jsonc` 已写入当前账户创建的两个 D1 ID；R2 桶名称与配置一致。
4. 执行 D1 迁移：

   ```bash
   npm run db:migrate:staging
   npm run db:migrate:production
   ```

5. 将现有本地 JSON 数据迁移到 staging。迁移脚本只读取本地数据库，不会修改它，也不会把数据库提交到 Git：

   ```bash
   npm run migrate:staging
   ```

   如需指定数据归属邮箱：

   ```bash
   node scripts/migrate-json-to-cloudflare.mjs --owner you@example.com
   ```

## 本地开发

```bash
npm install
npm run dev
```

本地 `server/persistence.mjs` 仍保留，便于继续使用 `data/moce-world-db.json` 做离线开发。Cloudflare Worker 的类型检查使用：

```bash
npm run typecheck:worker
```

## 部署

```bash
npm run deploy:staging
npm run deploy
```

前者部署 `moce-worldmaker-staging`，后者会先以 `CLOUDFLARE_ENV=production` 构建，再部署构建产物中已经展平为 production 的 `moce-worldmaker` 配置。不要只给 `wrangler deploy` 传 `--env production`；Vite 插件的环境选择发生在构建阶段。

## Cloudflare Access

在 Zero Trust → Access → Applications 中为 staging 和 production 的 Worker 地址创建 Self-hosted application：

- Policy：Allow
- Selector：Emails
- Value：公司受邀同事的邮箱地址
- 登录方式：One-time PIN

Access 放行后会注入 `Cf-Access-Authenticated-User-Email`。Worker 没有收到该请求头时，在非本地环境拒绝 API 请求；因此即使有人绕过前端直接请求 API，也不会拿到其他用户的数据。

为避免只伪造邮箱请求头，Worker 还会验证 `Cf-Access-Jwt-Assertion` 的 RS256 签名、issuer、audience、邮箱和有效期。创建 Access application 后，为每个环境写入两项 secret：

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUDIENCE
npx wrangler secret put ACCESS_TEAM_DOMAIN --env production
npx wrangler secret put ACCESS_AUDIENCE --env production
```

`ACCESS_TEAM_DOMAIN` 使用类似 `https://your-team.cloudflareaccess.com` 的地址；`ACCESS_AUDIENCE` 使用 Access application 的 Audience Tag。未配置这两个 secret 时，线上 API 会返回 503，而不是降级为不安全的匿名模式。

## GitHub Actions

仓库需要配置两个 Actions secrets：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Token 至少需要 Workers、D1 和 R2 的部署权限。合并到 `main` 后，`.github/workflows/deploy.yml` 会先执行 production D1 migration，再构建并部署 Worker。

## 数据边界

场景文件只保存当前场景重建所需的实体快照；资产库模板不会因为保存场景而被全部嵌入。Worker 读取场景时会把场景快照和当前用户的模板资产合并为编辑器所需的 `ProjectState`。同名资产、场景名称和类别都在当前用户范围内处理。
