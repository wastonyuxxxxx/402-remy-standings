import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../miniprogram/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("native mini program shares the V1 backend without embedding a webpage", async () => {
  const [project, app, home, publish, judge, manage, api, appJs, indexJs, judgeJs, publishJs, manageJs, indexConfig, judgeSheet, judgeSheetJs, manageSheet, manageSheetJs] = await Promise.all([
    read("project.config.json").then(JSON.parse),
    read("app.json").then(JSON.parse),
    read("pages/index/index.wxml"),
    read("components/publish-sheet/index.wxml"),
    read("pages/judge/judge.wxml"),
    read("pages/manage/manage.wxml"),
    read("lib/api.js"),
    read("app.js"),
    read("pages/index/index.js"),
    read("pages/judge/judge.js"),
    read("components/publish-sheet/index.js"),
    read("pages/manage/manage.js"),
    read("pages/index/index.json").then(JSON.parse),
    read("components/judge-sheet/index.wxml"),
    read("components/judge-sheet/index.js"),
    read("components/manage-sheet/index.wxml"),
    read("components/manage-sheet/index.js"),
  ]);

  assert.equal(project.appid, "wxe5fcf6be56ed781e");
  assert.deepEqual(project.packOptions.ignore, []);
  assert.deepEqual(app.pages, ["pages/index/index", "pages/publish/publish", "pages/judge/judge", "pages/manage/manage"]);
  assert.doesNotMatch(home + publish + judge + manage, /<web-view\b/);
  assert.match(home, /主厨榜/);
  assert.match(home, /平均得分/);
  assert.match(home, /上桌次数/);
  assert.match(indexJs, /switchDishMode\(event\)/);
  assert.match(publish, /添加漏识别的菜品/);
  assert.match(publish, /class="publish-mask"/);
  assert.match(publish, /class="results-list"/);
  assert.match(indexJs, /publishVisible: false/);
  assert.match(indexJs, /goPublish\(\) \{ this\.setData\(\{ publishVisible: true \}\); \}/);
  assert.match(indexJs, /goJudge\(\) \{ this\.setData\(\{ judgeVisible: true \}\); \}/);
  assert.equal(indexConfig.usingComponents["judge-sheet"], "/components/judge-sheet/index");
  assert.equal(indexConfig.usingComponents["manage-sheet"], "/components/manage-sheet/index");
  assert.match(home, /<judge-sheet visible="\{\{judgeVisible\}\}"/);
  assert.match(judgeSheet, /class="judge-mask"/);
  assert.match(judgeSheet, /class="meal-preview"/);
  assert.match(judgeSheet, /min="1" max="10" step="0\.5"/);
  assert.match(judgeSheetJs, /meal\.score == null/);
  assert.match(judgeSheetJs, /triggerEvent\("scored"\)/);
  assert.match(judge, /保存评分/);
  assert.match(home, /管理全部餐次/);
  assert.match(home, /管理厨师/);
  assert.match(home, /bindtap="openSelfChefEditor"/);
  assert.match(home, /设置厨王/);
  assert.doesNotMatch(home, /class="wechat-profile-trigger"/);
  assert.match(manageSheet, /编辑微信资料（昵称与头像）/);
  assert.match(manageSheetJs, /triggerEvent\("wechatprofile"\)/);
  assert.match(home, /bindwechatprofile="openWechatProfile"/);
  assert.match(indexJs, /openWechatProfile\(\)/);
  assert.match(home, /pendingMealCount \? pendingMealCount/);
  assert.match(home, /编辑这一餐/);
  assert.match(home, /bindtap="goEditLatest"/);
  assert.match(home, /target-meal-id="\{\{manageTargetMealId\}\}"/);
  assert.match(indexJs, /chefCount: visible\.length/);
  assert.match(indexJs, /manageTargetMealId: this\.data\.latest\.id/);
  assert.match(home, /<manage-sheet visible="\{\{manageVisible\}\}" tab="\{\{manageTab\}\}"/);
  assert.match(home, /target-chef-id="\{\{manageTargetChefId\}\}"/);
  assert.match(manageSheet, /class="manage-mask"/);
  assert.match(manageSheet, /选择要编辑的餐次/);
  assert.match(manageSheet, /新增厨师/);
  assert.match(manageSheet, /保存修改/);
  assert.match(manageSheet, /删除餐次/);
  assert.match(manageSheet, /删除厨师/);
  assert.match(manageSheetJs, /this\.triggerEvent\("changed"\)/);
  assert.match(manageSheetJs, /targetMealId: \{ type: String, value: "" \}/);
  assert.match(manageSheetJs, /this\.openMealRecord\(targetMealId\)/);
  assert.match(manageSheetJs, /targetChefId: \{ type: String, value: "" \}/);
  assert.match(manageSheetJs, /this\.openChefEditor\(null, false, true, targetChefId\)/);
  assert.match(indexJs, /selfChefName: selfChef \? selfChef\.name : ""/);
  assert.match(indexJs, /profilesCount: chefs\.length/);
  assert.match(manageJs, /管理全部餐次/);
  assert.match(manageJs, /管理厨师/);
  assert.doesNotMatch([publishJs, manageSheetJs, manageJs].join("\n"), /profile\.name !== "我的厨王"/);
  assert.doesNotMatch(manage, /switchTab|class="tabs"/);
  assert.match(manage, /保存修改/);
  assert.match(manage, /删除餐次/);
  assert.match(manage, /删除厨师/);
  assert.match(api, /lbzuahqvdzwwxqxbbohd\.supabase\.co/);
  assert.doesNotMatch(await read("app.js"), /wx\.login|tryWechatLogin/);
  assert.doesNotMatch(api, /appsecret|service_role|siliconflow_api_key/i);
  assert.doesNotMatch([appJs, indexJs, judgeJs, publishJs, manageJs, judgeSheetJs, manageSheetJs, api].join("\n"), /\?\./, "Mini Program JS must stay parseable with the current WeChat compiler settings");
});

test("privacy-sensitive mini program actions use WeChat's authorization callback", async () => {
  const [app, appJs, componentJs, componentWxml, pageConfigs, pageWxml] = await Promise.all([
    read("app.json").then(JSON.parse),
    read("app.js"),
    read("components/privacy-authorization/index.js"),
    read("components/privacy-authorization/index.wxml"),
    Promise.all(["index", "publish", "judge", "manage"].map((page) => read(`pages/${page}/${page}.json`).then(JSON.parse))),
    Promise.all(["index", "publish", "judge", "manage"].map((page) => read(`pages/${page}/${page}.wxml`))),
  ]);

  assert.equal(app.__usePrivacyCheck__, true);
  assert.match(appJs, /wx\.onNeedPrivacyAuthorization/);
  assert.match(appJs, /selectComponent\("#privacyAuthorization"\)/);
  for (const config of pageConfigs) {
    assert.equal(config.usingComponents["privacy-authorization"], "/components/privacy-authorization/index");
  }
  for (const markup of pageWxml) assert.match(markup, /<privacy-authorization id="privacyAuthorization"\s*\/>/);
  assert.match(componentWxml, /open-type="agreePrivacyAuthorization"/);
  assert.match(componentWxml, /bindagreeprivacyauthorization="agree"/);
  assert.match(componentWxml, /SiliconFlow/);
  assert.match(componentWxml, /Supabase/);
  assert.match(componentJs, /this\.finish\(\{ event: "agree", buttonId: event\.detail\.buttonId \}\)/);
  assert.match(componentJs, /this\.finish\(\{ event: "disagree" \}\)/);
  assert.match(componentJs, /wx\.openPrivacyContract/);
});

test("mini program management operations target individual records and verify returned rows", async () => {
  const api = await read("lib/api.js");
  const manage = await read("pages/manage/manage.js");
  assert.match(api, /async function updateMeal\(mealId, fields\)/);
  assert.match(api, /async function deleteMeal\(mealId\)/);
  assert.match(api, /functions\/v1\/mini-meal-delete/);
  assert.match(api, /async function saveChef\(profile\)/);
  assert.match(api, /profile\.id !== auth\.user\.id/);
  assert.match(api, /resolution=ignore-duplicates,return=representation/);
  assert.match(api, /async function deleteChef\(profileId\)/);
  assert.match(api, /Prefer: "return=representation"/);
  assert.match(manage, /至少选择一位厨师/);
  assert.match(manage, /唯一厨师/);
  assert.match(manage, /共同参与的餐次会保留/);
});

test("mini program keeps editable dish names in the publish flow", async () => {
  const [page, template, picker] = await Promise.all([
    read("components/publish-sheet/index.js"),
    read("components/publish-sheet/index.wxml"),
    read("lib/photo-picker.js"),
  ]);
  assert.match(page, /changeDishName/);
  assert.match(page, /addDish\(\)/);
  assert.match(page, /runRecognition\(\)/);
  assert.match(template, /bindinput="changeDishName"/);
  assert.match(template, /重新识别/);
  assert.match(template, /关闭弹窗后仍会继续识别/);
  assert.match(template, /查看结果/);
  assert.match(page, /handlePhotoPickerFailure\(error, "照片"\)/);
  assert.match(picker, /api scope is not declared in the privacy agreement/i);
  assert.doesNotMatch(template, /最多\s*6\s*道|6\s*道上限/);
});

test("photo picker errors explain privacy setup and device permission issues", async () => {
  const [helper, publish, manageSheet, managePage] = await Promise.all([
    read("lib/photo-picker.js"),
    read("components/publish-sheet/index.js"),
    read("components/manage-sheet/index.js"),
    read("pages/manage/manage.js"),
  ]);
  assert.match(helper, /api scope is not declared in the privacy agreement/i);
  assert.match(helper, /privacy permission is not authorized/i);
  assert.match(helper, /system auth deny/i);
  assert.match(publish, /handlePhotoPickerFailure\(error, "照片"\)/);
  assert.match(manageSheet, /handlePhotoPickerFailure\(error, "照片"\)/);
  assert.match(manageSheet, /handlePhotoPickerFailure\(error, "头像"\)/);
  assert.match(managePage, /handlePhotoPickerFailure\(error, "照片"\)/);
  assert.match(managePage, /handlePhotoPickerFailure\(error, "头像"\)/);
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
