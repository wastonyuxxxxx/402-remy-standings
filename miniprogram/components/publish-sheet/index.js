const { getProfiles, createMeal, recognize, uploadMealPhoto, saveChef } = require("../../lib/api");
const { handlePhotoPickerFailure } = require("../../lib/photo-picker");

const AVATARS = [
  { src: "/assets/miko-avatar-01.png", tone: "blue" },
  { src: "/assets/miko-avatar-02.png", tone: "gray" },
  { src: "/assets/miko-avatar-03.png", tone: "warm" },
  { src: "/assets/miko-avatar-04.png", tone: "mint" },
  { src: "/assets/miko-avatar-05.png", tone: "lavender" },
];

const today = () => {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

function dishCropStyle(bbox, imageWidth, imageHeight) {
  if (!bbox || !imageWidth || !imageHeight) return "";
  const values = [bbox.x, bbox.y, bbox.width, bbox.height].map(Number);
  if (values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) return "";
  const paddingX = values[2] * 0.12;
  const paddingY = values[3] * 0.12;
  const x0 = Math.max(0, values[0] - paddingX);
  const y0 = Math.max(0, values[1] - paddingY);
  const x1 = Math.min(1, values[0] + values[2] + paddingX);
  const y1 = Math.min(1, values[1] + values[3] + paddingY);
  const cropWidth = (x1 - x0) * imageWidth;
  const cropHeight = (y1 - y0) * imageHeight;
  const scale = Math.max(680 / cropWidth, 270 / cropHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const left = (680 - cropWidth * scale) / 2 - x0 * renderedWidth;
  const top = (270 - cropHeight * scale) / 2 - y0 * renderedHeight;
  return `width:${renderedWidth}rpx;height:${renderedHeight}rpx;left:${left}rpx;top:${top}rpx;`;
}

Component({
  properties: {
    visible: { type: Boolean, value: true, observer(value) { if (value) this.loadProfiles(); } },
  },
  data: {
    date: today(),
    mealType: "晚餐",
    profiles: [],
    chosenChefs: [],
    photoPath: "",
    photoWidth: 0,
    photoHeight: 0,
    photoType: "",
    recognition: "idle",
    recognitionError: "",
    dishes: [],
    resultsVisible: false,
    addChefVisible: false,
    chefName: "",
    chefAvatarIndex: 0,
    avatars: AVATARS,
    saving: false,
  },
  methods: {
    async loadProfiles() {
      if (this._loadingProfiles || this._profilesLoaded) return;
      this._loadingProfiles = true;
      try {
        const profiles = await getProfiles();
        this.setData({ profiles: profiles.map((profile) => {
            const avatarIndex = Math.max(0, Math.min(AVATARS.length - 1, Number(profile.avatar_index || 0)));
            return Object.assign({}, profile, { selected: false, avatarSource: profile.avatar_url || AVATARS[avatarIndex].src });
          }) });
        this._profilesLoaded = true;
      } catch (error) {
        wx.showToast({ title: error.message || "厨师名单加载失败", icon: "none" });
      } finally {
        this._loadingProfiles = false;
      }
    },
    stopTap() {},
    closeSheet() { this.triggerEvent("close"); },
    closeResults() { this.setData({ resultsVisible: false }); },
    showResults() { this.setData({ resultsVisible: true }); },
    choosePhoto() {
      wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        success: (result) => {
          const file = result.tempFiles[0];
          if (!file) return;
          wx.compressImage({
            src: file.tempFilePath,
            quality: 72,
            compressedWidth: 1200,
            success: (compressed) => this.preparePhoto(compressed.tempFilePath),
            fail: () => this.preparePhoto(file.tempFilePath),
          });
        },
        fail: (error) => handlePhotoPickerFailure(error, "照片"),
      });
    },
    preparePhoto(filePath) {
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          this.setData({ photoPath: filePath, photoWidth: info.width, photoHeight: info.height, photoType: info.type || "", dishes: [], recognition: "idle" });
          this.runRecognition();
        },
        fail: () => wx.showToast({ title: "无法读取照片", icon: "none" }),
      });
    },
    async runRecognition() {
      if (!this.data.photoPath || this.data.recognition === "loading") return;
      this.setData({ recognition: "loading", recognitionError: "", resultsVisible: true });
      try {
        const recognized = await recognize(this.data.photoPath, this.data.photoWidth, this.data.photoHeight, this.data.photoType);
        const dishes = recognized.map((dish, index) => ({
          id: `dish-${Date.now()}-${index}`,
          name: dish.name || "",
          bbox: dish.bbox || null,
          cropStyle: dishCropStyle(dish.bbox, this.data.photoWidth, this.data.photoHeight),
        }));
        this.setData({ recognition: "done", dishes });
      } catch (error) {
        this.setData({ recognition: "error", recognitionError: error.message || "识别失败" });
      }
    },
    changeDishName(event) {
      const index = Number(event.currentTarget.dataset.index);
      const dishes = this.data.dishes.slice();
      dishes[index] = Object.assign({}, dishes[index], { name: event.detail.value });
      this.setData({ dishes });
    },
    addDish() {
      this.setData({ dishes: this.data.dishes.concat({ id: `dish-${Date.now()}`, name: "", bbox: null, cropStyle: "" }) });
    },
    removeDish(event) {
      const index = Number(event.currentTarget.dataset.index);
      this.setData({ dishes: this.data.dishes.filter((_, position) => position !== index) });
    },
    changeDate(event) { this.setData({ date: event.detail.value }); },
    changeMealType(event) { this.setData({ mealType: event.currentTarget.dataset.type }); },
    toggleChef(event) {
      const id = event.currentTarget.dataset.id;
      const chosen = this.data.chosenChefs;
      const chosenChefs = chosen.includes(id) ? chosen.filter((value) => value !== id) : chosen.concat(id);
      this.setData({
        chosenChefs,
        profiles: this.data.profiles.map((profile) => Object.assign({}, profile, { selected: chosenChefs.includes(profile.id) })),
      });
    },
    openNewChef() {
      this.setData({ addChefVisible: true, chefName: "", chefAvatarIndex: this.data.profiles.length % AVATARS.length });
    },
    closeNewChef() { if (!this.data.saving) this.setData({ addChefVisible: false }); },
    changeChefName(event) { this.setData({ chefName: event.detail.value }); },
    selectChefAvatar(event) { this.setData({ chefAvatarIndex: Number(event.currentTarget.dataset.index) || 0 }); },
    async saveNewChef() {
      const name = this.data.chefName.trim().slice(0, 12);
      if (!name) return wx.showToast({ title: "请填写厨师昵称", icon: "none" });
      if (this.data.profiles.some((profile) => String(profile.name || "").trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return wx.showToast({ title: "这位厨师已经在名单里", icon: "none" });
      }
      const avatar = AVATARS[this.data.chefAvatarIndex] || AVATARS[0];
      this.setData({ saving: true });
      wx.showLoading({ title: "正在保存", mask: true });
      try {
        const result = await saveChef({ name, avatar_index: this.data.chefAvatarIndex, tone: avatar.tone });
        const profile = Object.assign({}, result, {
          name,
          avatar_index: this.data.chefAvatarIndex,
          tone: avatar.tone,
          avatar_url: null,
          selected: true,
          avatarSource: avatar.src,
        });
        const chosenChefs = this.data.chosenChefs.concat(result.id);
        this.setData({
          profiles: this.data.profiles.concat(profile),
          chosenChefs,
          addChefVisible: false,
          saving: false,
        });
        wx.hideLoading();
        wx.showToast({ title: "已添加并选中厨师", icon: "success" });
      } catch (error) {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showModal({ title: "添加失败", content: error.message || "请稍后重试", showCancel: false });
      }
    },
    async publish() {
      if (this.data.saving) return;
      if (!this.data.photoPath) return wx.showToast({ title: "请先上传餐桌照片", icon: "none" });
      if (!this.data.chosenChefs.length) return wx.showToast({ title: "请选择本桌厨师", icon: "none" });
      const names = this.data.dishes.map((dish) => dish.name.trim()).filter(Boolean);
      if (!names.length) return wx.showToast({ title: "请先确认或添加菜品", icon: "none" });
      this.setData({ saving: true });
      wx.showLoading({ title: "正在发布", mask: true });
      try {
        const imageUrl = await uploadMealPhoto(this.data.photoPath, this.data.photoType);
        const dateLabel = this.data.date.replace(/-/g, ".");
        await createMeal({
          title: `${dateLabel} ${this.data.mealType}`,
          meal_date: this.data.date,
          meal_type: this.data.mealType,
          chef_ids: this.data.chosenChefs,
          dishes: names.map((name, index) => ({ id: `dish-${Date.now()}-${index}`, name })),
          image_url: imageUrl,
          score: null,
          judge_scores: [null],
        });
        wx.hideLoading();
        wx.showToast({ title: "发布成功", icon: "success" });
        this.setData({ saving: false, resultsVisible: false });
        this.triggerEvent("published");
      } catch (error) {
        wx.hideLoading();
        wx.showModal({ title: "发布失败", content: error.message || "请稍后重试", showCancel: false });
        this.setData({ saving: false });
      }
    },
  },
});
