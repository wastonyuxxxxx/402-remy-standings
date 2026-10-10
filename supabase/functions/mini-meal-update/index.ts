const ALLOWED_ORIGINS = new Set(["https://wastonyuxxxxx.github.io", "http://localhost:4173", "http://127.0.0.1:4173"]);

function json(body: unknown, status = 200, origin: string | null = null) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function validScore(score: unknown): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10 && score * 2 === Math.round(score * 2);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "不允许的来源" }, 403);
  if (request.method === "OPTIONS") return json({}, 204, origin);
  if (request.method !== "POST") return json({ error: "仅支持 POST" }, 405, origin);
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(bearer)) return json({ error: "请先登录" }, 401, origin);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: "请求内容过大" }, 413, origin);
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad body");
  } catch { return json({ error: "请求格式无效" }, 400, origin); }
  if (typeof body.meal_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(body.meal_id) || !validScore(body.score)) {
    return json({ error: "餐次或分数无效" }, 400, origin);
  }

  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!base || !key) return json({ error: "服务尚未配置" }, 503, origin);
  const headers = { apikey: key, Authorization: bearer, "Content-Type": "application/json" };
  const path = `${base}/rest/v1/meals?id=eq.${encodeURIComponent(body.meal_id)}`;
  try {
    const current = await fetch(`${path}&select=id,dishes`, { headers });
    if (!current.ok) return json({ error: "读取餐次失败" }, 502, origin);
    const rows = await current.json();
    if (!Array.isArray(rows) || rows.length !== 1) return json({ error: "餐次不存在" }, 404, origin);
    const dishes = Array.isArray(rows[0].dishes) ? rows[0].dishes.map((dish: Record<string, unknown>) => ({ ...dish, score: body.score })) : [];
    const updated = await fetch(`${path}&select=id,score,dishes`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ score: body.score, judge_scores: [body.score], dishes }),
    });
    if (!updated.ok) return json({ error: "保存评分失败" }, updated.status === 403 ? 403 : 502, origin);
    const result = await updated.json();
    if (!Array.isArray(result) || result.length !== 1) return json({ error: "评分未保存" }, 409, origin);
    return json({ meal: result[0] }, 200, origin);
  } catch { return json({ error: "无法连接餐次服务" }, 503, origin); }
});
