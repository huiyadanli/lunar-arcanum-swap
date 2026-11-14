# 只读匹配池后台

在「我的」页对账号头像 **3 秒内点击 5 次**打开管理面板。鼠标点击、手机触摸和聚焦头像后按回车或空格均可触发。普通导航没有后台链接；入口隐藏不替代后端鉴权。

面板使用独立状态、按需加载的脚本与局部样式。关闭按钮或 Escape 会移除面板、清除管理密码和已查询数据，并将焦点还给原页面。打开、关闭、切换视图不修改路由、个人交换快照或业务轮询；管理请求自行显示加载状态。

## 查看内容

- 全池参与人数、等待人数、配对中人数、进行中及待确认配对、注册账号数、各状态配对数量、六服逐卡供需。
- 等待需求及已关闭需求：账号、完整 UID、区服、留言、卡牌、占用、信用和时间。
- 配对：双方账号与 UID 快照、双方留言、逐对交换、真实确认记录、查看 UID 时间、有效期与结算时间。
- 用户：账号类型、UID、信用、额度、当前需求、匹配历史和举报 / 申诉。

人数按交换账号计数，不能按游戏 UID 去重。全池参与人数是「有可匹配等待需求的账号」和「进行中配对双方账号」的并集；等待与配对中人数可能重叠。等待资格沿用当前供需、信用和冷却条件；等待列表还展示已被完全占用的需求，并标注不参与等待。到期但尚未被原维护任务处理的配对仍按其持久化状态展示，概览另标明待结算数量。

首次访问及手动刷新时读取，列表默认 50 条、最大 100 条；无自动轮询、在线人数心跳、业务操作或完整收藏 Box 上传。用户关联记录默认跨区服查询，以便查看更换 UID / 区服前的历史。

## 启用

1. 按迁移顺序应用 `cloudbase/migrations/20261115040000_admin_readonly.sql`。该迁移只增加 `swap_private.admin_accounts` 和 `public.swap_admin_query`；不替换现有函数，不修改业务表或触发器。RPC 仅授权 `service_role`，客户端无法直接查询名单或调用 RPC。
2. 构建、部署更新后的 `swap-api`，以及 `npm run build:online` 生成的线上前端。无需更新维护函数、网关路由、认证 provider 或 CORS 请求头。
3. 按下列方式配置匿名密码或登记 B站交换账号。两种方式独立可用；未配置密码只会使匿名后台访问返回 `ADMIN_NOT_CONFIGURED`，普通 API 和 B站名单访问继续正常工作。

本次代码变更不自动应用线上迁移、不写入真实管理员名单、不设置实际密码或发布产物。

### 匿名管理密码

运行 `node scripts/hash-admin-password.mjs`，在终端输入至少 16 字符的密码，输入不会回显。将输出的 `scrypt$盐值$哈希` 原样设为 `swap-api` 的环境变量 `SWAP_ADMIN_PASSWORD_HASH`。本地后端可在已忽略的 `.secrets/backend.runtime.json` 中设置同名键；现有部署配置脚本会传递该字段。

密码格式由该脚本固定生成。不要把实际密码、哈希或运行配置提交 Git。PowerShell 手动设置包含 `$` 的环境变量时使用单引号，避免变量展开。

用户先保持现有 CloudBase 匿名会话，再输入管理密码。每次管理查询都重新验证密码，密码只保存在面板闭包内，不进入快照、localStorage、sessionStorage、数据库或日志。关闭后台后再次进入需重新输入。

失败验证按来源 IP（无 IP 时按已验证主体）使用实例内计数：5 分钟最多 5 次。该限制不使用业务限流表；服务重启后重置，多实例之间不共享。应使用足够长的随机密码，不将此轻量限制当成全局防护。

### B站管理员名单

直接在数据库登记**当前站内 B站交换账号 ID**。该 ID 来自已登录用户 `/state` 返回的 `me.accountId`，不是游戏 UID、昵称或客户端传入的 Toy ID。现有 Toy 云存储凭据和 CloudBase 自定义登录流程保持原样。

```sql
-- 将占位值替换为经核对的当前 B站交换账号 ID；不根据重复的游戏 UID 授权。
INSERT INTO swap_private.admin_accounts(account_id)
SELECT id FROM public.accounts
WHERE id = 'b_替换为实际交换账号ID'
  AND account_type = 'bili' AND auth_user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 撤销后，下一次管理请求立即被拒绝。
DELETE FROM swap_private.admin_accounts
WHERE account_id = 'b_替换为实际交换账号ID';
```

后端通过现有平台校验接口验证 CloudBase token，再由只读 RPC 同时核对账号类型、custom ID、auth ID 和名单。B站账号不能通过提交匿名管理密码绕过名单。页面不提供自行加入名单的入口。

## 接口与隔离

唯一新增接口为 `POST /api/v1/admin/query`，沿用 `Authorization: Bearer <CloudBase access_token>`；不要求写入幂等键。匿名请求可附带 `password`。

```json
{
  "view": "matches",
  "server": "asia",
  "accountType": "bili",
  "status": "confirming",
  "search": "",
  "accountId": "",
  "id": "",
  "page": 1,
  "pageSize": 50
}
```

- `view`：`overview`、`waiting`、`matches`、`users`、`feedback`；默认 `overview`。
- `server`：现有六服键；概览只接受该项作为筛选条件。
- `search`：账号、游戏 UID；匹配列表同时搜索配对 ID。采用文字包含匹配，无动态 SQL。
- `accountId`：只查看该账号的需求、配对或反馈；`id`：查看当前类别的单条记录。
- `status`：等待需求默认 `waiting`，可查 `closed`；配对和反馈使用对应现有状态。
- 列表按创建时间和 ID 倒序，返回 `items`、`total`、`page`、`pageSize`、`updatedAt`。概览直接返回指标和 `servers`，时间为毫秒时间戳。

密码验证结果和主体 ID 由服务端构造，不透传客户端的同名字段。RPC 为 `STABLE`，管理读取不进入 `swap_dispatch`、不发维护唤醒、不产生业务幂等或限流记录。返回字段使用显式投影，排除认证 ID、登录凭据、密钥哈希与 Toy OpenID。

## 本地验证

默认 `npm run dev` 使用独立演示数据，匿名演示密码为 `dev-admin`，B站模拟账号直接进入；面板显示「本地模拟数据」。演示数据与个人 `mockdb` 相互独立，不读写其存储。online 模式不会因查询失败而降级到演示数据。

验证命令：`npm test`、`npm run build`、`npm run build:online`、`npm run build:backend`。

新增测试覆盖权限和名单撤销、密码失败限流、六服及重复 UID、分页、详情和反馈、只读事务、查询前后全部业务记录一致、迁移前后既有函数定义一致、延迟响应与面板关闭隔离。内置浏览器不可用时明确记录页面点击和布局验证缺口，不降级到 computer use。
