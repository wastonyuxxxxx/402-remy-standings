function rounded(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

const avatarAssets = [
  "/assets/miko-avatar-01.png",
  "/assets/miko-avatar-02.png",
  "/assets/miko-avatar-03.png",
  "/assets/miko-avatar-04.png",
  "/assets/miko-avatar-05.png",
];

function chefStandings(profiles, meals, mode = "total") {
  return profiles.map((profile) => {
    const scores = meals.filter((meal) => Array.isArray(meal.chef_ids) && meal.chef_ids.includes(profile.id))
      .map((meal) => Number(meal.score)).filter((score) => Number.isFinite(score) && score > 0);
    const sorted = scores.slice().sort((a, b) => b - a);
    const value = mode === "average"
      ? scores.reduce((sum, score) => sum + score, 0) / (scores.length || 1)
      : mode === "top3" ? sorted.slice(0, 3).reduce((sum, score) => sum + score, 0)
        : scores.reduce((sum, score) => sum + score, 0);
    const avatarIndex = Math.max(0, Math.min(avatarAssets.length - 1, Number(profile.avatar_index || 0)));
    return { id: profile.id, name: profile.name, avatarUrl: profile.avatar_url || avatarAssets[avatarIndex], meals: scores.length, score: rounded(value) };
  }).filter((chef) => chef.meals > 0).sort((a, b) => b.score - a.score || b.meals - a.meals || a.name.localeCompare(b.name))
    .map((chef, index) => Object.assign({}, chef, { rank: index + 1 }));
}

function dishStandings(meals) {
  const groups = new Map();
  meals.forEach((meal) => (Array.isArray(meal.dishes) ? meal.dishes : []).forEach((dish) => {
    const name = typeof dish.name === "string" ? dish.name.trim() : "";
    if (!name) return;
    const group = groups.get(name) || { name, count: 0, total: 0, scored: 0 };
    group.count += 1;
    const score = Number(dish.score);
    if (Number.isFinite(score) && score > 0) { group.total += score; group.scored += 1; }
    groups.set(name, group);
  }));
  return [...groups.values()].map((dish) => ({
    name: dish.name, count: dish.count, score: rounded(dish.total / (dish.scored || 1)),
  })).sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name))
    .map((dish, index) => Object.assign({}, dish, { rank: index + 1 }));
}

module.exports = { chefStandings, dishStandings };
