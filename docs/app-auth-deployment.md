# 莫测造境应用认证上线说明

## Cloudflare Access

主站不能继续使用旧的整站 Access 应用，否则 `/api/auth/*` 和自定义登录页会在 Worker 之前被拦截。

1. 在 Zero Trust → Access → Applications 中找到 `moce-worldmaker.xuyiyang038.workers.dev` 的旧应用。
2. 将旧应用删除或改为只匹配 `/admin`。
3. 如果新建应用，域名填写 `moce-worldmaker.xuyiyang038.workers.dev`，路径填写 `/admin*`。
4. 管理员策略只允许 `xuyiyang038@gmail.com`。
5. 主站根路径 `/`、`/api/auth/*` 和普通 `/api/*` 不应再受 Access 拦截；它们由莫测造境自己的邮箱密码认证保护。

Worker 内部仍会校验 Access JWT 和管理员邮箱，因此即使其他邮箱仍残留在 Access 策略中，也不能访问 `/admin`。

## Resend

生产环境必须配置已验证域名的发件地址和 API key：

```bash
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put RESEND_FROM --env production
```

`RESEND_FROM` 示例：`莫测造境 <no-reply@example.com>`。不要把 API key 写入仓库或 `wrangler.jsonc`。

## 发布与检查

```bash
npm run db:migrate:production
npm run typecheck:worker
npm run build
npm test -- --run
npm run deploy
```

发布后应验证：

- 访问 `/` 能看到自定义登录/注册入口；
- 未登录调用业务 API 返回 401；
- 注册后收到验证邮件，验证后可以登录；
- 访问 `/admin` 时只有 `xuyiyang038@gmail.com` 的 Cloudflare Access 会话可以通过。
