const { getMeals, scoreMeal } = require("../../lib/api");

Page({
  data: {
    meals: [],
    selectedId: "",
    score: 8,
    scoreLabel: "8.0",
    saving: false,
    loading: true,
    error: "",
  },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const meals = await getMeals();
      this.setData({
        meals: meals.map((meal) => Object.assign({}, meal, {
          summary: `${meal.meal_date} ${meal.meal_type} · ${meal.dishes?.length || 0} 道菜`,
          selected: meal.id === this.data.selectedId,
        })),
        selectedId: this.data.selectedId || (meals[0]?.id || ""),
        loading: false,
      });
      if (!this.data.meals.some((meal) => meal.selected) && meals.length) this.selectMeal({ currentTarget: { dataset: { id: meals[0].id } } });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "加载失败" });
    }
  },
  selectMeal(event) {
    const selectedId = event.currentTarget.dataset.id;
    const meal = this.data.meals.find((item) => item.id === selectedId);
    const score = meal?.score == null ? 8 : Number(meal.score);
    this.setData({ selectedId, score, scoreLabel: score.toFixed(1), meals: this.data.meals.map((item) => Object.assign({}, item, { selected: item.id === selectedId })) });
  },
  decrease() { const score = Math.max(0, this.data.score - 0.5); this.setData({ score, scoreLabel: score.toFixed(1) }); },
  increase() { const score = Math.min(10, this.data.score + 0.5); this.setData({ score, scoreLabel: score.toFixed(1) }); },
  async submit() {
    if (!this.data.selectedId || this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: "正在保存", mask: true });
    try {
      await scoreMeal(this.data.selectedId, this.data.score);
      wx.hideLoading();
      wx.showToast({ title: "评分已保存", icon: "success" });
      this.setData({ saving: false });
      this.load();
    } catch (error) {
      wx.hideLoading();
      wx.showModal({ title: "保存失败", content: error.message || "请稍后重试", showCancel: false });
      this.setData({ saving: false });
    }
  },
});
