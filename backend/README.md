# 后端开发与部署

当前已实现并部署 11 个接口、PostgreSQL 匹配事务、信用结算、申诉冲正与定时维护。UID 允许重复填写，需求、配额、库存占用和权限均按交换账号独立处理。前端目前仍调用模拟后端，真实后端的浏览器接入另行进行。

API 根地址：`https://lunar-arcanum-swap-d9cl8ad90b4e4-1252025612.ap-shanghai.app.tcloudbase.com/api/v1`。可通过 [配置接口](https://lunar-arcanum-swap-d9cl8ad90b4e4-1252025612.ap-shanghai.app.tcloudbase.com/api/v1/config) 检查服务；业务接口需要真实 CloudBase 会话。

## 本地开发

```powershell
npm ci
npm run start:backend
```

服务监听 `http://127.0.0.1:9000`，公开配置为 `/api/v1/config`。本地服务同样验证真实 CloudBase 令牌并读写云数据库，没有免鉴权调试模式。

本机运行配置位于已忽略的 `.secrets/backend.runtime.json`；生产环境将对应字段注入云函数环境变量。此文件及构建产物不提交 Git。

| 配置 | 用途 |
|---|---|
| `TCB_ENV` | 完整 CloudBase 环境 ID |
| `CLOUDBASE_APIKEY` | 仅服务端使用的 API Key，具有数据库服务端权限 |
| `CLOUDBASE_PUBLISHABLE_KEY` | 可公开的客户端密钥，由 `/config` 提供 |
| `SWAP_HMAC_SECRET` | 至少 32 字符的随机服务端密钥，用于哈希账号密钥、OpenID、设备和 IP |
| `SWAP_CUSTOM_LOGIN_PRIVATE_KEY` / `SWAP_CUSTOM_LOGIN_KEY_ID` | 生产环境分别注入 PEM 私钥及 key ID，仅 `swap-api` 需要；本地兼容 `SWAP_CUSTOM_LOGIN_KEY` JSON 字符串 |
| `SWAP_AUTHOR_MID` | UP主 mid；未配置时为空，正式前端接入时填写 |
| `SWAP_GATEWAY_CORS` | 默认 `true`，由 HTTP 网关处理跨域；直接部署且无网关时才设置为 `false` |
| `SWAP_CORS_ORIGINS` | 无网关直连模式的精确来源列表，逗号分隔 |
| `SWAP_TRUST_PROXY` | 网关部署设为 `true`，使用网关追加的最后一跳客户端 IP；本地设为 `false` |

## 接口约定

完整清单见 [概要设计](../docs/cloudbase-backend-design.md)。除配置和 B站身份建立入口外，业务请求均携带 `Authorization: Bearer <CloudBase access_token>`。匿名用户先通过 CloudBase SDK 匿名登录，B站用户用 `/session` 返回的 Ticket 完成 SDK 自定义登录；续期由 SDK 处理。

业务写请求携带 `Idempotency-Key`（8–128 位字母、数字、下划线或减号），同一操作的网络重试复用同一个值；修改请求内容需要新键。可同时携带随机生成并在本机保存的 `X-Device-Id`。匹配和列表中的时间为毫秒时间戳。

`POST /listings` 提交 `{ give: { "17": 2 }, want: [1, 2], mode: "quick", note: { preset: "anytime" } }`。编辑还需携带当前需求 `version`，give / want 表示尚未占用的部分，已经进入匹配的占用单独保留。`POST /matches/:id/confirm` 的 `completedPairs` 是零起始索引；省略时确认全部交换对。

错误格式为 `{ error: { code, message, retryAt? }, requestId }`。幂等重放会重新校验匹配可见性，已结束的交换不会从旧响应再次返回对方完整 UID。重复 UID 正常成功，响应不包含重复标记。

## 数据库与构建

数据库环境：`lunar-arcanum-swap-d9cl8ad90b4e4`，国内站上海地域，PostgreSQL 模式。迁移按文件名顺序保存在 `cloudbase/migrations/`，已经应用的文件保持不变，后续修改新增版本。

业务表位于 `public`，均启用 RLS 并撤回客户端直接访问权限；业务 RPC 仅授予 `service_role`。`swap_private` 中存放内部事务辅助函数、限流记录和信用流水。信用流水用于申诉后重新计算处罚，客户端不能读取。

```powershell
npm run build:backend
npm run package:backend
```

构建会将依赖打包到 `cloudfunctions/swap-api/index.js` 和 `cloudfunctions/swap-maintenance/index.js`，ZIP 产物位于 `output/backend/`。打包脚本显式为 `scf_bootstrap` 设置 LF 和 Linux 可执行权限。

## CloudBase 发布

1. 已应用 `20261113060000_init_swap`、`20261113064000_transport_errors` 和 `20261113065000_history_cursor` 三个迁移；匿名登录和自定义登录均已启用并通过真实登录验证。
2. 使用 CloudBase MCP `queryFunctions(action="getFunctionUploadUrl")` 获取上传地址，PUT 对应 ZIP，再将返回的 COS 三元组原样交给 `manageFunctions(action="createFunction", code=...)`。现有函数更新使用 `updateFunctionCode`。每次上传地址临时获取，不保存签名 URL。
3. `swap-api` 使用 HTTP 类型、`Nodejs20.19`、30 秒超时，注入运行配置；`swap-maintenance` 使用 Event 类型、相同运行时、`index.main` 入口和 60 秒超时，只需要环境 ID、服务端 API Key 和 HMAC 密钥。
4. 为维护函数创建 `timer` 触发器，7 段 cron 为 `0 * * * * * *`，每分钟执行。维护 RPC 可以重复执行，避免重试时重复结算。
5. HTTP 网关 `/api/v1` 路由到 `swap-api`，上游类型 `WEB_SCF`，开启完整路径透传。保留函数内业务鉴权；只放通网关公共入口不能放通数据库 RPC 或维护函数。
6. 为 B站及实际独立站来源配置安全域名，随后以真实访问令牌验证 `/state`，不要仅以 `/health` 判断数据库访问正常。

本次使用官方 CLI 3.9.2 从本地配置直接部署，两个函数已处于 Active 状态，`every-minute` 触发器和网关路径透传均已配置。已部署 API 的真实匿名 / 自定义登录、重复 UID、并发占用、请求幂等、权限隔离与完成结算均通过联调。

需要重新发布时，先运行 `node scripts/prepare-backend-deploy.mjs --key-file <私钥文件路径>`，脚本直接读取原始私钥并生成已忽略的 `.secrets/cloudbaserc.deploy.json`。然后执行：

```powershell
npm run build:backend
npx --yes --package @cloudbase/cli@3.9.2 tcb fn deploy swap-api --httpFn --install-dependency false --config-file .secrets/cloudbaserc.deploy.json --env-id lunar-arcanum-swap-d9cl8ad90b4e4 --region ap-shanghai --force
npx --yes --package @cloudbase/cli@3.9.2 tcb fn deploy swap-maintenance --install-dependency false --config-file .secrets/cloudbaserc.deploy.json --env-id lunar-arcanum-swap-d9cl8ad90b4e4 --region ap-shanghai --force
```

CLI 会把 JSON 形态的环境变量解析为对象，因此发布脚本将签票私钥拆成 PEM 与 key ID 两个字符串字段，未将密钥写进代码包。不要把 `.secrets` 中的实际发布配置提交到 Git。

待接入事项：当前体验版拒绝添加 `www.bilibili.com` 安全域名，真实 B站来源的认证预检返回 403，API 预检也未返回允许来源头。正式接入 Toy / 外站前需在支持安全域名配置的套餐中添加实际来源；本次没有变更付费套餐。UP主 mid 也仍需填写。当前前端继续使用模拟接口。

## 验证

```powershell
npm run test:backend
npm test
npm run test:backend:cloud
# 已部署 API 的同一套真实联调：
node scripts/check-backend-cloud.mjs --url https://实际网关域名/api/v1
```

常规测试使用 PGlite 执行实际 PostgreSQL 迁移和事务，覆盖账号隔离、重复 UID、额度、占用、部分完成、申诉冲正、超时、幂等及 HTTP 输入边界。云端联调会创建独立测试身份，验证真实匿名 / 自定义登录、并发匹配和数据库权限，结束后撤回测试身份的等待需求；不要将该命令作为每次前端构建的一部分。

本次验证：28 项后端测试通过，已部署 API 联调和维护函数调用通过，前后端构建通过。全项目测试为 82 / 83；现有 `tests/miyoushe-import.test.js:22` 的图片导入测试仍期待保留快速选牌，而当前图片导入实现会重建选牌，该断言不一致未在本次后端开发中改动。

服务端 API Key 名为 `lunar-swap-backend`，由环境维护者负责轮换或撤销。轮换后需同时更新 API 与维护函数。HMAC 密钥关联现有账号凭据哈希，不能直接替换；需要另做兼容迁移。自定义登录私钥轮换后仅更新 API 函数，原文不进入日志或响应。
