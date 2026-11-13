# 后端开发与部署

当前已实现并部署 11 个接口、PostgreSQL 匹配事务、信用结算、申诉冲正与定时维护。UID 允许重复填写，需求、配额、库存占用和权限均按交换账号独立处理。前端通过 `npm run dev:online` 连接已部署 API，默认 `npm run dev` 继续使用模拟后端。

API 根地址：`https://lunar-arcanum-swap-d9cl8ad90b4e4-1252025612.ap-shanghai.app.tcloudbase.com/api/v1`。可通过 [配置接口](https://lunar-arcanum-swap-d9cl8ad90b4e4-1252025612.ap-shanghai.app.tcloudbase.com/api/v1/config) 检查服务；业务接口需要真实 CloudBase 会话。

## 本地开发

本地前端连接线上后端：

```powershell
npm run dev:online
```

打开终端显示的本地地址（默认 `http://127.0.0.1:5173/`），即可通过页面执行真实操作。此模式只使用公开配置和 Web SDK 会话，不需要本地后端运行配置。普通窗口与无痕窗口可以作为两个独立账号测试；操作会写入线上数据库，并受真实额度限制。

如需开发和调试后端代码，再启动本地后端服务：

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

`GET /config` 只返回 `{ authorMid, cloudbase: { envId, publishableKey } }`，供前端获取当前部署的公开登录参数和 UP 主配置。服务器名称、时区、UID 规则、留言预设、固定限制和功能标志等静态数据随前端代码打包，不再由接口重复下发。后端仍复用规则校验 UID、留言和业务额度。

给对方的留言提供中文快捷短语和固定换牌时段，只能从前端本地预设中任选一项，或传 `null` 表示不选。匿名和 B站账号均不支持 `note.text` 自定义留言，发布与编辑接口统一拒绝。

任一方提交交换完成后，双方本轮需求即结束，剩余给出 / 想要不会自动继续匹配；已有匹配和预留卡牌保留到各自结算。另一方仍可查看 UID 并确认结果。双方主动确认相同的完成项，或单方确认后到期自动完成并成功结算时，立即清除双方主动发布 / 重新匹配冷却，恢复各 1 次额度；同一笔交换只恢复一次，等待对方确认期间、失败和争议均不恢复。当前交换全部结束后，用户重新选牌并发布下一轮。正常额度按各服下一次 04:00 刷新；信用处罚冷却为 7 天，与发布额度分开。只有尚未提交成功声明的等待需求，才会在失败释放后回到匹配池。

首次声明完成后，`expiresAt` 改为首次确认时间加 10 分钟，重复确认不会延长。对方在截止前主动确认相同完成项，双方结算时各加 6 信用分；到期仍未响应，由维护任务自动完成，主动确认者加 6 分、未响应方加 2 分。自动结算保留真实的确认记录，同时恢复双方各 1 次发布额度；页面每 10 秒轮询及返回前台时同步更新次数。维护任务每分钟执行，因此到期后的实际结算可能有不到 1 分钟的调度延迟；双方均未确认的匹配仍按原有 48 小时有效期处理。

错误格式为 `{ error: { code, message, retryAt? }, requestId }`。幂等重放会重新校验匹配可见性，已结束的交换不会从旧响应再次返回对方完整 UID。重复 UID 正常成功，响应不包含重复标记。

`GET /state?light=1` 用于轮询，返回当前交换、额度和账号信息，`history`、`stats` 为 `null`；首次加载、操作后和重新进入前台请求完整 `/state`。前端复用最近一次历史和统计，发现进行中的交换结束时立即补拉完整状态。无需求或进行中交换时不轮询，仅等待匹配每 30 秒刷新，交换进行中每 10 秒刷新，页面隐藏时停止。

## 空闲维护与费用控制

每分钟维护改为先列举现有 COS 桶 `_swap-maintenance/v1/` 内的到期索引，未到期或没有任务时不访问 PostgreSQL。索引只含时间与随机 ID，不含 UID、账号和密钥。资源配置在 `backend/runtime-resources.json`，仅匹配该环境时启用；跨环境部署必须配置对应桶，不会复用本环境资源。

所有业务写入先由 API 带服务端签名调用维护函数，持久化独立唤醒信号后才执行数据库事务。信号保留 2 分钟写入租约；事务在获取分区锁后再次校验租约，避免函数延迟或失败造成任务遗漏。租约到期后维护函数进行一次合并检查，返回下一次交换到期、信用恢复或清理时间并保存为独立计划。先保存新计划再清理旧快照，并发产生的新信号不删除；存储或数据库失败时保留旧信号供重试。

自动确认仍按首次确认时间加 10 分钟触发，定时任务最多有约 1 分钟调度延迟。维护函数每次从 Event 上下文重新读取临时 COS 凭据；HTTP API 函数只使用现有服务端 API Key 和 HMAC，未新增长期密钥。定时入口验证平台注入的 `TRIGGER_SRC`，其他维护操作必须通过 HMAC 校验。

空闲维护规则已包含在统一初始化 `20261114050000_init_swap`，两个云函数已部署。新环境的发布顺序为初始化数据库、维护函数、API 函数，随后运行 `node scripts/check-maintenance-cloud.mjs --run` 同步到期计划，再用 `node scripts/check-maintenance-cloud.mjs` 检查索引；后者不访问数据库。修改维护资源配置后需重新构建、部署两个函数。紧急回退可将资源配置中的 `maintenanceEnabled` 改为 `false` 并重新部署两个函数，恢复每分钟维护；保留数据库定义即可。

## 数据库与构建

数据库环境：`lunar-arcanum-swap-d9cl8ad90b4e4`，国内站上海地域，PostgreSQL 模式。项目尚未发布，原有 8 个迁移已合并为唯一初始化文件 `cloudbase/migrations/20261114050000_init_swap.sql`，空库直接创建最终表结构、索引、函数、触发器和权限，不保留旧数据回填或历史升级兼容路径。初始化文件只负责创建，不包含清空数据库的操作。

2026-11-14 已按未发布环境重置生产业务数据库，业务账号、玩家资料、换牌需求、匹配、反馈、屏蔽、幂等记录、限流及信用流水均为空，远端迁移记录仅保留统一初始化版本。CloudBase 的认证配置、系统账号、密钥及存储配置保留；维护到期索引已同步为空。此次合并没有修改业务 RPC 的接口，无需重新部署现有云函数。

业务表位于 `public`，均启用 RLS 并撤回客户端直接访问权限；业务 RPC 仅授予 `service_role`。`swap_private` 中存放内部事务辅助函数、限流记录和信用流水。信用流水用于申诉后重新计算处罚，客户端不能读取。

```powershell
npm run build:backend
npm run package:backend
```

构建会将依赖打包到 `cloudfunctions/swap-api/index.js` 和 `cloudfunctions/swap-maintenance/index.js`，ZIP 产物位于 `output/backend/`。打包脚本显式为 `scf_bootstrap` 设置 LF 和 Linux 可执行权限。

## CloudBase 发布

1. 空库应用唯一初始化 `20261114050000_init_swap`。生产环境已经应用，无需重复执行。该定义直接包含微秒历史游标、安全业务错误、确认后结束本轮需求、10 分钟自动确认、主动 +6 / 自动 +2、成功恢复双方各 1 次额度和按需维护。匿名登录和自定义登录均已启用并通过真实登录验证。
2. 使用 CloudBase MCP `queryFunctions(action="getFunctionUploadUrl")` 获取上传地址，PUT 对应 ZIP，再将返回的 COS 三元组原样交给 `manageFunctions(action="createFunction", code=...)`。现有函数更新使用 `updateFunctionCode`。每次上传地址临时获取，不保存签名 URL。
3. `swap-api` 使用 HTTP 类型、`Nodejs20.19`、30 秒超时，注入运行配置；`swap-maintenance` 使用 Event 类型、相同运行时、`index.main` 入口和 60 秒超时，只需要环境 ID、服务端 API Key 和 HMAC 密钥。
4. 为维护函数创建 `timer` 触发器，7 段 cron 为 `0 * * * * * *`，每分钟检查 COS 到期索引，只有任务到期才执行维护 RPC。维护 RPC 可以重复执行，避免重试时重复结算。
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

待接入事项：当前体验版拒绝添加 `www.bilibili.com` 安全域名，真实 B站来源的认证预检返回 403，API 预检也未返回允许来源头。正式接入 Toy / 外站前需在支持安全域名配置的套餐中添加实际来源；本次没有变更付费套餐。UP主 mid 也仍需填写。本地 localhost / 127.0.0.1 的认证及 API 预检已通过，online 前端模式可直接测试匿名交换流程。

## 验证

```powershell
npm run test:backend
npm test
# 本地 HTTP 服务连接真实云数据库：
npm run test:backend:cloud
# 直接验证当前已部署的线上 API，无需手动启动本地后端：
npm run test:backend:online
# 如需验证其他部署地址：
node scripts/check-backend-cloud.mjs --url https://实际网关域名/api/v1
```

`test:backend:cloud` 和 `test:backend:online` 都需要本机已有 `.secrets/backend.runtime.json`；线上验证成功时输出 `"ok": true` 和 `"mode": "deployed-api"`。

常规测试使用 PGlite 执行实际 PostgreSQL 迁移和事务，覆盖账号隔离、重复 UID、额度、占用、部分完成、申诉冲正、超时、幂等及 HTTP 输入边界。云端联调会创建独立测试身份，验证真实匿名 / 自定义登录、并发匹配和数据库权限，结束后撤回测试身份的等待需求；不要将该命令作为每次前端构建的一部分。

统一初始化已通过与原 8 个迁移的 PostgreSQL 目录对比，函数、触发器、表结构、索引及权限一致；当前本地全量 62 项测试通过，包含空库与新账号初始状态、数据库事务、轻量状态合并、空闲轮询、信号持久化、并发维护与失败重试。重置后复核业务表为空、远端仅有一条初始化迁移、维护任务数量为 0。此前两个独立会话已通过实际前端 SDK 和 API 适配器完成线上登录、UID 保存、发布、版本编辑、匹配、查看 UID 与双方确认结算；本次重置后的验证不运行会创建测试数据的云端联调。内置浏览器此前连接不可用，未完成页面点击和 B站真机验证。

服务端 API Key 名为 `lunar-swap-backend`，由环境维护者负责轮换或撤销。轮换后需同时更新 API 与维护函数。HMAC 密钥关联现有账号凭据哈希，不能直接替换；需要另做兼容迁移。自定义登录私钥轮换后仅更新 API 函数，原文不进入日志或响应。
