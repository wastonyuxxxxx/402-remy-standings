const BASE_URL = "https://lbzuahqvdzwwxqxbbohd.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_HB-03UF5VsV0MUdAQGDm8w__0ziYbXc";
const SESSION_KEY = "remy_supabase_session_v1";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: options.method || "GET",
      data: options.data,
      header: options.header || {},
      timeout: options.timeout || 30000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        const body = response.data || {};
        reject(new Error(body.msg || body.message || body.error || `请求失败（${response.statusCode}）`));
      },
      fail(error) {
        reject(new Error(error.errMsg || "网络连接失败，请检查小程序服务器域名设置"));
      },
    });
  });
}

function storedSession() {
  try { return wx.getStorageSync(SESSION_KEY) || null; } catch (_) { return null; }
}

function saveSession(session) {
  const saved = Object.assign({}, session, {
    expires_at: Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
  });
  wx.setStorageSync(SESSION_KEY, saved);
  return saved;
}

let sessionPromise = null;
function session() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const saved = storedSession();
    if (saved && saved.access_token && saved.expires_at > Date.now() / 1000 + 60) return saved;
    if (saved && saved.refresh_token) {
      try {
        const refreshed = await request(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          data: { refresh_token: saved.refresh_token },
          header: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
        });
        return saveSession(refreshed);
      } catch (_) { /* An expired anonymous account starts a new local session. */ }
    }
    const created = await request(`${BASE_URL}/auth/v1/signup`, {
      method: "POST",
      data: {},
      header: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    });
    if (!created.access_token || !created.user) throw new Error("匿名登录未启用，请联系管理员");
    return saveSession(created);
  })().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function api(path, options = {}) {
  const auth = options.auth === false ? null : await session();
  return request(`${BASE_URL}${path}`, {
    method: options.method,
    data: options.data,
    timeout: options.timeout,
    header: Object.assign({
      apikey: PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.access_token}` } : {}),
    }, options.header || {}),
  });
}

function getProfiles() {
  return api("/rest/v1/profiles?select=id,name,avatar_index,tone,avatar_url&order=created_at.asc", { auth: false });
}

function getMeals() {
  return api("/rest/v1/meals?select=id,title,meal_date,meal_type,chef_ids,judge_scores,score,dishes,image_url,created_at&order=meal_date.desc,created_at.desc", { auth: false });
}

function createId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 3) | 8).toString(16);
  });
}

async function updateMeal(mealId, fields) {
  const rows = await api(`/rest/v1/meals?id=eq.${encodeURIComponent(mealId)}&select=id`, {
    method: "PATCH",
    data: Object.assign({}, fields, { updated_at: new Date().toISOString() }),
    header: { Prefer: "return=representation" },
  });
  if (!Array.isArray(rows) || !rows.some((row) => row.id === mealId)) throw new Error("餐次没有保存，请检查权限后重试");
  return rows[0];
}

async function deleteMeal(mealId) {
  const auth = await session();
  const result = await request(`${BASE_URL}/functions/v1/mini-meal-delete`, {
    method: "POST",
    data: { meal_id: mealId },
    header: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
  });
  if (!result || result.deleted !== true || result.meal_id !== mealId) throw new Error("餐次没有删除，请稍后重试");
  return result;
}

async function saveChef(profile) {
  const auth = await session();
  const fields = {
    name: String(profile.name || "").trim(),
    avatar_index: Number(profile.avatar_index || 0),
    tone: profile.tone || "blue",
    avatar_url: profile.avatar_url || null,
    updated_at: new Date().toISOString(),
  };
  if (!fields.name) throw new Error("请填写厨师昵称");
  let rows = [];
  if (profile.id) {
    rows = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}&select=id`, {
      method: "PATCH",
      data: fields,
      header: { Prefer: "return=representation" },
    });
    if (Array.isArray(rows) && rows.length) return rows[0];
    if (profile.id !== auth.user.id) throw new Error("厨师资料没有保存，请检查权限后重试");
  }
  const id = profile.id || createId();
  rows = await api(`/rest/v1/profiles?on_conflict=id&select=id`, {
    method: "POST",
    data: Object.assign({}, fields, { id, created_by: auth.user.id }),
    header: { Prefer: "resolution=ignore-duplicates,return=representation" },
  });
  if (!Array.isArray(rows) || !rows.length) {
    rows = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id`);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error("厨师资料没有保存，请检查权限后重试");
  return rows[0];
}

async function markChefDeleted(profileId) {
  const auth = await session();
  const rows = await api("/rest/v1/deleted_profiles?on_conflict=profile_id&select=profile_id", {
    method: "POST",
    data: { profile_id: profileId, deleted_by: auth.user.id, deleted_at: new Date().toISOString() },
    header: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error("厨师删除标记没有保存，请稍后重试");
}

async function deleteChef(profileId) {
  await markChefDeleted(profileId);
  const rows = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}&select=id`, {
    method: "DELETE",
    header: { Prefer: "return=representation" },
  });
  if (!Array.isArray(rows) || !rows.some((row) => row.id === profileId)) throw new Error("厨师没有删除，请检查权限后重试");
  return rows[0];
}

async function createMeal(meal) {
  const auth = await session();
  return api("/rest/v1/meals", {
    method: "POST",
    data: Object.assign({}, meal, { created_by: auth.user.id }),
    header: { Prefer: "return=representation" },
  });
}

function scoreMeal(mealId, score) {
  return api("/functions/v1/mini-meal-update", {
    method: "POST",
    data: { meal_id: mealId, score },
  });
}

async function wechatSession(code, profile = {}) {
  const data = { code };
  if (typeof profile.nickname === "string") data.nickname = profile.nickname;
  if (typeof profile.avatar_url === "string") data.avatar_url = profile.avatar_url;
  const token = await request(`${BASE_URL}/functions/v1/wechat-session`, {
    method: "POST",
    data,
    header: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    timeout: 15000,
  });
  if (!token.access_token || !token.user) throw new Error("微信登录响应异常");
  return saveSession(token);
}

function loginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => result.code ? resolve(result.code) : reject(new Error("微信登录凭证获取失败，请重试")),
      fail: () => reject(new Error("微信登录失败，请检查网络后重试")),
    });
  });
}

function imageFormat(filePath, reportedType) {
  const extension = String(reportedType || filePath.split(/[?#]/)[0].split(".").pop() || "").toLowerCase();
  return extension === "png" ? { extension: "png", mime: "image/png" } : { extension: "jpg", mime: "image/jpeg" };
}

function recognize(filePath, width, height, reportedType) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      async success(result) {
        try {
          const auth = await session();
          const imageData = `data:${imageFormat(filePath, reportedType).mime};base64,${result.data}`;
          const raw = await api("/functions/v1/recognize-dishes", {
            method: "POST",
            data: {
              image_data_url: imageData,
              image_width: width,
              image_height: height,
              language: "zh-CN",
            },
            timeout: 45000,
            header: { Authorization: `Bearer ${auth.access_token}` },
          });
          if (typeof raw !== "string") throw new Error("识别结果格式异常");
          const events = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          const failed = events.find((event) => event.type === "error");
          if (failed) throw new Error(failed.error || "识别失败");
          if (!events.some((event) => event.type === "complete")) throw new Error("识别尚未完成，请重试");
          resolve(events.filter((event) => event.type === "dish").map((event) => event.dish));
        } catch (error) { reject(error); }
      },
      fail: () => reject(new Error("无法读取照片")),
    });
  });
}

function uploadMealPhoto(filePath, reportedType) {
  return new Promise(async (resolve, reject) => {
    try {
      const auth = await session();
      const format = imageFormat(filePath, reportedType);
      const objectPath = `${auth.user.id}/${Date.now()}-${Math.floor(Math.random() * 1e8)}.${format.extension}`;
      wx.getFileSystemManager().readFile({
        filePath,
        success(result) {
          wx.request({
            url: `${BASE_URL}/storage/v1/object/meal-photos/${objectPath}`,
            method: "POST",
            data: result.data,
            header: {
              apikey: PUBLISHABLE_KEY,
              Authorization: `Bearer ${auth.access_token}`,
              "Content-Type": format.mime,
              "x-upsert": "false",
            },
            timeout: 45000,
            success(response) {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve(`${BASE_URL}/storage/v1/object/public/meal-photos/${objectPath}`);
              } else {
                reject(new Error((response.data && response.data.message) || "照片上传失败"));
              }
            },
            fail(error) { reject(new Error(error.errMsg || "照片上传失败")); },
          });
        },
        fail() { reject(new Error("无法读取照片")); },
      });
    } catch (error) { reject(error); }
  });
}

function uploadWechatAvatar(filePath, reportedType) {
  return new Promise(async (resolve, reject) => {
    try {
      const auth = await session();
      const format = imageFormat(filePath, reportedType);
      const objectPath = `${auth.user.id}/${Date.now()}-${Math.floor(Math.random() * 1e8)}.${format.extension}`;
      wx.getFileSystemManager().readFile({
        filePath,
        success(result) {
          wx.request({
            url: `${BASE_URL}/storage/v1/object/avatars/${objectPath}`,
            method: "POST",
            data: result.data,
            header: {
              apikey: PUBLISHABLE_KEY,
              Authorization: `Bearer ${auth.access_token}`,
              "Content-Type": format.mime,
              "x-upsert": "false",
            },
            timeout: 30000,
            success(response) {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve(`${BASE_URL}/storage/v1/object/public/avatars/${objectPath}`);
              } else {
                reject(new Error((response.data && response.data.message) || "头像上传失败"));
              }
            },
            fail(error) { reject(new Error(error.errMsg || "头像上传失败")); },
          });
        },
        fail() { reject(new Error("无法读取所选头像")); },
      });
    } catch (error) { reject(error); }
  });
}

async function saveWechatProfile(profile = {}) {
  let auth = storedSession();
  if (!auth || !auth.user || !auth.user.user_metadata || auth.user.user_metadata.provider !== "wechat") {
    auth = await wechatSession(await loginCode());
  }
  let avatarUrl = profile.avatarPath ? await uploadWechatAvatar(profile.avatarPath, profile.avatarType) : null;
  if (!avatarUrl) avatarUrl = auth.user.user_metadata.avatar_url || null;
  const nickname = String(profile.nickname || "").trim();
  if (!nickname) throw new Error("请先填写昵称");
  return wechatSession(await loginCode(), {
    nickname,
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
  });
}

module.exports = { BASE_URL, getProfiles, getMeals, createMeal, updateMeal, deleteMeal, saveChef, deleteChef, scoreMeal, wechatSession, saveWechatProfile, recognize, uploadMealPhoto, uploadWechatAvatar, session };
