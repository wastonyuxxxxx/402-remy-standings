const { getProfiles, createMeal, recognize, uploadMealPhoto } = require("../../lib/api");

const today = () => {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

Page({
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
    saving: false,
  },
  onLoad() { this.loadProfiles(); },
  async loadProfiles() {
    try {
      const profiles = await getProfiles();
      this.setData({ profiles: profiles.filter((profile) => profile.name !== "我的厨王")
        .map((profile) => Object.assign({}, profile, { selected: false })) });
    } catch (error) {
      wx.showToast({ title: error.message || "厨师名单加载失败", icon: "none" });
    }
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const file = result.tempFiles[0];
        wx.compressImage({
          src: file.tempFilePath,
          quality: 72,
          compressedWidth: 1200,
          success: (compressed) => this.preparePhoto(compressed.tempFilePath),
          fail: () => this.preparePhoto(file.tempFilePath),
        });
      },
      fail: (error) => {
        if (/cancel/i.test(error.errMsg || "")) return;
        wx.showToast({ title: error.errMsg || "选择照片失败", icon: "none" });
      },
    });
  },
  preparePhoto(filePath) {
    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        this.setData({ photoPath: filePath, photoWidth: info.width, photoHeight: info.height, photoType: info.type || "", dishes: [] });
        this.runRecognition();
      },
      fail: () => wx.showToast({ title: "无法读取照片", icon: "none" }),
    });
  },
  async runRecognition() {
    if (!this.data.photoPath || this.data.recognition === "loading") return;
    this.setData({ recognition: "loading", recognitionError: "" });
    try {
      const recognized = await recognize(this.data.photoPath, this.data.photoWidth, this.data.photoHeight, this.data.photoType);
      const dishes = recognized.map((dish, index) => ({
        id: `dish-${Date.now()}-${index}`,
        name: dish.name || "",
        bbox: dish.bbox || null,
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
    this.setData({ dishes: this.data.dishes.concat({ id: `dish-${Date.now()}`, name: "", bbox: null }) });
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
      setTimeout(() => wx.navigateBack(), 700);
    } catch (error) {
      wx.hideLoading();
      wx.showModal({ title: "发布失败", content: error.message || "请稍后重试", showCancel: false });
      this.setData({ saving: false });
    }
  },
});
