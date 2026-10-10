const APP_ID = "wxe5fcf6be56ed781e";
const ALLOWED_ORIGINS = new Set(["https://wastonyuxxxxx.github.io", "http://localhost:4173", "http://127.0.0.1:4173"]);

function json(body: unknown, status = 200, origin: string | null = null) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validText(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "不允许的来源" }, 403, origin);
  if (request.method === "OPTIONS") return json({}, 204, origin);
  if (request.method !== "POST") return json({ error: "仅支持 POST" }, 405, origin);

  const secret = Deno.env.get("WECHAT_APP_SECRET");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!secret || !serviceKey || !base || !anonKey) return json({ error: "微信登录尚未配置" }, 503, origin);

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: "请求内容过大" }, 413, origin);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad body");
  } catch { return json({ error: "请求格式无效" }, 400, origin); }
  if (!validText(body.code, 256)) return json({ error: "登录凭证无效" }, 400, origin);
  const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, 64) : undefined;
  let avatarUrl: string | undefined;
  if (typeof body.avatar_url === "string" && body.avatar_url.trim()) {
    try {
      const candidate = new URL(body.avatar_url);
      const projectOrigin = new URL(base).origin;
      if (candidate.origin !== projectOrigin || !candidate.pathname.startsWith("/storage/v1/object/public/avatars/")) {
        return json({ error: "头像地址无效" }, 400, origin);
      }
      avatarUrl = body.avatar_url.slice(0, 2048);
    } catch { return json({ error: "头像地址无效" }, 400, origin); }
  }

  try {
    const query = new URLSearchParams({ appid: APP_ID, secret, js_code: body.code as string, grant_type: "authorization_code" });
    const wxResponse = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
    const wx = await wxResponse.json();
    if (!wxResponse.ok || !wx.openid) return json({ error: "微信登录凭证已失效，请重试" }, 401, origin);

    const openidHash = await sha256(`${APP_ID}:${wx.openid}`);
    const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
    const accountUrl = `${base}/rest/v1/wechat_accounts?openid_hash=eq.${openidHash}`;
    const existingResponse = await fetch(`${accountUrl}&select=openid_hash,user_id`, { headers: adminHeaders });
    if (!existingResponse.ok) return json({ error: "微信账号查询失败" }, 502, origin);
    const existing = await existingResponse.json();
    const email = `wechat.${openidHash}@wechat.invalid`;
    let userId: string;
    if (Array.isArray(existing) && existing.length === 1) {
      userId = existing[0].user_id;
      const profileFields: Record<string, unknown> = {};
      if (nickname !== undefined) profileFields.nickname = nickname;
      if (avatarUrl !== undefined) profileFields.avatar_url = avatarUrl;
      if (Object.keys(profileFields).length) {
        const userResponse = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
          method: "PUT",
          headers: adminHeaders,
          body: JSON.stringify({ user_metadata: { provider: "wechat", ...profileFields } }),
        });
        if (!userResponse.ok) return json({ error: "微信资料保存失败" }, 502, origin);
      }
      const accountPatch: Record<string, unknown> = { unionid: wx.unionid || null, updated_at: new Date().toISOString() };
      if (nickname !== undefined) accountPatch.nickname = nickname;
      if (avatarUrl !== undefined) accountPatch.avatar_url = avatarUrl;
      await fetch(accountUrl, {
        method: "PATCH",
        headers: { ...adminHeaders, Prefer: "return=minimal" },
        body: JSON.stringify(accountPatch),
      });
    } else {
      const createdResponse = await fetch(`${base}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          email,
          password: crypto.randomUUID() + crypto.randomUUID(),
          email_confirm: true,
          user_metadata: {
            provider: "wechat",
            ...(nickname !== undefined ? { nickname } : {}),
            ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}),
          },
        }),
      });
      const created = await createdResponse.json();
      if (!createdResponse.ok || !created.id) return json({ error: "微信账号创建失败" }, 502, origin);
      userId = created.id;
      const accountResponse = await fetch(`${base}/rest/v1/wechat_accounts`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ openid_hash: openidHash, user_id: userId, unionid: wx.unionid || null, nickname: nickname || null, avatar_url: avatarUrl || null }),
      });
      if (!accountResponse.ok) return json({ error: "微信账号绑定失败" }, 502, origin);
    }

    const linkResponse = await fetch(`${base}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ type: "magiclink", email }),
    });
    const link = await linkResponse.json();
    const tokenHash = link.properties?.hashed_token;
    if (!linkResponse.ok || !tokenHash) return json({ error: "微信会话创建失败" }, 502, origin);
    const tokenResponse = await fetch(`${base}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token || !token.user) return json({ error: "微信会话验证失败" }, 502, origin);
    return json(token, 200, origin);
  } catch {
    return json({ error: "微信登录服务暂时不可用" }, 503, origin);
  }
});
