import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../miniprogram/lib/standings.js", import.meta.url), "utf8");
const { dishStandings } = new Function(source.replace(
  "module.exports = { chefStandings, dishStandings };",
  "return { chefStandings, dishStandings };",
))();

test("dish standings support the same score and appearance sort modes as the website", () => {
  const meals = [
    { dishes: [{ name: "番茄炒蛋", score: 9 }, { name: "红烧肉", score: 10 }] },
    { dishes: [{ name: "番茄炒蛋", score: 8 }, { name: "鱼香茄子", score: 9 }] },
    { dishes: [{ name: "番茄炒蛋", score: 10 }] },
  ];

  const byScore = dishStandings(meals, "score");
  assert.deepEqual(byScore.map(({ name, rank }) => [name, rank]), [
    ["红烧肉", 1],
    ["番茄炒蛋", 2],
    ["鱼香茄子", 3],
  ]);

  const byAppearances = dishStandings(meals, "appearances");
  assert.deepEqual(byAppearances.map(({ name, count, rank }) => [name, count, rank]), [
    ["番茄炒蛋", 3, 1],
    ["红烧肉", 1, 2],
    ["鱼香茄子", 1, 3],
  ]);
});
