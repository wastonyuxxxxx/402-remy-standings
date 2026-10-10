const { tryWechatLogin } = require("./lib/api");

App({
  onLaunch() {
    // Optional: when WECHAT_APP_SECRET is configured in Supabase, this upgrades
    // the local anonymous session to a stable WeChat-linked session. If it is
    // not configured yet, pages continue using the existing anonymous flow.
    tryWechatLogin();
  },
});
