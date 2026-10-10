// ---------------------------------------------------------------------------
// Admin & Staff Portal — 4-Column Live Board, Multilingual CRUD & Staff Views
// ---------------------------------------------------------------------------
let editingItemId = null;
let editingItemFullTranslations = null;
let refreshTimer = null;
let liveTickerTimer = null;
let pendingImageBase64 = null;
let currentTodayDateKey = "";
let knownOrderIds = new Set();
let soundEnabled = true;
let currentCsrfToken = "";
let currentUser = null;
let staffListCache = [];
let pendingAdminCancelOrderId = null;

const PLACEHOLDER_IMG = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22100%22%20height%3D%22100%22%20viewBox%3D%220%200%20100%20100%22%3E%3Crect%20fill%3D%22%23e9eae2%22%20width%3D%22100%22%20height%3D%22100%22%20viewBox%3D%220%200%20100%20100%22%3E%3Ctext%20fill%3D%22%237c877e%22%20font-family%3D%22sans-serif%22%20font-size%3D%2212%22%20dy%3D%224%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3E%F0%9F%8D%BD%EF%B8%8F%3C%2Ftext%3E%3C%2Fsvg%3E";

function formatPrice(amount) {
  const num = Number(amount) || 0;
  const formatted = num % 1 === 0 ? num : num.toFixed(2);
  return `${formatted} ETB`;
}

function getItemEnglishName(item) {
  if (!item) return "";
  if (item.translations && item.translations.en && item.translations.en.name) {
    return item.translations.en.name;
  }
  if (typeof item.name === "object") return item.name.en || Object.values(item.name)[0] || "";
  return String(item.name || "");
}

function getItemEnglishDesc(item) {
  if (!item) return "";
  if (item.translations && item.translations.en && item.translations.en.description) {
    return item.translations.en.description;
  }
  if (typeof item.description === "object") return item.description.en || Object.values(item.description)[0] || "";
  return String(item.description || "");
}

function getItemEnglishIngredients(item) {
  if (!item) return "";
  if (item.translations && item.translations.en && Array.isArray(item.translations.en.ingredients)) {
    return item.translations.en.ingredients.join(", ");
  }
  if (Array.isArray(item.ingredients)) return item.ingredients.join(", ");
  if (typeof item.ingredients === "object") {
    const list = item.ingredients.en || Object.values(item.ingredients)[0] || [];
    return Array.isArray(list) ? list.join(", ") : "";
  }
  return "";
}

async function api(path, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(currentCsrfToken ? { "x-csrf-token": currentCsrfToken } : {}),
    ...(opts.headers || {}),
  };

  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 401 && path !== "/api/admin/login") {
    logout(false);
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Request failed");
  }
  if (res.status === 204) return null;
  return res.json();
}

function playOrderChime() {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now);
    osc1.frequency.setValueAtTime(880, now + 0.12);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc1.connect(gain);
    gain.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);
  } catch (e) {}
}

function userHasPermission(perm) {
  if (!currentUser || !currentUser.permissions) return false;
  return currentUser.permissions.includes(perm);
}

function applyRoleBasedUI() {
  if (!currentUser) return;

  document.querySelectorAll("#navTabs .tab-btn").forEach((btn) => {
    const reqPerm = btn.dataset.perm;
    if (!reqPerm || userHasPermission(reqPerm)) {
      btn.style.display = "inline-block";
    } else {
      btn.style.display = "none";
    }
  });

  // Hide any non-tab element (e.g. Export Excel) the user lacks permission for
  document.querySelectorAll("[data-perm]:not(#navTabs .tab-btn)").forEach((el) => {
    // setProperty(..., "important") is needed: CSS like .excel-export-btn uses
    // display: inline-flex !important, which a plain inline style cannot override.
    if (userHasPermission(el.dataset.perm)) {
      el.style.removeProperty("display");
    } else {
      el.style.setProperty("display", "none", "important");
    }
  });

  const activeBtn = document.querySelector("#navTabs .tab-btn.active");
  if (activeBtn && activeBtn.style.display === "none") {
    const firstVisible = Array.from(document.querySelectorAll("#navTabs .tab-btn")).find((b) => b.style.display !== "none");
    if (firstVisible) firstVisible.click();
  }
}

function showApp(user, csrfToken) {
  currentUser = user;
  currentCsrfToken = csrfToken || currentCsrfToken;

  document.getElementById("loginWrap").style.display = "none";
  document.getElementById("adminApp").style.display = "block";

  if (user) {
    const roleBadge = document.getElementById("activeUserBadge");
    roleBadge.textContent = `👤 ${user.fullName || user.username} (${user.role})`;
  }

  applyRoleBasedUI();
  loadTodayOrders(true);

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadTodayOrders(false), 3500);

  if (liveTickerTimer) clearInterval(liveTickerTimer);
  liveTickerTimer = setInterval(updateLiveTimersOnScreen, 10000);
}

async function logout(callApi = true) {
  if (callApi) {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch (e) {}
  }
  clearInterval(refreshTimer);
  clearInterval(liveTickerTimer);
  currentCsrfToken = "";
  currentUser = null;
  knownOrderIds.clear();
  document.getElementById("adminApp").style.display = "none";
  document.getElementById("loginWrap").style.display = "block";
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.classList.remove("show");

  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    showApp(data.user, data.csrfToken);
  } catch (err) {
    errorEl.textContent = err.message || "Invalid username or password.";
    errorEl.classList.add("show");
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => logout(true));

const soundBtn = document.getElementById("soundToggleBtn");
if (soundBtn) {
  soundBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    soundBtn.textContent = soundEnabled ? "🔔 Sound ON" : "🔕 Sound OFF";
    soundBtn.classList.toggle("muted", !soundEnabled);
  });
}

document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;

    document.getElementById("todayTab").style.display = tab === "today" ? "block" : "none";
    document.getElementById("historyTab").style.display = tab === "history" ? "block" : "none";
    document.getElementById("menuTab").style.display = tab === "menu" ? "block" : "none";
    document.getElementById("staffTab").style.display = tab === "staff" ? "block" : "none";
    document.getElementById("auditTab").style.display = tab === "audit" ? "block" : "none";
    document.getElementById("securityTab").style.display = tab === "security" ? "block" : "none";

    if (tab === "today") loadTodayOrders(false);
    if (tab === "history") loadHistoryOrders();
    if (tab === "menu") loadMenu();
    if (tab === "staff") loadStaffList();
    if (tab === "audit") loadAuditLogs();
  });
});

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add("show");
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove("show");
}
document.querySelectorAll("[data-modal-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.modalClose));
});

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMins = Math.floor(ms / 60000);
  if (totalMins < 1) return "just now";
  if (totalMins < 60) return `${totalMins} min`;

  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}

function getOrderTimingInfo(order) {
  const now = Date.now();

  if (order.status === "pending") {
    const pendingTime = new Date(order.pendingAt || order.createdAt).getTime();
    const elapsedMs = Math.max(0, now - pendingTime);
    return {
      status: "pending",
      badgeText: "🟡 PENDING",
      timerLabel: "Received",
      elapsedText: formatDuration(elapsedMs),
      rawTimestamp: order.pendingAt || order.createdAt,
      timeStr: order.pendingTimeStr || order.orderTime,
    };
  }

  if (order.status === "accepted") {
    const acceptedTime = new Date(order.acceptedAt || order.updatedAt || order.createdAt).getTime();
    const elapsedMs = Math.max(0, now - acceptedTime);
    return {
      status: "accepted",
      badgeText: "🔵 IN PROGRESS",
      timerLabel: "Accepted",
      elapsedText: formatDuration(elapsedMs),
      rawTimestamp: order.acceptedAt,
      timeStr: order.acceptedTimeStr || order.orderTime,
    };
  }

  if (order.status === "served" || order.status === "paid") {
    const pendingStart = new Date(order.pendingAt || order.createdAt).getTime();
    const acceptedStart = order.acceptedAt ? new Date(order.acceptedAt).getTime() : pendingStart;
    const servedEnd = order.servedAt ? new Date(order.servedAt).getTime() : new Date(order.updatedAt || order.createdAt).getTime();

    const pendingDuration = formatDuration(Math.max(0, acceptedStart - pendingStart));
    const inProgressDuration = formatDuration(Math.max(0, servedEnd - acceptedStart));
    const totalDuration = formatDuration(Math.max(0, servedEnd - pendingStart));

    return {
      status: "served",
      badgeText: "🟢 SERVED",
      servedAtStr: order.servedTimeStr || order.orderTime,
      pendingDuration,
      inProgressDuration,
      totalDuration,
      isCompleted: true,
    };
  }

  if (order.status === "cancelled") {
    return {
      status: "cancelled",
      badgeText: "🔴 CANCELLED",
      cancelledAtStr: order.cancelledTimeStr || order.orderTime,
      cancelledByName: order.cancelledByName || "Staff",
      cancelledByRole: order.cancelledByRole || "STAFF",
      cancellationReason: order.cancellationReason || "Cancelled",
      isCompleted: true,
    };
  }

  return {
    status: order.status,
    badgeText: String(order.status).toUpperCase(),
    elapsedText: "",
  };
}

// ---------- 1. TODAY'S LIVE DASHBOARD ----------

async function loadTodayOrders(isInitial = false) {
  try {
    const data = await api("/api/admin/orders/today");

    if (currentTodayDateKey && currentTodayDateKey !== data.dateKey) {
      knownOrderIds.clear();
    }
    currentTodayDateKey = data.dateKey;
    if (data.csrfToken) currentCsrfToken = data.csrfToken;

    if (data.user) {
      currentUser = data.user;
      applyRoleBasedUI();
    }

    const dateHeader = document.getElementById("currentDateHeader");
    if (dateHeader) dateHeader.textContent = `📍 Addis Ababa · ${data.todayFormatted}`;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setVal("statPending", data.summary.pending);
    setVal("statAccepted", data.summary.accepted);
    setVal("statServed", data.summary.served);
    setVal("statTotalCount", data.summary.totalCount);
    setVal("statTotalRev", formatPrice(data.summary.totalRevenue));

    setVal("pillPending", data.summary.pending);
    setVal("pillAccepted", data.summary.accepted);
    setVal("pillServed", data.summary.served);
    setVal("pillCancelled", data.summary.cancelled);

    const pendingOrders = data.orders.filter((o) => o.status === "pending");
    let hasNewArrival = false;

    pendingOrders.forEach((o) => {
      if (!knownOrderIds.has(o.id)) {
        if (!isInitial) hasNewArrival = true;
        knownOrderIds.add(o.id);
      }
    });

    if (hasNewArrival) playOrderChime();

    const acceptedOrders = data.orders.filter((o) => o.status === "accepted");
    const servedOrders = data.orders.filter((o) => o.status === "served" || o.status === "paid");
    const cancelledOrders = data.orders.filter((o) => o.status === "cancelled");

    renderColumn("colPending", pendingOrders, "pending");
    renderColumn("colAccepted", acceptedOrders, "accepted");
    renderColumn("colServed", servedOrders, "served");
    renderColumn("colCancelled", cancelledOrders, "cancelled");
  } catch (err) {
    console.error("Error loading today's orders:", err);
  }
}

function renderColumn(elId, orders, type) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (orders.length === 0) {
    el.innerHTML = '<p class="empty-note" style="padding:24px 0;">No orders in this column</p>';
    return;
  }

  el.innerHTML = orders
    .map((o, idx) => {
      const orderNum = o.dailyOrderNumber || `#${String(o.dailySeq || 1).padStart(3, "0")}`;
      const customerDisplay = o.customerName || `Guest (${o.customerId ? o.customerId.slice(-4) : "—"})`;
      const timing = getOrderTimingInfo(o);
      const isNextPriority = type === "pending" && idx === 0;

      let actionButtons = "";
      if (type === "pending" && userHasPermission("ACCEPT_ORDERS")) {
        actionButtons = `
          <div class="oc-actions">
            <button class="oc-btn-accept" data-order="${o.id}" data-action="accept">✓ Accept / In Progress</button>
            ${userHasPermission("CANCEL_ORDERS") ? `<button class="oc-btn-cancel" data-order="${o.id}" data-action="cancel" data-order-num="${orderNum}" data-cust-name="${customerDisplay}" data-table-num="${o.tableNumber}">✕ Cancel</button>` : ""}
          </div>
        `;
      } else if (type === "accepted" && userHasPermission("SERVE_ORDERS")) {
        actionButtons = `
          <div class="oc-actions">
            <button class="oc-btn-serve" data-order="${o.id}" data-action="serve">✓ Mark Served</button>
            ${userHasPermission("CANCEL_ORDERS") ? `<button class="oc-btn-cancel" data-order="${o.id}" data-action="cancel" data-order-num="${orderNum}" data-cust-name="${customerDisplay}" data-table-num="${o.tableNumber}">✕ Cancel</button>` : ""}
          </div>
        `;
      }

      let staffSignature = "";
      if (o.acceptedByName) {
        staffSignature += `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:4px;">Accepted by: <strong>${escapeHtml(o.acceptedByName)}</strong> (${escapeHtml(o.acceptedByRole || "STAFF")})</div>`;
      }
      if (o.servedByName) {
        staffSignature += `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:2px;">Served by: <strong>${escapeHtml(o.servedByName)}</strong> (${escapeHtml(o.servedByRole || "STAFF")})</div>`;
      }

      let specialRequestHtml = "";
      const srEnglish = o.specialRequest?.staffEnglish || o.customerSuggestion;
      const srOriginal = o.specialRequest?.originalText;
      const srLang = o.specialRequest?.originalLanguage || o.customerLanguage;

      if (srEnglish && srEnglish.trim()) {
        const showOriginalDiff = srOriginal && srOriginal.trim() !== srEnglish.trim() && srLang && srLang !== "en";
        specialRequestHtml = `
          <div class="oc-special-request">
            <div class="oc-sr-title">💬 SPECIAL REQUEST:</div>
            <div class="oc-sr-text">"${escapeHtml(srEnglish.trim())}"</div>
            ${showOriginalDiff ? `<div style="font-size:11px;color:#92400e;margin-top:3px;opacity:0.85;">Original (${srLang.toUpperCase()}): "${escapeHtml(srOriginal.trim())}"</div>` : ""}
          </div>
        `;
      }

      let feedbackDisplayHtml = "";
      if (o.feedback) {
        const starsText = o.feedback.rating ? "⭐".repeat(o.feedback.rating) : "💬 Written Feedback";
        const ratingScore = o.feedback.rating ? ` (${o.feedback.rating}/5)` : "";
        feedbackDisplayHtml = `
          <div class="oc-feedback-badge">
            <div class="oc-fb-stars">${starsText} <strong>${ratingScore}</strong></div>
            ${o.feedback.comment ? `<div class="oc-fb-comment">"${escapeHtml(o.feedback.comment)}"</div>` : ""}
            <div class="oc-fb-time">${escapeHtml(o.feedback.submittedTimeStr || "")}</div>
          </div>
        `;
      }

      let timingHtml = "";
      if (type === "cancelled") {
        timingHtml = `
          <div class="cancelled-meta">
            <div class="cancelled-meta-row">
              <span class="cancelled-meta-label">Cancelled by:</span>
              <span><strong>${escapeHtml(o.cancelledByName || "Staff")}</strong> (${escapeHtml(o.cancelledByRole || "STAFF")})</span>
            </div>
            <div class="cancelled-meta-row">
              <span class="cancelled-meta-label">Reason:</span>
              <span style="color:#991b1b;font-style:italic;">"${escapeHtml(o.cancellationReason || "No reason specified")}"</span>
            </div>
            <div class="cancelled-meta-row">
              <span class="cancelled-meta-label">Time:</span>
              <span>${escapeHtml(o.cancelledTimeStr || o.orderTime || "")}</span>
            </div>
          </div>
        `;
      } else if (timing.isCompleted) {
        timingHtml = `
          <div class="oc-served-breakdown">
            <div class="served-at-line">✓ Served at <strong>${escapeHtml(timing.servedAtStr)}</strong></div>
            <div class="breakdown-pills">
              <span>Pending: <strong>${timing.pendingDuration}</strong></span>
              <span>In Progress: <strong>${timing.inProgressDuration}</strong></span>
              <span>Total: <strong>${timing.totalDuration}</strong></span>
            </div>
            ${staffSignature}
          </div>
        `;
      } else {
        timingHtml = `
          <div class="oc-timer-badge">
            <span class="timer-clock">⏱️</span>
            <span>${timing.timerLabel}: <strong class="live-timer-val" data-timestamp="${timing.rawTimestamp}">${timing.elapsedText}</strong> (${escapeHtml(timing.timeStr)})</span>
          </div>
          ${staffSignature}
        `;
      }

      return `
        <div class="order-card ${type === "cancelled" ? "cancelled-order-card" : ""} status-${o.status} ${isNextPriority ? "next-priority-order" : ""}">
          ${isNextPriority ? '<div class="new-order-banner">🔔 NEXT ORDER TO PREPARE</div>' : ""}
          <div class="oc-header">
            <div class="oc-num-badge">${escapeHtml(orderNum)}</div>
            <span class="status-pill status-${o.status}">${timing.badgeText}</span>
          </div>

          ${timingHtml}

          <div class="oc-info-grid">
            <div>👤 <strong>Customer:</strong> ${escapeHtml(customerDisplay)}</div>
            <div>🪑 <strong>Table:</strong> <span class="oc-table-chip">${escapeHtml(o.tableNumber)}</span></div>
          </div>

          ${specialRequestHtml}
          ${feedbackDisplayHtml}

          <div class="oc-items">
            <ul>
              ${o.items
                .map(
                  (l) => `
                <li>
                  <span class="oc-item-qty">${l.qty} ×</span>
                  <span class="oc-item-name">${escapeHtml(l.name)}</span>
                  <span class="oc-item-price">${formatPrice(l.price * l.qty)}</span>
                </li>`
                )
                .join("")}
            </ul>
          </div>

          <div class="oc-total-row">
            <span>Total:</span>
            <span>${formatPrice(o.total)}</span>
          </div>

          ${actionButtons}
        </div>
      `;
    })
    .join("");

  el.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.order;
      const action = btn.dataset.action;

      if (action === "cancel") {
        openAdminCancellationModal({
          id: orderId,
          orderNum: btn.dataset.orderNum || "Order",
          customerName: btn.dataset.custName || "Customer",
          tableNumber: btn.dataset.tableNum || "—",
        });
        return;
      }

      btn.disabled = true;
      btn.textContent = "Updating...";
      try {
        await api(`/api/admin/orders/${orderId}/${action}`, { method: "POST" });
        loadTodayOrders(false);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

function openAdminCancellationModal(order) {
  pendingAdminCancelOrderId = order.id;
  const titleEl = document.getElementById("adminCancelTitle");
  const descEl = document.getElementById("adminCancelDesc");
  const reasonInput = document.getElementById("adminCancelReasonInput");
  const confirmBtn = document.getElementById("adminConfirmCancelBtn");

  if (titleEl) titleEl.textContent = `⚠️ Cancel ${order.orderNum}?`;
  if (descEl) descEl.textContent = `Customer: ${order.customerName} · Table: ${order.tableNumber}. Are you sure you want to cancel this order?`;
  if (reasonInput) reasonInput.value = "";
  if (confirmBtn) confirmBtn.disabled = true;

  const modal = document.getElementById("adminCancelOrderModal");
  if (modal) modal.style.display = "grid";
}

function closeAdminCancellationModal() {
  pendingAdminCancelOrderId = null;
  const modal = document.getElementById("adminCancelOrderModal");
  if (modal) modal.style.display = "none";
}

const adminCancelReasonInput = document.getElementById("adminCancelReasonInput");
const adminConfirmCancelBtn = document.getElementById("adminConfirmCancelBtn");

if (adminCancelReasonInput && adminConfirmCancelBtn) {
  adminCancelReasonInput.addEventListener("input", () => {
    adminConfirmCancelBtn.disabled = adminCancelReasonInput.value.trim().length === 0;
  });
}

const adminKeepOrderBtn = document.getElementById("adminKeepOrderBtn");
if (adminKeepOrderBtn) {
  adminKeepOrderBtn.addEventListener("click", closeAdminCancellationModal);
}

if (adminConfirmCancelBtn) {
  adminConfirmCancelBtn.addEventListener("click", async () => {
    if (!pendingAdminCancelOrderId) return;
    const reason = (adminCancelReasonInput?.value || "").trim();
    if (!reason) return;

    adminConfirmCancelBtn.disabled = true;
    adminConfirmCancelBtn.textContent = "Cancelling...";

    try {
      await api(`/api/admin/orders/${pendingAdminCancelOrderId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      closeAdminCancellationModal();
      loadTodayOrders(false);
    } catch (err) {
      alert(err.message);
    } finally {
      adminConfirmCancelBtn.disabled = false;
      adminConfirmCancelBtn.textContent = "Confirm Cancellation";
    }
  });
}

function updateLiveTimersOnScreen() {
  document.querySelectorAll(".live-timer-val[data-timestamp]").forEach((el) => {
    const raw = el.dataset.timestamp;
    if (raw) {
      const diff = Math.max(0, Date.now() - new Date(raw).getTime());
      el.textContent = formatDuration(diff);
    }
  });
}

// ---------- 2. ORDER HISTORY & PRECISE DATE-TIME REPORT ----------

function buildReportFilterParams() {
  const fromDateTime = (document.getElementById("histFromDateTime")?.value || "").trim();
  const toDateTime = (document.getElementById("histToDateTime")?.value || "").trim();
  const status = document.getElementById("histStatus")?.value || "all";
  const staffRole = document.getElementById("histStaffRole")?.value || "all";
  const search = (document.getElementById("histSearch")?.value || "").trim();

  const params = new URLSearchParams();
  if (fromDateTime) params.set("fromDateTime", fromDateTime);
  if (toDateTime) params.set("toDateTime", toDateTime);
  if (status && status !== "all") params.set("status", status);
  if (staffRole && staffRole !== "all") params.set("staffRole", staffRole);
  if (search) params.set("search", search);

  return { params, fromDateTime, toDateTime };
}

async function loadHistoryOrders() {
  const { params, fromDateTime, toDateTime } = buildReportFilterParams();

  if (fromDateTime && toDateTime) {
    const startMs = new Date(fromDateTime).getTime();
    const endMs = new Date(toDateTime).getTime();
    if (startMs > endMs) {
      alert("⚠️ Start Date & Time cannot be later than End Date & Time. Please adjust your range.");
      return;
    }
  }

  const container = document.getElementById("historyOrdersList");
  if (container) {
    container.innerHTML = `<p class="empty-note">Loading order history${userHasPermission("EXPORT_REPORTS") ? " & sales report" : ""}...</p>`;
  }

  try {
    const data = await api(`/api/admin/orders/history?${params.toString()}`);
    
    // Update Sales Summary KPIs
    const setElText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setElText("histKpiTotalOrders", data.totalOrders || 0);
    setElText("histKpiGrossSales", `${formatPrice(data.grossOrderValue || data.totalRevenue || 0)} Gross`);
    setElText("histKpiCompletedSales", formatPrice(data.completedSales || 0));
    setElText("histKpiServedOrders", `${data.counts?.served || 0} served / paid`);
    setElText("histKpiCancelledValue", formatPrice(data.cancelledValue || 0));
    setElText("histKpiCancelledOrders", `${data.counts?.cancelled || 0} cancelled`);
    setElText("histKpiActiveOrders", (data.counts?.pending || 0) + (data.counts?.accepted || 0));
    setElText("histKpiActiveBreakdown", `${data.counts?.pending || 0} pending · ${data.counts?.accepted || 0} in prep`);

    const summaryEl = document.getElementById("historyResultsSummary");
    if (summaryEl) {
      summaryEl.textContent = `Found ${data.totalOrders} order(s) · Completed Sales: ${formatPrice(data.completedSales || 0)} · Cancelled Value: ${formatPrice(data.cancelledValue || 0)}`;
    }

    if (!data.orders || data.orders.length === 0) {
      if (container) {
        container.innerHTML = '<p class="empty-note">No orders found matching your search and date/time criteria.</p>';
      }
      return;
    }

    if (container) {
      container.innerHTML = data.orders
        .map((o) => {
          const orderNum = o.dailyOrderNumber || `#${String(o.dailySeq || 1).padStart(3, "0")}`;
          const customerDisplay = o.customerName || `Guest (${o.customerId ? o.customerId.slice(-4) : "—"})`;
          const timing = getOrderTimingInfo(o);

          let staffInfo = "";
          if (o.acceptedByName) staffInfo += `<div>Accepted by: <strong>${escapeHtml(o.acceptedByName)}</strong> (${escapeHtml(o.acceptedByRole || "STAFF")})</div>`;
          if (o.servedByName) staffInfo += `<div>Served by: <strong>${escapeHtml(o.servedByName)}</strong> (${escapeHtml(o.servedByRole || "STAFF")})</div>`;
          if (o.cancelledByName) staffInfo += `<div>Cancelled by: <strong>${escapeHtml(o.cancelledByName)}</strong> (${escapeHtml(o.cancelledByRole || "STAFF")})</div>`;
          if (o.cancellationReason) staffInfo += `<div style="color:var(--red);font-style:italic;">Reason: <strong>${escapeHtml(o.cancellationReason)}</strong></div>`;

          let specialRequestHtml = "";
          const srEnglish = o.specialRequest?.staffEnglish || o.customerSuggestion;
          const srOriginal = o.specialRequest?.originalText;
          const srLang = o.specialRequest?.originalLanguage || o.customerLanguage;

          if (srEnglish && srEnglish.trim()) {
            const showOriginalDiff = srOriginal && srOriginal.trim() !== srEnglish.trim() && srLang && srLang !== "en";
            specialRequestHtml = `
              <div class="oc-special-request" style="margin-top:8px;">
                <div class="oc-sr-title">💬 SPECIAL REQUEST:</div>
                <div class="oc-sr-text">"${escapeHtml(srEnglish.trim())}"</div>
                ${showOriginalDiff ? `<div style="font-size:11px;color:#92400e;margin-top:3px;opacity:0.85;">Original (${srLang.toUpperCase()}): "${escapeHtml(srOriginal.trim())}"</div>` : ""}
              </div>
            `;
          }

          let feedbackHtml = "";
          if (o.feedback) {
            const starsText = o.feedback.rating ? "⭐".repeat(o.feedback.rating) : "💬 Written Feedback";
            const ratingScore = o.feedback.rating ? ` (${o.feedback.rating}/5)` : "";
            feedbackHtml = `
              <div class="oc-feedback-badge" style="margin-top:8px;">
                <div class="oc-fb-stars">${starsText} <strong>${ratingScore}</strong></div>
                ${o.feedback.comment ? `<div class="oc-fb-comment">"${escapeHtml(o.feedback.comment)}"</div>` : ""}
              </div>
            `;
          }

          // Build Chronological Status History Event Trail
          const historyEvents = Array.isArray(o.statusHistory) && o.statusHistory.length > 0
            ? o.statusHistory
            : [
                {
                  eventType: "ORDER_CREATED",
                  actorName: o.customerName || "Customer",
                  actorRole: "CUSTOMER",
                  date: o.orderDate || o.dateKey,
                  time: o.orderTime || "",
                  details: "Order placed by customer",
                },
                ...(o.acceptedAt
                  ? [{
                      eventType: "STATUS_CHANGE",
                      actorName: o.acceptedByName || "Staff",
                      actorRole: o.acceptedByRole || "STAFF",
                      date: o.orderDate || o.dateKey,
                      time: o.acceptedTimeStr || "",
                      details: "Order accepted into prep",
                    }]
                  : []),
                ...(o.servedAt
                  ? [{
                      eventType: "STATUS_CHANGE",
                      actorName: o.servedByName || "Staff",
                      actorRole: o.servedByRole || "STAFF",
                      date: o.orderDate || o.dateKey,
                      time: o.servedTimeStr || "",
                      details: "Order served to table",
                    }]
                  : []),
                ...(o.cancelledAt
                  ? [{
                      eventType: "ORDER_CANCELLED",
                      actorName: o.cancelledByName || "Staff",
                      actorRole: o.cancelledByRole || "STAFF",
                      date: o.orderDate || o.dateKey,
                      time: o.cancelledTimeStr || "",
                      details: o.cancellationReason || "Order cancelled",
                    }]
                  : []),
              ];

          const eventsListHtml = historyEvents
            .map(
              (ev) => `
            <div class="oc-event-row">
              <span class="oc-event-dot">●</span>
              <div class="oc-event-main">
                <div class="oc-event-head">
                  <span class="oc-event-time">${escapeHtml(ev.time || "")}</span>
                  <span class="oc-event-actor"><strong>${escapeHtml(ev.actorName || "Staff")}</strong> (${escapeHtml(ev.actorRole || "STAFF")})</span>
                </div>
                <div class="oc-event-detail">${escapeHtml(ev.details || ev.reason || ev.eventType)}</div>
              </div>
            </div>`
            )
            .join("");

          return `
            <div class="order-card history-card status-${o.status}">
              <div class="oc-header">
                <div class="oc-num-badge">${escapeHtml(orderNum)} <span style="font-size:11px;font-weight:400;color:var(--gray);">${escapeHtml(o.id)}</span></div>
                <span class="status-pill status-${o.status}">${timing.badgeText}</span>
              </div>

              <div class="oc-datetime">
                <div>📅 <strong>${escapeHtml(o.orderDate || o.dateKey)}</strong></div>
                <div>🕐 <strong>${escapeHtml(o.orderTime || "")}</strong> (Ethiopia Time)</div>
              </div>

              <div class="oc-info-grid" style="margin-top:6px;">
                <div>👤 <strong>Customer:</strong> ${escapeHtml(customerDisplay)}</div>
                <div>🪑 <strong>Table:</strong> <span class="oc-table-chip">${escapeHtml(o.tableNumber)}</span></div>
                ${staffInfo}
              </div>

              ${specialRequestHtml}
              ${feedbackHtml}

              ${
                timing.isCompleted && o.status !== "cancelled"
                  ? `
                  <div class="oc-served-breakdown" style="margin-top:8px;">
                    <div class="breakdown-pills">
                      <span>Pending: <strong>${timing.pendingDuration}</strong></span>
                      <span>In Progress: <strong>${timing.inProgressDuration}</strong></span>
                      <span>Total: <strong>${timing.totalDuration}</strong></span>
                    </div>
                  </div>`
                  : ""
              }

              <div class="oc-items">
                <ul>
                  ${(o.items || [])
                    .map(
                      (l) => `
                    <li>
                      <span class="oc-item-qty">${l.qty} ×</span>
                      <span class="oc-item-name">${escapeHtml(l.name)}</span>
                      <span class="oc-item-price">${formatPrice((l.price || 0) * (l.qty || 1))}</span>
                    </li>`
                    )
                    .join("")}
                </ul>
              </div>

              <div class="oc-total-row">
                <span>Total:</span>
                <span>${formatPrice(o.total)}</span>
              </div>

              <!-- Collapsible Status Audit Trail -->
              <details class="oc-history-details" style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px;font-size:12px;">
                <summary style="cursor:pointer;color:var(--blue);font-weight:700;">⏱️ View Event Audit Trail (${historyEvents.length})</summary>
                <div class="oc-events-timeline" style="margin-top:8px;">
                  ${eventsListHtml}
                </div>
              </details>
            </div>
          `;
        })
        .join("");
    }
  } catch (err) {
    if (container) {
      container.innerHTML = `<p class="empty-note" style="color:var(--red);">Failed to load history: ${escapeHtml(err.message)}</p>`;
    }
  }
}

const applyHistoryFilterBtn = document.getElementById("applyHistoryFilterBtn");
if (applyHistoryFilterBtn) {
  applyHistoryFilterBtn.addEventListener("click", loadHistoryOrders);
}

const resetHistoryFilterBtn = document.getElementById("resetHistoryFilterBtn");
if (resetHistoryFilterBtn) {
  resetHistoryFilterBtn.addEventListener("click", () => {
    const fromInput = document.getElementById("histFromDateTime");
    const toInput = document.getElementById("histToDateTime");
    const statusInput = document.getElementById("histStatus");
    const staffRoleInput = document.getElementById("histStaffRole");
    const searchInput = document.getElementById("histSearch");

    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
    if (statusInput) statusInput.value = "all";
    if (staffRoleInput) staffRoleInput.value = "all";
    if (searchInput) searchInput.value = "";

    document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    const allPresetBtn = document.querySelector('.preset-btn[data-preset="all"]');
    if (allPresetBtn) allPresetBtn.classList.add("active");

    loadHistoryOrders();
  });
}

// Excel Export Trigger
const exportHistoryExcelBtn = document.getElementById("exportHistoryExcelBtn");
if (exportHistoryExcelBtn) {
  exportHistoryExcelBtn.addEventListener("click", () => {
    const { params } = buildReportFilterParams();
    const downloadUrl = `/api/admin/orders/export?${params.toString()}`;
    window.location.href = downloadUrl;
  });
}

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const preset = btn.dataset.preset;
    const now = new Date();
    const todayStr = currentTodayDateKey || new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(now);

    const fromInput = document.getElementById("histFromDateTime");
    const toInput = document.getElementById("histToDateTime");

    if (preset === "all") {
      if (fromInput) fromInput.value = "";
      if (toInput) toInput.value = "";
    } else if (preset === "today") {
      if (fromInput) fromInput.value = `${todayStr}T00:00`;
      if (toInput) toInput.value = `${todayStr}T23:59`;
    } else if (preset === "yesterday") {
      const y = new Date(Date.now() - 86400000);
      const yStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(y);
      if (fromInput) fromInput.value = `${yStr}T00:00`;
      if (toInput) toInput.value = `${yStr}T23:59`;
    } else if (preset === "week") {
      const w = new Date(Date.now() - 7 * 86400000);
      const wStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(w);
      if (fromInput) fromInput.value = `${wStr}T00:00`;
      if (toInput) toInput.value = `${todayStr}T23:59`;
    } else if (preset === "month") {
      const mStr = todayStr.slice(0, 7) + "-01";
      if (fromInput) fromInput.value = `${mStr}T00:00`;
      if (toInput) toInput.value = `${todayStr}T23:59`;
    }

    loadHistoryOrders();
  });
});

// ---------- 3. STAFF MANAGEMENT ----------

async function loadStaffList() {
  const tbody = document.getElementById("staffTableBody");
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Loading staff members...</td></tr>';

  try {
    const list = await api("/api/admin/staff");
    staffListCache = list;
    renderStaffTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-note" style="color:var(--red);">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderStaffTable() {
  const tbody = document.getElementById("staffTableBody");
  if (!tbody) return;

  const search = (document.getElementById("staffSearchInput")?.value || "").trim().toLowerCase();
  const roleFilter = document.getElementById("staffRoleFilter")?.value || "ALL";
  const statusFilter = document.getElementById("staffStatusFilter")?.value || "ALL";

  let filtered = staffListCache.filter((s) => {
    const matchesSearch = !search || s.fullName.toLowerCase().includes(search) || s.username.toLowerCase().includes(search);
    const matchesRole = roleFilter === "ALL" || s.role === roleFilter;
    const matchesStatus = statusFilter === "ALL" || s.status === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-note">No staff accounts found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const isSelf = currentUser && currentUser.id === s.id;
      const isActive = s.status === "ACTIVE";

      return `
      <tr>
        <td>
          <strong>${escapeHtml(s.fullName)}</strong>
          ${isSelf ? '<span class="user-self-tag">(You)</span>' : ""}
        </td>
        <td><code>@${escapeHtml(s.username)}</code></td>
        <td><span class="role-badge role-${s.role.toLowerCase()}">${escapeHtml(s.role)}</span></td>
        <td>
          <span class="status-pill status-${isActive ? "served" : "cancelled"}">
            ${isActive ? "● Active" : "○ Disabled"}
          </span>
        </td>
        <td style="font-size:12px;color:var(--ink-soft);">${escapeHtml(s.lastLoginAt || "Never")}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="tab-btn" data-edit-staff="${s.id}" style="padding:4px 8px;font-size:11.5px;">Edit</button>
          <button class="tab-btn" data-pwd-staff="${s.id}" style="padding:4px 8px;font-size:11.5px;">Reset Pwd</button>
          ${
            !isSelf
              ? `
            <button class="tab-btn" data-toggle-staff="${s.id}" data-status="${s.status}" style="padding:4px 8px;font-size:11.5px;color:${isActive ? "var(--red)" : "var(--green)"};">
              ${isActive ? "Disable" : "Enable"}
            </button>
            <button class="tab-btn" data-del-staff="${s.id}" style="padding:4px 8px;font-size:11.5px;color:var(--red);">Delete</button>
          `
              : ""
          }
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-edit-staff]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const staff = staffListCache.find((s) => s.id === btn.dataset.editStaff);
      if (staff) openEditStaffModal(staff);
    });
  });

  tbody.querySelectorAll("[data-pwd-staff]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const staff = staffListCache.find((s) => s.id === btn.dataset.pwdStaff);
      if (staff) openResetPasswordModal(staff);
    });
  });

  tbody.querySelectorAll("[data-toggle-staff]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const isDisabling = btn.dataset.status === "ACTIVE";
      const promptText = isDisabling
        ? "Disable this staff account? The staff member will immediately be logged out and cannot sign in."
        : "Re-enable this staff account?";
      if (!confirm(promptText)) return;

      try {
        await api(`/api/admin/staff/${btn.dataset.toggleStaff}/toggle-status`, { method: "POST" });
        loadStaffList();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  tbody.querySelectorAll("[data-del-staff]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Permanently delete this staff account? (Disabling is recommended instead to preserve history).")) return;
      try {
        await api(`/api/admin/staff/${btn.dataset.delStaff}`, { method: "DELETE" });
        loadStaffList();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

const staffSearchInput = document.getElementById("staffSearchInput");
if (staffSearchInput) staffSearchInput.addEventListener("input", renderStaffTable);

const staffRoleFilter = document.getElementById("staffRoleFilter");
if (staffRoleFilter) staffRoleFilter.addEventListener("change", renderStaffTable);

const staffStatusFilter = document.getElementById("staffStatusFilter");
if (staffStatusFilter) staffStatusFilter.addEventListener("change", renderStaffTable);

const openAddStaffModalBtn = document.getElementById("openAddStaffModalBtn");
if (openAddStaffModalBtn) {
  openAddStaffModalBtn.addEventListener("click", () => {
    document.getElementById("addStaffFullName").value = "";
    document.getElementById("addStaffUsername").value = "";
    document.getElementById("addStaffPassword").value = "";
    document.getElementById("addStaffConfirmPassword").value = "";
    document.getElementById("addStaffRole").value = "WAITER";
    document.getElementById("addStaffStatus").value = "ACTIVE";
    document.getElementById("addStaffError").classList.remove("show");
    openModal("addStaffModal");
  });
}

const saveAddStaffBtn = document.getElementById("saveAddStaffBtn");
if (saveAddStaffBtn) {
  saveAddStaffBtn.addEventListener("click", async () => {
    const fullName = document.getElementById("addStaffFullName").value.trim();
    const username = document.getElementById("addStaffUsername").value.trim();
    const password = document.getElementById("addStaffPassword").value;
    const conf = document.getElementById("addStaffConfirmPassword").value;
    const role = document.getElementById("addStaffRole").value;
    const status = document.getElementById("addStaffStatus").value;
    const errEl = document.getElementById("addStaffError");

    errEl.classList.remove("show");

    if (!fullName || !username || !password) {
      errEl.textContent = "Please fill in all required fields.";
      errEl.classList.add("show");
      return;
    }
    if (password.length < 8) {
      errEl.textContent = "Password must be at least 8 characters long.";
      errEl.classList.add("show");
      return;
    }
    if (password !== conf) {
      errEl.textContent = "Password confirmation does not match.";
      errEl.classList.add("show");
      return;
    }

    saveAddStaffBtn.disabled = true;
    saveAddStaffBtn.textContent = "Creating...";

    try {
      await api("/api/admin/staff", {
        method: "POST",
        body: JSON.stringify({ fullName, username, password, role, status }),
      });
      closeModal("addStaffModal");
      loadStaffList();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    } finally {
      saveAddStaffBtn.disabled = false;
      saveAddStaffBtn.textContent = "Save Staff Account";
    }
  });
}

function openEditStaffModal(staff) {
  document.getElementById("editStaffId").value = staff.id;
  document.getElementById("editStaffTitle").textContent = `Edit @${staff.username}`;
  document.getElementById("editStaffFullName").value = staff.fullName;
  document.getElementById("editStaffUsername").value = staff.username;
  document.getElementById("editStaffRole").value = staff.role;
  document.getElementById("editStaffStatus").value = staff.status;
  document.getElementById("editStaffError").classList.remove("show");
  openModal("editStaffModal");
}

const saveEditStaffBtn = document.getElementById("saveEditStaffBtn");
if (saveEditStaffBtn) {
  saveEditStaffBtn.addEventListener("click", async () => {
    const id = document.getElementById("editStaffId").value;
    const fullName = document.getElementById("editStaffFullName").value.trim();
    const role = document.getElementById("editStaffRole").value;
    const status = document.getElementById("editStaffStatus").value;
    const errEl = document.getElementById("editStaffError");

    errEl.classList.remove("show");

    saveEditStaffBtn.disabled = true;
    saveEditStaffBtn.textContent = "Saving...";

    try {
      await api(`/api/admin/staff/${id}`, {
        method: "PUT",
        body: JSON.stringify({ fullName, role, status }),
      });
      closeModal("editStaffModal");
      loadStaffList();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    } finally {
      saveEditStaffBtn.disabled = false;
      saveEditStaffBtn.textContent = "Save Changes";
    }
  });
}

function openResetPasswordModal(staff) {
  document.getElementById("resetStaffId").value = staff.id;
  document.getElementById("resetPwdTitle").textContent = `Reset Password for @${staff.username}`;
  document.getElementById("resetNewPwd").value = "";
  document.getElementById("resetConfPwd").value = "";
  document.getElementById("resetPwdError").classList.remove("show");
  openModal("resetStaffPwdModal");
}

const saveResetStaffPwdBtn = document.getElementById("saveResetStaffPwdBtn");
if (saveResetStaffPwdBtn) {
  saveResetStaffPwdBtn.addEventListener("click", async () => {
    const id = document.getElementById("resetStaffId").value;
    const newPassword = document.getElementById("resetNewPwd").value;
    const conf = document.getElementById("resetConfPwd").value;
    const errEl = document.getElementById("resetPwdError");

    errEl.classList.remove("show");

    if (!newPassword || newPassword.length < 8) {
      errEl.textContent = "Password must be at least 8 characters long.";
      errEl.classList.add("show");
      return;
    }
    if (newPassword !== conf) {
      errEl.textContent = "Password confirmation does not match.";
      errEl.classList.add("show");
      return;
    }

    saveResetStaffPwdBtn.disabled = true;
    saveResetStaffPwdBtn.textContent = "Resetting...";

    try {
      await api(`/api/admin/staff/${id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      alert("Password reset successfully. The staff member can now sign in with the new password.");
      closeModal("resetStaffPwdModal");
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    } finally {
      saveResetStaffPwdBtn.disabled = false;
      saveResetStaffPwdBtn.textContent = "Reset Password";
    }
  });
}

// ---------- 4. AUDIT LOGS VIEWER ----------

async function loadAuditLogs() {
  const tbody = document.getElementById("auditTableBody");
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-note">Loading logs...</td></tr>';
  try {
    const logs = await api("/api/admin/audit-logs");
    if (!logs || logs.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-note">No audit logs recorded yet.</td></tr>';
      return;
    }
    if (tbody) {
      tbody.innerHTML = logs
        .map(
          (log) => `
        <tr>
          <td style="font-size:12px;white-space:nowrap;">${escapeHtml(log.timestamp)}</td>
          <td><strong>${escapeHtml(log.username)}</strong></td>
          <td><span class="role-badge role-${(log.role || "").toLowerCase()}">${escapeHtml(log.role)}</span></td>
          <td><span class="action-tag">${escapeHtml(log.action)}</span></td>
          <td style="font-size:12.5px;">${escapeHtml(log.details)}</td>
          <td style="font-family:monospace;font-size:12px;">${escapeHtml(log.ip)}</td>
        </tr>`
        )
        .join("");
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-note" style="color:var(--red);">Failed to load audit logs: ${escapeHtml(err.message)}</td></tr>`;
  }
}
const refreshAuditBtn = document.getElementById("refreshAuditBtn");
if (refreshAuditBtn) refreshAuditBtn.addEventListener("click", loadAuditLogs);

// ---------- 5. ACCOUNT SECURITY ----------

const savePasswordBtn = document.getElementById("savePasswordBtn");
if (savePasswordBtn) {
  savePasswordBtn.addEventListener("click", async () => {
    const curPassword = document.getElementById("curPassword").value;
    const newPassword = document.getElementById("newPassword").value;
    const confPassword = document.getElementById("confPassword").value;
    const errorEl = document.getElementById("pwdChangeError");
    const successEl = document.getElementById("pwdChangeSuccess");

    errorEl.classList.remove("show");
    successEl.style.display = "none";

    if (!curPassword || !newPassword) {
      errorEl.textContent = "Please fill in all password fields.";
      errorEl.classList.add("show");
      return;
    }
    if (newPassword.length < 8) {
      errorEl.textContent = "New password must be at least 8 characters long.";
      errorEl.classList.add("show");
      return;
    }
    if (newPassword !== confPassword) {
      errorEl.textContent = "New password confirmation does not match.";
      errorEl.classList.add("show");
      return;
    }

    savePasswordBtn.disabled = true;
    savePasswordBtn.textContent = "Updating...";

    try {
      await api("/api/admin/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: curPassword, newPassword }),
      });
      successEl.style.display = "block";
      document.getElementById("curPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confPassword").value = "";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add("show");
    } finally {
      savePasswordBtn.disabled = false;
      savePasswordBtn.textContent = "Update Password";
    }
  });
}

// ---------- 6. MULTILINGUAL MENU MANAGEMENT (5 LANGUAGES TABS) ----------

document.querySelectorAll(".admin-lang-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-lang-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".admin-lang-pane").forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    const lang = btn.dataset.adminLang;
    const pane = document.getElementById(`pane-${lang}`);
    if (pane) pane.classList.add("active");
  });
});

const fCategorySelect = document.getElementById("fCategory");
if (fCategorySelect) {
  fCategorySelect.addEventListener("change", (e) => {
    const isDrink = e.target.value === "Drinks";
    ["en", "ar", "am", "om", "ti"].forEach((lang) => {
      const wrap = document.getElementById(`ingWrap_${lang}`);
      if (wrap) wrap.style.display = isDrink ? "none" : "block";
    });
  });
}

async function loadMenu() {
  try {
    const items = await api("/api/admin/menu");
    renderMenuList(items);
  } catch (err) {
    console.error(err);
  }
}

function renderMenuList(items) {
  const el = document.getElementById("menuList");
  if (!el) return;

  if (items.length === 0) {
    el.innerHTML = '<p class="empty-note">No menu items yet.</p>';
    return;
  }
  el.innerHTML = items
    .map((item) => {
      const engName = getItemEnglishName(item);
      const engDesc = getItemEnglishDesc(item);
      const engIng = getItemEnglishIngredients(item);

      const trans = item.translations || {};
      const langsAvailable = ["en", "ar", "am", "om", "ti"].filter((l) => trans[l]?.name || item.name?.[l]);

      const badgesHtml = langsAvailable
        .map((l) => `<span style="font-size:10px;padding:2px 5px;background:#e9ece3;border-radius:4px;font-weight:700;">${l.toUpperCase()}</span>`)
        .join(" ");

      return `
      <div class="menu-admin-row">
        <div class="ma-img-wrap">
          <img src="${escapeHtml(item.image || PLACEHOLDER_IMG)}" alt="${escapeHtml(engName)}" onerror="this.src='${PLACEHOLDER_IMG}'" />
        </div>
        <div class="ma-main">
          <p class="item-name">${escapeHtml(engName)} <span style="font-weight:400;color:var(--ink-soft);font-size:12.5px;">(${escapeHtml(item.category)})</span></p>
          <div style="display:flex;gap:4px;margin:4px 0 6px;">${badgesHtml}</div>
          <p class="item-desc">${escapeHtml(engDesc)}</p>
          ${engIng ? `<p class="item-ingredients">${escapeHtml(engIng)}</p>` : ""}
          <p class="item-price">${formatPrice(item.cost)}</p>
          <p class="availability-toggle">${item.available ? "In stock" : "Out of stock"}</p>
        </div>
        <div class="ma-actions">
          <button data-edit="${item.id}">Edit</button>
          <button data-toggle="${item.id}" data-available="${item.available}">${item.available ? "Mark out of stock" : "Mark in stock"}</button>
          <button data-delete="${item.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  el.querySelectorAll("button[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => startEdit(items.find((i) => i.id === btn.dataset.edit)))
  );
  el.querySelectorAll("button[data-toggle]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const nowAvailable = btn.dataset.available !== "true";
      try {
        await api(`/api/admin/menu/${btn.dataset.toggle}`, {
          method: "PUT",
          body: JSON.stringify({ available: nowAvailable }),
        });
        loadMenu();
      } catch (err) {
        alert(err.message);
      }
    })
  );
  el.querySelectorAll("button[data-delete]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this item?")) return;
      try {
        await api(`/api/admin/menu/${btn.dataset.delete}`, { method: "DELETE" });
        loadMenu();
      } catch (err) {
        alert(err.message);
      }
    })
  );
}

const fImageFileInput = document.getElementById("fImageFile");
if (fImageFileInput) {
  fImageFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    const errorEl = document.getElementById("menuFormError");
    errorEl.classList.remove("show");

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      errorEl.textContent = "Please select a valid image file (JPG, PNG, WEBP, GIF).";
      errorEl.classList.add("show");
      e.target.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      errorEl.textContent = "Image size exceeds 5MB limit.";
      errorEl.classList.add("show");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      pendingImageBase64 = reader.result;
      updateImagePreview(pendingImageBase64);
    };
    reader.readAsDataURL(file);
  });
}

function updateImagePreview(src) {
  const box = document.getElementById("imgPreviewBox");
  const clearBtn = document.getElementById("clearImageBtn");
  if (!box) return;

  if (src) {
    box.innerHTML = `<img src="${src}" alt="Preview" />`;
    if (clearBtn) clearBtn.style.display = "inline-block";
  } else {
    box.innerHTML = `<span class="img-preview-placeholder">No image</span>`;
    if (clearBtn) clearBtn.style.display = "none";
  }
}

const clearImageBtn = document.getElementById("clearImageBtn");
if (clearImageBtn) {
  clearImageBtn.addEventListener("click", () => {
    pendingImageBase64 = null;
    document.getElementById("fImageUrl").value = "";
    document.getElementById("fImageFile").value = "";
    updateImagePreview(null);
  });
}

function startEdit(item) {
  editingItemId = item.id;
  editingItemFullTranslations = item.translations || {};
  pendingImageBase64 = null;

  const engName = getItemEnglishName(item);
  document.getElementById("formTitle").textContent = `Edit ${engName}`;
  document.getElementById("fCategory").value = item.category;
  document.getElementById("fCost").value = item.cost;
  document.getElementById("fAvailable").value = String(item.available);
  document.getElementById("fImageUrl").value = item.image || "";
  document.getElementById("fImageFile").value = "";
  updateImagePreview(item.image || null);

  const isDrink = item.category === "Drinks";
  const langs = ["en", "ar", "am", "om", "ti"];

  langs.forEach((lang) => {
    const tObj = item.translations?.[lang] || {};
    const nameVal = tObj.name || (typeof item.name === "object" ? item.name[lang] : (lang === "en" ? item.name : "")) || "";
    const descVal = tObj.description || (typeof item.description === "object" ? item.description[lang] : (lang === "en" ? item.description : "")) || "";
    
    let ingVal = "";
    if (Array.isArray(tObj.ingredients)) {
      ingVal = tObj.ingredients.join(", ");
    } else if (typeof item.ingredients === "object" && !Array.isArray(item.ingredients)) {
      ingVal = (item.ingredients[lang] || []).join(", ");
    } else if (lang === "en" && Array.isArray(item.ingredients)) {
      ingVal = item.ingredients.join(", ");
    }

    const nEl = document.getElementById(`fName_${lang}`);
    const dEl = document.getElementById(`fDesc_${lang}`);
    const iEl = document.getElementById(`fIng_${lang}`);
    const wrap = document.getElementById(`ingWrap_${lang}`);

    if (nEl) nEl.value = nameVal;
    if (dEl) dEl.value = descVal;
    if (iEl) iEl.value = ingVal;
    if (wrap) wrap.style.display = isDrink ? "none" : "block";
  });

  const baseTabBtn = document.querySelector('.admin-lang-tab-btn[data-admin-lang="en"]');
  if (baseTabBtn) baseTabBtn.click();

  document.getElementById("saveItemBtn").textContent = "Save changes";
  document.getElementById("cancelEditBtn").style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  editingItemId = null;
  editingItemFullTranslations = null;
  pendingImageBase64 = null;
  document.getElementById("formTitle").textContent = "Add a new item";
  document.getElementById("fCategory").value = "Food";
  document.getElementById("fCost").value = "";
  document.getElementById("fAvailable").value = "true";
  document.getElementById("fImageUrl").value = "";
  document.getElementById("fImageFile").value = "";
  updateImagePreview(null);

  ["en", "ar", "am", "om", "ti"].forEach((lang) => {
    const nEl = document.getElementById(`fName_${lang}`);
    const dEl = document.getElementById(`fDesc_${lang}`);
    const iEl = document.getElementById(`fIng_${lang}`);
    const wrap = document.getElementById(`ingWrap_${lang}`);

    if (nEl) nEl.value = "";
    if (dEl) dEl.value = "";
    if (iEl) iEl.value = "";
    if (wrap) wrap.style.display = "block";
  });

  const baseTabBtn = document.querySelector('.admin-lang-tab-btn[data-admin-lang="en"]');
  if (baseTabBtn) baseTabBtn.click();

  document.getElementById("saveItemBtn").textContent = "Add item";
  document.getElementById("cancelEditBtn").style.display = "none";
}

const cancelEditBtn = document.getElementById("cancelEditBtn");
if (cancelEditBtn) cancelEditBtn.addEventListener("click", resetForm);

const saveItemBtn = document.getElementById("saveItemBtn");
if (saveItemBtn) {
  saveItemBtn.addEventListener("click", async () => {
    const errorEl = document.getElementById("menuFormError");
    errorEl.classList.remove("show");

    let imageUrl = document.getElementById("fImageUrl").value;

    if (pendingImageBase64) {
      saveItemBtn.disabled = true;
      saveItemBtn.textContent = "Uploading photo...";
      try {
        const uploadRes = await api("/api/admin/upload", {
          method: "POST",
          body: JSON.stringify({ data: pendingImageBase64 }),
        });
        imageUrl = uploadRes.url;
      } catch (err) {
        errorEl.textContent = "Image upload failed: " + err.message;
        errorEl.classList.add("show");
        saveItemBtn.disabled = false;
        saveItemBtn.textContent = editingItemId ? "Save changes" : "Add item";
        return;
      }
    }

    const category = document.getElementById("fCategory").value;
    const cost = parseFloat(document.getElementById("fCost").value);
    const available = document.getElementById("fAvailable").value === "true";

    const englishName = (document.getElementById("fName_en")?.value || "").trim();
    if (!englishName || isNaN(cost) || cost < 0) {
      errorEl.textContent = "English base name and a valid cost are required.";
      errorEl.classList.add("show");
      saveItemBtn.disabled = false;
      saveItemBtn.textContent = editingItemId ? "Save changes" : "Add item";
      return;
    }

    const translations = editingItemFullTranslations ? { ...editingItemFullTranslations } : {};

    ["en", "ar", "am", "om", "ti"].forEach((lang) => {
      const name = (document.getElementById(`fName_${lang}`)?.value || "").trim();
      const desc = (document.getElementById(`fDesc_${lang}`)?.value || "").trim();
      const ingRaw = (document.getElementById(`fIng_${lang}`)?.value || "").trim();
      const ingredients = category === "Drinks" ? [] : ingRaw.split(",").map((s) => s.trim()).filter(Boolean);

      if (name || desc || ingredients.length > 0 || lang === "en") {
        translations[lang] = {
          name: name || (lang === "en" ? englishName : ""),
          description: desc || "",
          ingredients: ingredients
        };
      }
    });

    const payload = {
      name: englishName,
      category,
      cost,
      available,
      image: imageUrl || "",
      translations
    };

    try {
      saveItemBtn.disabled = true;
      saveItemBtn.textContent = "Saving...";
      if (editingItemId) {
        await api(`/api/admin/menu/${editingItemId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/api/admin/menu", { method: "POST", body: JSON.stringify(payload) });
      }
      resetForm();
      loadMenu();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add("show");
    } finally {
      saveItemBtn.disabled = false;
      saveItemBtn.textContent = editingItemId ? "Save changes" : "Add item";
    }
  });
}

// Auto Check Existing Session on page load
(async function checkExistingSession() {
  try {
    const data = await api("/api/admin/orders/today");
    showApp(data.user, data.csrfToken);
  } catch (e) {
    logout(false);
  }
})();