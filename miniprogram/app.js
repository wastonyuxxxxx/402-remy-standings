App({
  onLaunch() {
    if (typeof wx.onNeedPrivacyAuthorization !== "function") return;
    wx.onNeedPrivacyAuthorization((resolve) => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      const component = page && typeof page.selectComponent === "function"
        ? page.selectComponent("#privacyAuthorization")
        : null;
      if (component && typeof component.present === "function") {
        component.present(resolve);
        return;
      }
      resolve({ event: "disagree" });
    });
  },
});
