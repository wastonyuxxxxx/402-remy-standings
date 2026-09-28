import { JsonDishStreamParser, normalizeModelPayload, parseModelJson } from "./core.ts";

const MODEL = "Qwen/Qwen3.5-4B";
const MAX_BODY_BYTES = 5_500_000;
const MAX_IMAGE_DATA_URL_CHARS = 5_450_000;
const MODEL_TIMEOUT_MS = 28_000;
const ALLOWED_ORIGINS = new Set([
  "https://wastonyuxxxxx.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

const requestCounts = new Map<string, { startedAt: number; count: number }>();
const MAX_RATE_LIMIT_ENTRIES = 10_000;
let lastRateLimitCleanup = 0;

const SYSTEM_PROMPT = `你是餐桌菜品识别器。请仅根据用户提供的图片识别能明确区分的菜品，并输出严格符合给定 JSON Schema 的 JSON。
规则：
1. 只识别作为本餐菜品的盘、锅或碗装菜肴；不识别餐具、饮料、桌面、装饰物、调味料、人物，以及单独盛放的白米饭、紫米饭、杂粮饭、馒头、花卷、包子等普通主食。
2. 同一道菜只输出一次；同一个容器内明显属于同一道菜的食材不要拆分。
3. 看不清或无法确认时不要编造名称；使用保守名称、降低 confidence，并设置 needs_confirmation=true。
4. confidence 必须是 0 到 1 的数字，代表对菜品识别结果整体的可信程度，而不是图片质量；bbox 无法可靠定位时 confidence 不得高于 0.5。
5. 存在多个合理候选时填写 alternatives，并设置 needs_confirmation=true；备选名称不能与主名称重复。
6. bbox 是菜品主体或盛放容器的最小外接矩形，使用相对于输入图片的 0 到 1 坐标，格式为 {x,y,width,height}。无法可靠定位时返回 null。
7. 所有菜名必须使用请求指定的语言；请求为 zh-CN 时，name、normalized_name 和 alternatives.name 都必须是简体中文。
8. normalized_name 使用简洁、通用的中文标准名称；无法标准化时与 name 相同。
9. 不返回评分、厨师身份、餐次 ID、营养、价格或其他业务字段。
10. 空桌、只有饮料或完全无法判断时返回空 dishes，并在 warnings 中说明原因。
11. 顶层只返回 dishes 和 warnings；schema_version、status、meta 由服务端生成。每道菜仅返回 Schema 中定义的菜品字段。
12. 只输出 JSON，不添加 Markdown、代码围栏或解释文字。
13. 不要输出 thumbnail、截图、图片链接或其他未定义字段；截图由客户端根据 bbox 生成。`;

function responseHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set(
    "Access-Control-Allow-Headers",
    "authorization, x-client-info, apikey, content-type",
  );
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Max-Age", "600");
  return headers;
}

function jsonResponse(
  origin: string | null,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(origin),
  });
}

function isAllowedOrigin(origin: string | null): boolean {
  return origin === null || ALLOWED_ORIGINS.has(origin);
}

function identityFromVerifiedJwt(request: Request): string | null {
  // Supabase's gateway verifies the JWT before this handler because
  // verify_jwt is enabled in supabase/config.toml.
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;
  try {
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

function rateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  if (now - lastRateLimitCleanup >= 60_000) {
    for (const [entryKey, entry] of requestCounts) {
      if (now - entry.startedAt >= 60_000) requestCounts.delete(entryKey);
    }
    lastRateLimitCleanup = now;
  }
  const entry = requestCounts.get(key);
  if (!entry && requestCounts.size >= MAX_RATE_LIMIT_ENTRIES) return true;
  if (!entry || now - entry.startedAt >= 60_000) {
    requestCounts.set(key, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

class BodyTooLargeError extends Error {}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new BodyTooLargeError();
  if (!request.body) throw new Error("请求内容为空");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求格式无效");
  }
  return parsed as Record<string, unknown>;
}

function validImageDataUrl(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_IMAGE_DATA_URL_CHARS &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
}

function validDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 &&
    (value as number) <= 8192;
}

async function callVisionModelStream(
  apiKey: string,
  imageDataUrl: string,
  imageWidth: number,
  imageHeight: number,
  language: string,
  context: unknown,
  signal: AbortSignal,
  onDish: (dish: unknown) => void,
): Promise<{ requestId: string | null; warnings: string[] }> {
  const contextText = context === undefined || context === null
    ? "无"
    : typeof context === "string" ? context : JSON.stringify(context);
  if (contextText.length > 4000) {
    throw Object.assign(new Error("场景补充信息过长"), { status: 400 });
  }

  const userText = `请详细观察并识别这张餐桌图片。输出语言：${language}。场景补充信息：${contextText}。补充信息只能辅助判断，不能覆盖图片证据。模型响应只返回顶层字段 dishes 和 warnings；不要返回 schema_version、status 或 meta，这些字段由服务端生成。`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(
      "https://api.siliconflow.cn/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: imageDataUrl, detail: "low" },
                },
                { type: "text", text: userText },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 900,
          stream: true,
          response_format: { type: "json_object" },
          enable_thinking: false,
        }),
      },
    );

    if (!response.ok) {
      const status = response.status === 429
        ? 429
        : response.status >= 500 ? 503 : 502;
      throw Object.assign(new Error("模型服务暂时不可用"), { status });
    }
    if (!response.body) {
      throw Object.assign(new Error("模型未返回结果"), { status: 502 });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new JsonDishStreamParser();
    let buffer = "";
    let content = "";
    let requestId: string | null = null;
    let incomplete = false;
    let finished = false;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        if (data === "[DONE]") finished = true;
        return;
      }
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof event.id === "string") requestId = event.id;
      const choice = event.choices?.[0];
      if (choice?.finish_reason === "length") incomplete = true;
      const delta = choice?.delta?.content;
      if (typeof delta !== "string" || !delta) return;
      content += delta;
      for (const rawDish of parser.push(delta)) {
        const normalized = normalizeModelPayload({ dishes: [rawDish], warnings: [] }, imageWidth, imageHeight);
        if (normalized.dishes[0]) onDish(normalized.dishes[0]);
      }
    };

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (!content.trim()) {
      throw Object.assign(new Error("模型未返回结果"), { status: 502 });
    }
    if (incomplete) {
      throw Object.assign(new Error("模型结果不完整，请重试"), { status: 502 });
    }
    let rawPayload: unknown;
    try {
      rawPayload = parseModelJson(content);
    } catch {
      throw Object.assign(new Error("模型结果不完整，请重试"), { status: 502 });
    }
    const normalized = normalizeModelPayload(rawPayload, imageWidth, imageHeight);
    return { requestId, warnings: normalized.warnings };
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error("模型识别超过 28 秒"), { status: 504 });
    }
    if (error instanceof Error && "status" in error) throw error;
    throw Object.assign(new Error("无法连接模型服务"), { status: 503 });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

function streamingResponse(
  origin: string | null,
  apiKey: string,
  imageDataUrl: string,
  imageWidth: number,
  imageHeight: number,
  language: string,
  context: unknown,
): Response {
  const headers = responseHeaders(origin);
  headers.set("Content-Type", "application/x-ndjson; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let clientCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (event: unknown) => {
        if (clientCancelled) return;
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          clientCancelled = true;
        }
      };
      send({ type: "started" });
      try {
        const result = await callVisionModelStream(
          apiKey,
          imageDataUrl,
          imageWidth,
          imageHeight,
          language,
          context,
          controller.signal,
          (dish) => send({ type: "dish", dish }),
        );
        send({
          type: "complete",
          warnings: result.warnings,
          meta: {
            image_width: imageWidth,
            image_height: imageHeight,
            model: MODEL,
            request_id: result.requestId,
          },
        });
      } catch (error) {
        const status = typeof error === "object" && error !== null &&
            "status" in error && typeof error.status === "number"
          ? error.status
          : 502;
        const message = error instanceof Error && error.message === "模型识别超过 28 秒"
          ? error.message
          : error instanceof Error && error.message === "场景补充信息过长"
          ? error.message
          : error instanceof Error && error.message === "模型结果不完整，请重试"
          ? error.message
          : "菜品识别暂时失败，请稍后再试";
        send({ type: "error", status, error: message });
      } finally {
        if (!clientCancelled) streamController.close();
      }
    },
    cancel() {
      clientCancelled = true;
      controller.abort();
    },
  });
  return new Response(stream, { status: 200, headers });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin)) {
    return jsonResponse(null, { error: "不允许的来源" }, 403);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse(origin, { error: "仅支持 POST 请求" }, 405);
  }

  const userId = identityFromVerifiedJwt(request);
  if (!userId) return jsonResponse(origin, { error: "请先登录后再识别" }, 401);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (
    rateLimited(`user:${userId}`, 8) ||
    (ip && rateLimited(`ip:${ip}`, 24))
  ) {
    return jsonResponse(origin, { error: "识别请求过于频繁，请稍后再试" }, 429);
  }

  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return jsonResponse(origin, { error: "请求格式无效" }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : 400;
    const message = error instanceof BodyTooLargeError
      ? "图片过大，请压缩后重试"
      : "请求内容无效";
    return jsonResponse(origin, { error: message }, status);
  }

  const imageDataUrl = body.image_data_url;
  const imageWidth = body.image_width;
  const imageHeight = body.image_height;
  const language = typeof body.language === "string" ? body.language : "zh-CN";
  if (!validImageDataUrl(imageDataUrl)) {
    return jsonResponse(origin, { error: "图片格式无效或图片过大" }, 400);
  }
  if (!validDimension(imageWidth) || !validDimension(imageHeight)) {
    return jsonResponse(origin, { error: "图片尺寸无效" }, 400);
  }
  if (!language || language.length > 32) {
    return jsonResponse(origin, { error: "输出语言无效" }, 400);
  }
  const contextText = body.context === undefined || body.context === null
    ? "无"
    : typeof body.context === "string" ? body.context : JSON.stringify(body.context);
  if (contextText.length > 4000) {
    return jsonResponse(origin, { error: "场景补充信息过长" }, 400);
  }

  const apiKey = Deno.env.get("SILICONFLOW_API_KEY")?.trim();
  if (!apiKey) {
    return jsonResponse(origin, { error: "识别服务尚未完成配置" }, 503);
  }

  return streamingResponse(
    origin,
    apiKey,
    imageDataUrl,
    imageWidth,
    imageHeight,
    language,
    body.context,
  );
});
