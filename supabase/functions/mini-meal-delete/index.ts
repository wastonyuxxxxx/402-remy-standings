const ALLOWED_ORIGINS = new Set(["https://wastonyuxxxxx.github.io", "http://localhost:4173", "http://127.0.0.1:4173"]);

function json(body: unknown, status = 200, origin: string | null = null) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function validMealId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function managedPhotoPath(imageUrl: unknown, base: string): { path: string; url: string } | null {
  if (typeof imageUrl !== "string" || !imageUrl) return null;
  try {
    const url = new URL(imageUrl);
    const project = new URL(base);
    const prefix = "/storage/v1/object/public/meal-photos/";
    if (url.origin !== project.origin || !url.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const segments = path.split("/");
    if (segments.length !== 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(segments[0]) || !/^[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/i.test(segments[1])) return null;
    return { path, url: imageUrl };
  } catch { return null; }
}

async function responseBody(response: Response) {
  try { return await response.json(); } catch { return null; }
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
  if (!validMealId(body.meal_id)) return json({ error: "餐次编号无效" }, 400, origin);

  const base = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !anonKey || !serviceKey) return json({ error: "删除服务尚未配置" }, 503, origin);

  const callerHeaders = { apikey: anonKey, Authorization: bearer, "Content-Type": "application/json" };
  const mealFilter = `id=eq.${encodeURIComponent(body.meal_id)}`;
  try {
    const mealResponse = await fetch(`${base}/rest/v1/meals?${mealFilter}&select=id,image_url`, { headers: callerHeaders });
    if (!mealResponse.ok) return json({ error: "读取餐次失败，请稍后重试" }, 502, origin);
    const meals = await mealResponse.json();
    if (!Array.isArray(meals) || meals.length !== 1) return json({ error: "餐次不存在或已删除" }, 404, origin);

    const photo = managedPhotoPath(meals[0].image_url, base);
    let photoCleanup = photo ? "deleted" : "not_managed";
    if (photo) {
      const duplicateQuery = new URLSearchParams({
        select: "id",
        id: `neq.${body.meal_id}`,
        image_url: `like.${new URL(photo.url).origin}${new URL(photo.url).pathname}*`,
        limit: "1",
      });
      const duplicateResponse = await fetch(`${base}/rest/v1/meals?${duplicateQuery.toString()}`, { headers: callerHeaders });
      if (!duplicateResponse.ok) return json({ error: "无法确认照片是否被其他餐次使用，请稍后重试" }, 502, origin);
      const duplicates = await duplicateResponse.json();
      if (!Array.isArray(duplicates)) return json({ error: "照片引用检查失败，请稍后重试" }, 502, origin);
      if (duplicates.length) {
        photoCleanup = "shared";
      } else {
        const storageUrl = new URL(`/storage/v1/object/meal-photos/${photo.path.split("/").map(encodeURIComponent).join("/")}`, base);
        const storageResponse = await fetch(storageUrl, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
        if (!storageResponse.ok) {
          const details = await responseBody(storageResponse);
          const message = String(details && (details.message || details.error) || "");
          const alreadyMissing = storageResponse.status === 404 || /object.{0,20}(not found|missing)|not found/i.test(message);
          if (!alreadyMissing) return json({ error: "照片清理失败，餐次尚未删除；请稍后重试" }, 502, origin);
        }
      }
    }

    const deleteUrl = new URL("/rest/v1/meals", base);
    deleteUrl.searchParams.set("id", `eq.${body.meal_id}`);
    if (meals[0].image_url !== null && meals[0].image_url !== undefined) {
      deleteUrl.searchParams.set("image_url", `eq.${meals[0].image_url}`);
    }
    deleteUrl.searchParams.set("select", "id");
    const deleteResponse = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { ...callerHeaders, Prefer: "return=representation" },
    });
    if (!deleteResponse.ok) return json({ error: photo ? "照片已清理，但餐次未能删除；请重试" : "餐次删除失败，请稍后重试" }, deleteResponse.status === 403 ? 403 : 502, origin);
    const deleted = await deleteResponse.json();
    if (!Array.isArray(deleted) || deleted.length !== 1) return json({ error: "餐次刚刚发生变化，请刷新后重试" }, 409, origin);
    return json({ deleted: true, meal_id: body.meal_id, photo_cleanup: photoCleanup }, 200, origin);
  } catch { return json({ error: "无法连接餐次或照片服务，请稍后重试" }, 503, origin); }
});
