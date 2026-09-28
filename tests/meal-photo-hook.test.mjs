import assert from "node:assert/strict";
import test from "node:test";

test("meal photo upload hook strips stale crop metadata from the following meal update", async () => {
  const projectUrl = "https://lbzuahqvdzwwxqxbbohd.supabase.co";
  const requests = [];
  const root = {};
  Object.defineProperty(globalThis, "location", {
    value: { href: `${projectUrl}/` },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      getElementById: () => root,
      querySelector: () => null,
      addEventListener() {},
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    value: class { observe() {} },
    configurable: true,
  });
  const originalFetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  };
  Object.defineProperty(globalThis, "window", {
    value: { fetch: originalFetch },
    configurable: true,
  });

  await import(`../assets/dish-recognition.js?hook-test=${Date.now()}`);

  const upload = new File(["image"], "replacement.jpg", { type: "image/jpeg", lastModified: 1 });
  await window.fetch(`${projectUrl}/storage/v1/object/meal-photos/replacement.jpg`, {
    method: "POST",
    body: upload,
  });

  const mealBody = JSON.stringify({
    id: "meal-1",
    image_url: `${projectUrl}/storage/v1/object/public/meal-photos/replacement.jpg`,
    dishes: [{
      id: "dish-1",
      name: "番茄炒蛋",
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      confidence: 0.9,
      needs_confirmation: true,
    }],
  });
  await window.fetch(`${projectUrl}/rest/v1/meals?id=eq.meal-1`, {
    method: "PATCH",
    body: mealBody,
  });

  const updatedMealBody = JSON.parse(requests[1].init.body);
  assert.deepEqual(updatedMealBody.dishes, [{ id: "dish-1", name: "番茄炒蛋" }]);
});
