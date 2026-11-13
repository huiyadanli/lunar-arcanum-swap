# lunar-arcanum-swap

原神「月谕圣牌」交换站。设计文档见 [docs/design.md](docs/design.md)。

米游社导出图导入 Box 的[设计方案与模板素材](docs/miyoushe-box-import.md)已准备，采用浏览器本地 Canvas 和固定位置模板匹配，自动识别 0 / 1 / 2 张；尚未接入网页功能。

新增[跨设备尺寸评估与方案修订](docs/miyoushe-box-import-adaptive.md)：推荐分别归一化宽高、统计牌框颜色，保留数字小模板；已离线验证 `mine.jpeg` 与 `2.jpg` 两种导出尺寸。

## 当前进度：M0 静态可点击原型

原生 ES Modules + Alpine.js，使用 **Vite 构建为纯静态文件**。Alpine.js 保留在 `src/vendor/`，构建时一起打包，不依赖 CDN。
后端和 B站 Toy SDK 都是模拟的（`src/mock/`），完整流程可以在浏览器里直接走通。

### 运行

开发和构建需要 Node.js 20.19+（20.x）或 22.12+，以及 npm。

```bash
npm install
npm run dev
# 打开终端显示的本地地址，默认 http://localhost:5173/
```

### 构建与部署

```bash
npm run build
npm run preview
# 本地预览构建结果，默认 http://localhost:4173/
```

构建产物在 `dist/`，包含 `index.html` 和带内容哈希的 JS、CSS、卡图、字体。
HTML 页面片段通过 `?raw` 在构建时打包，不再在运行时请求 `src/partials/`。
只需将 **`dist/` 的全部内容**上传到任意静态托管服务，部署环境不需要 Node.js 或 Python。

Vite 配置使用 `base: './'`，同一份产物支持域名根目录和子目录部署（例如 `/lunar-arcanum-swap/`）。
页面继续使用 `#/box` 这类 Hash 路由，不需要服务器配置路由回退。
开发服务器和 `vite preview` 仅用于本地开发、检查；部署时直接托管 `dist/`。
构建产物仍需通过 HTTP(S) 访问，不能用 `file://` 双击打开。

CI 中可使用 `npm ci` 安装锁定版本，然后执行 `npm run build`；静态托管平台的构建命令为 `npm run build`，输出目录为 `dist`。

### 切换两类用户 / 运行环境

| 地址 | 效果 |
|---|---|
| `/?mock=anon` | 独立站（如 Vercel）上的**匿名用户** |
| `/?mock=bili` | B站 App 内的 **B站用户**（`toy-app`，顶部有模拟的 App 容器栏） |
| `/?env=toy-web` | B站 网页端打开 Toy（无分享 / 相册 / 容器能力） |

选择会记住。页面左边缘（PC 在右边缘）有一个扳手图标的调试把手，可以：

- 切换运行环境、B站 登录状态、是否已关注 UP主；
- 设置发布时「立即匹配」为随机 / 总是 / 从不；
- 模拟对方的行为：有人匹配到我、对方开始交换、对方确认完成；
- 重置今日次数、清空全部数据。

### 原型覆盖的设计点

- 引导 3 步（UID 实时识别服务器 → 选择快速 / 完整 Box → 选牌发布）
- 完整 Box：月相进度、筛选、卡牌抽屉（倾斜光泽、长按连续加减、左右滑动切换）、批量编辑
- 快速交换：给出 / 想要两组，点击 +1，长按移除，互斥提示
- 发布确认：B站用户写自由留言（模拟 `checkInputSafety`），匿名用户选预设短语；发布后直接进入交换页
- 匹配：主动扫描最多 3 对、揭晓动画、UID 全程脱敏 →「开始交换」才显示（解码动画）→ B站用户需先关注 UP主
- 完成 / 遇到问题的确认流程，完成后 Box 自动更新（可撤销）
- 我的：两类用户的账号卡片、云同步状态、Box 字母码导出 / 导入、语言 / 特效 / 保留张数
- 特效三档（华丽 / 流畅 / 关闭）自动检测，运行中持续掉帧会自动降档；中英双语

### 交换名片

在「我的 Box」选好给出和想要的卡牌后，可点击「制作交换名片」；已发布的需求也能在「交换 → 我的换牌需求」生成名片。名片使用对应入口的需求快照，完整展示卡面、名称、可换数量、服务器、生成日期及站点二维码。默认展示完整 UID，可在预览中主动隐藏。预览即保存的 1080px 宽 PNG 原图，牌多时自动增加高度。B站 App 内保存到相册，其他环境下载图片；手机也可长按预览保存。

- **自部署**：本地生成二维码，使用当前站点目录（兼容子目录），去掉调试参数。可通过 `VITE_PUBLIC_SITE_URL` 固定对外地址。
- **B站 Toy（包括未登录用户）**：优先调用 `toy.getQrCode`，图片上的地址使用同一次 SDK 返回的实际链接，并标注使用 B站 App 扫码。SDK 不可用时，只回退到当前真实的 B站 Toy 地址或 `VITE_BILIBILI_TOY_URL`；不会混用自部署地址。
- **本地模拟 Toy**：先复制 `.env.example` 为 `.env.local`，填写实际发布的 `VITE_BILIBILI_TOY_URL`，再启动开发服务。没有真实地址时会提示无法生成，不使用占位地址或装饰性假二维码。模拟 App 的保存操作实际下载图片，方便检查结果。

上述 `VITE_*` 值在构建时写入产物，正式部署修改配置后需要重新构建。二维码只包含站点入口，不包含 UID 或登录凭据。

### 圣牌 Box 字母码

在「我的 → 导出圣牌 Box」复制以 `LASB1-` 开头的字母码，再到「导入圣牌 Box」粘贴。界面自动识别并校验，点击「导入并替换 Box」即可应用。字母码包含 22 种圣牌的准确张数（0–99）、保留张数、想要标记、快速交换选牌和当前模式，不包含身份凭据或交换记录。已有进行中的交换时暂不允许导入；已有等待中的换牌需求可在导入后手动更新。

数据按位打包，数量根据实际最大值选择位宽，0/1 收藏状态每张牌只占一位；末尾加入 CRC-16 校验后转为纯大写字母。`LASB1-` 是格式魔数与版本标记，完整格式见 [Box 字母码格式](docs/box-code.md)。

### 目录

```
index.html              页面骨架
vite.config.js          Vite 构建配置（相对资源路径）
package.json            开发 / 构建 / 预览命令
src/main.js             Alpine 组件：状态、路由、业务流程
src/partials/*.html     各页面与抽屉的模板（构建时打包）
src/platform/           平台适配层（Toy SDK / 浏览器能力）
src/mock/               模拟后端、模拟 Toy SDK、调试配置
src/fx/                 特效：星空、倾斜、解码、揭晓动画、性能分级
src/styles/             tokens / base / components / pages
assets/cards/           由脚本生成的 WebP 卡图（160 / 360 / 684 宽）
assets/icons/           本地自绘 SVG 图标，替代 emoji 和字符图标
scripts/build-assets.py 从 docs/assets/cards 原图生成 WebP
dist/                   构建产物（不提交 Git）
```

重新生成卡图：`python3 scripts/build-assets.py`（需要 Pillow）。

UI 图标统一引用 `assets/icons/ui.svg`，不需要联网或额外依赖。使用方法见 [图标说明](assets/icons/README.md)。
