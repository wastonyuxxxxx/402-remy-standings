import assert from "node:assert/strict";
import test, { before } from "node:test";

const origin = "https://wastonyuxxxxx.github.io";
let handler;
let providerRequests = 0;
let holdProviderAfterFirstDish = false;
let releaseProviderRemainder = null;

before(async () => {
  globalThis.Deno = {
    env: { get: (name) => name === "SILICONFLOW_API_KEY" ? "test-key" : undefined },
    serve: (callback) => { handler = callback; },
  };
  globalThis.fetch = async (_url, init) => {
    providerRequests += 1;
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-key");
    const request = JSON.parse(init.body);
    assert.equal(request.model, "Qwen/Qwen3.5-4B");
    assert.equal(request.enable_thinking, false);
    assert.equal(request.max_tokens, 900);
    assert.equal(request.stream, true);
    assert.equal(request.messages[1].content[0].image_url.detail, "low");
    const content = JSON.stringify({
      dishes: [{
        name: "番茄炒蛋",
        normalized_name: "番茄炒蛋",
        confidence: 0.92,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        alternatives: [],
      }],
      warnings: [],
    });
    const encoder = new TextEncoder();
    const frame = (delta) => encoder.encode(
      `data: ${JSON.stringify({ id: "request-test", choices: [{ delta: { content: delta } }] })}\n\n`,
    );
    const finish = encoder.encode(`data: ${JSON.stringify({ id: "request-test", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    if (holdProviderAfterFirstDish) {
      holdProviderAfterFirstDish = false;
      const arrayClose = content.indexOf("}],");
      const first = frame(content.slice(0, arrayClose + 1));
      const rest = frame(content.slice(arrayClose + 1));
      let sentRemainder = false;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(first);
        },
        async pull(controller) {
          if (sentRemainder) return;
          sentRemainder = true;
          await new Promise((resolve) => { releaseProviderRemainder = resolve; });
          controller.enqueue(rest);
          controller.enqueue(finish);
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const frames = [...content].map((character) => frame(character));
    frames.push(finish);
    return new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  await import("../supabase/functions/recognize-dishes/index.ts");
});

function signedRequest({ userId = crypto.randomUUID(), body = {
  image_data_url: "data:image/jpeg;base64,YQ==",
  image_width: 320,
  image_height: 240,
  language: "zh-CN",
} } = {}) {
  const payload = btoa(JSON.stringify({ sub: userId }));
  return new Request(`${origin}/functions/v1/recognize-dishes`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer e30.${payload}.signature`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function readNdjson(response) {
  const lines = (await response.text()).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

test("OPTIONS preflight is answered for the published site", async () => {
  const response = await handler(new Request(`${origin}/functions/v1/recognize-dishes`, {
    method: "OPTIONS",
    headers: { Origin: origin },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("untrusted browser origins are rejected before model requests", async () => {
  const response = await handler(new Request("https://evil.example/functions/v1/recognize-dishes", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(response.status, 403);
  assert.equal(providerRequests, 0);
});

test("a verified-session request streams Qwen dishes and normalized boxes", async () => {
  const response = await handler(signedRequest());
  const events = await readNdjson(response);
  const result = events.find((event) => event.type === "dish").dish;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8");
  assert.deepEqual(events.map((event) => event.type), ["started", "dish", "complete"]);
  assert.equal(result.name, "番茄炒蛋");
  assert.deepEqual(result.bbox, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  assert.equal(result.needs_confirmation, true);
  assert.equal(result.thumbnail, null);
  assert.equal(events.at(-1).meta.model, "Qwen/Qwen3.5-4B");
  assert.deepEqual(events.at(-1).warnings, []);
  assert.equal(providerRequests, 1);
});

test("malformed input is rejected without a model call", async () => {
  const response = await handler(signedRequest({ body: { image_data_url: "not-an-image", image_width: 320, image_height: 240 } }));
  assert.equal(response.status, 400);
  assert.equal(providerRequests, 1);
});

test("oversized optional context is a client error rather than a provider error", async () => {
  const response = await handler(signedRequest({ body: {
    image_data_url: "data:image/jpeg;base64,YQ==",
    image_width: 320,
    image_height: 240,
    context: "字".repeat(4001),
  } }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /场景补充信息过长/);
  assert.equal(providerRequests, 1);
});

test("the per-user best-effort limit stops a ninth request in one minute", async () => {
  const userId = crypto.randomUUID();
  const statuses = [];
  for (let index = 0; index < 9; index += 1) {
    statuses.push((await handler(signedRequest({ userId }))).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429]);
});

test("the Edge Function emits a dish while the provider stream is still open", { timeout: 5000 }, async () => {
  holdProviderAfterFirstDish = true;
  try {
    const response = await handler(signedRequest());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const nextEvent = async () => {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return JSON.parse(line);
        }
        const { done, value } = await reader.read();
        assert.equal(done, false, "stream closed before the expected event");
        buffered += decoder.decode(value, { stream: true });
      }
    };
    const readWithin = (label) => Promise.race([
      nextEvent(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`missing ${label}; providerRequests=${providerRequests}; gate=${typeof releaseProviderRemainder}`)), 1000)),
    ]);
    assert.equal((await readWithin("started")).type, "started");
    const firstDish = await readWithin("dish");
    assert.equal(firstDish.type, "dish");
    assert.equal(firstDish.dish.name, "番茄炒蛋");
    assert.equal(typeof releaseProviderRemainder, "function");
    releaseProviderRemainder();
    assert.equal((await readWithin("complete")).type, "complete");
    await reader.cancel();
  } finally {
    releaseProviderRemainder?.();
  }
});
