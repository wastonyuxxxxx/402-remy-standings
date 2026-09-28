export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecognizedDish = {
  name: string;
  normalized_name: string;
  confidence: number;
  needs_confirmation: boolean;
  bbox: BoundingBox | null;
  alternatives: Array<{ name: string; confidence?: number | null }>;
  thumbnail: null;
};

export type RecognitionPayload = {
  dishes: RecognizedDish[];
  warnings: string[];
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function boxFromCorners(
  left: unknown,
  top: unknown,
  right: unknown,
  bottom: unknown,
  imageWidth: number,
  imageHeight: number,
): BoundingBox | null {
  let x1 = finiteNumber(left);
  let y1 = finiteNumber(top);
  let x2 = finiteNumber(right);
  let y2 = finiteNumber(bottom);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  if (Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) > 1) {
    x1 /= imageWidth;
    x2 /= imageWidth;
    y1 /= imageHeight;
    y2 /= imageHeight;
  }
  return validatedBox(x1, y1, x2 - x1, y2 - y1);
}

function validatedBox(
  x: number,
  y: number,
  width: number,
  height: number,
): BoundingBox | null {
  const epsilon = 1e-6;
  if (
    x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x + width > 1 + epsilon || y + height > 1 + epsilon
  ) return null;
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
  };
}

export function normalizeBoundingBox(
  value: unknown,
  imageWidth: number,
  imageHeight: number,
): BoundingBox | null {
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight)) return null;
  if (Array.isArray(value) && value.length === 4) {
    return boxFromCorners(
      value[0], value[1], value[2], value[3], imageWidth, imageHeight,
    );
  }

  const box = asObject(value);
  if (!box) return null;

  const cornerKeySets = [
    ["x1", "y1", "x2", "y2"],
    ["x_min", "y_min", "x_max", "y_max"],
    ["left", "top", "right", "bottom"],
  ] as const;
  for (const [left, top, right, bottom] of cornerKeySets) {
    if (left in box && top in box && right in box && bottom in box) {
      return boxFromCorners(
        box[left], box[top], box[right], box[bottom], imageWidth, imageHeight,
      );
    }
  }

  const x = finiteNumber(box.x);
  const y = finiteNumber(box.y);
  let width = finiteNumber(box.width);
  let height = finiteNumber(box.height);
  if (x === null || y === null || width === null || height === null) return null;
  let normalizedX = x;
  let normalizedY = y;
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(width), Math.abs(height)) > 1) {
    normalizedX /= imageWidth;
    normalizedY /= imageHeight;
    width /= imageWidth;
    height /= imageHeight;
  }
  return validatedBox(normalizedX, normalizedY, width, height);
}

function normalizeAlternatives(value: unknown, mainName: string) {
  if (!Array.isArray(value)) return [];
  const seen = new Set([mainName.trim().toLocaleLowerCase()]);
  const result: Array<{ name: string; confidence?: number | null }> = [];
  for (const candidate of value) {
    const item = typeof candidate === "string" ? { name: candidate } : asObject(candidate);
    if (!item || typeof item.name !== "string") continue;
    const name = item.name.trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || seen.has(normalized)) continue;
    seen.add(normalized);
    const confidence = finiteNumber(item.confidence);
    result.push({ name, ...(confidence === null ? {} : { confidence }) });
  }
  return result;
}

export function normalizeModelPayload(
  value: unknown,
  imageWidth: number,
  imageHeight: number,
): RecognitionPayload {
  const payload = asObject(value);
  if (!payload || !Array.isArray(payload.dishes)) {
    throw new Error("模型未返回菜品列表");
  }

  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean).slice(0, 20)
    : typeof payload.warnings === "string" ? [payload.warnings.trim()] : [];

  let dishesMissingBoxes = 0;
  const dishes: RecognizedDish[] = [];
  for (const rawDish of payload.dishes) {
    const item = asObject(rawDish);
    if (!item) continue;
    const nameValue = item.name ?? item.normalized_name;
    if (typeof nameValue !== "string" || !nameValue.trim()) continue;
    const name = nameValue.trim();
    const normalizedName = typeof item.normalized_name === "string" &&
        item.normalized_name.trim()
      ? item.normalized_name.trim()
      : name;
    const bbox = normalizeBoundingBox(item.bbox, imageWidth, imageHeight);
    if (bbox === null) dishesMissingBoxes += 1;
    const rawConfidence = finiteNumber(item.confidence);
    const confidence = Math.max(
      0,
      Math.min(bbox === null ? 0.5 : 1, rawConfidence ?? 0.5),
    );
    dishes.push({
      name,
      normalized_name: normalizedName,
      confidence,
      needs_confirmation: true,
      bbox,
      alternatives: normalizeAlternatives(item.alternatives, name),
      thumbnail: null,
    });
  }

  if (dishesMissingBoxes) {
    warnings.push(
      `${dishesMissingBoxes} 道菜缺少有效位置，无法生成对应缩略图`,
    );
  }
  return { dishes, warnings };
}

export function parseModelJson(content: string): unknown {
  let text = content.trim();
  if (text.startsWith("```")) {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines.at(-1)?.trim() === "```") lines.pop();
    text = lines.join("\n").trim();
  }
  return JSON.parse(text);
}

/** Extract complete top-level objects from a streamed `dishes` array. */
export class JsonDishStreamParser {
  private content = "";
  private cursor = 0;
  private arrayStarted = false;
  private arrayFinished = false;

  push(chunk: string): unknown[] {
    this.content += chunk;
    if (this.arrayFinished) return [];

    if (!this.arrayStarted) {
      const match = /"dishes"\s*:\s*\[/.exec(this.content);
      if (!match || match.index === undefined) return [];
      this.cursor = match.index + match[0].length;
      this.arrayStarted = true;
    }

    const result: unknown[] = [];
    while (this.cursor < this.content.length) {
      while (this.cursor < this.content.length && /[\s,]/.test(this.content[this.cursor])) {
        this.cursor += 1;
      }
      if (this.cursor >= this.content.length) break;
      if (this.content[this.cursor] === "]") {
        this.arrayFinished = true;
        break;
      }
      if (this.content[this.cursor] !== "{") {
        // Skip an unexpected array item without confusing nested JSON strings.
        const nextComma = this.content.indexOf(",", this.cursor);
        const nextClose = this.content.indexOf("]", this.cursor);
        if (nextComma < 0 && nextClose < 0) break;
        this.cursor = nextComma < 0 ? nextClose : nextClose < 0 ? nextComma : Math.min(nextComma, nextClose);
        continue;
      }

      const start = this.cursor;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let index = start; index < this.content.length; index += 1) {
        const character = this.content[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end < 0) break;
      result.push(JSON.parse(this.content.slice(start, end + 1)));
      this.cursor = end + 1;
    }
    return result;
  }
}
