const KEYS = { consent: "tt-consent", device: "tt-device", profile: "tt-profile", queued: "tt-queued-beads", theme: "tt-theme" };
const $ = (selector) => document.querySelector(selector);
const welcome = $("#welcome");
const app = $("#app");
const nameInput = $("#name-input");
const toast = $("#toast");
const audio = $("#chant-audio");
const API_BASE = String(window.TINH_TAM_API_BASE || "").replace(/\/$/, "");
let consent = safeRead(KEYS.consent);
let deviceId = safeRead(KEYS.device) || getCookie("tt_device") || "";
if (consent === "rejected") {
  deviceId = "";
  try { localStorage.removeItem(KEYS.device); } catch { /* Storage may be disabled. */ }
  document.cookie = "tt_device=; Max-Age=0; Path=/; SameSite=Lax";
}
let fingerprint = "";
let profile = readProfile();
let pendingBatches = [];
try {
  const savedQueue = JSON.parse(safeRead(KEYS.queued) || "[]");
  pendingBatches = Array.isArray(savedQueue) ? savedQueue : Number(savedQueue) > 0 ? [{ id: createRandomId(), count: Number(savedQueue), date: new Date().toISOString().slice(0, 10) }] : [];
} catch {
  const legacyCount = Number(safeRead(KEYS.queued) || 0);
  if (legacyCount > 0) pendingBatches = [{ id: createRandomId(), count: legacyCount, date: new Date().toISOString().slice(0, 10) }];
}
let activePage = "meditate";
let soundEnabled = true;
let autoTimer = null;
let syncTimer = null;
let toastTimer;
let online = false;
let wishes = Array.isArray(profile.wishes) ? profile.wishes : [];
let inFlightBatch = false;
let syncingDeletes = false;
const currentDate = new Date().toISOString().slice(0, 10);
if (profile.beadDate !== currentDate) {
  profile.todayBeads = 0;
  profile.beadDate = currentDate;
}

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeWrite(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Continue with in-memory state when storage is unavailable. */ }
}

function readProfile() {
  try {
    const stored = JSON.parse(safeRead(KEYS.profile) || "{}");
    return { name: stored.name || "Bạn", totalBeads: Number(stored.totalBeads) || 0, todayBeads: Number(stored.todayBeads) || 0, beadDate: stored.beadDate || new Date().toISOString().slice(0, 10), wishes: Array.isArray(stored.wishes) ? stored.wishes : [] };
  } catch {
    return { name: "Bạn", totalBeads: 0, todayBeads: 0, beadDate: new Date().toISOString().slice(0, 10), wishes: [] };
  }
}

function saveProfile() {
  profile.wishes = wishes;
  safeWrite(KEYS.profile, JSON.stringify(profile));
  $("#total-count").textContent = profile.totalBeads.toLocaleString("vi-VN");
  $("#today-count").textContent = profile.todayBeads.toLocaleString("vi-VN");
}

function queuedCount() {
  return pendingBatches.reduce((sum, batch) => sum + batch.count, 0);
}

function saveQueue() {
  safeWrite(KEYS.queued, JSON.stringify(pendingBatches));
}

function createDeviceId() {
  const id = createRandomId();
  safeWrite(KEYS.device, id);
  document.cookie = `tt_device=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  return id;
}

function createRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto?.getRandomValues ? crypto.getRandomValues(new Uint8Array(16)) : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ensureDeviceId() {
  if (!deviceId) deviceId = createDeviceId();
  return deviceId;
}

function getCookie(key) {
  const match = document.cookie.split("; ").find((item) => item.startsWith(`${key}=`));
  return match ? decodeURIComponent(match.slice(key.length + 1)) : "";
}

function cleanName(value) {
  return Array.from(String(value || "").trim()).slice(0, 40).join("") || "Bạn";
}

async function getFingerprint() {
  const components = [navigator.userAgent, navigator.language, `${screen.width}x${screen.height}`, Intl.DateTimeFormat().resolvedOptions().timeZone || ""].join("|");
  const signals = [components];
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 36;
    const context = canvas.getContext("2d");
    context.font = "16px sans-serif";
    context.fillText("Tinh Tam an nhien", 3, 24);
    signals.push(canvas.toDataURL());
  } catch {
    signals.push("canvas-unavailable");
  }
  try {
    const AudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (AudioContext) {
      const audioContext = new AudioContext(1, 44100, 44100);
      const oscillator = audioContext.createOscillator();
      const compressor = audioContext.createDynamicsCompressor();
      oscillator.type = "triangle";
      oscillator.frequency.value = 10000;
      oscillator.connect(compressor).connect(audioContext.destination);
      oscillator.start(0);
      const rendered = await audioContext.startRendering();
      const samples = rendered.getChannelData(0);
      let signature = 0;
      for (let index = 0; index < samples.length; index += 101) signature = Math.imul(signature ^ Math.round(samples[index] * 1e7), 16777619) >>> 0;
      signals.push(signature.toString(16));
    }
  } catch {
    signals.push("audio-unavailable");
  }
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signals.join("|")));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Array.from(signals.join("|")).reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16);
}

function profilePayload(name) {
  return {
    consent: true,
    deviceId,
    fingerprint,
    name,
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `${screen.width}x${screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Không thể kết nối máy chủ.");
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function setConsent(value) {
  consent = value ? "accepted" : "rejected";
  safeWrite(KEYS.consent, consent);
  if (!value) {
    deviceId = "";
    try { localStorage.removeItem(KEYS.device); } catch { /* Storage may be disabled. */ }
    document.cookie = "tt_device=; Max-Age=0; Path=/; SameSite=Lax";
  }
  $("#consent-box").classList.add("hidden");
  $("#consent-status").textContent = value ? "Bạn đã đồng ý lưu dữ liệu để đồng bộ." : "Bạn từ chối lưu dữ liệu trên máy chủ.";
}

function enterApp(name, greeting = false) {
  profile.name = cleanName(name);
  saveProfile();
  welcome.classList.add("hidden");
  app.classList.remove("hidden");
  $("#greeting").textContent = `Chào ${profile.name}, chúc bạn một ngày an nhiên`;
  $("#rename-input").value = profile.name === "Bạn" ? "" : profile.name;
  $("#welcome-back").textContent = `Chào ${profile.name}, chúc bạn một ngày an nhiên.`;
  $("#welcome-back").classList.toggle("hidden", !greeting);
  renderWishes();
  if (consent === "accepted") {
    syncPending();
    syncPendingWishes();
    request("/api/visit", { method: "POST", body: JSON.stringify({ deviceId, page: activePage }) }).catch((error) => console.warn("Không ghi được lượt truy cập:", error.message));
  }
}

async function identify(name) {
  ensureDeviceId();
  fingerprint ||= await getFingerprint();
  const result = await request("/api/identify", { method: "POST", body: JSON.stringify(profilePayload(name)) });
  online = true;
  return result;
}

async function resumeIdentity() {
  if (consent !== "accepted") return;
  ensureDeviceId();
  try {
    fingerprint ||= await getFingerprint();
    const result = await identify();
    if (result.known) {
      profile = { ...profile, ...result.user, beadDate: new Date().toISOString().slice(0, 10), wishes };
      profile.identityPending = false;
      saveProfile();
      enterApp(result.user.name, true);
      loadWishes();
    } else if (result.candidate?.name) {
      showIpConfirmation(result.candidate.name);
    }
  } catch {
    showToast("Chưa kết nối được máy chủ. Bạn vẫn có thể tĩnh tâm trên thiết bị này.");
  }
}

function showIpConfirmation(masked) {
  $("#ip-confirm-text").textContent = `Có phải bạn là ${masked}?`;
  const dialog = $("#ip-confirm");
  if (!dialog.open) dialog.showModal();
}

async function startSession(name) {
  const selectedName = cleanName(name);
  if (consent !== "accepted") {
    enterApp(selectedName);
    return;
  }
  ensureDeviceId();
  try {
    fingerprint ||= await getFingerprint();
    const result = await identify();
    if (result.known) {
      profile = { ...profile, ...result.user, beadDate: new Date().toISOString().slice(0, 10), wishes };
      profile.identityPending = false;
      enterApp(result.user.name, true);
      loadWishes();
      return;
    }
    if (result.candidate?.name) {
      showIpConfirmation(result.candidate.name);
      return;
    }
    const created = await identify(selectedName);
    if (created.known) {
      profile = { ...profile, ...created.user, beadDate: new Date().toISOString().slice(0, 10), wishes };
      profile.identityPending = false;
      enterApp(created.user.name);
    } else {
      enterApp(selectedName);
      showToast("Dữ liệu đang ở trên thiết bị này; máy chủ chưa xác nhận hồ sơ.");
    }
  } catch (error) {
    profile.identityPending = true;
    enterApp(selectedName);
    saveProfile();
    showToast(`${error.message} Tiến độ được lưu tạm trên thiết bị.`);
  }
}

$("#welcome-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!consent) {
    showToast("Chọn Đồng ý hoặc Từ chối để tiếp tục.");
    $("#consent-box").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  startSession(nameInput.value);
});
$("#skip-button").addEventListener("click", () => {
  if (!consent) {
    showToast("Chọn Đồng ý hoặc Từ chối để tiếp tục.");
    $("#consent-box").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  startSession("Bạn");
});
$("#accept-consent").addEventListener("click", async () => {
  setConsent(true);
  await resumeIdentity();
  if (welcome.classList.contains("hidden") || $("#ip-confirm").open) return;
  startSession(nameInput.value);
});
$("#decline-consent").addEventListener("click", () => {
  setConsent(false);
  showToast("Bạn có thể dùng đầy đủ; dữ liệu chỉ lưu trên thiết bị.");
});
$("#ip-no").addEventListener("click", async () => {
  $("#ip-confirm").close();
  const name = cleanName(nameInput.value);
  try {
    const result = await identify(name);
    if (result.known) {
      profile = { ...profile, ...result.user, beadDate: new Date().toISOString().slice(0, 10), wishes };
      profile.identityPending = false;
      enterApp(result.user.name);
    } else {
      enterApp(name);
    }
  } catch (error) {
    profile.identityPending = true;
    enterApp(name);
    saveProfile();
    showToast(`${error.message} Tiến độ được lưu tạm trên thiết bị.`);
  }
});
$("#ip-yes").addEventListener("click", async () => {
  try {
    fingerprint ||= await getFingerprint();
    ensureDeviceId();
    const result = await request("/api/identify/confirm-ip", { method: "POST", body: JSON.stringify(profilePayload()) });
    online = true;
    $("#ip-confirm").close();
    if (result.known) {
      profile = { ...profile, ...result.user, beadDate: new Date().toISOString().slice(0, 10), wishes };
      profile.identityPending = false;
      enterApp(result.user.name, true);
      loadWishes();
    } else {
      showToast("Không thể xác nhận hồ sơ từ địa chỉ IP.");
    }
  } catch (error) {
    $("#ip-confirm").close();
    showToast(error.message);
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});

function switchPage(page) {
  activePage = page;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  document.querySelectorAll(".page-view").forEach((view) => view.classList.toggle("hidden", view.id !== `page-${page}`));
  if (page === "wishes") loadWishes();
  if (page === "settings") $("#consent-status").textContent = consent === "accepted" ? "Bạn đã đồng ý lưu dữ liệu để đồng bộ." : "Từ chối lưu định danh; dữ liệu chỉ ở trên thiết bị.";
  if (consent === "accepted" && online) request("/api/visit", { method: "POST", body: JSON.stringify({ deviceId, page }) }).catch((error) => console.warn("Không ghi được lượt truy cập:", error.message));
}

function playMokSound() {
  if (!soundEnabled) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const volume = Number($("#volume").value);
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(190, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(92, context.currentTime + .13);
  gain.gain.setValueAtTime(Math.max(.001, volume * .17), context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .32);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + .33);
  oscillator.addEventListener("ended", () => context.close(), { once: true });
}

function strike() {
  profile.totalBeads += 1;
  const date = new Date().toISOString().slice(0, 10);
  if (profile.beadDate !== date) {
    profile.todayBeads = 0;
    profile.beadDate = date;
  }
  profile.todayBeads += 1;
  const currentBatch = pendingBatches.at(-1);
  if (currentBatch && !currentBatch.sent && !inFlightBatch && currentBatch.date === date) currentBatch.count += 1;
  else pendingBatches.push({ id: createRandomId(), count: 1, date });
  saveQueue();
  saveProfile();
  playMokSound();
  const gong = $("#gong");
  gong.classList.remove("hit", "ripple");
  void gong.offsetWidth;
  gong.classList.add("hit", "ripple");
  const float = document.createElement("span");
  float.textContent = "+1 công đức";
  $("#merit-float").replaceChildren(float);
  if (profile.totalBeads % 108 === 0) {
    $("#milestone b").textContent = profile.totalBeads.toLocaleString("vi-VN");
    $("#milestone").classList.remove("hidden");
    setTimeout(() => $("#milestone").classList.add("hidden"), 2200);
  }
  if (queuedCount() >= 25) syncPending();
}

$("#gong").addEventListener("click", strike);
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.code === "Space" && !event.repeat && welcome.classList.contains("hidden") && !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) {
    event.preventDefault();
    strike();
  }
});
$("#sound-toggle").addEventListener("click", (event) => {
  soundEnabled = !soundEnabled;
  event.currentTarget.setAttribute("aria-pressed", String(soundEnabled));
  event.currentTarget.setAttribute("aria-label", soundEnabled ? "Tắt âm thanh" : "Bật âm thanh");
  event.currentTarget.textContent = soundEnabled ? "♫" : "♪";
});
$("#auto-toggle").addEventListener("click", (event) => {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    event.currentTarget.textContent = "Bắt đầu";
    event.currentTarget.setAttribute("aria-pressed", "false");
  } else {
    autoTimer = setInterval(strike, Number($("#auto-speed").value));
    event.currentTarget.textContent = "Dừng lại";
    event.currentTarget.setAttribute("aria-pressed", "true");
  }
});
$("#auto-speed").addEventListener("change", () => {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = setInterval(strike, Number($("#auto-speed").value));
  }
});

async function syncPending() {
  if (!pendingBatches.length || consent !== "accepted" || !deviceId || !online || syncTimer) return;
  const batch = pendingBatches[0];
  syncTimer = true;
  inFlightBatch = true;
  batch.sent = true;
  saveQueue();
  let succeeded = false;
  try {
    const result = await request("/api/beads", { method: "POST", body: JSON.stringify({ deviceId, count: batch.count, batchId: batch.id, date: batch.date }) });
    if (pendingBatches[0]?.id === batch.id) pendingBatches.shift();
    saveQueue();
    profile.totalBeads = Math.max(profile.totalBeads, result.totalBeads + queuedCount());
    saveProfile();
    succeeded = true;
  } catch (error) {
    console.warn("Lượt gõ mõ sẽ được đồng bộ lại khi có kết nối:", error.message);
  } finally {
    syncTimer = false;
    inFlightBatch = false;
    if (succeeded && pendingBatches.length) setTimeout(syncPending, 0);
  }
}
window.addEventListener("online", reconnectIdentity);
setInterval(() => {
  if (navigator.onLine && (profile.identityPending || profile.namePending || pendingBatches.length || wishes.some((wish) => wish.pending) || profile.pendingWishDeletes?.length)) reconnectIdentity();
}, 12000);

function formatDate(value) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderWishes() {
  const list = $("#wish-list");
  list.replaceChildren();
  $("#wish-total").textContent = `${wishes.length} điều ước`;
  if (!wishes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-wishes";
    empty.textContent = "Những điều ước dịu dàng của bạn sẽ ở đây.";
    list.append(empty);
    return;
  }
  for (const wish of [...wishes].sort((a, b) => b.at.localeCompare(a.at))) {
    const item = document.createElement("article");
    item.className = "wish-item";
    const content = document.createElement("div");
    const text = document.createElement("p");
    text.textContent = wish.text;
    const date = document.createElement("small");
    date.textContent = formatDate(wish.at);
    content.append(text, date);
    const remove = document.createElement("button");
    remove.className = "wish-delete";
    remove.type = "button";
    remove.textContent = "Xoá";
    remove.setAttribute("aria-label", "Xoá điều ước");
    remove.addEventListener("click", () => deleteWish(wish.id));
    item.append(content, remove);
    list.append(item);
  }
}

async function loadWishes() {
  if (consent !== "accepted" || !online) {
    renderWishes();
    return;
  }
  try {
    const result = await request(`/api/wishes?deviceId=${encodeURIComponent(deviceId)}`);
    const pending = wishes.filter((wish) => wish.pending && !result.wishes.some((remote) => remote.clientId === wish.clientId));
    const pendingDeletes = new Set(profile.pendingWishDeletes || []);
    const deletedClientIds = new Set();
    const serverWishes = result.wishes.filter((wish) => {
      if (pendingDeletes.has(wish.id)) return false;
      if (pendingDeletes.has(`client:${wish.clientId}`)) {
        deletedClientIds.add(`client:${wish.clientId}`);
        profile.pendingWishDeletes.push(wish.id);
        return false;
      }
      return true;
    });
    profile.pendingWishDeletes = (profile.pendingWishDeletes || []).filter((id) => !deletedClientIds.has(id));
    wishes = [...serverWishes, ...pending];
    profile.wishes = wishes;
    saveProfile();
    renderWishes();
    syncPendingDeletes();
    syncPendingWishes();
  } catch (error) {
    console.warn("Không tải được điều ước; tiếp tục dùng bản lưu trên thiết bị:", error.message);
    renderWishes();
  }
}

async function reconnectIdentity() {
  if (consent !== "accepted" || !deviceId) return;
  try {
    let result = await identify();
    if (!result.known && result.candidate?.name) {
      showIpConfirmation(result.candidate.name);
      return;
    }
    if (!result.known && profile.identityPending) result = await identify(profile.name);
    if (!result.known) return;

    if (profile.namePending) {
      await request("/api/profile", { method: "PATCH", body: JSON.stringify({ deviceId, name: profile.name }) });
      profile.namePending = false;
    } else {
      profile.name = result.user.name;
    }
    profile.identityPending = false;
    profile.totalBeads = Math.max(profile.totalBeads, result.user.totalBeads);
    if (profile.beadDate === new Date().toISOString().slice(0, 10)) profile.todayBeads = Math.max(profile.todayBeads, result.user.todayBeads);
    saveProfile();
    if (!app.classList.contains("hidden")) {
      $("#greeting").textContent = `Chào ${profile.name}, chúc bạn một ngày an nhiên`;
      await syncPending();
      await loadWishes();
      await syncPendingWishes();
      await syncPendingDeletes();
    }
  } catch (error) {
    console.warn("Dữ liệu sẽ được đồng bộ lại khi máy chủ sẵn sàng:", error.message);
  }
}

async function syncPendingWishes() {
  if (consent !== "accepted" || !online) return;
  for (const wish of wishes.filter((item) => item.pending)) {
    try {
      const result = await request("/api/wishes", { method: "POST", body: JSON.stringify({ deviceId, text: wish.text, clientId: wish.clientId }) });
      wish.id = result.wish.id;
      wish.at = result.wish.at;
      wish.pending = false;
    } catch (error) {
      console.warn("Điều ước sẽ được đồng bộ lại khi có kết nối:", error.message);
      break;
    }
  }
  saveProfile();
  renderWishes();
}

async function syncPendingDeletes() {
  if (syncingDeletes || consent !== "accepted" || !online || !Array.isArray(profile.pendingWishDeletes)) return;
  syncingDeletes = true;
  try {
    while (profile.pendingWishDeletes.length) {
      const id = profile.pendingWishDeletes[0];
      try {
        await request(`/api/wishes/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ deviceId }) });
      } catch (error) {
        if (error.message !== "Không tìm thấy điều ước.") throw error;
      }
      profile.pendingWishDeletes.shift();
      saveProfile();
    }
  } catch (error) {
    console.warn("Yêu cầu xoá điều ước sẽ được đồng bộ lại:", error.message);
  } finally {
    syncingDeletes = false;
  }
}

$("#wish-input").addEventListener("input", (event) => { $("#wish-length").textContent = Array.from(event.target.value).length; });
$("#wish-submit").addEventListener("click", async () => {
  const text = $("#wish-input").value.trim();
  if (!text) return showToast("Hãy viết một điều ước trước khi gửi.");
  const clientId = createRandomId();
  const wish = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, clientId, text, at: new Date().toISOString(), pending: consent === "accepted" };
  if (consent === "accepted" && online) {
    try {
      const result = await request("/api/wishes", { method: "POST", body: JSON.stringify({ deviceId, text, clientId }) });
      wish.id = result.wish.id;
      wish.at = result.wish.at;
      wish.pending = false;
    } catch (error) {
      showToast(`${error.message} Điều ước được giữ tạm trên thiết bị.`);
    }
  }
  wishes.unshift(wish);
  profile.wishes = wishes;
  saveProfile();
  renderWishes();
  $("#wish-input").value = "";
  $("#wish-length").textContent = "0";
  const sky = $("#wish-sky");
  sky.classList.remove("hidden");
  setTimeout(() => sky.classList.add("hidden"), 2850);
  showToast("Điều ước của bạn đã bay lên trời đêm.");
});

async function deleteWish(id) {
  const wish = wishes.find((entry) => entry.id === id);
  if (consent === "accepted" && wish?.pending && wish.clientId) {
    profile.pendingWishDeletes ||= [];
    profile.pendingWishDeletes.push(`client:${wish.clientId}`);
  } else if (consent === "accepted" && wish && !String(id).startsWith("local-")) {
    profile.pendingWishDeletes ||= [];
    if (online) {
      try { await request(`/api/wishes/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ deviceId }) }); }
      catch (error) {
        if (!profile.pendingWishDeletes.includes(id)) profile.pendingWishDeletes.push(id);
        showToast("Yêu cầu xoá sẽ được đồng bộ khi có kết nối.");
      }
    } else {
      if (!profile.pendingWishDeletes.includes(id)) profile.pendingWishDeletes.push(id);
    }
  }
  wishes = wishes.filter((wish) => wish.id !== id);
  saveProfile();
  renderWishes();
}

$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = cleanName($("#rename-input").value);
  if (consent === "accepted" && online) {
    try {
      await request("/api/profile", { method: "PATCH", body: JSON.stringify({ deviceId, name }) });
      profile.namePending = false;
    } catch (error) {
      profile.namePending = true;
      showToast(`${error.message} Tên mới sẽ đồng bộ khi có kết nối.`);
    }
  } else if (consent === "accepted") {
    profile.namePending = true;
  }
  profile.name = name;
  saveProfile();
  $("#greeting").textContent = `Chào ${name}, chúc bạn một ngày an nhiên`;
  showToast("Tên của bạn đã được cập nhật.");
});

$("#delete-data").addEventListener("click", async () => {
  if (!window.confirm("Xoá toàn bộ dữ liệu của bạn trên thiết bị và máy chủ? Thao tác này không thể hoàn tác.")) return;
  if (consent === "accepted" && online) {
    try { await request("/api/me", { method: "DELETE", body: JSON.stringify({ deviceId }) }); }
    catch (error) { return showToast(`Chưa xoá được dữ liệu trên máy chủ: ${error.message}`); }
  } else if (consent === "accepted") {
    return showToast("Đang ngoại tuyến; kết nối lại để xoá dữ liệu trên máy chủ.");
  }
  for (const key of Object.values(KEYS)) {
    try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
  }
  document.cookie = `tt_device=; Max-Age=0; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  location.reload();
});

$("#theme-toggle").addEventListener("click", () => {
  document.body.classList.toggle("light-mode");
  safeWrite(KEYS.theme, document.body.classList.contains("light-mode") ? "light" : "dark");
});
if (safeRead(KEYS.theme) === "light") document.body.classList.add("light-mode");
$("#privacy-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("#privacy-dialog").showModal();
});
$("#privacy-close").addEventListener("click", () => $("#privacy-dialog").close());

audio.addEventListener("error", () => {
  $("#audio-fallback").classList.remove("hidden");
  $("#audio-state").textContent = "Chưa có tệp âm thanh";
});
audio.addEventListener("timeupdate", () => {
  const paragraphs = [...$("#sutra-text").querySelectorAll("p")];
  if (!audio.duration || !paragraphs.length) return;
  const index = Math.min(paragraphs.length - 1, Math.floor(audio.currentTime / audio.duration * paragraphs.length));
  paragraphs.forEach((paragraph, current) => paragraph.classList.toggle("current", index === current));
  paragraphs[index].scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#chant-play").addEventListener("click", async () => {
  if (audio.paused) {
    try {
      await audio.play();
      $("#audio-state").textContent = "Đang phát";
      $("#chant-play").textContent = "Ⅱ";
      $("#audio-fallback").classList.add("hidden");
    } catch {
      $("#audio-fallback").classList.remove("hidden");
      $("#audio-state").textContent = "Bản tụng chưa được cài đặt";
      showToast("Chưa có tệp âm thanh. Bạn vẫn có thể đọc lời kinh.");
    }
  } else {
    audio.pause();
    $("#audio-state").textContent = "Đã tạm dừng";
    $("#chant-play").textContent = "▶";
  }
});
$("#chant-loop").addEventListener("change", (event) => { audio.loop = event.target.checked; });
document.querySelector(".chant-volume").addEventListener("input", (event) => { audio.volume = Number(event.target.value); });

if (consent === "accepted") $("#consent-box").classList.add("hidden");
if (consent === "rejected") $("#consent-status").textContent = "Từ chối lưu định danh; dữ liệu chỉ ở trên thiết bị.";
saveProfile();
resumeIdentity();
renderWishes();
