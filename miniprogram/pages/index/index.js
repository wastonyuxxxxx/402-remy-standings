const { getProfiles, getMeals } = require("../../lib/api");
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
  },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [profiles, meals] = await Promise.all([getProfiles(), getMeals()]);
      const visible = profiles.filter((profile) => profile.name !== "我的厨王" || meals.some((meal) => meal.chef_ids?.includes(profile.id)));
      const latest = meals[0] || null;
      this.meals = meals;
      this.profiles = visible;
      this.setData({
        chefs: chefStandings(visible, meals, this.data.mode),
        dishes: dishStandings(meals),
        latest: latest ? Object.assign({}, latest, {
          chefNames: latest.chef_ids.map((id) => profiles.find((profile) => profile.id === id)?.name || "厨师").join(" · "),
          dateLabel: latest.meal_date.replace(/-/g, "."),
          dishCount: Array.isArray(latest.dishes) ? latest.dishes.length : 0,
          scoreLabel: latest.score == null ? "待评分" : `${Number(latest.score).toFixed(1)} / 10`,
        }) : null,
        profilesCount: visible.length,
        dishesCount: dishStandings(meals).length,
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
});
