import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.DATA_DIR || join(root, "data");
const dataFile = join(dataDir, "tinh-tam.json");
const port = Number(process.env.PORT || 3000);
const trustedProxyHeader = process.env.TRUSTED_PROXY_HEADER?.toLowerCase();
const logRetentionDays = Math.max(1, Math.floor(Number(process.env.LOG_RETENTION_DAYS) || 90));
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
const adminTotpSecret = process.env.ADMIN_TOTP_SECRET || "";
const adminHash = adminPassword ? await bcrypt.hash(adminPassword, 12) : null;
const sessions = new Map();
const attempts = new Map();
const mimeTypes = {
  ".mp3": "audio/mpeg",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const emptyStore = () => ({ users: [], wishes: [], logs: [], blockedDevices: [], blockedIps: [] });
mkdirSync(dataDir, { recursive: true });
let store = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : emptyStore();
for (const key of Object.keys(emptyStore())) store[key] ||= [];

function saveStore() {
  const temporary = `${dataFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  renameSync(temporary, dataFile);
}

function pruneLogs() {
  const retained = store.logs.filter((log) => Date.now() - Date.parse(log.at) < logRetentionDays * 86400000);
  if (retained.length !== store.logs.length) {
    store.logs = retained;
    saveStore();
  }
}

pruneLogs();
setInterval(pruneLogs, 86400000).unref();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getIp(req) {
  const forwarded = trustedProxyHeader && req.headers[trustedProxyHeader];
  const value = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
  return (value || "unknown").replace(/^::ffff:/, "").slice(0, 80);
}

function respond(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...(res.corsHeaders || {}),
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function cookieValue(req, key) {
  const entry = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  return entry ? decodeURIComponent(entry.slice(key.length + 1)) : "";
}

function adminSession(req) {
  const id = cookieValue(req, "tt_admin");
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  return session;
}

function addLog({ userId = null, ip, deviceId = null, page = "admin", action = "visit", detail = "" }) {
  store.logs.push({ id: randomBytes(12).toString("hex"), userId, ip, deviceId, page, action, detail, at: new Date().toISOString() });
  store.logs = store.logs.filter((log) => Date.now() - Date.parse(log.at) < logRetentionDays * 86400000);
}

function safeName(value) {
  return Array.from(String(value || "").trim()).slice(0, 40).join("") || "Bạn";
}

function maskedName(value) {
  const chars = Array.from(value || "Bạn");
  return chars.length < 3 ? `${chars[0] || "B"}***` : `${chars.slice(0, 3).join("")}***`;
}

function verifyTotp(secret, token) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]+$/.test(normalized)) return false;
  let bits = "";
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value < 0) return false;
    bits += value.toString(2).padStart(5, "0");
  }
  const keyBytes = bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) || [];
  if (!keyBytes.length || !/^\d{6}$/.test(String(token || ""))) return false;
  const key = Buffer.from(keyBytes);
  const supplied = Buffer.from(String(token));
  const step = Math.floor(Date.now() / 30000);
  for (let offset = -1; offset <= 1; offset += 1) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + offset));
    const digest = createHmac("sha1", key).update(counter).digest();
    const index = digest[digest.length - 1] & 0x0f;
    const code = ((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
    if (timingSafeEqual(supplied, Buffer.from(code))) return true;
  }
  return false;
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error("Yêu cầu quá lớn");
  }
  return text ? JSON.parse(text) : {};
}

function userFromDevice(deviceId) {
  return store.users.find((user) => user.devices.some((device) => device.id === deviceId));
}

function deviceIsBlocked(deviceId, ip) {
  return store.blockedDevices.includes(deviceId) || store.blockedIps.includes(ip);
}

function userSummary(user) {
  const wishes = store.wishes.filter((wish) => wish.userId === user.id);
  const ips = [...new Set(user.visits.map((visit) => visit.ip))];
  const sharedIp = ips.some((ip) => store.users.some((other) => other.id !== user.id && other.visits.some((visit) => visit.ip === ip)));
  const names = [...new Set((user.nameHistory || []).map((entry) => entry.name))];
  return {
    id: user.id,
    name: user.name,
    deviceId: user.devices.at(-1)?.id || "",
    devices: user.devices,
    fingerprint: user.devices.at(-1)?.fingerprint || "",
    ip: user.visits.at(-1)?.ip || "",
    ips,
    firstSeen: user.createdAt,
    lastSeen: user.lastSeen,
    visits: user.visitCount,
    totalBeads: user.totalBeads,
    wishes: wishes.length,
    names,
    sharedIp,
    blocked: user.devices.some((device) => store.blockedDevices.includes(device.id)) || ips.some((ip) => store.blockedIps.includes(ip)),
  };
}

async function handleApi(req, res, url) {
  const ip = getIp(req);
  const origin = req.headers.origin;
  let originHost = "";
  if (origin) {
    try { originHost = new URL(origin).host; } catch { return respond(res, 403, { error: "Nguồn yêu cầu không hợp lệ." }); }
  }
  const sameOrigin = origin && originHost === req.headers.host;
  if (origin && !sameOrigin && origin !== process.env.ALLOWED_ORIGIN) return respond(res, 403, { error: "Nguồn yêu cầu không hợp lệ." });
  if (origin && (sameOrigin || origin === process.env.ALLOWED_ORIGIN)) {
    res.corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }
  if (req.method === "OPTIONS") {
    if (!res.corsHeaders) return respond(res, 403, { error: "Nguồn yêu cầu không hợp lệ." });
    res.writeHead(204, res.corsHeaders);
    return res.end();
  }
  if (url.pathname.startsWith("/api/admin/") && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return respond(res, 403, { error: "Nguồn yêu cầu không hợp lệ." });
    } catch {
      return respond(res, 403, { error: "Nguồn yêu cầu không hợp lệ." });
    }
  }
  if (url.pathname === "/api/identify" && req.method === "POST") {
    const body = await readBody(req);
    if (body.consent !== true) return respond(res, 403, { error: "Cần đồng ý với chính sách quyền riêng tư trước khi đồng bộ." });
    const deviceId = String(body.deviceId || "").slice(0, 80);
    const fingerprint = String(body.fingerprint || "").slice(0, 128);
    if (!deviceId || !fingerprint) return respond(res, 400, { error: "Thiết bị chưa sẵn sàng." });
    if (deviceIsBlocked(deviceId, ip)) return respond(res, 403, { error: "Thiết bị này hiện không thể sử dụng dịch vụ." });

    let user = userFromDevice(deviceId) || store.users.find((candidate) => candidate.devices.some((device) => device.fingerprint === fingerprint));
    if (!user && body.name !== undefined) {
      user = {
        id: randomBytes(16).toString("hex"),
        name: safeName(body.name),
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        visitCount: 0,
        totalBeads: 0,
        dailyBeads: {},
        visits: [],
        devices: [],
        nameHistory: [],
      };
      store.users.push(user);
      user.nameHistory.push({ name: user.name, at: user.createdAt });
    } else if (user && body.name !== undefined) {
      const name = safeName(body.name);
      if (user.name !== name) user.nameHistory.push({ name, at: new Date().toISOString() });
      user.name = name;
    }

    const candidate = !user ? store.users.find((entry) => entry.visits.some((visit) => visit.ip === ip)) : null;
    if (!user) return respond(res, 200, { known: false, candidate: candidate ? { name: maskedName(candidate.name) } : null });

    let device = user.devices.find((entry) => entry.id === deviceId);
    if (!device) {
      device = { id: deviceId, fingerprint, userAgent: String(body.userAgent || "").slice(0, 300), language: String(body.language || "").slice(0, 40), screen: String(body.screen || "").slice(0, 40), timezone: String(body.timezone || "").slice(0, 80), firstSeen: new Date().toISOString() };
      user.devices.push(device);
    } else {
      device.fingerprint = fingerprint;
      device.userAgent = String(body.userAgent || device.userAgent).slice(0, 300);
      device.language = String(body.language || device.language).slice(0, 40);
      device.screen = String(body.screen || device.screen).slice(0, 40);
      device.timezone = String(body.timezone || device.timezone).slice(0, 80);
    }
    const now = new Date().toISOString();
    user.lastSeen = now;
    user.visitCount += 1;
    user.visits.push({ ip, at: now });
    user.visits = user.visits.slice(-500);
    addLog({ userId: user.id, ip, deviceId, page: "home", action: "visit" });
    saveStore();
    return respond(res, 200, { known: true, user: { name: user.name, totalBeads: user.totalBeads, todayBeads: user.dailyBeads[today()] || 0 } });
  }

  if (url.pathname === "/api/identify/confirm-ip" && req.method === "POST") {
    const body = await readBody(req);
    if (body.consent !== true) return respond(res, 403, { error: "Cần đồng ý với chính sách quyền riêng tư trước khi đồng bộ." });
    const deviceId = String(body.deviceId || "").slice(0, 80);
    const fingerprint = String(body.fingerprint || "").slice(0, 128);
    if (!deviceId || !fingerprint) return respond(res, 400, { error: "Thiết bị chưa sẵn sàng." });
    if (deviceIsBlocked(deviceId, ip)) return respond(res, 403, { error: "Thiết bị này hiện không thể sử dụng dịch vụ." });
    const candidate = store.users.find((entry) => entry.visits.some((visit) => visit.ip === ip));
    if (!candidate) return respond(res, 200, { known: false });
    let device = candidate.devices.find((entry) => entry.id === deviceId);
    if (!device) {
      device = { id: deviceId, fingerprint, userAgent: String(body.userAgent || "").slice(0, 300), language: String(body.language || "").slice(0, 40), screen: String(body.screen || "").slice(0, 40), timezone: String(body.timezone || "").slice(0, 80), firstSeen: new Date().toISOString() };
      candidate.devices.push(device);
    }
    const now = new Date().toISOString();
    candidate.lastSeen = now;
    candidate.visitCount += 1;
    candidate.visits.push({ ip, at: now });
    addLog({ userId: candidate.id, ip, deviceId, page: "home", action: "ip_confirmed" });
    saveStore();
    return respond(res, 200, { known: true, user: { name: candidate.name, totalBeads: candidate.totalBeads, todayBeads: candidate.dailyBeads[today()] || 0 } });
  }

  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/admin/") && url.pathname !== "/api/identify" && url.pathname !== "/api/identify/confirm-ip") {
    const body = req.method === "GET" ? {} : await readBody(req);
    const deviceId = String(body.deviceId || url.searchParams.get("deviceId") || "").slice(0, 80);
    const user = userFromDevice(deviceId);
    if (!user || deviceIsBlocked(deviceId, ip)) return respond(res, 401, { error: "Không tìm thấy hồ sơ thiết bị." });

    if (url.pathname === "/api/beads" && req.method === "POST") {
      const count = Math.max(0, Math.min(100000, Math.floor(Number(body.count) || 0)));
      const batchId = String(body.batchId || "").slice(0, 100);
      const requestedDate = String(body.date || "");
      const dateValue = new Date(`${requestedDate}T00:00:00.000Z`);
      const beadDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && !Number.isNaN(dateValue.valueOf()) && dateValue.toISOString().slice(0, 10) === requestedDate ? requestedDate : today();
      user.beadBatches ||= [];
      const alreadyProcessed = batchId && user.beadBatches.includes(batchId);
      if (!alreadyProcessed) {
        user.totalBeads += count;
        user.dailyBeads[beadDate] = (user.dailyBeads[beadDate] || 0) + count;
        if (batchId) user.beadBatches.push(batchId);
        user.beadBatches = user.beadBatches.slice(-2000);
      }
      user.lastSeen = new Date().toISOString();
      if (!alreadyProcessed) addLog({ userId: user.id, ip, deviceId, page: "meditation", action: "beads", detail: String(count) });
      saveStore();
      return respond(res, 200, { totalBeads: user.totalBeads, todayBeads: user.dailyBeads[today()] });
    }
    if (url.pathname === "/api/wishes" && req.method === "GET") {
      return respond(res, 200, { wishes: store.wishes.filter((wish) => wish.userId === user.id).sort((a, b) => b.at.localeCompare(a.at)) });
    }
    if (url.pathname === "/api/wishes" && req.method === "POST") {
      const text = String(body.text || "").trim();
      if (!text || Array.from(text).length > 200) return respond(res, 400, { error: "Điều ước cần có từ 1 đến 200 ký tự." });
      const clientId = String(body.clientId || "").slice(0, 100);
      const existing = clientId && store.wishes.find((wish) => wish.userId === user.id && wish.clientId === clientId);
      if (existing) return respond(res, 200, { wish: existing });
      const wish = { id: randomBytes(12).toString("hex"), userId: user.id, clientId, text, at: new Date().toISOString() };
      store.wishes.push(wish);
      addLog({ userId: user.id, ip, deviceId, page: "wishes", action: "wish" });
      saveStore();
      return respond(res, 201, { wish });
    }
    const wishMatch = url.pathname.match(/^\/api\/wishes\/([a-f0-9]+)$/);
    if (wishMatch && req.method === "DELETE") {
      const index = store.wishes.findIndex((wish) => wish.id === wishMatch[1] && wish.userId === user.id);
      if (index < 0) return respond(res, 404, { error: "Không tìm thấy điều ước." });
      store.wishes.splice(index, 1);
      saveStore();
      return respond(res, 200, { ok: true });
    }
    if (url.pathname === "/api/profile" && req.method === "PATCH") {
      const name = safeName(body.name);
      if (name !== user.name) user.nameHistory.push({ name, at: new Date().toISOString() });
      user.name = name;
      addLog({ userId: user.id, ip, deviceId, page: "profile", action: "rename" });
      saveStore();
      return respond(res, 200, { name });
    }
    if (url.pathname === "/api/visit" && req.method === "POST") {
      const page = ["meditate", "chant", "wishes", "settings"].includes(body.page) ? body.page : "home";
      addLog({ userId: user.id, ip, deviceId, page, action: "visit" });
      const now = new Date().toISOString();
      user.lastSeen = now;
      user.visitCount += 1;
      user.visits.push({ ip, at: now });
      user.visits = user.visits.slice(-500);
      saveStore();
      return respond(res, 200, { ok: true });
    }
    if (url.pathname === "/api/me" && req.method === "DELETE") {
      store.users = store.users.filter((entry) => entry.id !== user.id);
      store.wishes = store.wishes.filter((wish) => wish.userId !== user.id);
      store.logs = store.logs.filter((log) => log.userId !== user.id);
      saveStore();
      return respond(res, 200, { ok: true });
    }
    return respond(res, 404, { error: "Không tìm thấy chức năng." });
  }

  if (url.pathname === "/api/admin/login" && req.method === "POST") {
    const body = await readBody(req);
    const recent = attempts.get(ip) || { count: 0, until: 0 };
    if (recent.until > Date.now()) {
      addLog({ ip, action: "admin_login_failed", page: "admin", detail: "rate_limited" });
      saveStore();
      return respond(res, 429, { error: "Tạm khóa đăng nhập. Vui lòng thử lại sau." });
    }
    const passwordValid = Boolean(adminHash && await bcrypt.compare(String(body.password || ""), adminHash));
    const totpValid = !adminTotpSecret || verifyTotp(adminTotpSecret, body.totp);
    const success = Boolean(adminUsername && body.username === adminUsername && passwordValid && totpValid);
    addLog({ ip, action: success ? "admin_login_success" : "admin_login_failed", page: "admin" });
    if (!success) {
      recent.count += 1;
      if (recent.count >= 5) { recent.count = 0; recent.until = Date.now() + 15 * 60 * 1000; }
      attempts.set(ip, recent);
      saveStore();
      return respond(res, 401, { error: adminHash ? "Thông tin đăng nhập hoặc mã xác thực chưa đúng." : "Admin chưa được cấu hình trên máy chủ." });
    }
    attempts.delete(ip);
    const sessionId = randomBytes(32).toString("hex");
    sessions.set(sessionId, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    saveStore();
    return respond(res, 200, { ok: true }, { "Set-Cookie": `tt_admin=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}` });
  }
  if (url.pathname.startsWith("/api/admin/")) {
    if (url.pathname === "/api/admin/logout" && req.method === "POST") {
      sessions.delete(cookieValue(req, "tt_admin"));
      return respond(res, 200, { ok: true }, { "Set-Cookie": `tt_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}` });
    }
    if (!adminSession(req)) return respond(res, 401, { error: "Vui lòng đăng nhập quản trị." });
    if (url.pathname === "/api/admin/dashboard" && req.method === "GET") {
      const day = today();
      const visits = {};
      const beads = {};
      for (let offset = logRetentionDays - 1; offset >= 0; offset -= 1) {
        const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        visits[date] = 0; beads[date] = 0;
      }
      for (const log of store.logs) {
        const date = log.at.slice(0, 10);
        if (date in visits && log.action === "visit") visits[date] += 1;
        if (date in beads && log.action === "beads") beads[date] += Number(log.detail) || 0;
      }
      return respond(res, 200, {
        users: store.users.length,
        online: store.users.filter((user) => Date.now() - Date.parse(user.lastSeen) < 5 * 60000).length,
        newToday: store.users.filter((user) => user.createdAt.slice(0, 10) === day).length,
        beads: store.users.reduce((sum, user) => sum + user.totalBeads, 0),
        wishes: store.wishes.length,
        chart: Object.keys(visits).map((date) => ({ date, visits: visits[date], beads: beads[date] })),
      });
    }
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const sort = url.searchParams.get("sort") || "last";
      const all = store.users.map(userSummary)
        .filter((user) => `${user.name} ${user.deviceId} ${user.ips.join(" ")}`.toLowerCase().includes(query))
        .filter((user) => (!from || user.firstSeen.slice(0, 10) >= from) && (!to || user.firstSeen.slice(0, 10) <= to))
        .sort((a, b) => sort === "first" ? a.firstSeen.localeCompare(b.firstSeen) : sort === "beads" ? b.totalBeads - a.totalBeads : sort === "name" ? a.name.localeCompare(b.name, "vi") : b.lastSeen.localeCompare(a.lastSeen));
      return respond(res, 200, { users: all.slice((page - 1) * 50, page * 50), total: all.length });
    }
    if (url.pathname === "/api/admin/logs" && req.method === "GET") {
      return respond(res, 200, { logs: store.logs.slice(-200).reverse() });
    }
    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9]+)$/);
    if (userMatch && req.method === "GET") {
      const user = store.users.find((entry) => entry.id === userMatch[1]);
      if (!user) return respond(res, 404, { error: "Không tìm thấy người dùng." });
      return respond(res, 200, { user: { ...userSummary(user), visits: user.visits.slice(-100).reverse(), visitHistory: store.logs.filter((log) => log.userId === user.id).slice(-200).reverse(), nameHistory: user.nameHistory, wishes: store.wishes.filter((wish) => wish.userId === user.id).sort((a, b) => b.at.localeCompare(a.at)) } });
    }
    if (userMatch && req.method === "DELETE") {
      const user = store.users.find((entry) => entry.id === userMatch[1]);
      if (!user) return respond(res, 404, { error: "Không tìm thấy người dùng." });
      store.users = store.users.filter((entry) => entry.id !== user.id);
      store.wishes = store.wishes.filter((wish) => wish.userId !== user.id);
      store.logs = store.logs.filter((log) => log.userId !== user.id);
      saveStore();
      return respond(res, 200, { ok: true });
    }
    const blockMatch = url.pathname.match(/^\/api\/admin\/blocks\/(device|ip)$/);
    if (blockMatch && req.method === "POST") {
      const body = await readBody(req);
      const list = blockMatch[1] === "device" ? store.blockedDevices : store.blockedIps;
      const value = String(body.value || "").slice(0, 120);
      if (!value) return respond(res, 400, { error: "Thiếu giá trị cần chặn." });
      store[blockMatch[1] === "device" ? "blockedDevices" : "blockedIps"] = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
      saveStore();
      return respond(res, 200, { ok: true });
    }
    return respond(res, 404, { error: "Không tìm thấy chức năng quản trị." });
  }
  return respond(res, 404, { error: "Không tìm thấy API." });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname === "/admin" || url.pathname === "/admin/" ? "admin.html" : normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
    const file = join(publicDir, requested);
    if (!file.startsWith(`${publicDir}/`) || !existsSync(file)) return respond(res, 404, { error: "Không tìm thấy trang." });
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(readFileSync(file));
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!res.headersSent) respond(res, 500, { error: "Đã có lỗi xảy ra. Vui lòng thử lại." });
    else res.end();
  }
});

server.listen(port, () => {
  console.log(`Tĩnh Tâm đang chạy tại http://localhost:${port}`);
  if (!adminHash || !adminUsername) console.warn("Chưa cấu hình admin: đặt ADMIN_USERNAME và ADMIN_PASSWORD.");
});
