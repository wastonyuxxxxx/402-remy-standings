const { getProfiles, getMeals, session, saveWechatProfile } = require("../../lib/api");
const { chefStandings, dishStandings } = require("../../lib/standings");

Page({
  data: {
    tab: "chefs",
    mode: "total",
    loading: true,
    error: "",
    chefs: [],
    dishes: [],
    latest: null,
    profilesCount: 0,
    dishesCount: 0,
    profileEditorVisible: false,
    profileSaving: false,
    profileNickname: "",
    profileAvatarUrl: "",
    profileAvatarPath: "",
    profileAvatarType: "",
  },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [profiles, meals] = await Promise.all([getProfiles(), getMeals()]);
      const auth = await session();
      const metadata = (auth.user && auth.user.user_metadata) || {};
      const visible = profiles.filter((profile) => profile.name !== "我的厨王" || meals.some((meal) => meal.chef_ids && meal.chef_ids.includes(profile.id)));
      const latest = meals[0] || null;
      this.meals = meals;
      this.profiles = visible;
      this.setData({
        chefs: chefStandings(visible, meals, this.data.mode),
        dishes: dishStandings(meals),
        latest: latest ? Object.assign({}, latest, {
          chefNames: (Array.isArray(latest.chef_ids) ? latest.chef_ids : []).map((id) => {
            const chef = profiles.find((profile) => profile.id === id);
            return (chef && chef.name) || "厨师";
          }).join(" · "),
          dateLabel: latest.meal_date.replace(/-/g, "."),
          dishCount: Array.isArray(latest.dishes) ? latest.dishes.length : 0,
          scoreLabel: latest.score == null ? "待评分" : `${Number(latest.score).toFixed(1)} / 10`,
        }) : null,
        profilesCount: visible.length,
        dishesCount: dishStandings(meals).length,
        profileNickname: metadata.nickname || "",
        profileAvatarUrl: metadata.avatar_url || "",
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "加载失败" });
    }
  },
  switchTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); },
  switchMode(event) {
    const mode = event.currentTarget.dataset.mode;
    this.setData({ mode, chefs: chefStandings(this.profiles || [], this.meals || [], mode) });
  },
  goPublish() { wx.navigateTo({ url: "/pages/publish/publish" }); },
  goJudge() { wx.navigateTo({ url: "/pages/judge/judge" }); },
  refresh() { this.load(); },
  async openProfileEditor() {
    try {
      const auth = await session();
      const metadata = (auth.user && auth.user.user_metadata) || {};
      this.setData({
        profileEditorVisible: true,
        profileNickname: metadata.nickname || "",
        profileAvatarUrl: metadata.avatar_url || "",
        profileAvatarPath: "",
        profileAvatarType: "",
      });
    } catch (error) {
      wx.showModal({ title: "暂时无法获取微信资料", content: error.message || "请检查网络后重试", showCancel: false });
    }
  },
  closeProfileEditor() { if (!this.data.profileSaving) this.setData({ profileEditorVisible: false }); },
  stopTap() {},
  changeProfileNickname(event) { this.setData({ profileNickname: event.detail.value }); },
  chooseWechatAvatar(event) {
    const filePath = event.detail.avatarUrl;
    if (!filePath) return;
    wx.compressImage({
      src: filePath,
      quality: 80,
      compressedWidth: 320,
      success: (result) => this.setData({ profileAvatarPath: result.tempFilePath, profileAvatarUrl: result.tempFilePath }),
      fail: () => this.setData({ profileAvatarPath: filePath, profileAvatarUrl: filePath }),
    });
  },
  async saveProfile() {
    if (this.data.profileSaving) return;
    const nickname = this.data.profileNickname.trim();
    if (!nickname) return wx.showToast({ title: "请填写昵称", icon: "none" });
    this.setData({ profileSaving: true });
    wx.showLoading({ title: "正在保存", mask: true });
    try {
      const auth = await saveWechatProfile({
        nickname,
        avatarPath: this.data.profileAvatarPath,
        avatarType: this.data.profileAvatarType,
      });
      const metadata = (auth.user && auth.user.user_metadata) || {};
      this.setData({
        profileNickname: metadata.nickname || nickname,
        profileAvatarUrl: metadata.avatar_url || this.data.profileAvatarUrl,
        profileAvatarPath: "",
        profileEditorVisible: false,
        profileSaving: false,
      });
      wx.hideLoading();
      wx.showToast({ title: "微信资料已保存", icon: "success" });
    } catch (error) {
      wx.hideLoading();
      this.setData({ profileSaving: false });
      wx.showModal({ title: "保存失败", content: error.message || "请稍后重试", showCancel: false });
    }
  },
});
