function handlePhotoPickerFailure(error, itemName) {
  const message = error && error.errMsg ? String(error.errMsg) : "";
  if (/cancel/i.test(message)) return;

  if (/api scope is not declared in the privacy agreement/i.test(message)) {
    wx.showModal({
      title: "照片权限尚未配置",
      content: "当前小程序的《用户隐私保护指引》没有声明“选中的照片或视频信息”，因此微信暂时不允许打开相册。请小程序管理员在微信公众平台补充该项；如需直接拍照，还要声明相机用途。",
      showCancel: false,
    });
    return;
  }

  if (/privacy permission is not authorized/i.test(message)) {
    wx.showModal({
      title: "请先同意隐私提示",
      content: "选择照片前，微信会展示隐私保护提示。请先同意并继续，然后重新选择照片。",
      showCancel: false,
    });
    return;
  }

  if (/system auth deny|system authorization deny/i.test(message)) {
    wx.showModal({
      title: "相册访问被拒绝",
      content: "请在手机设置中允许微信访问照片，再回来重试。",
      showCancel: false,
    });
    return;
  }

  wx.showToast({ title: `选择${itemName || "照片"}失败`, icon: "none" });
}

module.exports = { handlePhotoPickerFailure };
