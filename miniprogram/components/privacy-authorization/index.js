Component({
  data: { visible: false },
  methods: {
    present(resolve) {
      if (this._privacyResolve) this._privacyResolve({ event: "disagree" });
      this._privacyResolve = typeof resolve === "function" ? resolve : null;
      this.setData({ visible: true });
    },
    agree(event) {
      this.finish({ event: "agree", buttonId: event.detail.buttonId });
    },
    reject() {
      this.finish({ event: "disagree" });
    },
    authorizationFailed() {
      this.finish({ event: "disagree" });
    },
    openPrivacyContract() {
      if (typeof wx.openPrivacyContract !== "function") {
        wx.showToast({ title: "暂时无法打开隐私指引", icon: "none" });
        return;
      }
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: "暂时无法打开隐私指引", icon: "none" }),
      });
    },
    finish(result) {
      const resolve = this._privacyResolve;
      this._privacyResolve = null;
      this.setData({ visible: false }, () => {
        if (resolve) resolve(result);
      });
    },
    stopInteraction() {},
  },
});
