const $ = (selector) => document.querySelector(selector);
const login = $("#admin-login");
const panel = $("#admin-panel");
const toast = $("#admin-toast");
let currentPage = 1;
let searchTimer;
let toastTimer;
let dashboardData;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
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

function textCell(value, secondary = "") {
  const cell = document.createElement("td");
  cell.textContent = value || "—";
  if (secondary) {
    const small = document.createElement("small");
    small.textContent = secondary;
    cell.append(small);
  }
  return cell;
}

function displayDate(value) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function describeDevice(device) {
  const agent = device.userAgent || "";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Không rõ trình duyệt";
  const os = /Android/.test(agent) ? "Android" : /iPhone|iPad|iPod/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Mac OS/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "Không rõ hệ điều hành";
  const kind = /iPad|Tablet/.test(agent) ? "máy tính bảng" : /Mobi|iPhone|Android/.test(agent) ? "điện thoại" : "máy tính";
  return `${browser} · ${os} · ${kind}\n${device.screen || "Không rõ độ phân giải"} · ${device.language || "Không rõ ngôn ngữ"} · ${device.timezone || "Không rõ múi giờ"}\n${agent || "Không có user agent"}`;
}

async function loadPanel() {
  try {
    await loadDashboard();
    login.classList.add("hidden");
    panel.classList.remove("hidden");
    await loadUsers();
  } catch (error) {
    if (error.message !== "Vui lòng đăng nhập quản trị.") {
      $("#login-error").textContent = error.message;
    }
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username: $("#admin-user").value, password: $("#admin-pass").value, totp: $("#admin-totp").value }) });
    $("#admin-pass").value = "";
    $("#admin-totp").value = "";
    await loadPanel();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#admin-logout").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
    panel.classList.add("hidden");
    login.classList.remove("hidden");
  } catch (error) {
    showToast(error.message);
  }
});

async function loadDashboard() {
  dashboardData = await api("/api/admin/dashboard");
  const data = dashboardData;
  const metrics = [["Người dùng", data.users], ["Đang online", data.online], ["Mới hôm nay", data.newToday], ["Lượt gõ mõ", data.beads], ["Điều ước", data.wishes]];
  const grid = $("#stat-grid");
  grid.replaceChildren();
  for (const [label, value] of metrics) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const title = document.createElement("span");
    title.textContent = label;
    const total = document.createElement("strong");
    total.textContent = Number(value).toLocaleString("vi-VN");
    card.append(title, total);
    grid.append(card);
  }
  drawChart(data.chart);
}

function drawChart(daily) {
  const period = $("#chart-period").value;
  const points = new Map();
  for (const day of period === "day" ? daily.slice(-30) : daily) {
    let key = day.date;
    if (period === "week") {
      const date = new Date(`${day.date}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      key = date.toISOString().slice(0, 10);
    } else if (period === "month") {
      key = day.date.slice(0, 7);
    }
    const point = points.get(key) || { date: key, visits: 0, beads: 0 };
    point.visits += day.visits;
    point.beads += day.beads;
    points.set(key, point);
  }
  const data = [...points.values()];
  $("#chart-title").textContent = period === "day" ? "Hoạt động 30 ngày" : period === "week" ? "Hoạt động theo tuần" : "Hoạt động theo tháng";
  const chart = $("#chart");
  chart.replaceChildren();
  const maxVisits = Math.max(1, ...data.map((day) => day.visits));
  const maxBeads = Math.max(1, ...data.map((day) => day.beads));
  for (const day of data) {
    const column = document.createElement("div");
    column.className = "chart-day";
    column.title = `${day.date}: ${day.visits} lượt truy cập · ${day.beads} lượt gõ`;
    const visits = document.createElement("div");
    visits.className = "chart-bar visits";
    visits.style.height = `${Math.max(1, day.visits / maxVisits * 100)}%`;
    const beads = document.createElement("div");
    beads.className = "chart-bar";
    beads.style.height = `${Math.max(1, day.beads / maxBeads * 100)}%`;
    column.append(visits, beads);
    chart.append(column);
  }
}

function userQuery(page = currentPage) {
  const query = new URLSearchParams({
    q: $("#user-search").value.trim(),
    page: String(page),
    sort: $("#user-sort").value,
    from: $("#user-from").value,
    to: $("#user-to").value,
  });
  return `/api/admin/users?${query}`;
}

async function loadUsers(page = currentPage) {
  currentPage = page;
  try {
    const data = await api(userQuery(page));
    const table = $("#users-table");
    table.replaceChildren();
    $("#users-empty").classList.toggle("hidden", data.total > 0);
    for (const user of data.users) {
      const row = document.createElement("tr");
      const device = user.deviceId || "";
      const flags = [];
      if (user.sharedIp) flags.push("IP dùng chung");
      if (user.names.length > 1) flags.push("Thiết bị nhiều tên");
      if (user.blocked) flags.push("Đang chặn");
      row.append(
        textCell(user.name, flags.join(" · ")),
        textCell(device ? `${device.slice(0, 10)}…` : "", `${user.devices.length} thiết bị`),
        textCell(user.devices.length ? describeDevice(user.devices.at(-1)).split("\n")[0] : "—"),
        textCell(user.fingerprint ? user.fingerprint.slice(0, 12) : "—"),
        textCell(user.ip, `${user.ips.length} IP`),
        textCell(String(user.ips.length)),
        textCell(displayDate(user.firstSeen)),
        textCell(displayDate(user.lastSeen)),
        textCell(Number(user.visits).toLocaleString("vi-VN")),
        textCell(Number(user.totalBeads).toLocaleString("vi-VN")),
        textCell(String(user.wishes)),
      );
      const actions = document.createElement("td");
      const detail = document.createElement("button");
      detail.className = "table-action";
      detail.textContent = "Chi tiết";
      detail.addEventListener("click", () => loadUserDetail(user.id));
      const deleteButton = document.createElement("button");
      deleteButton.className = "table-action danger";
      deleteButton.textContent = "Xoá";
      deleteButton.addEventListener("click", () => deleteUser(user.id));
      actions.append(detail, deleteButton);
      row.append(actions);
      table.append(row);
    }
    $("#page-label").textContent = `${data.total ? (page - 1) * 50 + 1 : 0}–${Math.min(page * 50, data.total)} / ${data.total}`;
    $("#page-prev").disabled = page <= 1;
    $("#page-next").disabled = page * 50 >= data.total;
  } catch (error) {
    showToast(error.message);
  }
}

async function loadUserDetail(id) {
  try {
    const { user } = await api(`/api/admin/users/${encodeURIComponent(id)}`);
    const detail = $("#user-detail");
    detail.replaceChildren();
    detail.classList.remove("hidden");
    const heading = document.createElement("div");
    heading.className = "section-title";
    const title = document.createElement("h2");
    title.textContent = `Chi tiết: ${user.name}`;
    const close = document.createElement("button");
    close.className = "table-action";
    close.textContent = "Đóng";
    close.addEventListener("click", () => detail.classList.add("hidden"));
    heading.append(title, close);
    detail.append(heading);
    const summary = document.createElement("p");
    summary.className = "detail-summary";
    summary.textContent = `Ngày đầu: ${displayDate(user.firstSeen)} · Truy cập gần nhất: ${displayDate(user.lastSeen)} · ${user.visits.length} lượt gần đây`;
    detail.append(summary);
    const info = document.createElement("div");
    info.className = "detail-info";
    const fields = [
      ["Thiết bị · trình duyệt · hệ điều hành", user.devices.map((item) => `${item.id}\n${describeDevice(item)}`).join("\n\n")],
      ["Fingerprint rút gọn", user.fingerprint ? user.fingerprint.slice(0, 16) : "—"],
      ["IP từng dùng", user.ips.join(", ") || "—"],
      ["Vị trí ước lượng", "Không tra cứu vị trí IP để tránh gửi IP cho dịch vụ bên thứ ba."],
      ["Lịch sử tên", (user.nameHistory || []).map((entry) => `${entry.name} · ${displayDate(entry.at)}`).join("\n") || "—"],
      ["Điều ước riêng tư", (user.wishes || []).map((wish) => `${displayDate(wish.at)} — ${wish.text}`).join("\n") || "Chưa có điều ước"],
      ["Lịch sử truy cập và hoạt động", (user.visitHistory || []).map((entry) => `${displayDate(entry.at)} · ${entry.ip} · ${entry.page} · ${entry.action}${entry.detail ? ` (${entry.detail})` : ""}`).join("\n") || "—"],
    ];
    for (const [label, value] of fields) {
      const field = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = label;
      const content = document.createElement("pre");
      content.textContent = value;
      field.append(strong, content);
      info.append(field);
    }
    detail.append(info);
    const blockActions = document.createElement("div");
    blockActions.className = "detail-actions";
    for (const device of user.devices) {
      const button = document.createElement("button");
      button.className = "button button-outline button-small";
      button.textContent = `Chặn/bỏ chặn thiết bị ${device.id.slice(0, 8)}`;
      button.addEventListener("click", () => toggleBlock("device", device.id));
      blockActions.append(button);
    }
    for (const ip of user.ips) {
      const button = document.createElement("button");
      button.className = "button button-outline button-small";
      button.textContent = `Chặn/bỏ chặn IP ${ip}`;
      button.addEventListener("click", () => toggleBlock("ip", ip));
      blockActions.append(button);
    }
    detail.append(blockActions);
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleBlock(type, value) {
  try {
    await api(`/api/admin/blocks/${type}`, { method: "POST", body: JSON.stringify({ value }) });
    showToast("Đã cập nhật trạng thái chặn.");
    await loadUsers();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteUser(id) {
  if (!window.confirm("Xoá hồ sơ, điều ước và nhật ký liên quan? Thao tác này không thể hoàn tác.")) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("Đã xoá người dùng.");
    await loadUsers();
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function exportCsv() {
  try {
    const first = await api(userQuery(1));
    const pages = Math.ceil(first.total / 50);
    const all = first.users.slice();
    for (let page = 2; page <= pages; page += 1) all.push(...(await api(userQuery(page))).users);
    const rows = [["Tên", "Device ID", "Trình duyệt và thiết bị", "Fingerprint", "IP gần nhất", "Danh sách IP", "Lần đầu", "Lần cuối", "Lượt truy cập", "Lượt gõ mõ", "Điều ước"]];
    for (const user of all) rows.push([user.name, user.deviceId, user.devices.map((device) => describeDevice(device)).join("\n\n"), user.fingerprint, user.ip, user.ips.join(", "), user.firstSeen, user.lastSeen, user.visits, user.totalBeads, user.wishes]);
    const csv = `\uFEFF${rows.map((row) => row.map((field) => {
      let value = String(field ?? "");
      if (/^[\t\r=+\-@]/.test(value)) value = `'${value}`;
      return `"${value.replaceAll('"', '""')}"`;
    }).join(",")).join("\r\n")}`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "tinh-tam-nguoi-dung.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    showToast(error.message);
  }
}

$("#export-users").addEventListener("click", exportCsv);
$("#chart-period").addEventListener("change", () => { if (dashboardData) drawChart(dashboardData.chart); });
$("#user-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadUsers(1), 250);
});
["user-from", "user-to", "user-sort"].forEach((id) => $(`#${id}`).addEventListener("change", () => loadUsers(1)));
$("#page-prev").addEventListener("click", () => loadUsers(Math.max(1, currentPage - 1)));
$("#page-next").addEventListener("click", () => loadUsers(currentPage + 1));

document.querySelectorAll(".admin-tabs button").forEach((button) => {
  button.addEventListener("click", async () => {
    document.querySelectorAll(".admin-tabs button").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".admin-view").forEach((view) => view.classList.toggle("hidden", view.id !== `admin-${button.dataset.adminTab}`));
    if (button.dataset.adminTab === "users") await loadUsers();
    if (button.dataset.adminTab === "logs") await loadLogs();
    if (button.dataset.adminTab === "overview") await loadDashboard();
  });
});

async function loadLogs() {
  try {
    const { logs } = await api("/api/admin/logs");
    const table = $("#logs-table");
    table.replaceChildren();
    const actionNames = { visit: "Truy cập", beads: "Gõ mõ", wish: "Gửi điều ước", rename: "Đổi tên", ip_confirmed: "Xác nhận IP", admin_login_success: "Admin đăng nhập", admin_login_failed: "Admin đăng nhập thất bại" };
    for (const log of logs) {
      const row = document.createElement("tr");
      row.append(textCell(displayDate(log.at)), textCell(log.ip), textCell(log.deviceId ? `${log.deviceId.slice(0, 12)}…` : "—"), textCell(log.page), textCell(actionNames[log.action] || log.action, log.detail));
      table.append(row);
    }
  } catch (error) {
    showToast(error.message);
  }
}

loadPanel();
