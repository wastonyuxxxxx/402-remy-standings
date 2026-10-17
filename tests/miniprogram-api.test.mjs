import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../miniprogram/lib/api.js", import.meta.url), "utf8");

function loadApi(responses) {
  const requests = [];
  const storage = new Map();
  const wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    request(options) {
      requests.push(options);
      const response = responses.shift();
      queueMicrotask(() => options.success({ statusCode: response.statusCode || 200, data: response.data }));
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, wx }, { filename: "miniprogram/lib/api.js" });
  return { api: module.exports, requests };
}

test("personal chef creation can insert the current auth user's missing profile", async () => {
  const { api, requests } = loadApi([
    { data: { access_token: "session-token", refresh_token: "refresh", expires_in: 3600, user: { id: "current-user" } } },
    { data: [] },
    { statusCode: 201, data: [{ id: "current-user" }] },
  ]);

  const result = await api.saveChef({ id: "current-user", name: "我的厨王" });

  assert.equal(result.id, "current-user");
  assert.match(requests[1].url, /profiles\?id=eq\.current-user/);
  assert.equal(requests[1].method, "PATCH");
  assert.match(requests[2].url, /profiles\?on_conflict=id/);
  assert.equal(requests[2].method, "POST");
  assert.equal(requests[2].data.id, "current-user");
  assert.equal(requests[2].data.created_by, "current-user");
  assert.match(requests[2].header.Prefer, /resolution=ignore-duplicates/);
});

test("missing profiles for another user's id are not recreated", async () => {
  const { api, requests } = loadApi([
    { data: { access_token: "session-token", refresh_token: "refresh", expires_in: 3600, user: { id: "current-user" } } },
    { data: [] },
  ]);

  await assert.rejects(api.saveChef({ id: "someone-else", name: "厨师" }), /厨师资料没有保存/);
  assert.equal(requests.length, 2);
});
