# 402 鼠王争霸赛 · 原生微信小程序

这不是 `web-view` 网页壳。`pages/` 是微信原生页面（WXML/WXSS/JS），`lib/api.js` 连接网页 V1 同一个 Supabase 项目，`lib/standings.js` 计算排行榜。使用正式 AppID `wxe5fcf6be56ed781e` 导入本目录即可在开发者工具中编译。没有使用或开通微信云开发。

## 当前已实现

- 首页从原项目的 `profiles`、`meals` 读取真实数据，展示主厨榜、菜品榜和最近一餐；沿用鼠王与厨师头像素材。
- 原生发布页：选照片、自动识别、改菜名、添加或删除漏识别菜品、重新识别、选择日期/午晚餐/厨师、上传到现有 Storage 并保存到现有 `meals`。
- 原生评委页：选餐次，按 0.5 分调整，由 Supabase Edge Function `mini-meal-update` 更新餐次和菜品分数。该函数要求已验证的 Supabase 用户 JWT，不使用 service role。
- 首页可主动选择微信头像并填写昵称；首次打开不会自动向微信申请登录凭证，也不读取微信号。用户主动保存资料时才建立小程序身份关联；头像和昵称只在用户选择后保存，资料和 OpenID 哈希映射仅由 `wechat-session` Edge Function 写入。
- 只在客户端使用可公开的 Supabase publishable key。SiliconFlow 密钥和微信 AppSecret 都只留在 Supabase Edge Function Secrets。
- 微信登录 Edge Function `wechat-session` 已部署，OpenID 会先做哈希再用于账号映射；真实微信登录码尚未在手机上走通验收。

## 尚未验收与上线门槛

1. 目前开发者工具打开了“开发环境不校验合法域名”，所以模拟器读到线上数据**不能证明手机正式版可用**。必须在微信公众平台把 `https://lbzuahqvdzwwxqxbbohd.supabase.co` 加入 request 合法域名，并按实际图片/上传 API 要求配置 downloadFile、uploadFile 合法域名；关闭跳过校验后再真机验证。若微信后台不接受这个域名，需换为可配置的自有 HTTPS API 域名，不能靠调试开关上线。
2. `wx.login` → Supabase Edge Function → 微信 OpenID 的后端链路已部署；无副作用配置检查确认函数能读取到 Secret，但仍需真机拿到登录码验证完整登录。微信号本身不能由小程序直接读取；头像/昵称由用户在首页主动选择。若登录失败，小程序会回退到现有匿名会话。
3. 图片识别在模拟器上尚未完成端到端验收；发布和评分也尚未用正式餐次做写入验收。提交审核前还要检查小程序备案、隐私说明、头像昵称使用提示和真机网络行为。

`project.private.config.json` 是本机私有设置，不应提交。现有 GitHub Pages 网站继续独立运行，两个前端共享同一套后端数据。
