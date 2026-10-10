import assert from "node:assert/strict";
import test, { before } from "node:test";

let handler;
let writes = [];
before(async () => {
  globalThis.Deno = {
    env: { get: (name) => ({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "public-test-key" })[name] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.fetch = async (_url, options) => {
    if (options.method === "PATCH") {
      writes.push({ url: _url, options });
      return Response.json([{ id: "68ef0232-168e-4a52-9720-dd0efee296d1", score: 8.5, dishes: [{ name: "炒青菜", score: 8.5 }] }]);
    }
    return Response.json([{ id: "68ef0232-168e-4a52-9720-dd0efee296d1", dishes: [{ name: "炒青菜" }] }]);
  };
  await import("../supabase/functions/mini-meal-update/index.ts");
});

function scoreRequest(score, headers = { Authorization: "Bearer test-user-jwt" }) {
  return new Request("https://example.supabase.co/functions/v1/mini-meal-update", {
    method: "POST",
    headers,
    body: JSON.stringify({ meal_id: "68ef0232-168e-4a52-9720-dd0efee296d1", score }),
  });
}

test("score update uses the caller JWT and updates each dish", async () => {
  const response = await handler(scoreRequest(8.5));
  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.headers.Authorization, "Bearer test-user-jwt");
  assert.deepEqual(JSON.parse(writes[0].options.body), {
    score: 8.5,
    judge_scores: [8.5],
    dishes: [{ name: "炒青菜", score: 8.5 }],
  });
});

test("score rejects fractional tenths and unauthenticated writes", async () => {
  assert.equal((await handler(scoreRequest(8.1))).status, 400);
  assert.equal((await handler(scoreRequest(8.5, {}))).status, 401);
  assert.equal(writes.length, 1);
});
