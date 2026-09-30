import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../miniprogram/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("mini program opens the canonical V1 site with the test AppID", async () => {
  const [project, app, page, template] = await Promise.all([
    read("project.config.json").then(JSON.parse),
    read("app.json").then(JSON.parse),
    read("pages/index/index.js"),
    read("pages/index/index.wxml"),
  ]);

  assert.match(project.appid, /^wx[0-9a-f]{16}$/i);
  assert.equal(project.compileType, "miniprogram");
  assert.deepEqual(app.pages, ["pages/index/index"]);
  assert.match(page, /https:\/\/wastonyuxxxxx\.github\.io\/402-remy-standings\//);
  assert.match(template, /<web-view src="{{siteUrl}}"><\/web-view>/);
  assert.doesNotMatch(page, /appsecret|service_role|siliconflow_api_key/i);
});
