# 网站编辑入口

此目录逐字节保留当前 V1.0 运行文件。运行 `npm run sync:pages` 后，文件会复制到 `dist/` 和仓库根目录供 GitHub Pages 使用。请在这里修改网页，然后同步发布文件。

- `index.html`：页面入口及资源引用。
- `assets/dish-recognition.js`：识别、结果弹窗、裁图和菜品截图逻辑，可直接编辑。
- `assets/leaderboard-polish.css`：后来补充的网页样式，可直接编辑。
- `assets/index-LYk49IIm.js` 与 `assets/index-B1ot1QN7.css`：早期 React 编译结果，目前仍承担主界面。它们是迁移目标，不是易维护的原始组件源码。

旧手机预览原型无法生成当前 V1.0，不能拿它的构建结果覆盖此目录。
