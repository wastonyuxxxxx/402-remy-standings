const { getProfiles, getMeals, updateMeal, deleteMeal, saveChef, deleteChef, uploadMealPhoto, uploadWechatAvatar } = require("../../lib/api");
const { handlePhotoPickerFailure } = require("../../lib/photo-picker");

const AVATARS = [
  { src: "/assets/miko-avatar-01.png", tone: "blue" },
  { src: "/assets/miko-avatar-02.png", tone: "gray" },
  { src: "/assets/miko-avatar-03.png", tone: "warm" },
  { src: "/assets/miko-avatar-04.png", tone: "mint" },
  { src: "/assets/miko-avatar-05.png", tone: "lavender" },
];

function profileView(profile, selected) {
  const avatarIndex = Math.max(0, Math.min(AVATARS.length - 1, Number(profile.avatar_index || 0)));
  return Object.assign({}, profile, {
    avatarIndex,
    avatarSource: profile.avatar_url || AVATARS[avatarIndex].src,
    selected: Boolean(selected),
  });
}

function mealView(meal, profiles) {
  const chefIds = Array.isArray(meal.chef_ids) ? meal.chef_ids : [];
  const chefNames = chefIds.map((id) => {
    const profile = profiles.find((item) => item.id === id);
    return profile ? profile.name : "厨师";
  });
  const dishes = Array.isArray(meal.dishes) ? meal.dishes : [];
  return Object.assign({}, meal, {
    heading: meal.title || `${meal.meal_date || "日期未知"} ${meal.meal_type || ""}`,
    dateLabel: String(meal.meal_date || "日期未知").replace(/-/g, "."),
    subtitle: `${chefNames.join("、") || "未选择厨师"} · ${dishes.length} 道菜`,
    dishSummary: dishes.map((dish) => dish.name).filter(Boolean).join("、") || "尚未填写菜品",
    scoreLabel: meal.score == null ? "待评分" : `${Number(meal.score).toFixed(1)} 分`,
  });
}

function validNames(text) {
  return String(text || "").split(/[,，、\n]/).map((name) => name.trim()).filter(Boolean);
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    tab: { type: String, value: "meals" },
    targetMealId: { type: String, value: "" },
    targetChefId: { type: String, value: "" },
  },
  data: {
    heading: "管理全部餐次",
    subheading: "选择一餐继续编辑",
    loading: true,
    error: "",
    meals: [],
    profiles: [],
    avatars: AVATARS,
    editMealId: "",
    editDate: "",
    editType: "晚餐",
    editChefIds: [],
    editProfiles: [],
    editImageUrl: "",
    editPhotoPath: "",
    editPhotoType: "",
    editDishesText: "",
    editChefId: "",
    chefName: "",
    chefAvatarIndex: 0,
    chefAvatarUrl: "",
    chefAvatarPath: "",
    chefAvatarType: "",
    chefEditorVisible: false,
    chefIdentityMode: false,
    editChefExists: false,
    chefFromMeal: false,
    saving: false,
  },
  observers: {
    "visible, tab, targetMealId, targetChefId": function(visible, tab) {
      if (!visible) {
        this._openedTargetMealId = "";
        this._openedTargetChefId = "";
        return;
      }
      const activeTab = tab === "chefs" ? "chefs" : "meals";
      this.setData({
        heading: activeTab === "chefs" ? "管理厨师" : "管理全部餐次",
        subheading: activeTab === "chefs" ? "当前版本向熟人局所有成员开放编辑" : "选择一餐继续编辑",
      });
      this.load();
    },
  },
  methods: {
    closeSheet() { if (!this.data.saving) this.triggerEvent("close"); },
  openWechatProfile() { this.triggerEvent("wechatprofile"); },
    async load() {
    this.setData({ loading: true, error: "" });
    try {
      const result = await Promise.all([getProfiles(), getMeals()]);
      const profiles = result[0].map((profile) => profileView(profile, false));
      const meals = result[1].map((meal) => mealView(meal, profiles));
      this.setData({ profiles, meals, loading: false }, () => {
        const targetMealId = this.data.targetMealId;
        if (targetMealId && this.data.visible && this._openedTargetMealId !== targetMealId) {
          this._openedTargetMealId = targetMealId;
          this.openMealRecord(targetMealId);
          return;
        }
        const targetChefId = this.data.targetChefId;
        if (!targetChefId || this.data.tab !== "chefs" || !this.data.visible || this._openedTargetChefId === targetChefId) return;
        this._openedTargetChefId = targetChefId;
        this.openChefEditor(null, false, true, targetChefId);
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "加载失败" });
    }
  },
  retry() { this.load(); },
  stopTap() {},

  openMeal(event) {
    this.openMealRecord(event.currentTarget.dataset.id);
  },
  openMealRecord(mealId) {
    const meal = this.data.meals.find((item) => item.id === mealId);
    if (!meal) return;
    const chefIds = Array.isArray(meal.chef_ids) ? meal.chef_ids.slice() : [];
    this.setData({
      editMealId: meal.id,
      editDate: meal.meal_date || "",
      editType: meal.meal_type || "晚餐",
      editChefIds: chefIds,
      editProfiles: this.data.profiles.map((profile) => profileView(profile, chefIds.includes(profile.id))),
      editImageUrl: meal.image_url || "",
      editPhotoPath: "",
      editPhotoType: "",
      editDishesText: (Array.isArray(meal.dishes) ? meal.dishes : []).map((dish) => dish.name || "").join("，"),
    });
  },
  closeMealEditor() { if (!this.data.saving) this.setData({ editMealId: "" }); },
  changeEditDate(event) { this.setData({ editDate: event.detail.value }); },
  changeEditType(event) { this.setData({ editType: event.currentTarget.dataset.type }); },
  changeEditDishes(event) { this.setData({ editDishesText: event.detail.value }); },
  toggleEditChef(event) {
    const id = event.currentTarget.dataset.id;
    const chefIds = this.data.editChefIds.includes(id)
      ? this.data.editChefIds.filter((item) => item !== id)
      : this.data.editChefIds.concat(id);
    this.setData({ editChefIds: chefIds, editProfiles: this.data.profiles.map((profile) => profileView(profile, chefIds.includes(profile.id))) });
  },
  addChefFromMeal() { this.openChefEditor(null, true); },

  chooseMealPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const file = result.tempFiles[0];
        if (!file) return;
        this.setData({ editImageUrl: file.tempFilePath, editPhotoPath: file.tempFilePath, editPhotoType: file.fileType || "" });
      },
      fail: (error) => handlePhotoPickerFailure(error, "照片"),
    });
  },
  clearMealPhoto() { this.setData({ editImageUrl: "", editPhotoPath: "", editPhotoType: "" }); },

  async saveMeal() {
    if (this.data.saving) return;
    const meal = this.data.meals.find((item) => item.id === this.data.editMealId);
    if (!meal) return;
    if (!this.data.editDate) return wx.showToast({ title: "请选择日期", icon: "none" });
    if (!this.data.editChefIds.length) return wx.showToast({ title: "请至少选择一位厨师", icon: "none" });
    this.setData({ saving: true });
    wx.showLoading({ title: "正在保存", mask: true });
    try {
      let imageUrl = this.data.editImageUrl || null;
      if (this.data.editPhotoPath) imageUrl = await uploadMealPhoto(this.data.editPhotoPath, this.data.editPhotoType);
      const oldDishes = Array.isArray(meal.dishes) ? meal.dishes : [];
      const names = validNames(this.data.editDishesText);
      const dishes = names.map((name, index) => {
        const previous = oldDishes.find((dish) => String(dish.name || "").trim().toLocaleLowerCase() === name.toLocaleLowerCase());
        return {
          id: previous ? previous.id : `${meal.id}-dish-${Date.now()}-${index}`,
          name,
          score: previous && previous.score != null ? previous.score : meal.score,
        };
      });
      const dateLabel = this.data.editDate.replace(/-/g, ".");
      await updateMeal(meal.id, {
        title: `${dateLabel} ${this.data.editType}`,
        meal_date: this.data.editDate,
        meal_type: this.data.editType,
        chef_ids: this.data.editChefIds,
        dishes,
        image_url: imageUrl,
      });
      wx.hideLoading();
      this.setData({ saving: false, editMealId: "" });
      wx.showToast({ title: "餐次信息已更新", icon: "success" });
          this.triggerEvent("changed");
      this.load();
    } catch (error) {
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showModal({ title: "修改失败", content: error.message || "请稍后重试", showCancel: false });
    }
  },
  confirmDeleteMeal() {
    const meal = this.data.meals.find((item) => item.id === this.data.editMealId);
    if (!meal || this.data.saving) return;
    wx.showModal({
      title: "删除这餐？",
      content: `确定删除「${meal.heading}」吗？删除后无法恢复。`,
      confirmText: "删除",
      confirmColor: "#c34d4d",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ saving: true });
        wx.showLoading({ title: "正在删除", mask: true });
        try {
          await deleteMeal(meal.id);
          wx.hideLoading();
          this.setData({ saving: false, editMealId: "" });
          wx.showToast({ title: "餐次已删除", icon: "success" });
          this.triggerEvent("changed");
          this.load();
        } catch (error) {
          wx.hideLoading();
          this.setData({ saving: false });
          wx.showModal({ title: "删除失败", content: error.message || "请稍后重试", showCancel: false });
        }
      },
    });
  },

  openChefEditor(event, fromMeal, identityMode, identityId) {
    let profile = null;
    if (event && event.currentTarget) profile = this.data.profiles.find((item) => item.id === event.currentTarget.dataset.id);
    const isIdentity = Boolean(identityMode);
    const chefId = profile ? profile.id : (isIdentity ? identityId || this.data.targetChefId : "");
    const index = profile ? profile.avatarIndex : this.data.profiles.length % AVATARS.length;
    this.setData({
      editChefId: chefId,
      chefName: profile ? profile.name : (isIdentity ? "我的厨王" : ""),
      chefAvatarIndex: index,
      chefAvatarUrl: profile ? profile.avatar_url || "" : "",
      chefAvatarPath: "",
      chefAvatarType: "",
      chefEditorVisible: true,
      chefIdentityMode: isIdentity,
      editChefExists: Boolean(profile),
      chefFromMeal: Boolean(fromMeal),
    });
  },
  openNewChef() { this.openChefEditor(null, false); },
  closeChefEditor() {
    if (this.data.saving) return;
    this.setData({ chefEditorVisible: false });
    if (this.data.chefIdentityMode) this.triggerEvent("close");
  },
  changeChefName(event) { this.setData({ chefName: event.detail.value }); },
  selectChefAvatar(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    this.setData({ chefAvatarIndex: index, chefAvatarUrl: "", chefAvatarPath: "", chefAvatarType: "" });
  },
  chooseChefAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const file = result.tempFiles[0];
        if (file) this.setData({ chefAvatarPath: file.tempFilePath, chefAvatarUrl: file.tempFilePath, chefAvatarType: file.fileType || "" });
      },
      fail: (error) => handlePhotoPickerFailure(error, "头像"),
    });
  },
  async saveChefProfile() {
    if (this.data.saving) return;
    const name = this.data.chefName.trim().slice(0, 12);
    if (!name) return wx.showToast({ title: "请填写厨师昵称", icon: "none" });
    const duplicate = this.data.profiles.find((profile) => profile.id !== this.data.editChefId && profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) return wx.showToast({ title: "这位厨师已经在名单里", icon: "none" });
    const avatar = AVATARS[this.data.chefAvatarIndex] || AVATARS[0];
    this.setData({ saving: true });
    wx.showLoading({ title: "正在保存", mask: true });
    try {
      let avatarUrl = this.data.chefAvatarUrl || null;
      if (this.data.chefAvatarPath) avatarUrl = await uploadWechatAvatar(this.data.chefAvatarPath, this.data.chefAvatarType);
      const payload = {
        id: this.data.editChefId || undefined,
        name,
        avatar_index: this.data.chefAvatarIndex,
        tone: avatar.tone,
        avatar_url: avatarUrl,
      };
      const result = await saveChef(payload);
      const saved = profileView(Object.assign({}, payload, { id: result.id }), false);
      let profiles = this.data.profiles.filter((profile) => profile.id !== saved.id);
      profiles = profiles.concat(saved);
      let editChefIds = this.data.editChefIds;
      if (this.data.chefFromMeal && !this.data.editChefId) editChefIds = editChefIds.concat(saved.id);
      this.setData({
        profiles,
        editProfiles: profiles.map((profile) => profileView(profile, editChefIds.includes(profile.id))),
        editChefIds,
        chefEditorVisible: false,
        saving: false,
      });
      wx.hideLoading();
      const toastTitle = this.data.chefIdentityMode
        ? (this.data.editChefExists ? "厨王身份已更新" : "已建立厨王身份")
        : (this.data.editChefId ? "厨师资料已更新" : "已添加新厨师");
      wx.showToast({ title: toastTitle, icon: "success" });
      this.triggerEvent("changed");
      this.load();
    } catch (error) {
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showModal({ title: "保存失败", content: error.message || "请稍后重试", showCancel: false });
    }
  },
  confirmDeleteChef() {
    const profile = this.data.profiles.find((item) => item.id === this.data.editChefId);
    if (!profile || this.data.saving) return;
    const affected = this.data.meals.filter((meal) => Array.isArray(meal.chef_ids) && meal.chef_ids.includes(profile.id));
    const sole = affected.filter((meal) => meal.chef_ids.length === 1);
    if (sole.length) return wx.showModal({ title: "暂时不能删除", content: `「${profile.name}」仍是 ${sole.length} 餐的唯一厨师。请先编辑这些餐次，添加其他厨师后再删除。`, showCancel: false });
    wx.showModal({
      title: "删除这位厨师？",
      content: `确定删除「${profile.name}」吗？共同参与的餐次会保留。`,
      confirmText: "删除",
      confirmColor: "#c34d4d",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ saving: true });
        wx.showLoading({ title: "正在删除", mask: true });
        try {
          await deleteChef(profile.id);
          for (const meal of affected) {
            await updateMeal(meal.id, { chef_ids: meal.chef_ids.filter((id) => id !== profile.id) });
          }
          wx.hideLoading();
          this.setData({ saving: false, chefEditorVisible: false });
          wx.showToast({ title: `已删除厨师「${profile.name}」`, icon: "success" });
          this.triggerEvent("changed");
          this.load();
        } catch (error) {
          wx.hideLoading();
          this.setData({ saving: false });
          wx.showModal({ title: "删除未完成", content: error.message || "请重新打开名单检查", showCancel: false });
          this.load();
        }
      },
    });
  },
  },
});
