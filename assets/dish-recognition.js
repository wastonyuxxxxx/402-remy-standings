const PROJECT_REF = "lbzuahqvdzwwxqxbbohd";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const MAX_IMAGE_SIDE = 1280;
const JPEG_QUALITY = 0.82;
const MAX_DISHES = 6;
const CLIENT_TIMEOUT_MS = 29_000;
const SNAPSHOT_TTL_MS = 15 * 60_000;

let sequence = 0;
let activeController = null;
let activeReview = null;
let dialogElements = null;
let mealWriteSnapshot = null;
let pendingUploadedPhoto = null;
const mealsById = new Map();
let rootObserver = null;

export function resizeDimensions(width, height, maxSide = MAX_IMAGE_SIDE) {
  if (![width, height, maxSide].every(Number.isFinite) || width <= 0 || height <= 0 || maxSide <= 0) {
    throw new Error("图片尺寸无效");
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function normalizedBoxToPixels(box, width, height, padding = 0.06) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null;
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) return null;
  const padX = box.width * padding;
  const padY = box.height * padding;
  const left = Math.max(0, Math.floor((box.x - padX) * width + 1e-9));
  const top = Math.max(0, Math.floor((box.y - padY) * height + 1e-9));
  const right = Math.min(width, Math.ceil((box.x + box.width + padX) * width - 1e-9));
  const bottom = Math.min(height, Math.ceil((box.y + box.height + padY) * height - 1e-9));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function attachBoundingBoxes(dishes, recognizedDishes) {
  const byName = new Map();
  const locatedDishes = [];
  for (const recognized of recognizedDishes) {
    if (typeof recognized?.name !== "string" || !recognized.bbox) continue;
    const key = recognized.name.trim().toLocaleLowerCase();
    const matches = byName.get(key) ?? [];
    matches.push(recognized);
    byName.set(key, matches);
    locatedDishes.push(recognized);
  }
  const matches = dishes.map((dish) => byName.get(String(dish.name ?? "").trim().toLocaleLowerCase())?.shift() ?? null);
  const unmatchedRows = matches.flatMap((match, index) => match ? [] : [index]);
  const unmatchedLocations = locatedDishes.filter((located) => !matches.includes(located));
  if (unmatchedRows.length === unmatchedLocations.length) {
    unmatchedRows.forEach((rowIndex, index) => { matches[rowIndex] = unmatchedLocations[index]; });
  }
  return dishes.map((dish, index) => {
    const recognized = matches[index];
    return recognized ? {
      ...dish,
      bbox: recognized.bbox,
      confidence: recognized.confidence,
      needs_confirmation: true,
    } : dish;
  });
}

function imageLookupKey(value) {
  try {
    const base = typeof location === "undefined" ? "https://local.invalid/" : location.href;
    const url = new URL(value, base);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function findMealByImageUrl(meals, imageUrl) {
  const key = imageLookupKey(imageUrl);
  if (!key) return null;
  return meals.find((meal) => imageLookupKey(meal?.image_url) === key) ?? null;
}

function selectedPublishKey() {
  return document.querySelector('meta[name="supabase-publishable-key"]')?.content?.trim() ?? "";
}

function getStoredSession() {
  try {
    const session = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof session?.access_token !== "string") return null;
    if (typeof session.expires_at === "number" && session.expires_at * 1000 <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

async function waitForSession() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const session = getStoredSession();
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("登录状态尚未准备好，请稍后重试");
}

function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("浏览器无法读取这张照片"));
    };
    image.src = url;
  });
}

async function prepareImage(file) {
  const bitmap = await loadBitmap(file);
  try {
    const size = resizeDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法处理这张照片");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return {
      canvas,
      width: size.width,
      height: size.height,
      imageDataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
    };
  } finally {
    bitmap.close?.();
  }
}

export async function consumeRecognitionStream(body, onEvent) {
  if (!body || typeof onEvent !== "function") throw new Error("识别结果流无效");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new Error("识别结果格式无效");
    }
    onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffered += decoder.decode();
    if (buffered.trim()) consumeLine(buffered);
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The request may already have been aborted by the user or timeout.
    }
    throw error;
  }
}

function makeThumbnail(source, box) {
  if (!box) return null;
  const crop = normalizedBoxToPixels(box, source.width, source.height);
  if (!crop) return null;
  const scale = Math.min(1, 320 / Math.max(crop.width, crop.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

function createDialog() {
  const container = document.querySelector(".bottom-sheet") ?? document.body;
  if (dialogElements) {
    if (!dialogElements.host.isConnected && dialogElements.dialog.open) dialogElements.dialog.close();
    if (dialogElements.host.parentElement !== container) container.append(dialogElements.host);
    return dialogElements;
  }
  const host = document.createElement("div");
  host.setAttribute("aria-live", "polite");
  // Keep actions inside this modal from reaching the publish sheet's outside-click handler.
  for (const type of ["pointerdown", "pointerup", "click"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      dialog { width: min(92vw, 620px); max-width: none; max-height: min(86dvh, 760px); padding: 0; border: 0; border-radius: 22px; color: #111214; background: #fff; box-shadow: 0 24px 80px #0004; overflow: hidden; }
      dialog::backdrop { background: #151d2b99; backdrop-filter: blur(3px); }
      .panel { display: flex; flex-direction: column; max-height: min(86dvh, 760px); }
      header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 22px 12px; }
      h2 { margin: 0; font: 900 19px/1.3 "Arial Rounded MT Bold", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: -.04em; }
      .hint { margin: 6px 0 0; color: #73767c; font-size: 13px; line-height: 1.5; }
      .close { flex: 0 0 34px; width: 34px; height: 34px; border: 1px solid #d9e1ec; border-radius: 50%; background: #fff; color: #111214; font-size: 22px; cursor: pointer; }
      .body { overflow: auto; padding: 8px 22px 16px; }
      .loading { padding: 30px 6px 36px; text-align: center; color: #73767c; line-height: 1.7; }
      .consent { padding: 14px 4px 18px; color: #73767c; font-size: 14px; line-height: 1.7; }
      .spinner { display: inline-block; width: 24px; height: 24px; margin-bottom: 10px; border: 3px solid #e8f2ff; border-top-color: #93beff; border-radius: 50%; animation: spin .8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 12px; }
      .card { overflow: hidden; border: 1px solid #e7e9ed; border-radius: 15px; background: #fff; }
      .photo { display: grid; place-items: center; width: 100%; aspect-ratio: 1.25; background: #f7faff; color: #73767c; font-size: 12px; }
      .photo img { width: 100%; height: 100%; object-fit: cover; }
      .card label { display: block; padding: 9px 10px 10px; color: #73767c; font-size: 11px; font-weight: 900; }
      .card input { box-sizing: border-box; width: 100%; margin-top: 5px; padding: 8px 9px; border: 1px solid #e0e4ea; border-radius: 12px; color: #111214; background: #fafbfc; font: inherit; font-size: 14px; font-weight: 700; }
      .notice { margin: 0 0 12px; color: #73767c; font-size: 12px; line-height: 1.5; }
      .stream-status { display: flex; align-items: center; gap: 9px; margin: 0 0 12px; padding: 10px 12px; border: 1px solid #e1edfb; border-radius: 13px; color: #526983; background: #f7faff; font-size: 12px; line-height: 1.5; }
      .stream-status .spinner { flex: 0 0 14px; width: 14px; height: 14px; margin: 0; border-width: 2px; }
      .error { padding: 20px 4px 26px; color: #8a4a36; line-height: 1.6; }
      footer { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 22px 20px; border-top: 1px solid #e7e9ed; }
      footer button { min-height: 42px; padding: 0 17px; border: 1px solid #d9e1ec; border-radius: 999px; background: #fff; color: #111214; font: inherit; font-weight: 900; cursor: pointer; }
      footer .primary { border-color: #b9d7ff; background: #b9d7ff; color: #111214; }
      footer button:disabled { opacity: .55; cursor: not-allowed; }
      footer button:focus-visible, .close:focus-visible, .card input:focus-visible { outline: 3px solid #93beff; outline-offset: 2px; }
      @media (max-width: 440px) { header { padding: 18px 16px 10px; } .body { padding: 8px 16px 14px; } footer { padding: 10px 16px 16px; } .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; } }
    </style>
    <dialog aria-labelledby="dish-recognition-title"><div class="panel"></div></dialog>
  `;
  container.append(host);
  const dialog = shadow.querySelector("dialog");
  dialog.addEventListener("cancel", () => {
    sequence += 1;
    activeController?.abort();
    activeController = null;
    activeReview = null;
  });
  dialogElements = { host, shadow, dialog, panel: shadow.querySelector(".panel") };
  return dialogElements;
}

function openDialog() {
  const { dialog } = createDialog();
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (dialogElements?.dialog.open) sequence += 1;
  activeController?.abort();
  activeController = null;
  activeReview = null;
  if (dialogElements?.dialog.open) dialogElements.dialog.close();
}

function footerButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderPanel({ title, hint, body, actions = [] }) {
  const { panel } = createDialog();
  panel.replaceChildren();
  const header = document.createElement("header");
  const titles = document.createElement("div");
  const heading = document.createElement("h2");
  heading.id = "dish-recognition-title";
  heading.textContent = title;
  const subheading = document.createElement("p");
  subheading.className = "hint";
  subheading.textContent = hint;
  titles.append(heading, subheading);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("aria-label", "关闭菜品识别");
  close.textContent = "×";
  close.addEventListener("click", closeDialog);
  header.append(titles, close);
  const content = document.createElement("div");
  content.className = "body";
  content.append(body);
  const footer = document.createElement("footer");
  for (const action of actions) footer.append(action);
  panel.append(header, content, footer);
  openDialog();
}

function renderLoading() {
  const body = document.createElement("div");
  body.className = "loading";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  body.append(spinner, document.createElement("br"));
  body.append(document.createTextNode("正在处理照片、识别菜品并生成截图，请稍候…"));
  renderPanel({
    title: "正在识别菜品",
    hint: "识别已自动开始；菜名会尽快显示，可以边等边修改。",
    body,
    actions: [footerButton("稍后再说", "", closeDialog)],
  });
}

function renderFailure(message, file, form) {
  const body = document.createElement("div");
  body.className = "error";
  body.textContent = `${message}。你仍可手动填写菜名并发布。`;
  const retry = footerButton("重新识别", "primary", () => {
    const requestId = ++sequence;
    renderLoading();
    void recognizePhoto(file, form, requestId);
  });
  renderPanel({
    title: "这次没有识别成功",
    hint: "识别失败不会影响原照片和手动录入。",
    body,
    actions: [footerButton("手动填写", "", closeDialog), retry],
  });
}

function renderResults(review, state = "complete", failureMessage = "") {
  const previouslyFocused = dialogElements?.shadow.activeElement;
  const focusedIndex = previouslyFocused?.matches?.(".card input")
    ? Array.from(dialogElements.shadow.querySelectorAll(".card input")).indexOf(previouslyFocused)
    : -1;
  const selection = focusedIndex >= 0
    ? [previouslyFocused.selectionStart, previouslyFocused.selectionEnd]
    : null;
  const dishes = review.dishes.slice(0, MAX_DISHES);
  const body = document.createElement("div");
  const notice = document.createElement("p");
  notice.className = "notice";
  const countNote = review.dishes.length > MAX_DISHES
    ? `识别到 ${review.dishes.length} 道菜；当前餐次最多记录 ${MAX_DISHES} 道。`
    : "请核对截图和菜名；名称可直接修改，无法定位的菜品也可手动命名。";
  notice.textContent = state === "partial"
    ? `${failureMessage || "识别提前结束。"} 已保留目前识别结果，可先填入菜名，也可以关闭后重试。`
    : review.warnings?.length
    ? `${countNote} ${review.warnings.join("；")}`
    : countNote;
  if (state === "streaming" && dishes.length) {
    const progress = document.createElement("div");
    progress.className = "stream-status";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = `已先识别 ${review.dishes.length} 道菜，其余结果仍在返回；现在可以修改已出现的菜名。`;
    progress.append(spinner, text);
    body.append(progress);
  }
  const cards = document.createElement("div");
  cards.className = "cards";
  dishes.forEach((dish, index) => {
    const card = document.createElement("article");
    card.className = "card";
    const photo = document.createElement("div");
    photo.className = "photo";
    if (dish.thumbnail) {
      const image = document.createElement("img");
      image.src = dish.thumbnail;
      image.alt = `${dish.name} 的位置截图`;
      photo.append(image);
    } else {
      photo.textContent = "未找到可靠位置框";
    }
    const label = document.createElement("label");
    label.textContent = `菜品 ${index + 1}`;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.value = dish.name;
    input.setAttribute("aria-label", `修改菜品 ${index + 1} 名称`);
    input.addEventListener("input", () => {
      dish.name = input.value;
      const thumbnail = photo.querySelector("img");
      if (thumbnail) thumbnail.alt = `${dish.name || "菜品"} 的位置截图`;
    });
    label.append(input);
    card.append(photo, label);
    cards.append(card);
  });
  if (!dishes.length && state === "streaming") {
    const loading = document.createElement("div");
    loading.className = "loading";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, document.createElement("br"));
    loading.append(document.createTextNode("模型正在分析照片，识别出的菜品会先显示在这里…"));
    body.append(loading);
  } else if (!dishes.length) {
    const empty = document.createElement("div");
    empty.className = "error";
    empty.textContent = state === "partial"
      ? "超时前尚未收到完整菜品；可以关闭此窗口后手动填写或重新识别。"
      : "暂未发现可以确认的菜品；可以关闭此窗口后手动填写。";
    body.append(notice, empty);
  } else {
    body.append(notice, cards);
  }
  const useNames = footerButton("填入菜名", "primary", () => {
    const names = dishes.map((dish) => dish.name.trim()).filter(Boolean).slice(0, MAX_DISHES);
    const { form, file } = review;
    if (names.length) setDishNames(form, names.join("，"));
    mealWriteSnapshot = {
      file,
      dishes: dishes.filter((dish) => dish.name.trim()).map((dish) => ({
        name: dish.name.trim(),
        bbox: dish.bbox,
        confidence: dish.confidence,
      })),
      createdAt: Date.now(),
      storageObjectPath: null,
    };
    window.__dishRecognitionSnapshot = mealWriteSnapshot;
    activeReview = null;
    closeDialog();
  });
  if (!dishes.length) useNames.disabled = true;
  const actions = [footerButton(state === "streaming" ? "停止识别" : "关闭", "", closeDialog)];
  if (state === "partial") {
    actions.push(footerButton("重新识别", "", () => {
      const requestId = ++sequence;
      activeController?.abort();
      renderLoading();
      void recognizePhoto(review.file, review.form, requestId);
    }));
  }
  actions.push(useNames);
  renderPanel({
    title: state === "streaming" ? "识别进行中" : state === "partial" ? "部分识别结果" : "菜品识别结果",
    hint: state === "streaming"
      ? "结果会逐道出现；可以边等边检查，也可先填入当前已识别菜名。"
      : "可逐个修改菜名；确认后填入本餐，截图位置会一并保存。",
    body,
    actions,
  });
  if (focusedIndex >= 0) {
    const nextInput = dialogElements.shadow.querySelectorAll(".card input")[focusedIndex];
    if (nextInput) {
      nextInput.focus({ preventScroll: true });
      if (selection && nextInput.setSelectionRange) nextInput.setSelectionRange(selection[0], selection[1]);
    }
  }
}

function renderStoredGallery(meal, source) {
  const body = document.createElement("div");
  body.className = "notice";
  body.textContent = "截图由浏览器根据已保存的位置框生成；不会再次调用识别模型。";
  const cards = document.createElement("div");
  cards.className = "cards";
  let count = 0;
  for (const dish of Array.isArray(meal?.dishes) ? meal.dishes : []) {
    const name = typeof dish?.name === "string" ? dish.name.trim() : "";
    if (!name || !dish.bbox) continue;
    const thumbnail = makeThumbnail(source, dish.bbox);
    if (!thumbnail) continue;
    const card = document.createElement("article");
    card.className = "card";
    const photo = document.createElement("div");
    photo.className = "photo";
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = `${name} 的位置截图`;
    photo.append(image);
    const label = document.createElement("label");
    label.textContent = name;
    card.append(photo, label);
    cards.append(card);
    count += 1;
  }
  if (count) body.append(cards);
  else body.textContent = "这餐没有可用的位置框；原有菜名和照片没有受到影响。";
  renderPanel({
    title: "这餐的菜品截图",
    hint: "对应菜名来自这餐已保存的菜品记录。",
    body,
    actions: [footerButton("关闭", "primary", closeDialog)],
  });
}

function galleryLoadingBody() {
  const body = document.createElement("div");
  body.className = "loading";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  body.append(spinner, document.createElement("br"));
  body.append(document.createTextNode("正在用餐桌原图生成菜品截图…"));
  return body;
}

function renderGalleryFailure() {
  const body = document.createElement("div");
  body.className = "error";
  body.textContent = "暂时无法读取餐桌照片来生成截图；餐次记录没有受到影响。";
  renderPanel({
    title: "截图暂时无法显示",
    hint: "可以稍后再试。",
    body,
    actions: [footerButton("关闭", "primary", closeDialog)],
  });
}

async function showStoredGallery(mealId) {
  const meal = mealsById.get(mealId);
  if (!meal?.image_url || !Array.isArray(meal.dishes)) return;
  const requestId = ++sequence;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  renderPanel({
    title: "正在准备菜品截图",
    hint: "只读取已发布的餐桌照片，在浏览器本地裁切。",
    body: galleryLoadingBody(),
    actions: [footerButton("取消", "", closeDialog)],
  });
  try {
    const response = await fetch(meal.image_url, {
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("photo fetch failed");
    const bitmap = await loadBitmap(await response.blob());
    let source;
    try {
      const size = resizeDimensions(bitmap.width, bitmap.height);
      source = document.createElement("canvas");
      source.width = size.width;
      source.height = size.height;
      const context = source.getContext("2d", { alpha: false });
      if (!context) throw new Error("canvas unavailable");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
    } finally {
      bitmap.close?.();
    }
    if (requestId !== sequence) return;
    renderStoredGallery(meal, source);
  } catch {
    if (requestId === sequence) renderGalleryFailure();
  } finally {
    clearTimeout(timeout);
    if (requestId === sequence) activeController = null;
  }
}

function setDishNames(form, value) {
  const field = form?.querySelector('input[placeholder*="番茄炒蛋"], textarea[placeholder*="番茄炒蛋"]');
  if (!field) return;
  const prototype = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function recognizePhoto(file, form, requestId) {
  activeReview = null;
  try {
    const publishableKey = selectedPublishKey();
    if (!publishableKey) throw new Error("Supabase 公钥未配置");
    const [session, image] = await Promise.all([waitForSession(), prepareImage(file)]);
    if (requestId !== sequence) return;
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    activeReview = { file, form, dishes: [], warnings: [] };
    try {
      const response = await fetch(`${PROJECT_URL}/functions/v1/recognize-dishes`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": publishableKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_data_url: image.imageDataUrl,
          image_width: image.width,
          image_height: image.height,
          language: "zh-CN",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "识别服务暂时不可用");
      }
      if (response.headers.get("Content-Type")?.includes("application/json")) {
        // Keep the web build compatible while the deployed Edge Function is updated.
        const payload = await response.json().catch(() => ({}));
        if (!Array.isArray(payload.dishes)) throw new Error("识别结果格式无效");
        activeReview.dishes = payload.dishes.map((dish) => ({
          name: typeof dish.name === "string" ? dish.name : "",
          bbox: dish.bbox ?? null,
          confidence: typeof dish.confidence === "number" ? dish.confidence : 0.5,
          thumbnail: makeThumbnail(image.canvas, dish.bbox ?? null),
        })).filter((dish) => dish.name.trim());
        activeReview.warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
        if (requestId === sequence) renderResults(activeReview, "complete");
        return;
      }
      if (!response.body) throw new Error("识别服务没有返回结果流");
      let streamError = "";
      let completed = false;
      const handleEvent = (event) => {
        if (requestId !== sequence || !event || typeof event !== "object") return;
        if (event.type === "dish" && event.dish && typeof event.dish.name === "string") {
          const dish = {
            name: event.dish.name,
            bbox: event.dish.bbox ?? null,
            confidence: typeof event.dish.confidence === "number" ? event.dish.confidence : 0.5,
            thumbnail: makeThumbnail(image.canvas, event.dish.bbox ?? null),
          };
          if (dish.name.trim()) {
            activeReview.dishes.push(dish);
            renderResults(activeReview, "streaming");
          }
        } else if (event.type === "complete") {
          completed = true;
          activeReview.warnings = Array.isArray(event.warnings)
            ? event.warnings.filter((warning) => typeof warning === "string")
            : [];
        } else if (event.type === "error") {
          streamError = typeof event.error === "string" ? event.error : "菜品识别暂时失败";
        }
      };
      await consumeRecognitionStream(response.body, handleEvent);
      if (streamError) throw new Error(streamError);
      if (!completed) throw new Error("识别结果未完整返回");
      if (requestId !== sequence) return;
      renderResults(activeReview, "complete");
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (requestId !== sequence) return;
    const message = error?.name === "AbortError"
      ? "识别已停止或超过 29 秒"
      : error instanceof Error ? error.message : "识别暂时失败";
    if (activeReview?.dishes.length) renderResults(activeReview, "partial", message);
    else renderFailure(message, file, form);
  } finally {
    if (requestId === sequence) activeController = null;
  }
}

function isMealPhotoInput(input) {
  return input instanceof HTMLInputElement && input.type === "file" &&
    input.accept.includes("image") && Boolean(input.closest(".publish-form")) &&
    !input.closest(".avatar-picker-field");
}

export function startDishRecognition(file, form) {
  if (!(file instanceof File) || !file.type.startsWith("image/") || !form?.matches(".publish-form")) return false;
  sequence += 1;
  const requestId = sequence;
  activeController?.abort();
  activeController = null;
  activeReview = null;
  mealWriteSnapshot = null;
  window.__dishRecognitionSnapshot = null;
  window.setTimeout(() => {
    if (requestId !== sequence) return;
    renderLoading();
    void recognizePhoto(file, form, requestId);
  }, 0);
  return true;
}

function onFileChange(event) {
  const input = event.target;
  if (!isMealPhotoInput(input)) return;
  startDishRecognition(input.files?.[0], input.closest(".publish-form"));
}

function requestUrl(input) {
  try {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
  } catch {
    return null;
  }
}

function requestBody(init) {
  return typeof init?.body === "string" ? init.body : null;
}

function sameSelectedFile(body, file) {
  return body === file || (body instanceof File && body.name === file.name && body.size === file.size && body.lastModified === file.lastModified);
}

function currentSnapshot() {
  if (!mealWriteSnapshot || Date.now() - mealWriteSnapshot.createdAt > SNAPSHOT_TTL_MS) {
    mealWriteSnapshot = null;
    window.__dishRecognitionSnapshot = null;
  }
  return mealWriteSnapshot;
}

function currentUploadedPhoto() {
  if (!pendingUploadedPhoto || Date.now() - pendingUploadedPhoto.createdAt > SNAPSHOT_TTL_MS) {
    pendingUploadedPhoto = null;
  }
  return pendingUploadedPhoto;
}

export function attachMealBoundingBoxes(bodyText, snapshot) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const matched = rows.some((row) => {
    if (!row || typeof row !== "object" || !Array.isArray(row.dishes) || typeof row.image_url !== "string") return false;
    if (!row.image_url.includes(snapshot.storageObjectPath)) return false;
    row.dishes = attachBoundingBoxes(row.dishes, snapshot.dishes);
    return true;
  });
  if (!matched) return null;
  return JSON.stringify(parsed);
}

export function removeStaleMealBoundingBoxes(bodyText, storageObjectPath) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const matched = rows.some((row) => {
    if (!row || typeof row !== "object" || !Array.isArray(row.dishes) || typeof row.image_url !== "string") return false;
    if (!row.image_url.includes(storageObjectPath)) return false;
    row.dishes = row.dishes.map((dish) => {
      if (!dish || typeof dish !== "object") return dish;
      const { bbox, confidence, needs_confirmation, ...withoutRecognitionLocation } = dish;
      return withoutRecognitionLocation;
    });
    return true;
  });
  if (!matched) return null;
  return JSON.stringify(parsed);
}

function cacheMealRows(value) {
  const rows = Array.isArray(value) ? value : [value];
  for (const meal of rows) {
    if (meal && typeof meal.id === "string" && typeof meal.image_url === "string" && Array.isArray(meal.dishes)) {
      mealsById.set(meal.id, meal);
    }
  }
  renderRecentGalleryButton();
}

function renderRecentGalleryButton() {
  const card = document.querySelector(".recent-meal-card:not(.empty-recent-card)");
  const image = card?.querySelector(".recent-meal-body img");
  const meal = image ? findMealByImageUrl([...mealsById.values()], image.currentSrc || image.src) : null;
  const eligible = meal && meal.dishes.some((dish) =>
    typeof dish?.name === "string" && dish.name.trim() && normalizedBoxToPixels(dish.bbox, 100, 100),
  );
  let host = card?.querySelector("[data-dish-recognition-gallery]");
  if (!card || !eligible) {
    host?.remove();
    return;
  }
  const imageKey = imageLookupKey(meal.image_url);
  const dishRevision = JSON.stringify(meal.dishes.map((dish) => ({ name: dish?.name, bbox: dish?.bbox })));
  if (host?.dataset.mealId === meal.id && host.dataset.imageKey === imageKey && host.dataset.dishRevision === dishRevision) return;
  host?.remove();
  host = document.createElement("div");
  host.dataset.dishRecognitionGallery = "true";
  host.dataset.mealId = meal.id;
  host.dataset.imageKey = imageKey ?? "";
  host.dataset.dishRevision = dishRevision;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { display: block; margin: 12px 0 0; }
      button { min-height: 40px; padding: 0 15px; border: 1px solid #b9cce5; border-radius: 14px; background: #f7faff; color: #4f83c9; font: 900 14px "Arial Rounded MT Bold", "PingFang SC", "Microsoft YaHei", sans-serif; cursor: pointer; }
      button:hover { background: #e8f2ff; }
      button:focus-visible { outline: 3px solid #93beff; outline-offset: 2px; }
    </style>
    <button type="button">查看菜品截图</button>
  `;
  shadow.querySelector("button").addEventListener("click", () => void showStoredGallery(meal.id));
  card.append(host);
}

function installRecentGalleryObserver() {
  const root = document.getElementById("root");
  if (!root || rootObserver) return;
  rootObserver = new MutationObserver(() => renderRecentGalleryButton());
  rootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  renderRecentGalleryButton();
}

function installMealWriteHook() {
  if (window.__dishRecognitionFetchWrapped) return;
  window.__dishRecognitionFetchWrapped = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const snapshot = currentSnapshot();
    let nextInit = init;
    if (url?.origin === PROJECT_URL && method === "POST" && url.pathname.includes("/storage/v1/object/meal-photos/")) {
      const body = init.body;
      if (body instanceof File) {
        const marker = "/storage/v1/object/";
        const storageObjectPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
        pendingUploadedPhoto = { storageObjectPath, createdAt: Date.now() };
        if (snapshot && sameSelectedFile(body, snapshot.file)) snapshot.storageObjectPath = storageObjectPath;
      }
    }
    let clearSnapshotAfterSuccess = false;
    let consumedPhotoPath = null;
    if (url?.origin === PROJECT_URL && url.pathname === "/rest/v1/meals" && ["POST", "PATCH"].includes(method)) {
      const body = requestBody(init);
      const uploadedPhoto = currentUploadedPhoto();
      const updatedBody = body && snapshot?.storageObjectPath
        ? attachMealBoundingBoxes(body, snapshot)
        : body && uploadedPhoto
          ? removeStaleMealBoundingBoxes(body, uploadedPhoto.storageObjectPath)
          : null;
      if (updatedBody) {
        nextInit = { ...init, body: updatedBody };
        clearSnapshotAfterSuccess = Boolean(snapshot?.storageObjectPath && updatedBody !== body);
        if (uploadedPhoto) consumedPhotoPath = uploadedPhoto.storageObjectPath;
      }
    }
    const response = await originalFetch(input, nextInit);
    if (clearSnapshotAfterSuccess && response.ok && currentSnapshot() === snapshot) {
      try {
        cacheMealRows(JSON.parse(nextInit.body));
      } catch {
        // The app's next meal refresh remains the source of truth if this body is unavailable.
      }
      mealWriteSnapshot = null;
      window.__dishRecognitionSnapshot = null;
    }
    if (consumedPhotoPath && response.ok && currentUploadedPhoto()?.storageObjectPath === consumedPhotoPath) {
      pendingUploadedPhoto = null;
    }
    if (url?.origin === PROJECT_URL && url.pathname === "/rest/v1/meals" && method === "GET" && response.ok) {
      void response.clone().json().then(cacheMealRows).catch(() => {});
    }
    return response;
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installMealWriteHook();
  installRecentGalleryObserver();
  document.addEventListener("change", onFileChange, true);
}
