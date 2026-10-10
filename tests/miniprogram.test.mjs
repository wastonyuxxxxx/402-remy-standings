import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../miniprogram/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("native mini program shares the V1 backend without embedding a webpage", async () => {
  const [project, app, home, publish, judge, api] = await Promise.all([
    read("project.config.json").then(JSON.parse),
    read("app.json").then(JSON.parse),
    read("pages/index/index.wxml"),
    read("pages/publish/publish.wxml"),
    read("pages/judge/judge.wxml"),
    read("lib/api.js"),
  ]);

  assert.equal(project.appid, "wxe5fcf6be56ed781e");
  assert.deepEqual(app.pages, ["pages/index/index", "pages/publish/publish", "pages/judge/judge"]);
  assert.doesNotMatch(home + publish + judge, /<web-view\b/);
  assert.match(home, /主厨榜/);
  assert.match(publish, /添加漏识别菜品/);
  assert.match(judge, /保存评分/);
  assert.match(api, /lbzuahqvdzwwxqxbbohd\.supabase\.co/);
  assert.doesNotMatch(api, /appsecret|service_role|siliconflow_api_key/i);
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
  assert.doesNotMatch(template, /最多\s*6\s*道|6\s*道上限/);
});
