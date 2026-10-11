import assert from "node:assert/strict";
import test, { before } from "node:test";

let handler;
let writes;
let createNewAccount = false;

before(async () => {
  globalThis.Deno = {
    env: { get: (name) => ({
      WECHAT_APP_SECRET: "test-only-secret",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
    })[name] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.weixin.qq.com/")) return Response.json({ openid: "openid-for-test", unionid: "raw-unionid-for-test" });
    if (url.includes("/rest/v1/wechat_accounts?") && (!options.method || options.method === "GET")) {
      return Response.json(createNewAccount ? [] : [{ openid_hash: "hashed", user_id: "user-123" }]);
    }
    if (url.includes("/auth/v1/admin/users/") && options.method === "PUT") {
      writes.push({ kind: "user", body: JSON.parse(options.body) });
      return Response.json({ id: "user-123" });
    }
    if (url.includes("/rest/v1/wechat_accounts?") && options.method === "PATCH") {
      writes.push({ kind: "account", body: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/auth/v1/admin/users") && options.method === "POST") {
      return Response.json({ id: "user-456" });
    }
    if (url.endsWith("/rest/v1/wechat_accounts") && options.method === "POST") {
      writes.push({ kind: "account_insert", body: JSON.parse(options.body) });
      return Response.json({}, { status: 201 });
    }
    if (url.endsWith("/auth/v1/admin/generate_link")) return Response.json({ properties: { hashed_token: "hash" } });
    if (url.endsWith("/auth/v1/verify")) return Response.json({ access_token: "token", user: { id: "user-123" } });
    throw new Error(`Unexpected request: ${url}`);
  };
  await import("../supabase/functions/wechat-session/index.ts");
});

function request(body) {
  return new Request("https://project.supabase.co/functions/v1/wechat-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a routine WeChat login preserves previously saved optional profile data", async () => {
  writes = [];
  const response = await handler(request({ code: "one-time-login-code" }));
  assert.equal(response.status, 200);
  const accountWrite = writes.find((write) => write.kind === "account");
  assert.ok(accountWrite);
  assert.equal("unionid" in accountWrite.body, false);
  assert.equal("nickname" in accountWrite.body, false);
  assert.equal("avatar_url" in accountWrite.body, false);
  assert.equal(writes.some((write) => write.kind === "user"), false);
});

test("first login stores only a hashed OpenID and never stores the raw UnionID", async () => {
  writes = [];
  createNewAccount = true;
  try {
    const response = await handler(request({ code: "one-time-login-code" }));
    assert.equal(response.status, 200);
    const accountWrite = writes.find((write) => write.kind === "account_insert");
    assert.ok(accountWrite);
    assert.match(accountWrite.body.openid_hash, /^[a-f0-9]{64}$/);
    assert.equal("unionid" in accountWrite.body, false);
  } finally {
    createNewAccount = false;
  }
});

test("explicitly provided nickname and first-party avatar URL are saved", async () => {
  writes = [];
  const response = await handler(request({
    code: "one-time-login-code",
    nickname: "小厨师",
    avatar_url: "https://project.supabase.co/storage/v1/object/public/avatars/user-123/avatar.jpg",
  }));
  assert.equal(response.status, 200);
  const accountWrite = writes.find((write) => write.kind === "account");
  const userWrite = writes.find((write) => write.kind === "user");
  assert.equal(accountWrite.body.nickname, "小厨师");
  assert.match(accountWrite.body.avatar_url, /\/avatars\/user-123\/avatar.jpg$/);
  assert.deepEqual(userWrite.body.user_metadata, {
    provider: "wechat",
    nickname: "小厨师",
    avatar_url: "https://project.supabase.co/storage/v1/object/public/avatars/user-123/avatar.jpg",
  });
});

test("profile updates reject avatars hosted outside the project's public avatar bucket", async () => {
  writes = [];
  const response = await handler(request({
    code: "one-time-login-code",
    nickname: "小厨师",
    avatar_url: "https://example.com/avatar.jpg",
  }));
  assert.equal(response.status, 400);
  assert.equal(writes.length, 0);
});
