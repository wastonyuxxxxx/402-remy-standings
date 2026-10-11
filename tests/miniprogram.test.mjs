import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../miniprogram/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("native mini program shares the V1 backend without embedding a webpage", async () => {
  const [project, app, home, publish, judge, manage, api, appJs, indexJs, judgeJs, publishJs, manageJs] = await Promise.all([
    read("project.config.json").then(JSON.parse),
    read("app.json").then(JSON.parse),
    read("pages/index/index.wxml"),
    read("pages/publish/publish.wxml"),
    read("pages/judge/judge.wxml"),
    read("pages/manage/manage.wxml"),
    read("lib/api.js"),
    read("app.js"),
    read("pages/index/index.js"),
    read("pages/judge/judge.js"),
    read("pages/publish/publish.js"),
    read("pages/manage/manage.js"),
  ]);

  assert.equal(project.appid, "wxe5fcf6be56ed781e");
  assert.deepEqual(project.packOptions.ignore, []);
  assert.deepEqual(app.pages, ["pages/index/index", "pages/publish/publish", "pages/judge/judge", "pages/manage/manage"]);
  assert.doesNotMatch(home + publish + judge + manage, /<web-view\b/);
  assert.match(home, /主厨榜/);
  assert.match(publish, /添加漏识别菜品/);
  assert.match(judge, /保存评分/);
  assert.match(home, /管理全部餐次/);
  assert.match(home, /管理厨师/);
  assert.match(indexJs, /chefCount: visible\.length/);
  assert.match(manageJs, /管理全部餐次/);
  assert.match(manageJs, /管理厨师/);
  assert.match(manageJs, /profile\.name !== "我的厨王" \|\| result\[1\]\.some/);
  assert.doesNotMatch(manage, /switchTab|class="tabs"/);
  assert.match(manage, /保存修改/);
  assert.match(manage, /删除餐次/);
  assert.match(manage, /删除厨师/);
  assert.match(api, /lbzuahqvdzwwxqxbbohd\.supabase\.co/);
  assert.doesNotMatch(await read("app.js"), /wx\.login|tryWechatLogin/);
  assert.doesNotMatch(api, /appsecret|service_role|siliconflow_api_key/i);
  assert.doesNotMatch([appJs, indexJs, judgeJs, publishJs, manageJs, api].join("\n"), /\?\./, "Mini Program JS must stay parseable with the current WeChat compiler settings");
});

test("mini program management operations target individual records and verify returned rows", async () => {
  const api = await read("lib/api.js");
  const manage = await read("pages/manage/manage.js");
  assert.match(api, /async function updateMeal\(mealId, fields\)/);
  assert.match(api, /async function deleteMeal\(mealId\)/);
  assert.match(api, /async function saveChef\(profile\)/);
  assert.match(api, /async function deleteChef\(profileId\)/);
  assert.match(api, /Prefer: "return=representation"/);
  assert.match(manage, /至少选择一位厨师/);
  assert.match(manage, /唯一厨师/);
  assert.match(manage, /共同参与的餐次会保留/);
});

test("mini program keeps editable dish names in the publish flow", async () => {
  const [page, template] = await Promise.all([
    read("pages/publish/publish.js"),
    read("pages/publish/publish.wxml"),
  ]);
  assert.match(page, /changeDishName/);
  assert.match(page, /addDish\(\)/);
  assert.match(page, /runRecognition\(\)/);
  assert.match(template, /bindinput="changeDishName"/);
  assert.match(template, /选中的照片会发送至菜品识别服务处理；发布后与餐次记录一起展示/);
  assert.doesNotMatch(template, /最多\s*6\s*道|6\s*道上限/);
});

test("WeChat profile data is opt-in and the native picker is available", async () => {
  const [home, page, api] = await Promise.all([
    read("pages/index/index.wxml"),
    read("pages/index/index.js"),
    read("lib/api.js"),
  ]);
  assert.match(home, /open-type="chooseAvatar"/);
  assert.match(home, /type="nickname"/);
  assert.match(home, /仅在你主动选择后保存/);
  assert.match(page, /saveWechatProfile/);
  assert.match(api, /storage\/v1\/object\/avatars/);
  assert.match(api, /wx\.login/);
  assert.doesNotMatch(api, /appsecret|service_role|siliconflow_api_key/i);
});
