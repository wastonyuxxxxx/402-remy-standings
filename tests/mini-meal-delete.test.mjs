import assert from "node:assert/strict";
import test, { before } from "node:test";

const mealId = "68ef0232-168e-4a52-9720-dd0efee296d1";
const photoUrl = "https://example.supabase.co/storage/v1/object/public/meal-photos/user-123/1728540000000-12345.jpg";
let handler;
let fetcher;

before(async () => {
  globalThis.Deno = {
    env: { get: (name) => ({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
    })[name] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.fetch = (...args) => fetcher(...args);
  await import("../supabase/functions/mini-meal-delete/index.ts");
});

function deleteRequest(headers = { Authorization: "Bearer test-user-jwt" }) {
  return new Request("https://example.supabase.co/functions/v1/mini-meal-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ meal_id: mealId }),
  });
}

test("meal deletion removes its unshared first-party photo through Storage API", async () => {
  const calls = [];
  fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname === "/rest/v1/meals" && options.method === "DELETE") return Response.json([{ id: mealId }]);
    if (parsed.pathname === "/storage/v1/object/meal-photos/user-123/1728540000000-12345.jpg" && options.method === "DELETE") return Response.json({ message: "Successfully deleted" });
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("select") === "id,image_url") return Response.json([{ id: mealId, image_url: photoUrl }]);
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("id") === `neq.${mealId}`) return Response.json([]);
    throw new Error(`Unexpected request: ${options.method || "GET"} ${parsed}`);
  };

  const response = await handler(deleteRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, meal_id: mealId, photo_cleanup: "deleted" });
  const storageCall = calls.find((call) => call.url.pathname.startsWith("/storage/v1/object/"));
  const databaseDelete = calls.find((call) => call.url.pathname === "/rest/v1/meals" && call.options.method === "DELETE");
  assert.equal(storageCall.options.headers.Authorization, "Bearer server-only-test-key");
  assert.equal(databaseDelete.options.headers.Authorization, "Bearer test-user-jwt");
  assert.ok(calls.indexOf(storageCall) < calls.indexOf(databaseDelete));
});

test("a photo shared by another meal is kept when one meal is deleted", async () => {
  let storageDeleteCount = 0;
  fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/rest/v1/meals" && options.method === "DELETE") return Response.json([{ id: mealId }]);
    if (parsed.pathname === "/storage/v1/object/meal-photos/user-123/1728540000000-12345.jpg") storageDeleteCount++;
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("select") === "id,image_url") return Response.json([{ id: mealId, image_url: photoUrl }]);
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("id") === `neq.${mealId}`) {
      assert.match(parsed.searchParams.get("image_url"), /^like\.https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/meal-photos\//);
      return Response.json([{ id: "another-meal" }]);
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${parsed}`);
  };

  const response = await handler(deleteRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).photo_cleanup, "shared");
  assert.equal(storageDeleteCount, 0);
});

test("storage failure keeps the meal row so the user can retry", async () => {
  const calls = [];
  fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("select") === "id,image_url") return Response.json([{ id: mealId, image_url: photoUrl }]);
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("id") === `neq.${mealId}`) return Response.json([]);
    if (parsed.pathname.startsWith("/storage/v1/object/")) return Response.json({ message: "Storage unavailable" }, { status: 503 });
    throw new Error(`Unexpected request: ${options.method || "GET"} ${parsed}`);
  };

  const response = await handler(deleteRequest());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "照片清理失败，餐次尚未删除；请稍后重试");
  assert.equal(calls.some((call) => call.url.pathname === "/rest/v1/meals" && call.options.method === "DELETE"), false);
});

test("deletion does not attempt to remove external or unrecognized image URLs", async () => {
  let storageDeleteCount = 0;
  fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/storage/v1/object/")) storageDeleteCount++;
    if (parsed.pathname === "/rest/v1/meals" && parsed.searchParams.get("select") === "id,image_url") return Response.json([{ id: mealId, image_url: "https://images.example.com/meal.jpg" }]);
    if (parsed.pathname === "/rest/v1/meals" && options.method === "DELETE") return Response.json([{ id: mealId }]);
    throw new Error(`Unexpected request: ${options.method || "GET"} ${parsed}`);
  };

  const response = await handler(deleteRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).photo_cleanup, "not_managed");
  assert.equal(storageDeleteCount, 0);
});

test("meal deletion requires a caller session", async () => {
  let called = false;
  fetcher = async () => { called = true; return Response.json([]); };
  const response = await handler(deleteRequest({}));
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
