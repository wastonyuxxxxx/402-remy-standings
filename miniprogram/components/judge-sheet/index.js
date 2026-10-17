const { getMeals, getProfiles, scoreMeal } = require("../../lib/api");

function formatScore(value) {
  const score = Number(value);
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

Component({
  properties: {
    visible: { type: Boolean, value: false, observer(value) { if (value) this.load(); } },
  },
  data: {
    meals: [],
    profiles: [],
    selectedId: "",
    selectedMeal: null,
    score: 8,
    scoreLabel: "8",
    saving: false,
    loading: false,
    error: "",
  },
  methods: {
    stopTap() {},
    closeSheet() { this.triggerEvent("close"); },
    async load() {
      this.setData({ loading: true, error: "" });
      try {
        const result = await Promise.all([getMeals(), getProfiles()]);
        const profiles = result[1];
        const meals = result[0].map((meal) => {
          const chefIds = Array.isArray(meal.chef_ids) ? meal.chef_ids : [];
          const chefNames = chefIds.map((id) => {
            const profile = profiles.find((item) => item.id === id);
            return profile ? profile.name : "";
          }).filter(Boolean);
          return Object.assign({}, meal, {
            heading: meal.title || `${meal.meal_date || "日期未知"} ${meal.meal_type || ""}`,
            dateLabel: meal.meal_date || "日期未知",
            chefNames,
            chefSummary: chefNames.join(" · "),
            scoreLabel: meal.score == null ? "" : formatScore(meal.score),
            selected: false,
          });
        });
        const selected = meals.find((meal) => meal.score == null) || meals[0] || null;
        const selectedId = selected ? selected.id : "";
        const score = selected && selected.score != null ? Number(selected.score) : 8;
        this.setData({
          profiles,
          meals: meals.map((meal) => Object.assign({}, meal, { selected: meal.id === selectedId })),
          selectedId,
          selectedMeal: selected,
          score,
          scoreLabel: formatScore(score),
          loading: false,
        });
      } catch (error) {
        this.setData({ loading: false, error: error.message || "加载失败" });
      }
    },
    retry() { this.load(); },
    selectMeal(event) {
      const selectedId = event.currentTarget.dataset.id;
      const meal = this.data.meals.find((item) => item.id === selectedId);
      if (!meal) return;
      const score = meal.score == null ? 8 : Number(meal.score);
      this.setData({
        selectedId,
        selectedMeal: meal,
        score,
        scoreLabel: formatScore(score),
        meals: this.data.meals.map((item) => Object.assign({}, item, { selected: item.id === selectedId })),
      });
    },
    changeScore(event) {
      const rawScore = Number(event.detail.value);
      if (!Number.isFinite(rawScore)) return;
      const score = Math.max(1, Math.min(10, Math.round(rawScore * 2) / 2));
      this.setData({ score, scoreLabel: formatScore(score) });
    },
    async submit() {
      if (!this.data.selectedId || this.data.saving) return;
      this.setData({ saving: true });
      wx.showLoading({ title: "正在保存", mask: true });
      try {
        await scoreMeal(this.data.selectedId, this.data.score);
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: "评分已保存", icon: "success" });
        this.triggerEvent("scored");
      } catch (error) {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showModal({ title: "保存失败", content: error.message || "请稍后重试", showCancel: false });
      }
    },
  },
});
