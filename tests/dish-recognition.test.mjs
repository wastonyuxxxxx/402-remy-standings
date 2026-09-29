import assert from "node:assert/strict";
import test from "node:test";

import {
  attachBoundingBoxes,
  attachMealBoundingBoxes,
  consumeRecognitionStream,
  formatDishNames,
  fitCropBoxToImage,
  findMealByImageUrl,
  normalizedBoxToPixels,
  removeStaleMealBoundingBoxes,
  resizeDimensions,
  resizeCropBox,
} from "../assets/dish-recognition.js";

test("browser consumes chunked recognition events without losing UTF-8 dish names", async () => {
  const bytes = new TextEncoder().encode([
    JSON.stringify({ type: "started" }),
    JSON.stringify({ type: "dish", dish: { name: "番茄炒蛋" } }),
    JSON.stringify({ type: "complete", warnings: [] }),
  ].join("\n") + "\n");
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  const events = [];
  await consumeRecognitionStream(stream, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["started", "dish", "complete"]);
  assert.equal(events[1].dish.name, "番茄炒蛋");
});

test("recognition keeps more than six dishes and skips empty names", () => {
  const dishes = Array.from({ length: 9 }, (_, index) => ({ name: `菜品${index + 1}` }));
  dishes.splice(3, 0, { name: "  " });
  assert.equal(
    formatDishNames(dishes),
    "菜品1，菜品2，菜品3，菜品4，菜品5，菜品6，菜品7，菜品8，菜品9",
  );
});

test("dishes already streamed remain available when the response ends with an error", async () => {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ type: "dish", dish: { name: "宫保鸡丁" } })}\n`,
  );
  let sentDish = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (sentDish) {
        controller.error(new Error("provider stream interrupted"));
        return;
      }
      sentDish = true;
      controller.enqueue(bytes);
    },
  });
  const events = [];

  await assert.rejects(
    consumeRecognitionStream(stream, (event) => events.push(event)),
    /provider stream interrupted/,
  );
  assert.deepEqual(events.map((event) => event.dish?.name), ["宫保鸡丁"]);
});

test("resize dimensions never upscale and keep the longest side capped", () => {
  assert.deepEqual(resizeDimensions(4000, 3000), { width: 1280, height: 960 });
  assert.deepEqual(resizeDimensions(3024, 4032), { width: 960, height: 1280 });
  assert.deepEqual(resizeDimensions(800, 600), { width: 800, height: 600 });
});

test("invalid dimensions are rejected before canvas allocation", () => {
  assert.throws(() => resizeDimensions(0, 600), /图片尺寸无效/);
  assert.throws(() => resizeDimensions(800, Number.NaN), /图片尺寸无效/);
});

test("normalized boxes convert to padded pixel crops", () => {
  assert.deepEqual(
    normalizedBoxToPixels({ x: 0.25, y: 0.2, width: 0.5, height: 0.4 }, 1000, 500),
    { x: 220, y: 88, width: 560, height: 224 },
  );
  assert.deepEqual(
    normalizedBoxToPixels({ x: 0, y: 0, width: 0.1, height: 0.1 }, 100, 100),
    { x: 0, y: 0, width: 11, height: 11 },
  );
});

test("invalid or out-of-image boxes do not produce thumbnails", () => {
  assert.equal(normalizedBoxToPixels(null, 100, 100), null);
  assert.equal(normalizedBoxToPixels({ x: 0.9, y: 0.2, width: 0.2, height: 0.1 }, 100, 100), null);
  assert.equal(normalizedBoxToPixels({ x: 0.2, y: 0.2, width: 0, height: 0.1 }, 100, 100), null);
});

test("manual crop boxes preserve their free aspect ratio and stay inside the image", () => {
  const portrait = fitCropBoxToImage(
    { x: 0.72, y: 0.68, width: 0.24, height: 0.25 },
    960,
    1280,
  );
  assert.ok(portrait.x >= 0 && portrait.y >= 0);
  assert.ok(portrait.x + portrait.width <= 1);
  assert.ok(portrait.y + portrait.height <= 1);
  assert.ok(Math.abs(portrait.width - 0.24) < 0.00001);
  assert.ok(Math.abs(portrait.height - 0.25) < 0.00001);
  assert.ok(Math.abs((portrait.width * 960) / (portrait.height * 1280) - 4 / 3) > 0.1);
});

test("a missing model box gets a centered default crop that is large enough to edit", () => {
  const crop = fitCropBoxToImage(null, 1280, 960);
  assert.ok(Math.abs(crop.x + crop.width / 2 - 0.5) < 0.00001);
  assert.ok(Math.abs(crop.y + crop.height / 2 - 0.5) < 0.00001);
  assert.ok(crop.width * 1280 >= 96);
  assert.ok(crop.height * 960 >= 96);
  assert.ok(Math.abs((crop.width * 1280) / (crop.height * 960) - 4 / 3) < 0.00001);
});

test("edge handles change only one dimension while corner handles resize freely", () => {
  const box = { x: 0.2, y: 0.25, width: 0.4, height: 0.3 };
  assert.deepEqual(resizeCropBox(box, "e", 0.85, 0.9, 0.1, 0.1), {
    x: 0.2, y: 0.25, width: 0.65, height: 0.3,
  });
  assert.deepEqual(resizeCropBox(box, "nw", 0.05, 0.1, 0.1, 0.1), {
    x: 0.05, y: 0.1, width: 0.55, height: 0.45,
  });
});

test("free crop resizing respects minimum dimensions and image boundaries", () => {
  const box = { x: 0.2, y: 0.25, width: 0.4, height: 0.3 };
  assert.deepEqual(resizeCropBox(box, "se", 0, 0, 0.1, 0.08), {
    x: 0.2, y: 0.25, width: 0.1, height: 0.08,
  });
  assert.deepEqual(resizeCropBox(box, "se", 1.2, 1.2, 0.1, 0.1), {
    x: 0.2, y: 0.25, width: 0.8, height: 0.75,
  });
});

test("stored meals match the displayed photo even when the browser adds query parameters", () => {
  const meal = {
    id: "meal-1",
    image_url: "https://storage.example/storage/v1/object/public/meal-photos/meal-1.jpg",
    dishes: [{ name: "番茄炒蛋", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }],
  };
  assert.equal(
    findMealByImageUrl([meal], `${meal.image_url}?cache=123`),
    meal,
  );
  assert.equal(findMealByImageUrl([meal], "https://other.example/meal-1.jpg"), null);
  assert.equal(findMealByImageUrl([meal], "not a url"), null);
});

test("bounding boxes follow edited dish names and leave manual dishes unchanged", () => {
  const result = attachBoundingBoxes(
    [{ id: "a", name: "清炒时蔬", score: null }, { id: "b", name: "手动菜名", score: null }],
    [{ name: "清炒时蔬", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.73 }],
  );

  assert.deepEqual(result[0], {
    id: "a",
    name: "清炒时蔬",
    score: null,
    bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    confidence: 0.73,
    needs_confirmation: true,
  });
  assert.deepEqual(result[1], { id: "b", name: "手动菜名", score: null });
});

test("duplicate dish names keep their separate crops in recognition order", () => {
  const result = attachBoundingBoxes(
    [{ name: "清炒时蔬" }, { name: "清炒时蔬" }],
    [
      { name: "清炒时蔬", bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.8 },
      { name: "清炒时蔬", bbox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }, confidence: 0.7 },
    ],
  );
  assert.deepEqual(result.map((dish) => dish.bbox), [
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
  ]);
});

test("a renamed dish keeps its crop when the form still has a one-to-one dish list", () => {
  const result = attachBoundingBoxes(
    [{ name: "用户修正后的菜名" }, { name: "番茄炒蛋" }],
    [
      { name: "红烧肉", bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.8 },
      { name: "番茄炒蛋", bbox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }, confidence: 0.7 },
    ],
  );
  assert.deepEqual(result.map((dish) => dish.bbox), [
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
  ]);
});

test("meal write metadata is attached only to the matching uploaded photo", () => {
  const snapshot = {
    storageObjectPath: "meal-photos/meal-123.jpg",
    dishes: [{ name: "番茄炒蛋", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.91 }],
  };
  const body = JSON.stringify({
    image_url: "https://storage.example/storage/v1/object/public/meal-photos/meal-123.jpg",
    dishes: [{ id: "dish-1", name: "番茄炒蛋", score: null }],
  });
  const attached = attachMealBoundingBoxes(body, snapshot);
  assert.ok(attached);
  const saved = JSON.parse(attached);
  assert.deepEqual(saved.dishes[0].bbox, snapshot.dishes[0].bbox);
  assert.equal(saved.dishes[0].needs_confirmation, true);
  assert.equal(attachMealBoundingBoxes(body.replace("meal-123", "other-photo"), snapshot), null);
});

test("replacing a meal photo removes stale crop metadata but preserves dish names", () => {
  const body = JSON.stringify({
    id: "meal-123",
    image_url: "https://storage.example/storage/v1/object/public/meal-photos/new-photo.jpg",
    dishes: [{ id: "dish-1", name: "番茄炒蛋", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.9, needs_confirmation: true }],
  });
  const updated = removeStaleMealBoundingBoxes(body, "meal-photos/new-photo.jpg");
  assert.ok(updated);
  const saved = JSON.parse(updated);
  assert.deepEqual(saved.dishes, [{ id: "dish-1", name: "番茄炒蛋" }]);
  assert.equal(removeStaleMealBoundingBoxes(body, "meal-photos/not-this-photo.jpg"), null);
});
