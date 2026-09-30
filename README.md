# 402 鼠王争霸赛 · V1.0

记录每一餐、识别和核对菜品，再由一位评委打分的网页应用。

- 线上站点：https://wastonyuxxxxx.github.io/402-remy-standings/
- 发布方式：GitHub Pages（仓库根目录）
- 后端：Supabase 项目 `lbzuahqvdzwwxqxbbohd`

## V1.0 链路

上传餐桌照片后自动识别菜品。识别期间可以关闭弹窗，发布表单仍显示进度；完成后可以检查局部截图、修改菜名、添加漏识别菜品、调整截图或重新识别。选择日期、午晚餐和厨师后发布，再由一位评委以 0.5 分为单位打分。主厨榜和菜品榜展示结果。

## 项目目录

| 路径 | 用途 |
| --- | --- |
| `site/` | 网站文件的编辑入口；修改网页请从这里开始 |
| `index.html`、`assets/` | `site/` 同步生成的 GitHub Pages 发布文件 |
| `scripts/` | 构建与本地预览工具 |
| `.github/workflows/` | 每次提交时检查测试和发布文件是否同步 |
| `supabase/` | 菜品识别 Edge Function 源码与配置说明 |
| `docs/` | 产品需求与验收口径 |
| `tests/` | 可重复执行的自动测试 |

GitHub `main` 分支是项目的权威版本。本机目录只是它的一份副本；换设备时重新克隆即可。`site/` 与当前线上 V1.0 的文件逐字节一致，`npm run build` 能在新设备重新生成可发布的站点。

前端主脚本 `site/assets/index-LYk49IIm.js` 仍是早期 React 构建产物，虽然现在有可重复的构建和发布流程，但这份脚本尚未还原为易读的 React 组件源码。独立的菜品识别脚本与补充样式可以直接维护。旧手机原型与当前功能不一致，保存在本机历史归档中，不作为开发入口。要大幅修改主界面，应先逐步把这份脚本迁移为组件，并用现有页面和测试验证功能一致。

## 换设备继续开发

1. 安装 Node.js 24 或更新版本，并用 Git 克隆本仓库。
2. 在项目目录运行 `npm run dev`，打开提示的本地地址。默认是离线界面预览，避免开发时在正式数据库自动新增匿名厨师。无需安装额外依赖。需要核对真实数据时可主动运行 `npm run dev:live`。
3. 修改 `site/` 下的网页文件。运行 `npm run sync:pages` 生成 `dist/` 并同步仓库根目录的发布文件，再运行 `npm run verify`。
4. 提交并推送 `site/`、`index.html`、`assets/` 等改动。GitHub 会自动检查；当前 GitHub Pages 继续从 `main` 分支根目录发布。

模型密钥保存在 Supabase Edge Function Secret 中，不需要随设备复制。本地 GitHub 登录由每台设备自行完成。

## 检查与保密

在仓库根目录执行 `npm run verify`。`npm run preview` 可预览构建后的 `dist/`。直接双击打开 `index.html` 可能受到浏览器模块加载限制。

线上识别使用 Supabase Edge Function Secret 中的模型密钥；仓库只包含可公开的 Supabase publishable key。本机另存的密钥、`.env`、令牌、个人照片和本地归档不得提交到公开仓库。
