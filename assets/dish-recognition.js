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
let recognitionRun = null;
let statusHost = null;
let dialogDismiss = null;
let dialogSheet = null;

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

function ensureStatusHost() {
  const form = recognitionRun?.form;
  if (!form?.isConnected) return;
  if (!statusHost) {
    statusHost = document.createElement("div");
    statusHost.dataset.dishRecognitionStatus = "true";
    const shadow = statusHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display: block; margin: 12px 0; color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid #dce9fa; border-radius: 16px; background: #f7faff; color: #233349; }
        .copy { min-width: 0; }
        strong { display: block; font-size: 13px; line-height: 1.4; }
        span { display: block; margin-top: 3px; color: #66768a; font-size: 12px; line-height: 1.4; }
        .actions { display: flex; flex: 0 0 auto; gap: 6px; }
        button { min-height: 34px; padding: 0 10px; border: 1px solid #b9d7ff; border-radius: 999px; background: #fff; color: #42699e; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
        button:first-child { background: #dcecff; color: #233349; }
        button:focus-visible { outline: 3px solid #93beff; outline-offset: 2px; }
        @media (max-width: 390px) { .status { flex-wrap: wrap; } .actions { width: 100%; } }
      </style>
      <div class="status" role="status" aria-live="polite">
        <div class="copy"><strong></strong><span></span></div>
        <div class="actions"><button type="button" data-action="view"></button><button type="button" data-action="retry">重新识别</button></div>
      </div>
    `;
    shadow.querySelector('[data-action="view"]').addEventListener("click", showRecognitionRun);
    shadow.querySelector('[data-action="retry"]').addEventListener("click", () => {
      if (recognitionRun) startDishRecognition(recognitionRun.file, recognitionRun.form);
    });
  }
  if (statusHost.parentElement !== form) {
    const uploadZone = form.querySelector(".upload-zone");
    if (uploadZone) uploadZone.after(statusHost);
    else form.prepend(statusHost);
  }
}

function renderRecognitionStatus() {
  if (!recognitionRun) {
    statusHost?.remove();
    return;
  }
  ensureStatusHost();
  if (!statusHost?.isConnected) return;
  const { status, review, error } = recognitionRun;
  const count = review?.dishes.filter((dish) => dish.name.trim()).length ?? 0;
  const titles = {
    loading: "正在识别菜品…",
    streaming: `已识别 ${count} 道，仍在继续…`,
    complete: `识别完成：${count} 道菜`,
    partial: `识别中断：已找到 ${count} 道菜`,
    error: "这次识别没有成功",
    applied: `已填入 ${count} 道菜，可继续修改`,
  };
  const details = {
    loading: "关闭弹窗后仍会继续识别。",
    streaming: "可以随时查看、修改已找到的菜。",
    complete: "请核对名称和截图，漏掉的菜可手动添加。",
    partial: error || "可以使用现有结果或重新识别。",
    error: error || "可手动填写，也可以重试。",
    applied: "提交前仍可返回检查截图。",
  };
  const shadow = statusHost.shadowRoot;
  shadow.querySelector("strong").textContent = titles[status] ?? titles.loading;
  shadow.querySelector(".copy span").textContent = details[status] ?? details.loading;
  shadow.querySelector('[data-action="view"]').textContent = status === "loading" ? "查看进度" : status === "error" ? "查看原因" : "查看结果";
}

function setRecognitionStatus(requestId, status, error = "") {
  if (recognitionRun?.requestId !== requestId) return;
  recognitionRun.status = status;
  recognitionRun.error = error;
  renderRecognitionStatus();
}

function createDialog() {
  const container = document.querySelector(".bottom-sheet") ?? document.body;
  if (dialogElements) {
    if (!dialogElements.host.isConnected && dialogElements.dialog.open) dialogElements.dialog.close();
    if (dialogElements.host.parentElement !== container) container.append(dialogElements.host);
    return dialogElements;
  }
  const host = document.createElement("div");
  host.className = "dish-recognition-host";
  host.setAttribute("aria-live", "polite");
  // The sheet's gesture and outside-click handlers must not take over the review.
  for (const type of ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "click"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  // Keep the scrolling element in light DOM: the parent sheet's scroll lock
  // cannot recognize a scrollable descendant hidden behind a shadow root.
  host.innerHTML = '<dialog aria-labelledby="dish-recognition-title"><div class="panel"></div></dialog>';
  container.append(host);
  const dialog = host.querySelector("dialog");
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    (dialogDismiss ?? closeDialog)();
  });
  dialogElements = { host, root: host, dialog, panel: host.querySelector(".panel") };
  return dialogElements;
}

function openDialog() {
  const { dialog } = createDialog();
  const sheet = dialogElements.host.closest(".bottom-sheet");
  if (dialogSheet && dialogSheet !== sheet) dialogSheet.removeAttribute("data-dish-recognition-dialog-open");
  dialogSheet = sheet;
  dialogSheet?.setAttribute("data-dish-recognition-dialog-open", "true");
  if (!dialog.open) dialog.showModal();
}

function releaseDialogSheet() {
  dialogSheet?.removeAttribute("data-dish-recognition-dialog-open");
  dialogSheet = null;
}

function closeDialog() {
  if (dialogElements?.dialog.open) sequence += 1;
  activeController?.abort();
  activeController = null;
  activeReview = null;
  if (dialogElements?.dialog.open) dialogElements.dialog.close();
  releaseDialogSheet();
}

function dismissRecognitionDialog() {
  if (recognitionRun) recognitionRun.dialogVisible = false;
  if (dialogElements?.dialog.open) dialogElements.dialog.close();
  releaseDialogSheet();
}

function footerButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderPanel({ title, hint, body, actions = [], onDismiss = closeDialog, preserveScroll = false }) {
  const { panel } = createDialog();
  const previousScroll = preserveScroll ? panel.querySelector(".body")?.scrollTop ?? 0 : 0;
  dialogDismiss = onDismiss;
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
  close.addEventListener("click", () => dialogDismiss());
  header.append(titles, close);
  const content = document.createElement("div");
  content.className = "body";
  content.append(body);
  const footer = document.createElement("footer");
  for (const action of actions) footer.append(action);
  panel.append(header, content, footer);
  openDialog();
  if (preserveScroll) content.scrollTop = previousScroll;
}

function renderLoading() {
  const body = document.createElement("div");
  body.className = "loading";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  body.append(spinner, document.createElement("br"));
  const message = document.createElement("span");
  message.className = "single-line";
  message.textContent = "正在识别菜品，请稍候…";
  body.append(message);
  renderPanel({
    title: "正在识别菜品",
    hint: "关闭弹窗后仍会继续识别。",
    body,
    actions: [footerButton("稍后再说", "", dismissRecognitionDialog)],
    onDismiss: dismissRecognitionDialog,
  });
}

function renderFailure(message, file, form) {
  const body = document.createElement("div");
  body.className = "error";
  body.textContent = `${message}。你仍可手动填写菜名并发布。`;
  const retry = footerButton("重新识别", "primary", () => startDishRecognition(file, form));
  renderPanel({
    title: "这次没有识别成功",
    hint: "识别失败不会影响原照片和手动录入。",
    body,
    actions: [footerButton("手动填写", "", dismissRecognitionDialog), retry],
    onDismiss: dismissRecognitionDialog,
  });
}

function renderResults(review, state = "complete", failureMessage = "") {
  const previouslyFocused = dialogElements?.host.contains(document.activeElement) ? document.activeElement : null;
  const focusedIndex = previouslyFocused?.matches?.(".card input")
    ? Array.from(dialogElements.root.querySelectorAll(".card input")).indexOf(previouslyFocused)
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
    : "请核对菜名和截图；漏掉的菜可手动添加。";
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
      const applyButton = dialogElements?.root.querySelector("footer .primary");
      if (applyButton) applyButton.disabled = !dishes.some((item) => item.name.trim());
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
  if (review.dishes.length < MAX_DISHES) {
    const addDish = document.createElement("button");
    addDish.type = "button";
    addDish.className = "add-dish";
    addDish.textContent = "+ 添加漏识别的菜品";
    addDish.addEventListener("click", () => {
      review.dishes.push({ name: "", bbox: null, confidence: null, thumbnail: null, manual: true });
      renderRecognitionStatus();
      renderResults(review, state, failureMessage);
      const addedInput = dialogElements?.root.querySelectorAll(".card input")[review.dishes.length - 1];
      addedInput?.focus({ preventScroll: true });
      addedInput?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    body.append(addDish);
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
    sequence += 1;
    activeController?.abort();
    activeController = null;
    if (recognitionRun?.review === review) {
      recognitionRun.status = "applied";
      recognitionRun.error = "";
      renderRecognitionStatus();
    }
    activeReview = null;
    dismissRecognitionDialog();
  });
  if (!dishes.some((dish) => dish.name.trim())) useNames.disabled = true;
  const actions = [footerButton(state === "streaming" ? "稍后再说" : "关闭", "", dismissRecognitionDialog)];
  if (state === "partial") {
    actions.push(footerButton("重新识别", "", () => startDishRecognition(review.file, review.form)));
  }
  actions.push(useNames);
  renderPanel({
    title: state === "streaming" ? "识别进行中" : state === "partial" ? "部分识别结果" : "菜品识别结果",
    hint: state === "streaming"
      ? "结果会逐道出现；可以边等边检查，也可先填入当前已识别菜名。"
      : "可改菜名或添加漏掉的菜；无位置框的菜暂不生成截图。",
    body,
    actions,
    onDismiss: dismissRecognitionDialog,
    preserveScroll: true,
  });
  if (focusedIndex >= 0) {
    const nextInput = dialogElements.root.querySelectorAll(".card input")[focusedIndex];
    if (nextInput) {
      nextInput.focus({ preventScroll: true });
      if (selection && nextInput.setSelectionRange) nextInput.setSelectionRange(selection[0], selection[1]);
    }
  }
}

function showRecognitionRun() {
  if (!recognitionRun) return;
  recognitionRun.dialogVisible = true;
  const { status, review, error, file, form } = recognitionRun;
  if (status === "loading") renderLoading();
  else if (status === "error") renderFailure(error || "识别暂时失败", file, form);
  else if (review) renderResults(review, status === "applied" ? "complete" : status, error);
  else renderLoading();
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
    if (recognitionRun?.requestId === requestId) recognitionRun.review = activeReview;
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
        if (requestId === sequence) {
          setRecognitionStatus(requestId, "complete");
          if (recognitionRun?.dialogVisible) renderResults(activeReview, "complete");
        }
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
            setRecognitionStatus(requestId, "streaming");
            if (recognitionRun?.dialogVisible) renderResults(activeReview, "streaming");
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
      setRecognitionStatus(requestId, "complete");
      if (recognitionRun?.dialogVisible) renderResults(activeReview, "complete");
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (requestId !== sequence) return;
    const message = error?.name === "AbortError"
      ? "识别已停止或超过 29 秒"
      : error instanceof Error ? error.message : "识别暂时失败";
    if (activeReview?.dishes.length) {
      setRecognitionStatus(requestId, "partial", message);
      if (recognitionRun?.dialogVisible) renderResults(activeReview, "partial", message);
    } else {
      setRecognitionStatus(requestId, "error", message);
      if (recognitionRun?.dialogVisible) renderFailure(message, file, form);
    }
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
  recognitionRun = { requestId, file, form, status: "loading", review: null, error: "", dialogVisible: true };
  renderRecognitionStatus();
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
  rootObserver = new MutationObserver(() => {
    renderRecentGalleryButton();
    ensureStatusHost();
  });
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
