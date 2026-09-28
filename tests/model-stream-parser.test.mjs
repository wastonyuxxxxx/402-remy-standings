import assert from "node:assert/strict";
import test from "node:test";

import { JsonDishStreamParser } from "../supabase/functions/recognize-dishes/core.ts";

test("dish objects become available as soon as each streamed JSON object closes", () => {
  const parser = new JsonDishStreamParser();
  assert.deepEqual(parser.push('{"dishes":[{"name":"番茄'), []);
  assert.deepEqual(parser.push('炒蛋","bbox":{"x":0.1,"y":0.2,"width":0.3,"height":0.4}}'), [
    { name: "番茄炒蛋", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
  ]);
  assert.deepEqual(parser.push(',{"name":"鱼\\"香\\"茄子"}'), [{ name: '鱼"香"茄子' }]);
  assert.deepEqual(parser.push('],"warnings":[]}'), []);
  assert.deepEqual(parser.push(" "), []);
});

test("dish parser handles braces, commas, and brackets inside JSON strings", () => {
  const parser = new JsonDishStreamParser();
  const payload = '{"dishes":[{"name":"酱汁 {甜，辣} [微酸]","alternatives":[{"name":"家常炒菜"}]}],"warnings":[]}';
  const chunks = [payload.slice(0, 18), payload.slice(18, 43), payload.slice(43)];
  const dishes = chunks.flatMap((chunk) => parser.push(chunk));
  assert.deepEqual(dishes, [
    { name: "酱汁 {甜，辣} [微酸]", alternatives: [{ name: "家常炒菜" }] },
  ]);
});
