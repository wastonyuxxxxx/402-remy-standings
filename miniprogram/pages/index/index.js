const { getProfiles, getMeals, session, saveWechatProfile } = require("../../lib/api");
const { chefStandings, dishStandings } = require("../../lib/standings");
const SELF_CHEF_KEY = "remy_self_chef_id_v1";

Page({
  data: {
    tab: "chefs",
    mode: "total",
    dishMode: "score",
    loading: true,
    error: "",
    chefs: [],
    dishes: [],
    latest: null,
    profilesCount: 0,
    dishesCount: 0,
    mealCount: 0,
    chefCount: 0,
    pendingMealCount: 0,
    selfChefId: "",
    selfChefName: "",
    selfChefAvatarUrl: "",
    selfChefExists: false,
    profileEditorVisible: false,
    profileSaving: false,
    profileNickname: "",
    profileAvatarUrl: "",
    profileAvatarPath: "",
    profileAvatarType: "",
    publishVisible: false,
    judgeVisible: false,
    manageVisible: false,
    manageTab: "meals",
    manageTargetMealId: "",
    manageTargetChefId: "",
  },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [profiles, meals] = await Promise.all([getProfiles(), getMeals()]);
      const auth = await session();
      const metadata = (auth.user && auth.user.user_metadata) || {};
      const savedChefId = wx.getStorageSync(SELF_CHEF_KEY) || "";
      const selfChef = profiles.find((profile) => profile.id === savedChefId)
        || profiles.find((profile) => profile.id === auth.user.id);
      const selfChefId = selfChef ? selfChef.id : auth.user && auth.user.id || "";
      if (selfChefId && selfChefId !== savedChefId) wx.setStorageSync(SELF_CHEF_KEY, selfChefId);
      const visible = profiles;
      const chefs = chefStandings(visible, meals, this.data.mode);
      const latest = meals[0] || null;
      this.meals = meals;
      this.profiles = visible;
      this.setData({
        chefs,
        dishes: dishStandings(meals, this.data.dishMode),
        latest: latest ? Object.assign({}, latest, {
          chefNames: (Array.isArray(latest.chef_ids) ? latest.chef_ids : []).map((id) => {
            const chef = profiles.find((profile) => profile.id === id);
            return (chef && chef.name) || "厨师";
          }).join(" · "),
          dateLabel: latest.meal_date.replace(/-/g, "."),
          dishCount: Array.isArray(latest.dishes) ? latest.dishes.length : 0,
          scoreLabel: latest.score == null ? "待评分" : `${Number(latest.score).toFixed(1)} / 10`,
          scoreValue: latest.score == null ? "待评分" : Number(latest.score).toFixed(1),
          scoreStatus: latest.score == null ? "等待评委评分" : "已评分",
        }) : null,
        profilesCount: chefs.length,
        dishesCount: dishStandings(meals).length,
        mealCount: meals.length,
        chefCount: visible.length,
        pendingMealCount: meals.filter((meal) => meal.score == null).length,
        selfChefId,
        selfChefName: selfChef ? selfChef.name : "",
        selfChefAvatarUrl: selfChef ? selfChef.avatar_url || "" : "",
        selfChefExists: Boolean(selfChef),
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
  switchDishMode(event) {
    const dishMode = event.currentTarget.dataset.mode === "appearances" ? "appearances" : "score";
    this.setData({ dishMode, dishes: dishStandings(this.meals || [], dishMode) });
  },
  goPublish() { this.setData({ publishVisible: true }); },
  closePublish() { this.setData({ publishVisible: false }); },
  onMealPublished() {
    this.setData({ publishVisible: false });
    this.load();
  },
  goJudge() { this.setData({ judgeVisible: true }); },
  closeJudge() { this.setData({ judgeVisible: false }); },
  onMealScored() {
    this.setData({ judgeVisible: false });
    this.load();
  },
  goManage(event) {
    const tab = event.currentTarget.dataset.tab === "chefs" ? "chefs" : "meals";
    this.setData({ manageTab: tab, manageTargetMealId: "", manageTargetChefId: "", manageVisible: true });
  },
  goEditLatest() {
    if (!this.data.latest) return;
    this.setData({ manageTab: "meals", manageTargetMealId: this.data.latest.id, manageTargetChefId: "", manageVisible: true });
  },
  async openSelfChefEditor() {
    try {
      const auth = await session();
      const selfChefId = this.data.selfChefId || auth.user && auth.user.id;
      if (!selfChefId) throw new Error("暂时无法取得当前身份");
      wx.setStorageSync(SELF_CHEF_KEY, selfChefId);
      this.setData({ manageTab: "chefs", manageTargetMealId: "", manageTargetChefId: selfChefId, manageVisible: true });
    } catch (error) {
      wx.showModal({ title: "暂时无法打开厨王身份", content: error.message || "请检查网络后重试", showCancel: false });
    }
  },
  closeManage() { this.setData({ manageVisible: false, manageTargetMealId: "", manageTargetChefId: "" }); },
  openWechatProfile() {
    this.setData({ manageVisible: false, manageTargetMealId: "", manageTargetChefId: "" });
    this.openProfileEditor();
  },
  onManageChanged() {
    this.setData({ manageVisible: false, manageTargetMealId: "", manageTargetChefId: "" });
    this.load();
  },
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
      let selfChefId = this.data.selfChefId;
      if (!this.data.selfChefExists && auth.user && auth.user.id) {
        selfChefId = auth.user.id;
        wx.setStorageSync(SELF_CHEF_KEY, selfChefId);
      }
      this.setData({
        selfChefId,
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
