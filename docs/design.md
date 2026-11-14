# LunarArcanumSwap — 更好的原神 · 月谕圣牌交换站 设计文档

> 版本：v0.7（精简并同步实现现状）· 更新：2026-11-13
> 状态：前端已实现（`npm run dev` 用模拟后端，`npm run dev:online` 连接已部署的 CloudBase API）；后端 11 个接口、PostgreSQL 事务与定时维护已部署。
> 相关文档：[后端概要设计](cloudbase-backend-design.md) · [后端说明与发布](../backend/README.md) · [Box 字母码](box-code.md) · [Toy SDK 能力](toy-js-sdk-abilities.md) · 图片导入：[自适应识别](miyoushe-box-import-flexible.md)、[宽高归一化](miyoushe-box-import-adaptive.md)、[素材准备](miyoushe-box-import.md)
> 当文档与代码不一致时，以代码和 [后端说明](../backend/README.md) 为准。

---

## 1. 项目概述

为《原神》玩家提供月谕圣牌的**交换撮合**：玩家填写「我有什么多余的、我缺什么」，网站找到正好能互换的人，双方在游戏内加好友完成交换。**网站只做信息匹配，不经手任何游戏内物品。**

### 1.1 设计原则

- **移动端优先**：按 360–430px 设计，PC 为放宽版（≥1024px 侧栏布局）。
- **3 步上手**：填 UID → 选牌 → 发布。不注册、不登录。
- **本地优先**：Box 存本地；只有发布换牌需求时才把 give / want 交给后端，后端不保存完整 Box。
- **一套代码，两处部署**：B站 Toy 与独立静态站；SDK 能力按环境检测，缺失时降级，不缺页不报错。
- **卡牌即界面**：深色低饱和 UI，把视觉焦点让给卡面；特效可一键关闭。

### 1.2 范围

**包含**：Box 管理（快速 / 完整）、UID → 服务器识别、UID 脱敏与按需展示、即时 1 对 1 匹配、结果确认、信用与限频、中英双语、Box 字母码导入导出、米游社截图导入 Box、交换名片图片、B站 Toy 与独立站双部署。

**不包含**：自建注册登录、站内聊天、排行榜、单向赠送、三人及以上环形交换（预留扩展点）、Web Push、Service Worker / PWA（当前未实现）。

---

## 2. 核心概念与规则

### 2.1 术语

| 术语 | 含义 |
|---|---|
| 圣牌 | 22 种月谕圣牌，`id` 1–22。元数据在 `src/data/cards.js`。 |
| Box | 每种牌的持有数（0–99）。 |
| 保留数 | 每种牌自留张数，默认 1，可全局设为 0 / 1 / 2。 |
| 可换 | `max(持有 − 保留, 0)`。缺少 = 持有 0，默认即「想要」；已拥有的牌不能加入想要。 |
| 换牌需求 | 匹配池中的一条需求：`give`（带数量）+ `want`。UI 文案统一称「换牌需求」，按钮「帮我找人换牌」。 |
| 匹配 | 两个需求配成的一组交换，含 1–3 对「你给 X ⇄ 你得 Y」。 |
| 分区 | 能互加好友的服务器集合，匹配只在同分区内进行。 |
| 账号 | 交换身份，`bili` 或 `anon`。保存 1 个当前原神 UID。 |
| 原神 UID | 仅为游戏匹配与加好友信息，不验证归属，**允许不同账号重复填写**，不提示重复。 |
| 运行环境 | `toy-app` / `toy-web` / `standalone`。 |

圣牌中文名、英文名与主色见 `src/data/cards.js`（官方译名；愚者编号为 XXII）。中文界面不带序号和分隔点（「星」），英文界面用短名（The Star），详情中显示全名。

### 2.2 交换规则

- **严格 1 换 1**；双方需先在游戏内互加好友，跨服不能加。
- **主动方上限 3 对**：发布 / 重新匹配时的即时扫描最多配 3 对；**被动等待方不限次数**，但每个匹配仍最多 3 对。
- 不提供单向赠送。

### 2.3 UID → 服务器（`src/lib/uid.js`，前后端同一规则）

| UID | 服务器 | 分区 |
|---|---|---|
| 9 位首位 1 / 2 / 3 | 天空岛 | `cn` |
| 9 位首位 5 | 世界树（与天空岛互通） | `cn` |
| 9 位首位 6 / 7 / 8 / 9 | 美服 / 欧服 / 亚服 / 港澳台服 | `us` / `eu` / `asia` / `tw` |
| 10 位前缀 `18` | 亚服 | `asia` |
| 其他 | 无法识别，不能继续 | — |

格式：纯数字、9 或 10 位、不能全相同或明显顺序串。

---

## 3. 运行环境与用户类型

### 3.1 环境判定（`src/platform/`）

| 环境 | 判定 |
|---|---|
| `toy-app` | 在 B站域名（`bilibili.com` / `bilibilitoy.com` 及子域）加载 Toy SDK，且 `isSupport('closeBrowser')` 为 true |
| `toy-web` | 同上但 `closeBrowser` 不可用（浏览器中打开） |
| `standalone` | 非 B站域名，或 SDK 加载失败 |

SDK 由 `toy-sdk-loader.js` 按域名动态加载（不再用构建变量区分两种包）；本地开发由 `src/mock/toy-sdk.js` 模拟。业务代码只用 `platform`，不直接访问 `window.toy`。`exchange-site.js` 负责根据当前环境生成独立站 / Toy 页面链接（用于分享、二维码、名片）。

### 3.2 两类用户

| | **B站用户 `bili`** | **匿名用户 `anon`** |
|---|---|---|
| 条件 | Toy 中且云存储可读写（已登录 B站） | 其他所有情况 |
| 身份 | 账号密钥存 B站云存储，`/session` 换取 CloudBase 自定义登录 Ticket | CloudBase 匿名登录，首次发布时才建号 |
| 跨设备 | 自动（Box 与偏好同步到云存储） | Box 字母码导入 / 导出，身份仍属原设备 |
| 查看 UID 前 | 需先关注 UP主（客户端引导，失败 / 不支持时放行） | 无 |
| 匹配规则、信用、额度 | **完全相同** | **完全相同** |

后端无法校验「是否真是 B站用户」（SDK 不提供 B站 UID，`toyOpenId` 不是凭证），所以 B站身份只带来**便利**，不带来匹配特权；风控一律以交换账号、设备和 IP 为准。信用、额度、屏蔽均记在**交换账号**上，相同 UID 的其他账号互不影响。

### 3.3 身份流程

- **bili**：读云存储 `cred`（不弹授权窗）→ 有则 `POST /session {credential}`，无则 `POST /session` 新建并写回云存储。除限流（`307044`，指数退避）外任何错误都按匿名处理。用户主动点击头像入口才调用 `getUserProfile`（平台授权弹窗），`toyOpenId` 仅以 HMAC 形式用于去重，原文不落库、不进日志。
- **anon**：浏览和编辑 Box 全在本地；首次发布时 SDK 匿名登录。
- 不同账号填同一 UID 正常保存与匹配；不提供账号合并，Box 字母码只迁移收藏数据。

### 3.4 SDK 能力使用

| 能力 | 用途 | 降级 |
|---|---|---|
| 云存储 | 身份密钥、Box / 偏好同步 | localStorage |
| `getUserProfile` | 可选的 B站头像昵称、toyOpenId 去重 | 月相头像 |
| `share` / `getQrCode` / `saveImageToAlbum` | 邀请分享、电脑端扫码继续、保存交换名片 | Web Share → 复制链接；包内 `qrcode-generator`；`<a download>` |
| `onContainerChange` | 安全区 | CSS `env(safe-area-inset-*)` |
| `getAuthorRelation` / `getAuthorProfile` / `navigate` | 关注 UP主 引导 | 不拦截 / 仅文字 / 外链 |
| 排行榜、`setContainerMode`、`closeBrowser`、`requestCamera` | 不使用 | — |

约束：调用前先 `isSupport`；错误统一包装为 `PlatformError { kind }`；云存储写入防抖 5 秒，切后台立即写；`307044` 按 2s→4s→8s 退避最多 3 次。

云存储仅用 5 个 key：`cred`、`box`、`quick`、`prefs`、`sync`。冲突按 `updatedAt`，双方都有新改动时让用户选「云端 / 本机」。

### 3.5 部署

- 同一份 `vite build`（`base: './'`，相对路径，可部署在域名根或 `/toy/<slug>/` 子路径）；`npm run build:online` 连接线上 API。构建后自动把 `dist` 打包为 `output/dist.zip`（online 模式为 `dist-online.zip`）。
- 全部资源本地打包（Cinzel woff2 子集、Alpine 本地副本），不依赖外部 CDN。
- 后端 API 根地址由 `VITE_API_BASE_URL`（`.env.online`）配置。B站 / 外站来源的网关安全域名尚待配置，见 [后端说明](../backend/README.md)。

---

## 4. 信息架构与导航

- 路由（hash）：`#/welcome`（首次或未填 UID）、`#/box`（默认）、`#/trade`、`#/me`；匹配详情为 `#/trade` 内的视图。
- 手机：底部 3 标签（我的Box / 交换 / 我的），交换标签显示新匹配角标；安全区写入 `--safe-bottom`。PC（≥1024px）改左侧竖排导航。
- 引导流程：引导页 → ① UID（实时服务器徽章）→ ② 选择快速 / 完整 → ③ 确认给出与想要 → 发布 → 交换页。每步内容实时保存在本地。

---

## 5. 核心流程与规则

### 5.1 匹配生命周期

`草稿 → 等待中 → 已匹配 → 待确认 → 完成 / 失败 / 过期 / 争议`

| 状态 | 文案 |
|---|---|
| `waiting` | 等待匹配中 |
| `matched` | 已匹配 · 点击开始交换（未 reveal）/ 交换中 · 加好友（已 reveal） |
| `confirming` | 等待对方确认 |
| `completed` / `failed` / `expired` | 交换完成 / 未完成 / 已超时 |

### 5.2 UID 脱敏

**交换前任何 UID 都脱敏；只有点击「开始交换」（reveal）后才显示对方完整 UID。** 脱敏保留前 3 后 2（`812****78`）。

- 自己的 UID 默认脱敏，点 👁 临时显示 3 秒。
- 等待中不显示他人 UID；已匹配未 reveal 为脱敏；reveal 后到匹配结束前显示完整 UID；结束后、历史、Toast、分享内容一律脱敏。
- **后端强制**：`POST /matches/:id/reveal` 之前 `/state` 只返回 `uidMasked`；reveal 不可撤销并记录时间，对方会看到「对方已开始交换」。

### 5.3 加好友

不区分发起方；双方 reveal 后谁先看到谁先加。提供「复制 UID」和「复制申请留言」（从复制者视角生成，只描述交换内容，如 `换月谕圣牌：我给你「星」，换你的「塔」`）。

### 5.4 关注 UP主（仅 bili）

点击「开始交换」→ `getAuthorRelation`：已关注或 `isAuthor === true`（作者本人）直接 reveal；明确未关注才弹 `FollowGateSheet`（去关注 → 返回页面自动复查 / 我已关注 → 手动复查）；调用失败、`unsupported`、限流或关注字段缺失一律放行并提示，无法判断不缓存为已关注。两个关注入口的跳转错误均显示提示，区分 UP主空间未配置、不支持跳转及浏览器拦截。仅客户端引导，不是安全措施；`authorMid` 由 `/config` 下发，当前配置为字符串 `3546777483479879`。

### 5.5 确认与结算

- 匹配有效期 **48 小时**，从匹配成立起算。
- 任一方提交「完成」后，双方本轮需求结束，剩余给出 / 想要不再自动匹配；另一方仍可查看 UID 并确认。
- 首次声明完成后截止时间改为**首次确认 + 10 分钟**（重复确认不延长）：
  - 对方在截止前确认相同完成项 → 双方各 +6 信用；
  - 到期未响应 → 维护任务自动完成，主动确认者 +6、未响应方 +2。
- 双方确认相同完成项，或单方确认后自动完成成功结算时，**立即清除双方的发布冷却，各恢复 1 次额度**（同一笔交换只恢复一次）；失败、争议、等待期间不恢复。
- 支持按对勾选完成项（零起始索引 `completedPairs`，省略即全部）；确认后 Box 自动更新。集齐 22/22 播放满月动画。
- 「遇到问题」按单选原因（对方未加好友 / 未回应 / 没有牌 / 不想换 / 我无法完成 / 其他）决定处罚对象，用户只看到结果；被报告方 24 小时内可申诉（按争议处理，后端可冲正信用）。

---

## 6. 页面概要

- **引导页 `#/welcome`**：标题 BetterGI、卡牌展示、UID 输入与服务器徽章（未通过校验时按钮保持可点，Toast 说明原因并聚焦输入框）；B站用户有可选「用 B站头像昵称」入口。
- **我的 Box `#/box`**：顶部分段「快速交换 | 完整 Box」，两种模式选牌各自独立保存。
  - 完整 Box：22 格网格、月相收藏进度、缺少 / 可换统计；卡牌状态为缺少 / 持有 / 可换（`+N`）/ 已锁定；底部抽屉编辑数量与想要；支持批量编辑。
  - 快速交换：两段式选择「我能给出」「我想要」，同一张牌不能同时出现。
  - **截图导入**：入口在 Box 页，本地识别米游社导出的 Box 图片（颜色分割 + 牌框定位，不依赖固定分辨率），生成草稿由用户确认后写入，纯前端，识别资源在 `assets/recognition/`。
  - **发布确认抽屉**：留言可选一项（再点取消）——快捷短语（今晚 20 点后在线 / 随时可加 / 工作日晚上 / 周末全天在线）或固定时段（08–12、12–14、14–18、18–20、20–24、00–08）。**不支持自定义文本**，前后端都按预设白名单校验，对方按自己的语言显示，仅匹配成功后可见。
- **交换 `#/trade`**：我的换牌需求（分区在线人数、稀缺提示、撤回 / 重新匹配）、待完成的交换、历史记录（脱敏 UID）。匹配成立播放可跳过的揭晓动画；详情页 reveal 前后两种状态，reveal 后以逐位「解码」显示 UID。
- **交换名片**：把交换内容渲染为图片（`src/lib/exchange-card.js`），SDK 激活时通过 `sharePicture({ base64Data })` 分享当前预览图片；不支持或调用失败时提示，不回退下载。独立站下载图片。
- **我的 `#/me`**：账号卡片（bili 显示同步状态与关注入口）、语言、**特效开关**、保留张数、Box 字母码导出 / 导入、PC 端扫码继续、清除本地数据；修改 UID 时若有有效需求或进行中的交换会二次确认或被拒绝。
- **Box 字母码**：无前缀、按位打包、CRC-10，32 字符无歧义串；含 22 种牌张数、保留数、想要标记、快速选牌与当前模式；有进行中的交换时禁止导入。详见 [box-code.md](box-code.md)。
- **请求反馈**：请求超过 400ms 显示顶部进度条与状态胶囊，超过 4 秒改为「服务响应较慢」说明（应对云函数冷启动）；轮询等后台请求不触发该提示，同一条后台错误只提示一次，主动操作失败始终提示。

---

## 7. 视觉与动效

- **风格**：月夜、银色拱窗、玻璃质感、克制的金色；**只做深色主题**。色彩 Token 在 `src/styles/tokens.css`：主背景 `--bg-0/1`、玻璃面 `--surface-*`、强调 `--moon-silver` / `--moon-gold`（主操作与好消息，每屏至多一处大面积）/ `--arcane` / `--glow-cyan`，语义色 `--ok/--warn/--bad`；B站粉只用于账号角标。
- **字体**：中文系统字体；英文标题与罗马数字用自托管 Cinzel 600 子集；UID / 数字用等宽。
- **卡牌**：保持 684×1024 比例，原图自带拱窗边框，UI 不再加边框；状态用外发光、角标、透明度区分。卡图构建为 160 / 360 / 684 三档 WebP（`scripts/build-assets.py`，位于 `assets/cards/`）。
- **布局**：4px 网格，左右边距 16px，可点击区域 ≥ 44px；卡牌网格 `<600` 4 列、`600–1023` 6 列、`≥1024` 8 列 + 侧栏。样式分 `tokens / base / components / pages / namecard / image-import` 六个文件。
- **特效**：现为**单一开关**（`fxOn`，兼容旧版 `fxPref`，仅明确选过「关闭」才保持关闭）。开启时自动按设备分级（`src/fx/perf.js`）：`prefers-reduced-motion` → 关；低内存 / 低核心或采样帧率 < 45fps → 流畅；否则华丽；运行中连续 3 秒 < 30fps 自动降一档。效果包括星空背景（`stars.js`）、3D 倾斜与全息光泽、数量粒子、UID 解码、等待星轨、匹配揭晓、引导页卡牌展示（`showcase.js`）。只对 `transform` / `opacity` 做动画。

---

## 8. 国际化

支持 `zh-CN`（默认）与 `en`，首次按 `navigator.language`，可手动切换（bili 同步到云存储 `prefs`）。文案集中在 `src/i18n.js`，卡牌名称来自 `src/data/cards.js`。英文界面注意按钮宽度与换行；时间与数字用 `Intl`。服务器名：中文「天空岛 / 世界树 / 亚服 / 美服 / 欧服 / 港澳台服」，英文 Celestia / Irminsul / Asia / America / Europe / TW·HK·MO。

---

## 9. 匹配机制（后端实现，PostgreSQL RPC）

### 9.1 匹配池与即时贪心

- 按分区隔离；每个账号同时最多 1 条有效需求；不按 UID 排除候选（只排除同账号）。
- 发布 / 重新匹配时立即扫描，`budget = 3`。候选 B 须为同分区等待中，且与 A 的账号之间 30 天内无失败交换。令 `X = A.give ∩ B.want`、`Y = B.give ∩ A.want`，`k = min(|X|, |Y|, budget) ≥ 1`。
- `score(B) = 10·k + Σ rarity(card) + priority(B)`；每次选分最高者生成匹配，扣 `budget` 后重算，直到用尽。A 的剩余部分转为被动等待。
- `rarity = demand / (supply + 1)`（分区内）；`priority = credit_factor × (1 + min(等待小时, 72) / 24)`。
- 贪心换取「能配就立刻配」；三人环形交换留作批处理扩展点，v1 不做。

### 9.2 并发与锁

同分区匹配通过事务锁串行；卡牌占用、匹配创建、次数扣减同事务提交；编辑 / 撤回 / 结算 / 超时释放遵守相同锁顺序。被占用的牌在前端显示「交换中」，不可改。占用以账号需求为单位，不跨账号共享。

### 9.3 信用与处罚

- 初始 100，上限 150，对用户只显示 5 颗月亮。每 7 天无不良记录 +5（最高 100）。

| 信用 | 状态 | `credit_factor` |
|---|---|---|
| ≥ 90 | 良好 | 1.0 |
| 60–89 | 一般 | 0.6 |
| 30–59 | 较低 | 0.3，仅可被动等待 |
| < 30 | 冷却 | 移出匹配池 7 天，到期重置为 50 |

- 失败处理：对方原因 → 举报者回池且不耗次数、被举报方 −15（「没牌 / 不想换」−10）；自身原因 → −5，对方回池；双方超时 → 各 −5；一方完成一方失败 → 争议，不扣分，争议 ≥ 3 次人工复核。连续 3 次作为责任方失败直接冷却。失败过的两个账号 30 天内不再互配。
- 成功结算加分见 5.5。信用流水存于 `swap_private`，供申诉后重新计算。

### 9.4 限频与反作弊

- 主动发布或重新匹配：每账号共用冷却：**B站授权账号 1 分钟、匿名账号 20 分钟**（匹配本身不要求 B站授权），从每次成功发布或主动重新匹配时开始计时，不按服务器游戏日刷新；对方原因失败回池不触发新的冷却；成功交换恢复额度（5.5）；等待期间编辑需求不限次但**不触发扫描**；撤回需求立即恢复额度，再发布开始新一轮冷却。信用处罚冷却（7 天）与发布额度分开。
- 写操作限流（设备 / IP）；数据异常（单牌 > 99、给出总数 > 200）拒绝；留言走预设白名单；举报关联具体匹配与对方账号，被多人举报进入人工复核；异常 reveal 行为人工复核；完整 UID 只经 reveal 返回给双方。

---

## 10. 前端实现现状

### 10.1 技术栈

Vite 8 + 原生 ES Modules + **Alpine.js 3.14（本地副本 `src/vendor/`）**；原生 CSS；`@cloudbase/js-sdk`（登录）、`qrcode-generator`（二维码）。**未使用** Service Worker / PWA、前端路由库、TypeScript。测试用 `node --test`，后端测试用 PGlite 跑真实迁移。

### 10.2 目录结构

```
index.html                  # 入口，加载各 partial
src/
├─ main.js                  # Alpine 根状态：路由、Box、发布、交换、同步、特效
├─ config.js                # ONLINE_BACKEND / API_BASE_URL（由 Vite mode 决定，不接受 URL 参数切换）
├─ i18n.js
├─ data/cards.js
├─ api/{index,online}.js    # 按模式选择模拟或线上 API；online 含 CloudBase 会话、幂等键、请求计数
├─ mock/{api,dev,toy-sdk}.js# 模拟后端与模拟 Toy SDK（本地开发）
├─ platform/{index,toy-sdk-loader,exchange-site}.js
├─ lib/                     # uid, box-code, storage, trade-state, trade-notes, state-polling,
│                           # exchange-card, namecard-selection, qrcode, image-*/miyoushe-*（截图导入）
├─ fx/{effects,perf,showcase,stars}.js
├─ partials/{welcome,box,trade,match,me,sheets,overlays}.html
├─ styles/*.css
└─ vendor/alpine-3.14.1.esm.js
assets/{cards,fonts,icons,recognition}/
backend/                    # 本地开发服务与云函数公共代码
cloudfunctions/{swap-api,swap-maintenance}/
cloudbase/migrations/20261114050000_init_swap.sql   # 唯一初始化迁移
scripts/                    # 资源构建、后端构建 / 打包 / 部署、识别评估
tests/                      # box-code, trade-notes, exchange-site, toy-sdk-loader, backend-*, maintenance-scheduler
```

### 10.3 状态与同步

- Box 主数据在 localStorage；bili 额外与云存储防抖同步。
- **状态轮询**（`state-polling.js`）：`GET /state?light=1` 为轻量轮询（`history`、`stats` 为 `null`，前端复用上次值）；首次加载、操作后、回前台、进行中交换结束时拉完整 `/state`。节奏：有进行中匹配 10 秒，仅等待中 30 秒，无需求或页面隐藏时不轮询。不使用 WebSocket 或事件流。
- 写请求带 `Idempotency-Key`（同一操作重试复用）和本机随机 `X-Device-Id`；CloudBase 会话由 SDK 持久化续期。
- 通知：首版仅页内提示与交换标签角标。

### 10.4 平台适配层接口

`platform = { env, can(feature), cloud, getProfile(), checkText(), share(), saveImage(), qrcode(), onSafeArea(), author: { isFollowing(), profile(), openSpace() } }`；不支持的能力返回 `null` / `false`，界面据此隐藏入口。

---

## 11. 后端概要

完整内容见 [后端概要设计](cloudbase-backend-design.md) 与 [后端说明](../backend/README.md)。

- **架构**：CloudBase Auth + HTTP 云函数 `swap-api`（网关 `/api/v1`）+ Event 云函数 `swap-maintenance`（每分钟定时）+ PostgreSQL（RPC 事务，业务表启用 RLS，RPC 仅授予 `service_role`）。维护任务先查 COS 到期索引，无任务不访问数据库。
- **11 个接口**：`GET /config`、`POST /session`、`PUT /me`、`GET /state`、发布 / 编辑 / 撤回 / 重新匹配需求、`POST /matches/:id/reveal`、`POST /matches/:id/confirm`、`POST /matches/:id/feedback`（申诉与举报合并）。`/config` 只下发 `authorMid` 与 CloudBase 公开登录参数；服务器、UID 规则、留言预设等静态数据随前端打包。
- **错误格式**：`{ error: { code, message, retryAt? }, requestId }`；常见码 `UID_INVALID`、`DAILY_LIMIT`、`COOLDOWN`、`LISTING_EXISTS`、`CARDS_LOCKED`、`RATE_LIMITED`、`CREDENTIAL_INVALID`、`BILI_ALREADY_LINKED`、`NOTE_TEXT_FORBIDDEN`、`NOTE_REJECTED`。重复 UID 正常成功。
- **数据模型**：`Account`、`Player`（信用、冷却、额度，UID 可重复无唯一约束）、`Listing`、`Match`（含 UID 快照、`scannedBy`、各方 reveal / confirm）、`PairBlock`、`Feedback`、`RequestRecord`（幂等与限流）。所有权与外键均以账号 ID 为准。
- **隐私**：`toyOpenId` 只存 HMAC；日志过滤 `toyOpenId / credential / ticket / token`；B站昵称头像不上传。

---

## 12. 当前进度与待办

**已完成**：前端全部页面与流程、模拟后端、线上 API 适配、后端 11 接口与数据库、定时维护、云函数已部署、截图导入、字母码、交换名片、双语、特效分级。测试 `npm test`（后端含 PGlite 真实迁移）。

**待办 / 未完成**
1. **UP主 mid**：`SWAP_AUTHOR_MID` 已配置为 `3546777483479879`；关注引导文案为草稿，待确认语气。
2. **B站来源安全域名**：当前套餐拒绝添加 `www.bilibili.com`，真实 B站来源 API 预检返回 403，需升级套餐或换方案后配置。
3. **B站真机验证**：Toy 内云存储登录、`getUserProfile`、关注检查、分享 / 保存相册均未在真机验证。
4. **未实现**：PWA / Service Worker、Web Push、三人环形交换、性能指标（首屏 JS ≤ 60KB gzip、LCP < 2.5s、Lighthouse 移动端 ≥ 90）尚未度量。

### 已确认事项摘要

严格 1 换 1，主动最多 3 对、被动不限；好友申请可带留言；跨服不能加好友（国服官服与渠道服互通）；圣牌使用官方译名；发布 / 重新匹配共用冷却（B站账号 1 分钟、匿名账号 20 分钟），撤回及成功结算立即恢复；不做单向赠送与排行榜；v1 之外的截图识别已按专项方案接入；Toy 允许请求外部 API、无包大小限制、允许 wasm / 本地存储；开启 OpenID 模式；平台不提供服务端身份校验（故 B站身份不带匹配特权）；分享与二维码路径可带 hash；未登录时云存储错误类型未知，故非限流错误一律按未登录处理；UID 可重复，账号状态各自独立。
