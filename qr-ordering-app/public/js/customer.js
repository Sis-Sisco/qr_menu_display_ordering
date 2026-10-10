// ---------------------------------------------------------------------------
// Multilingual Customer Ordering App powered by i18next
// Supports 5 Languages: English (en), Arabic (ar - RTL), Amharic (am), Afaan Oromoo (om), Tigrinya (ti)
// ---------------------------------------------------------------------------
const LANG_STORAGE_KEY = "qr_customer_lang";
const PENDING_ORDERS_KEY = "qr_pending_orders_v1";
const MENU_CACHE_KEY = "qr_menu_cache_v2";
const CUST_ID_STORAGE_KEY = "qr_customer_id_v3";
const CUST_NAME_STORAGE_KEY = "qr_customer_preferred_name";
const DB_NAME = "qr_customer_orders_db";
const DB_VERSION = 1;
const STORE_NAME = "order_history";
const FEEDBACK_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 Hours
const MAX_ITEM_QUANTITY = 10;

const PLACEHOLDER_IMAGE = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22200%22%20height%3D%22200%22%20viewBox%3D%220%200%20200%20200%22%3E%3Crect%20fill%3D%22%23e9eae2%22%20width%3D%22200%22%20height%3D%22200%22%20viewBox%3D%220%200%20200%20200%22%2F%3E%3Ctext%20fill%3D%22%237c877e%22%20font-family%3D%22sans-serif%22%20font-size%3D%2214%22%20dy%3D%225%22%20font-weight%3D%22bold%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3E%F0%9F%8D%BD%EF%B8%8F%20Delicious%20Food%3C%2Ftext%3E%3C%2Fsvg%3E";

const SUPPORTED_LANGUAGES = {
  en: { name: "English", flag: "🇬🇧", dir: "ltr" },
  ar: { name: "العربية", flag: "🇸🇦", dir: "rtl" },
  am: { name: "አማርኛ", flag: "🇪🇹", dir: "ltr" },
  om: { name: "Afaan Oromoo", flag: "🌍", dir: "ltr" },
  ti: { name: "ትግርኛ", flag: "🇪🇹", dir: "ltr" }
};

const params = new URLSearchParams(window.location.search);
// The table is decided by the server (signed QR token -> HttpOnly cookie), never by
// a value the customer could edit in the address bar.
let tableNumber = null;

async function resolveTableSession() {
  const token = params.get("t") || "";
  try {
    const res = await fetch(`/api/table-session${token ? `?t=${encodeURIComponent(token)}` : ""}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.table) return null;
    // Remove the token / any table parameter from the address bar.
    if (window.location.search) history.replaceState(null, "", window.location.pathname);
    try { sessionStorage.setItem("qr_last_table", String(data.table)); } catch (e) {}
    return String(data.table);
  } catch (e) {
    // Network problem: show the last verified table (display only; the server still enforces it).
    try { return sessionStorage.getItem("qr_last_table"); } catch (e2) { return null; }
  }
}

let customerId = localStorage.getItem(CUST_ID_STORAGE_KEY);
if (!customerId) {
  customerId = "cust_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem(CUST_ID_STORAGE_KEY, customerId);
}

let currentLang = localStorage.getItem(LANG_STORAGE_KEY) || "en";
if (!SUPPORTED_LANGUAGES[currentLang]) currentLang = "en";

let menu = [];
let cart = {};
let activeCustomerOrder = null;
let lastKnownStatus = null;
let isSubmittingOrder = false;
let customerOrdersPollTimer = null;
let feedbackCountdownInterval = null;

let alertedCancelledOrders = new Set();
let audioContextUnlocked = false;

let currentViewMode = "MENU_INITIAL";
let servedFeedbackOrder = null;
let selectedFeedbackRating = 0;

let activeCategoryFilter = "all";
let currentSearchQuery = "";
let editOrderDraftItems = [];

// ---------- TRANSLATION ENGINE INTEGRATION WITH i18next ----------

async function initI18n() {
  const loadResources = async (lang) => {
    try {
      const res = await fetch(`/locales/${lang}/translation.json`);
      if (res.ok) return await res.json();
    } catch (e) {}
    return null;
  };

  const resources = {};
  for (const lang of Object.keys(SUPPORTED_LANGUAGES)) {
    const data = await loadResources(lang);
    if (data) resources[lang] = { translation: data };
  }

  if (window.i18next) {
    await i18next.init({
      lng: currentLang,
      fallbackLng: "en",
      resources,
      interpolation: { escapeValue: false },
      returnNull: false,
      returnEmptyString: false
    });
  }
}

function t(key, fallback = "") {
  if (window.i18next && typeof i18next.t === "function") {
    const val = i18next.t(key);
    if (val && val !== key) return val;
  }
  return fallback || key;
}

// Universal Multilingual Resolver with Safe English Fallback
function getLocalizedField(item, field) {
  if (!item) return "";
  const lang = (window.i18next && i18next.language) || currentLang || "en";

  // 1. Structured translations dictionary
  if (item.translations && typeof item.translations === "object") {
    const langObj = item.translations[lang];
    if (langObj && langObj[field]) return langObj[field];
    if (item.translations.en && item.translations.en[field]) return item.translations.en[field];
  }

  // 2. Direct field object
  const val = item[field];
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    return val[lang] || val.en || Object.values(val)[0] || "";
  }
  return String(val);
}

function getLocalizedIngredients(item) {
  if (!item) return "";
  const lang = (window.i18next && i18next.language) || currentLang || "en";

  if (item.translations && typeof item.translations === "object") {
    const langObj = item.translations[lang];
    if (langObj && langObj.ingredients && Array.isArray(langObj.ingredients) && langObj.ingredients.length > 0) {
      return langObj.ingredients.join(", ");
    }
    if (item.translations.en && item.translations.en.ingredients && Array.isArray(item.translations.en.ingredients)) {
      return item.translations.en.ingredients.join(", ");
    }
  }

  const val = item.ingredients;
  if (!val) return "";
  if (Array.isArray(val)) return val.join(", ");
  if (typeof val === "object") {
    const list = val[lang] || val.en || Object.values(val)[0] || [];
    return Array.isArray(list) ? list.join(", ") : String(list);
  }
  return String(val);
}

function unlockAudioContext() {
  audioContextUnlocked = true;
}

function playCustomerCancellationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sawtooth";
    osc2.type = "sine";
    osc1.frequency.setValueAtTime(440, now);
    osc1.frequency.exponentialRampToValueAtTime(220, now + 0.35);
    osc2.frequency.setValueAtTime(554.37, now);
    osc2.frequency.exponentialRampToValueAtTime(277.18, now + 0.35);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.5);
    osc2.stop(now + 0.5);
  } catch (e) {}
}

// ---------- INDEXEDDB LOCAL DEVICE ORDER HISTORY ----------
function openHistoryDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => resolve(null);
  });
}

async function saveOrderToDeviceHistory(order) {
  if (!order || !order.id) return;
  try {
    const db = await openHistoryDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({
      id: order.id,
      dailyOrderNumber: order.dailyOrderNumber || "#" + (order.dailySeq || 1),
      tableNumber: order.tableNumber,
      orderDate: order.orderDate || new Date(order.createdAt).toLocaleDateString(),
      orderTime: order.orderTime || "",
      items: order.items || [],
      total: order.total || 0,
      status: order.status || "served",
      customerName: order.customerName || "Customer",
      feedback: order.feedback || null,
      cancelledByName: order.cancelledByName || null,
      cancelledByRole: order.cancelledByRole || null,
      cancellationReason: order.cancellationReason || null,
      cancelledTimeStr: order.cancelledTimeStr || null,
      timestamp: Date.now(),
    });
  } catch (e) {}
}

async function loadDeviceOrderHistory() {
  try {
    const db = await openHistoryDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function renderDeviceHistory() {
  const container = document.getElementById("customerHistorySection");
  const listEl = document.getElementById("historyOrdersList");
  if (!container || !listEl) return;

  const history = await loadDeviceOrderHistory();
  if (history.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  safeSetText("historySectionTitle", t("history.title", "🧾 My Order History"));

  const servedOrders = history.filter((h) => h.status === "served" || h.status === "paid");
  const cancelledOrders = history.filter((h) => h.status === "cancelled");

  let html = "";

  if (servedOrders.length > 0) {
    html += `
      <div class="history-stack-category">
        <h4 class="history-category-title">🟢 ${escapeHtml(t("orderStatus.served", "SERVED"))} (${servedOrders.length})</h4>
        <div class="history-stack-cards">
          ${servedOrders
            .map((h) => {
              const itemsList = (h.items || [])
                .map((i) => `<div class="hsc-item-line"><span>• ${escapeHtml(i.customerName || i.name)}</span> <strong>x${i.qty}</strong></div>`)
                .join("");
              return `
              <div class="history-stack-card history-card-served">
                <div class="hsc-header">
                  <span class="hsc-order-num">${escapeHtml(h.dailyOrderNumber)}</span>
                  <span class="history-served">🟢 SERVED</span>
                </div>
                <div class="hsc-meta">👤 <strong>${escapeHtml(h.customerName || "Customer")}</strong> · 🪑 ${escapeHtml(t("table.label", "Table"))} ${escapeHtml(h.tableNumber)}</div>
                <div class="hsc-items-box">${itemsList}</div>
                <div class="hsc-footer">
                  <span class="hsc-time">📅 ${escapeHtml(h.orderDate)} ${escapeHtml(h.orderTime)}</span>
                  <span class="hsc-total">${formatPrice(h.total)}</span>
                </div>
              </div>`;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  if (cancelledOrders.length > 0) {
    html += `
      <div class="history-stack-category" style="margin-top:16px;">
        <h4 class="history-category-title" style="color:#b42318;">🔴 ${escapeHtml(t("orderStatus.cancelled", "CANCELLED"))} (${cancelledOrders.length})</h4>
        <div class="history-stack-cards">
          ${cancelledOrders
            .map((h) => {
              const itemsList = (h.items || [])
                .map((i) => `<div class="hsc-item-line"><span>• ${escapeHtml(i.customerName || i.name)}</span> <strong>x${i.qty}</strong></div>`)
                .join("");
              return `
              <div class="history-stack-card history-card-cancelled">
                <div class="hsc-header">
                  <span class="hsc-order-num">${escapeHtml(h.dailyOrderNumber)}</span>
                  <span class="history-served" style="background:#fee2e2;color:#991b1b;">🔴 CANCELLED</span>
                </div>
                <div class="hsc-meta">👤 <strong>${escapeHtml(h.customerName || "Customer")}</strong> · 🪑 ${escapeHtml(t("table.label", "Table"))} ${escapeHtml(h.tableNumber)}</div>
                <div class="hsc-items-box">${itemsList}</div>
                <div class="hsc-cancellation-info">
                  <div><strong>${escapeHtml(t("history.cancelledBy", "Cancelled by"))}:</strong> ${escapeHtml(h.cancelledByName || "Staff")} (${escapeHtml(h.cancelledByRole || "STAFF")})</div>
                  <div><strong>${escapeHtml(t("history.reason", "Reason"))}:</strong> <em>"${escapeHtml(h.cancellationReason || "Not specified")}"</em></div>
                </div>
                <div class="hsc-footer">
                  <span class="hsc-time">📅 ${escapeHtml(h.orderDate)} ${escapeHtml(h.cancelledTimeStr || h.orderTime)}</span>
                  <span class="hsc-total" style="color:var(--gray);text-decoration:line-through;">${formatPrice(h.total)}</span>
                </div>
              </div>`;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

function formatPrice(amount) {
  const num = Number(amount) || 0;
  const formatted = num % 1 === 0 ? num : num.toFixed(2);
  return `${formatted} ETB`;
}

function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function safeSetPlaceholder(id, text) {
  const el = document.getElementById(id);
  if (el) el.placeholder = text;
}

function safeAddListener(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function restoreRememberedCustomerName() {
  const savedName = localStorage.getItem(CUST_NAME_STORAGE_KEY);
  const nameInput = document.getElementById("custNameInput");
  if (nameInput && savedName) {
    nameInput.value = savedName;
  }
}

async function applyLanguage(lang) {
  if (!SUPPORTED_LANGUAGES[lang]) lang = "en";
  currentLang = lang;
  localStorage.setItem(LANG_STORAGE_KEY, lang);

  if (window.i18next && i18next.language !== lang) {
    await i18next.changeLanguage(lang);
  }

  const isRtl = SUPPORTED_LANGUAGES[lang].dir === "rtl";
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl ? "rtl" : "ltr";

  const langConfig = SUPPORTED_LANGUAGES[lang];
  safeSetText("currentLangLabel", `${langConfig.flag} ${langConfig.name}`);

  document.querySelectorAll(".language-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });

  safeSetText("brandName", t("brand.name", "Yabi Cafe & Restaurant"));
  safeSetText("taglineText", t("brand.tagline", "Browse our delicious menu & order straight to your table"));
  safeSetText("offlineBanner", t("offline.banner", "You're offline — browsing saved menu. Orders will send once online."));
  safeSetText("tablePrefix", t("table.prefix", "Table"));
  safeSetPlaceholder("menuSearchInput", t("menu.searchPlaceholder", "Search food, drinks, ingredients..."));

  safeSetText("btnFilterAll", t("menu.filterAll", "🍽️ ALL"));
  safeSetText("btnFilterFood", t("menu.filterFood", "🍔 FOOD"));
  safeSetText("btnFilterDrink", t("menu.filterDrink", "🥤 DRINK"));

  safeSetText("cartItemsLabel", t("cart.barText", "items"));
  safeSetText("viewCartBtn", t("cart.viewOrder", "View order"));
  safeSetText("cartSheetTitle", t("cart.sheetTitle", "Your order"));
  safeSetText("labelCartTotal", t("cart.total", "Total"));
  safeSetText("custInfoTitle", t("cart.infoTitle", "Your Information"));
  safeSetText("labelCustName", t("cart.nameLabel", "Customer Name"));
  safeSetPlaceholder("custNameInput", t("cart.namePlaceholder", "Enter your name"));
  safeSetText("hintCustName", t("cart.nameHint", "Your name is saved for your next order. You can change it anytime."));
  safeSetText("labelSpecialReq", t("cart.specialReqLabel", "Special Request"));
  safeSetText("labelOptional", t("cart.optional", "(Optional)"));
  safeSetPlaceholder("custSuggestionInput", t("cart.specialReqPlaceholder", "Example: Less salt, less sugar, no spicy food, extra sauce..."));
  safeSetText("hintSpecialReq", t("cart.specialReqHint", "Tell our kitchen if you have any special request about your food or drink."));
  safeSetText("btnPlaceOrderText", t("cart.placeOrder", "Send Order"));
  safeSetText("btnViewBillText", t("cart.viewBill", "View Table Bill"));

  safeSetText("billTitleTablePrefix", t("table.prefix", "Table"));
  safeSetText("billTitleSuffix", t("bill.titleSuffix", "Orders & Bill"));
  safeSetText("labelAmountDue", t("bill.amountDue", "Amount due"));
  safeSetText("payBtn", t("bill.payNow", "Pay now"));
  safeSetText("billNote", t("bill.note", "All orders placed at this table are shown above."));

  safeSetText("btnBackToOrderText", t("orderStatus.backToOrder", "Back to My Order"));
  safeSetText("addModeBannerText", t("orderStatus.addModeBanner", "➕ Select items below to add to your order."));

  safeSetText("editModalTitle", t("editModal.title", "✏️ Edit Your Order"));
  safeSetText("labelEditSpecialReq", t("cart.specialReqLabel", "Special Request"));
  safeSetText("labelEditOptional", t("cart.optional", "(Optional)"));
  safeSetPlaceholder("editSpecialRequestInput", t("editModal.specialReqPlaceholder", "e.g. Less salt, no onion, less sugar..."));
  safeSetText("labelEditRecalculatedTotal", t("editModal.updatedTotal", "Updated Total"));
  safeSetText("cancelEditOrderBtn", t("editModal.cancel", "Cancel"));
  safeSetText("saveEditedOrderBtn", t("editModal.save", "Save Changes"));

  safeSetText("addConfirmModalTitle", t("addModal.title", "➕ Confirm Added Items"));
  safeSetText("addConfirmPrompt", t("addModal.prompt", "The following additional items will be added to your pending order:"));
  safeSetText("labelPrevTotal", t("addModal.prevTotal", "Previous Total"));
  safeSetText("labelAddTotal", t("addModal.additional", "+ Additional Items"));
  safeSetText("labelNewTotal", t("addModal.newTotal", "New Total"));
  safeSetText("cancelConfirmAddBtn", t("editModal.cancel", "Cancel"));
  safeSetText("submitConfirmAddBtn", t("addModal.confirmBtn", "Add to Order"));

  safeSetText("cancelModalTitle", t("cancelModal.title", "⚠️ Cancel Order"));
  safeSetText("cancelModalMessage", t("cancelModal.message", "Are you sure you want to cancel this order? Please enter the reason below."));
  safeSetText("labelCancelReason", t("cancelModal.reasonLabel", "Cancellation reason"));
  safeSetPlaceholder("custCancelReasonInput", t("cancelModal.reasonPlaceholder", "Why are you cancelling this order?"));
  safeSetText("keepOrderBtn", t("cancelModal.keepBtn", "Keep Order"));
  safeSetText("confirmCancelOrderBtn", t("cancelModal.confirmBtn", "Confirm Cancellation"));

  safeSetText("sfTitle", t("feedback.title", "ORDER SERVED"));
  safeSetText("sfSubtitle", t("feedback.subtitle", "How was your experience?"));
  safeSetPlaceholder("servedFeedbackCommentInput", t("feedback.commentPlaceholder", "Tell us about your food and service experience..."));
  safeSetText("btnLeaveCommentText", t("feedback.submitBtn", "Submit Feedback"));
  safeSetText("sfSuccessTitle", t("feedback.successTitle", "Thank You!"));
  safeSetText("sfSuccessMsg", t("feedback.successMsg", "Your feedback has been received. We appreciate your feedback!"));
  safeSetText("btnOrderAgainText", t("feedback.orderAgain", "ORDER AGAIN"));

  renderMenu();
  updateCartBar();
  renderCartSheet();
  renderAppViews();
  renderDeviceHistory();
}

async function init() {
  document.addEventListener("click", unlockAudioContext, { once: true });
  document.addEventListener("touchstart", unlockAudioContext, { once: true });

  await initI18n();

  tableNumber = await resolveTableSession();

  if (!tableNumber) {
    const landing = document.getElementById("landing");
    if (landing) landing.style.display = "block";
    return;
  }

  const app = document.getElementById("app");
  if (app) app.style.display = "block";

  safeSetText("tableNumberLabel", tableNumber);
  safeSetText("billTableLabel", tableNumber);

  wireLanguageSelector();
  await applyLanguage(currentLang);
  restoreRememberedCustomerName();

  loadMenu();
  loadCustomerActiveOrder(true);
  wireEvents();
  wireSearchAndFilters();
  registerServiceWorker();
  setupOfflineHandling();

  if (customerOrdersPollTimer) clearInterval(customerOrdersPollTimer);
  customerOrdersPollTimer = setInterval(() => loadCustomerActiveOrder(false), 3500);
}

function wireLanguageSelector() {
  const btn = document.getElementById("languageDropdownBtn");
  const menuEl = document.getElementById("languageMenu");

  if (!btn || !menuEl) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menuEl.classList.contains("show");
    menuEl.classList.toggle("show", !isOpen);
    btn.setAttribute("aria-expanded", String(!isOpen));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#languageSelector")) {
      menuEl.classList.remove("show");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  document.querySelectorAll(".language-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const selected = opt.dataset.lang;
      menuEl.classList.remove("show");
      btn.setAttribute("aria-expanded", "false");
      applyLanguage(selected);
    });
  });
}

async function loadMenu() {
  const container = document.getElementById("menuContainer");
  if (container) {
    container.innerHTML = '<div class="menu-loading-state"><div class="spinner"></div><p>Loading menu...</p></div>';
  }

  try {
    const res = await fetch("/api/menu");
    if (!res.ok) throw new Error("Network response was not ok");
    menu = await res.json();
    localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(menu));
  } catch (err) {
    const cached = localStorage.getItem(MENU_CACHE_KEY);
    menu = cached ? JSON.parse(cached) : [];
  }
  renderMenu();
}

async function loadCustomerActiveOrder(isInitial = false) {
  if (!tableNumber || !customerId) return;

  try {
    const res = await fetch(`/api/customer/active-order?table=${encodeURIComponent(tableNumber)}`, {
      headers: { "x-customer-token": customerId },
    });
    if (!res.ok) return;

    const data = await res.json();
    const active = data.activeOrder;
    const latestServed = data.latestServedOrder;
    const latestCancelled = data.latestCancelledOrder;

    if (latestCancelled && !active && !alertedCancelledOrders.has(latestCancelled.id)) {
      const isStaffCancelled = latestCancelled.cancelledByRole !== "CUSTOMER";
      await saveOrderToDeviceHistory(latestCancelled);
      alertedCancelledOrders.add(latestCancelled.id);

      if (!isInitial && isStaffCancelled) {
        playCustomerCancellationSound();
        showCustomerCancellationAlertModal(latestCancelled);
      }
    }

    if (isInitial) {
      if (active && (active.status === "pending" || active.status === "accepted")) {
        activeCustomerOrder = active;
        lastKnownStatus = active.status;
        currentViewMode = "ORDER_ONLY";
      } else {
        activeCustomerOrder = null;
        lastKnownStatus = null;
        currentViewMode = "MENU_INITIAL";
      }
      renderAppViews();
      renderDeviceHistory();
      return;
    }

    if (active) {
      if (lastKnownStatus && lastKnownStatus !== active.status) {
        if (active.status === "accepted") showToast(t("toasts.inProgress", "🔵 Your order is now being prepared."));
      }
      lastKnownStatus = active.status;
      activeCustomerOrder = active;

      if (currentViewMode === "MENU_INITIAL") {
        currentViewMode = "ORDER_ONLY";
      }
    } else {
      if (activeCustomerOrder && (activeCustomerOrder.status === "pending" || activeCustomerOrder.status === "accepted")) {
        const justServedOrder = latestServed || { ...activeCustomerOrder, status: "served", servedAt: new Date().toISOString() };
        await saveOrderToDeviceHistory(justServedOrder);
        showToast(t("toasts.served", "🟢 Order Served! We hope you enjoyed your meal."));

        servedFeedbackOrder = justServedOrder;
        selectedFeedbackRating = 0;
        currentViewMode = "SERVED_FEEDBACK";
        startFeedbackExpiryCountdown(justServedOrder);
      }

      activeCustomerOrder = null;
      lastKnownStatus = null;

      if (currentViewMode === "ORDER_ONLY") {
        currentViewMode = "MENU_INITIAL";
      }
    }

    renderAppViews();
    renderDeviceHistory();
  } catch (e) {}
}

function showCustomerCancellationAlertModal(order) {
  const modal = document.getElementById("customerCancellationAlertModal");
  if (!modal) return;

  const orderNum = order.dailyOrderNumber || "#" + (order.dailySeq || 1);
  const byRole = order.cancelledByRole || "Manager";
  const reason = order.cancellationReason || "Item unavailable";
  const time = order.cancelledTimeStr || order.orderTime || new Date(order.cancelledAt).toLocaleTimeString();

  safeSetText("ccaOrderNum", orderNum);
  safeSetText("ccaCancelledBy", `${order.cancelledByName || byRole} (${byRole})`);
  safeSetText("ccaCancelledTime", `${order.orderDate || ""} ${time}`);
  safeSetText("ccaReasonText", reason);

  modal.style.display = "grid";
}

function renderAppViews() {
  const orderView = document.getElementById("customerOrderOnlyView");
  const servedCard = document.getElementById("servedFeedbackCardSection");
  const menuSection = document.getElementById("menuBrowsingSection");
  const addBanner = document.getElementById("addModeBanner");

  if (!orderView || !servedCard || !menuSection) return;

  if (currentViewMode === "SERVED_FEEDBACK" && servedFeedbackOrder && servedFeedbackOrder.status !== "cancelled") {
    orderView.style.display = "none";
    menuSection.style.display = "none";
    servedCard.style.display = "block";
    renderServedFeedbackCard();
  } else if (activeCustomerOrder && currentViewMode === "ORDER_ONLY") {
    servedCard.style.display = "none";
    menuSection.style.display = "none";
    orderView.style.display = "block";
    if (addBanner) addBanner.style.display = "none";
    renderActiveOrderView();
  } else if (currentViewMode === "ADD_ITEMS_MODE") {
    servedCard.style.display = "none";
    orderView.style.display = "none";
    menuSection.style.display = "block";
    if (addBanner) {
      addBanner.style.display = "block";
      const orderNum = activeCustomerOrder?.dailyOrderNumber || "#" + (activeCustomerOrder?.dailySeq || 1);
      safeSetText("ambOrderTag", orderNum);
    }
  } else {
    servedCard.style.display = "none";
    orderView.style.display = "none";
    menuSection.style.display = "block";
    if (addBanner) addBanner.style.display = "none";
  }

  updateCartBar();
}

function renderActiveOrderView() {
  const container = document.getElementById("customerOrderOnlyView");
  if (!container || !activeCustomerOrder) return;

  const o = activeCustomerOrder;
  const orderNum = o.dailyOrderNumber || `#${String(o.dailySeq || 1).padStart(3, "0")}`;
  const status = o.status || "pending";
  const isPending = status === "pending";
  const isProgress = status === "accepted";

  let badgeClass = isProgress ? "order-status-progress" : "order-status-pending";
  let badgeLabel = isProgress ? t("orderStatus.inProgress", "IN PROGRESS") : t("orderStatus.pending", "PENDING");

  let step1Class = "done";
  let step2Class = isProgress ? "active" : "";
  let step3Class = "";

  const timePlaced = o.orderTime || o.pendingTimeStr || "";
  const timeAccepted = o.acceptedTimeStr || "";

  const timelineHtml = `
    <div class="order-timeline">
      <div class="timeline-step ${step1Class}">
        <div class="timeline-dot">✓</div>
        <span class="timeline-label">${escapeHtml(t("orderStatus.received", "Received"))}</span>
        ${timePlaced ? `<span class="timeline-time">${escapeHtml(timePlaced)}</span>` : ""}
      </div>
      <div class="timeline-line ${isProgress ? "done" : ""}"></div>
      <div class="timeline-step ${step2Class}">
        <div class="timeline-dot">${isProgress ? "●" : "○"}</div>
        <span class="timeline-label">${escapeHtml(t("orderStatus.preparing", "Preparing"))}</span>
        ${timeAccepted ? `<span class="timeline-time">${escapeHtml(timeAccepted)}</span>` : ""}
      </div>
      <div class="timeline-line"></div>
      <div class="timeline-step ${step3Class}">
        <div class="timeline-dot">○</div>
        <span class="timeline-label">${escapeHtml(t("orderStatus.timelineServed", "Served"))}</span>
      </div>
    </div>
  `;

  let actionsHtml = "";
  if (isPending) {
    actionsHtml = `
      <button type="button" class="add-items-button" id="triggerAddItemsBtn">
        ${escapeHtml(t("orderStatus.addItemsBtn", "ADD ITEMS"))}
      </button>
      <div class="order-actions" style="margin-top:12px;">
        <button type="button" class="order-action-btn edit" id="triggerEditBtn">
          ${escapeHtml(t("orderStatus.editBtn", "Edit"))}
        </button>
        <button type="button" class="order-action-btn cancel" id="triggerCancelBtn">
          ${escapeHtml(t("orderStatus.cancelBtn", "Cancel"))}
        </button>
      </div>
    `;
  } else {
    actionsHtml = `
      <div class="order-lock-notice">
        ${escapeHtml(t("orderStatus.lockedNotice", "Locked"))}
      </div>
    `;
  }

  let specReqHtml = "";
  if (o.customerSuggestion && o.customerSuggestion.trim()) {
    specReqHtml = `
      <div class="order-card-spec-req">
        <strong>💬 ${escapeHtml(t("cart.specialReqLabel", "Special Request"))}:</strong> "${escapeHtml(o.customerSuggestion.trim())}"
      </div>
    `;
  }

  container.innerHTML = `
    <div class="customer-order-header">
      <h1 class="customer-order-title">${escapeHtml(t("orderStatus.myOrderTitle", "MY ORDER"))}</h1>
      <div class="customer-order-subtitle">${escapeHtml(orderNum)} · ${escapeHtml(t("table.label", "Table"))} ${escapeHtml(o.tableNumber)}</div>
      <div class="order-status-badge ${badgeClass}">${badgeLabel}</div>
    </div>

    <div class="order-customer-line" style="text-align:center;">
      👤 <strong>${escapeHtml(t("cart.nameLabel", "Customer Name"))}:</strong> ${escapeHtml(o.customerName || "Customer")}
    </div>

    ${timelineHtml}

    <div class="customer-order-items-wrap">
      ${(o.items || [])
        .map(
          (it) => `
        <div class="customer-order-item">
          <div class="customer-order-item-info">
            <h3 class="customer-order-item-name">${escapeHtml(it.customerName || it.name)}</h3>
            <div class="customer-order-item-quantity">${it.qty} × ${formatPrice(it.price)}</div>
          </div>
          <div class="customer-order-item-price">${formatPrice(it.price * it.qty)}</div>
        </div>`
        )
        .join("")}
    </div>

    ${specReqHtml}

    <div class="summary-row total" style="margin-top:14px;">
      <span>${escapeHtml(t("cart.total", "Total"))}</span>
      <span style="color:var(--red);font-size:18px;">${formatPrice(o.total)}</span>
    </div>

    ${actionsHtml}
  `;

  safeAddListener("triggerAddItemsBtn", "click", () => {
    currentViewMode = "ADD_ITEMS_MODE";
    cart = {};
    renderAppViews();
    showToast(t("orderStatus.addModeBanner"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  safeAddListener("triggerEditBtn", "click", () => openEditOrderModal(o));
  safeAddListener("triggerCancelBtn", "click", () => openCancelModal(o));
}

function renderServedFeedbackCard() {
  if (!servedFeedbackOrder) return;
  const orderNum = servedFeedbackOrder.dailyOrderNumber || "#" + (servedFeedbackOrder.dailySeq || 1);
  safeSetText("sfOrderNumTag", orderNum);
  safeSetText("sfTableTag", `${t("table.label", "Table")} ${servedFeedbackOrder.tableNumber}`);

  updateFeedbackStars(selectedFeedbackRating);
}

function updateFeedbackStars(rating) {
  selectedFeedbackRating = rating;
  const stars = document.querySelectorAll("#servedFeedbackStars .feedback-star");
  
  stars.forEach((btn) => {
    const r = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle("active", r <= rating);
    btn.classList.remove("preview");
  });

  safeSetText("servedFeedbackRatingLabel", rating > 0 ? t(`feedback.stars.${rating}`, `${rating} Stars`) : "");
}

function previewFeedbackStars(hoverRating) {
  const stars = document.querySelectorAll("#servedFeedbackStars .feedback-star");
  stars.forEach((btn) => {
    const r = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle("preview", r <= hoverRating);
  });
}

function startFeedbackExpiryCountdown(order) {
  if (feedbackCountdownInterval) clearInterval(feedbackCountdownInterval);

  const servedTimeMs = new Date(order.servedAt || order.updatedAt || Date.now()).getTime();
  const expiresAtMs = order.feedbackExpiresAt ? new Date(order.feedbackExpiresAt).getTime() : (servedTimeMs + FEEDBACK_WINDOW_MS);

  function updateTimer() {
    const now = Date.now();
    const remainingMs = expiresAtMs - now;

    if (remainingMs <= 0) {
      clearInterval(feedbackCountdownInterval);
      feedbackCountdownInterval = null;
      servedFeedbackOrder = null;
      currentViewMode = "MENU_INITIAL";
      showToast(t("feedback.expired"));
      renderAppViews();
      return;
    }

    const totalSeconds = Math.floor(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    let displayStr = `${t("feedback.availablePrefix")} ${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (hours === 0 && minutes < 15) {
      const seconds = totalSeconds % 60;
      displayStr = `${t("feedback.availablePrefix")} ${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    safeSetText("feedbackCountdownTimer", displayStr);

    const timerBox = document.getElementById("feedbackExpiryTimerBox");
    if (timerBox) {
      timerBox.classList.toggle("warning", remainingMs < 15 * 60 * 1000);
    }
  }

  updateTimer();
  feedbackCountdownInterval = setInterval(updateTimer, 1000);
}

async function submitServedFeedbackComment() {
  if (!servedFeedbackOrder) return;

  const commentInput = document.getElementById("servedFeedbackCommentInput");
  const comment = (commentInput?.value || "").trim();

  const hasRating = selectedFeedbackRating >= 1 && selectedFeedbackRating <= 5;
  const hasComment = comment.length > 0;

  if (!hasRating && !hasComment) {
    showToast(t("feedback.emptyPrompt"));
    return;
  }

  const btn = document.getElementById("submitServedCommentBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("feedback.submitting");
  }

  try {
    const res = await fetch(`/api/orders/${servedFeedbackOrder.id}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-customer-token": customerId,
      },
      body: JSON.stringify({
        customerId,
        rating: hasRating ? selectedFeedbackRating : null,
        comment,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || t("toasts.genericError"));
    }

    if (feedbackCountdownInterval) clearInterval(feedbackCountdownInterval);

    const formBody = document.getElementById("servedFeedbackFormBody");
    const successBox = document.getElementById("servedFeedbackSuccessBox");
    if (formBody) formBody.style.display = "none";
    if (successBox) successBox.style.display = "block";

    if (data.order) {
      await saveOrderToDeviceHistory(data.order);
    }

    showToast(t("toasts.feedbackSubmitted"));
  } catch (err) {
    showToast(err.message || t("toasts.genericError"));
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("feedback.submitBtn");
    }
  }
}

function resetForNewOrderAfterFeedback() {
  if (feedbackCountdownInterval) clearInterval(feedbackCountdownInterval);
  servedFeedbackOrder = null;
  activeCustomerOrder = null;
  selectedFeedbackRating = 0;
  currentViewMode = "MENU_INITIAL";
  cart = {};

  const formBody = document.getElementById("servedFeedbackFormBody");
  const successBox = document.getElementById("servedFeedbackSuccessBox");
  if (formBody) formBody.style.display = "block";
  if (successBox) successBox.style.display = "none";

  const commentInput = document.getElementById("servedFeedbackCommentInput");
  if (commentInput) commentInput.value = "";

  const btn = document.getElementById("submitServedCommentBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = t("feedback.submitBtn");
  }

  renderAppViews();
  renderMenu();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- EDIT ORDER LOGIC ----------

function openEditOrderModal(order) {
  if (order.status !== "pending") {
    showStatusAlert("🔒 " + t("toasts.genericError"), t("orderStatus.lockedNotice"), "🔒");
    return;
  }

  editOrderDraftItems = (order.items || []).map((it) => ({ ...it }));

  const specReqInput = document.getElementById("editSpecialRequestInput");
  if (specReqInput) specReqInput.value = order.customerSuggestion || "";

  const errEl = document.getElementById("editOrderError");
  if (errEl) errEl.classList.remove("show");

  renderEditModalItems();
  openModalOverlay("editOrderModal");
}

function renderEditModalItems() {
  const container = document.getElementById("editOrderItemsList");
  if (!container) return;

  if (editOrderDraftItems.length === 0) {
    container.innerHTML = `<p class="empty-note">${escapeHtml(t("cart.empty"))}</p>`;
    safeSetText("editModalTotalDisplay", formatPrice(0));
    return;
  }

  container.innerHTML = editOrderDraftItems
    .map(
      (it, idx) => `
    <div class="edit-item-row">
      <div class="eir-info">
        <strong class="eir-name">${escapeHtml(it.customerName || it.name)}</strong>
        <span class="eir-unit-price">${formatPrice(it.price)} / ea</span>
      </div>
      <div class="quantity-control">
        <button type="button" class="quantity-button" data-edit-action="dec" data-idx="${idx}" aria-label="Decrease quantity">−</button>
        <span class="quantity-value">${it.qty}</span>
        <button type="button" class="quantity-button plus" data-edit-action="inc" data-idx="${idx}" aria-label="Increase quantity" ${it.qty >= MAX_ITEM_QUANTITY ? "disabled" : ""}>+</button>
      </div>
    </div>`
    )
    .join("");

  const currentDraftTotal = editOrderDraftItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  safeSetText("editModalTotalDisplay", formatPrice(currentDraftTotal));

  container.querySelectorAll("[data-edit-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const action = btn.dataset.editAction;
      if (action === "inc") {
        if (editOrderDraftItems[idx].qty >= MAX_ITEM_QUANTITY) {
          showToast(t("cart.maxQtyWarning"));
          return;
        }
        editOrderDraftItems[idx].qty = Math.min(MAX_ITEM_QUANTITY, editOrderDraftItems[idx].qty + 1);
      } else if (action === "dec") {
        if (editOrderDraftItems[idx].qty > 1) {
          editOrderDraftItems[idx].qty -= 1;
        } else {
          editOrderDraftItems.splice(idx, 1);
        }
      }
      renderEditModalItems();
    });
  });
}

async function saveEditedOrder() {
  if (!activeCustomerOrder) return;

  const errorEl = document.getElementById("editOrderError");
  if (errorEl) errorEl.classList.remove("show");

  if (editOrderDraftItems.length === 0) {
    if (errorEl) {
      errorEl.textContent = t("cart.empty");
      errorEl.classList.add("show");
    }
    return;
  }

  const suggestion = (document.getElementById("editSpecialRequestInput")?.value || "").trim();
  const saveBtn = document.getElementById("saveEditedOrderBtn");

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "...";
  }

  try {
    const res = await fetch(`/api/orders/${activeCustomerOrder.id}/customer-edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-customer-token": customerId,
      },
      body: JSON.stringify({
        customerId,
        items: editOrderDraftItems.map((i) => ({ itemId: i.itemId, qty: i.qty })),
        customerSuggestion: suggestion,
        customerLanguage: currentLang,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || t("toasts.genericError"));
    }

    closeModalOverlay("editOrderModal");
    showStatusAlert(t("toasts.orderUpdated"), t("toasts.orderUpdated"), "✅");
    showToast(t("toasts.orderUpdated"));
    await loadCustomerActiveOrder();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.classList.add("show");
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = t("editModal.save");
    }
  }
}

// ---------- ADD ITEMS TO EXISTING ORDER ----------

function openAddItemsConfirmationModal() {
  if (!activeCustomerOrder || activeCustomerOrder.status !== "pending") {
    currentViewMode = "ORDER_ONLY";
    renderAppViews();
    showStatusAlert("🔒 " + t("orderStatus.lockedNotice"), t("orderStatus.lockedNotice"), "🔒");
    return;
  }

  const entries = cartEntries();
  if (entries.length === 0) return;

  const reviewList = document.getElementById("addItemsReviewList");
  if (reviewList) {
    reviewList.innerHTML = entries
      .map(
        (e) => `
      <div class="edit-item-row">
        <div class="eir-info">
          <strong class="eir-name">${escapeHtml(getLocalizedField(e.item, "name"))}</strong>
          <span class="eir-unit-price">${formatPrice(e.item.cost)} / ea</span>
        </div>
        <div class="quantity-value" style="font-weight:700;">${e.qty} ×</div>
      </div>`
      )
      .join("");
  }

  const addTotal = cartTotal();
  const prevTotal = activeCustomerOrder.total;
  const newTotal = prevTotal + addTotal;

  safeSetText("displayPrevTotal", formatPrice(prevTotal));
  safeSetText("displayAddTotal", `+ ${formatPrice(addTotal)}`);
  safeSetText("displayNewTotal", formatPrice(newTotal));

  const errEl = document.getElementById("confirmAddItemsError");
  if (errEl) errEl.classList.remove("show");

  openModalOverlay("confirmAddItemsModal");
}

async function submitAddItemsToOrder() {
  if (!activeCustomerOrder) return;

  const entries = cartEntries();
  const errEl = document.getElementById("confirmAddItemsError");
  if (errEl) errEl.classList.remove("show");

  const btn = document.getElementById("submitConfirmAddBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }

  try {
    const res = await fetch(`/api/orders/${activeCustomerOrder.id}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-customer-token": customerId,
      },
      body: JSON.stringify({
        customerId,
        items: entries.map((e) => ({ itemId: e.item.id, qty: e.qty })),
        customerLanguage: currentLang,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || t("toasts.genericError"));
    }

    cart = {};
    closeModalOverlay("confirmAddItemsModal");
    currentViewMode = "ORDER_ONLY";

    showStatusAlert(
      t("toasts.itemsAdded"),
      `${t("toasts.itemsAdded")} (${data.order.dailyOrderNumber}) · ${t("addModal.newTotal")}: ${formatPrice(data.newTotal)}`,
      "✅"
    );
    showToast(t("toasts.itemsAdded"));
    await loadCustomerActiveOrder();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("addModal.confirmBtn");
    }
  }
}

// ---------- CANCEL ORDER WITH REQUIRED REASON ----------

function openCancelModal(order) {
  if (order.status !== "pending") {
    showStatusAlert("🔒 " + t("orderStatus.lockedNotice"), t("orderStatus.lockedNotice"), "🔒");
    return;
  }

  const orderNum = order.dailyOrderNumber || "#" + order.dailySeq;
  safeSetText("cancelModalMessage", `${t("cancelModal.message")} (${orderNum})`);

  const reasonInput = document.getElementById("custCancelReasonInput");
  if (reasonInput) reasonInput.value = "";

  const confirmBtn = document.getElementById("confirmCancelOrderBtn");
  if (confirmBtn) confirmBtn.disabled = true;

  const errEl = document.getElementById("cancelOrderError");
  if (errEl) errEl.classList.remove("show");

  openModalOverlay("cancelOrderModal");
}

async function confirmCancelOrder() {
  if (!activeCustomerOrder) return;

  const reasonInput = document.getElementById("custCancelReasonInput");
  const reason = (reasonInput?.value || "").trim();

  const errEl = document.getElementById("cancelOrderError");
  if (errEl) errEl.classList.remove("show");

  if (!reason) {
    if (errEl) {
      errEl.textContent = t("cancelModal.reasonRequired");
      errEl.classList.add("show");
    }
    return;
  }

  const btn = document.getElementById("confirmCancelOrderBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }

  try {
    const res = await fetch(`/api/orders/${activeCustomerOrder.id}/cancel-by-customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-customer-token": customerId,
      },
      body: JSON.stringify({
        customerId,
        cancellationReason: reason,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || t("toasts.genericError"));
    }

    if (data.order) {
      await saveOrderToDeviceHistory(data.order);
    }

    closeModalOverlay("cancelOrderModal");
    activeCustomerOrder = null;
    currentViewMode = "MENU_INITIAL";

    showStatusAlert(t("toasts.orderCancelled"), t("toasts.orderCancelled"), "🔴");
    showToast(t("toasts.orderCancelled"));
    renderAppViews();
    renderDeviceHistory();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("cancelModal.confirmBtn");
    }
  }
}

function openModalOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "grid";
}

function closeModalOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

function showStatusAlert(title, message, icon = "✅") {
  safeSetText("statusAlertIcon", icon);
  safeSetText("statusAlertTitle", title);
  safeSetText("statusAlertMessage", message);
  openModalOverlay("statusAlertModal");
}

// ---------- DYNAMIC MULTILINGUAL 3-COLUMN MENU RENDERING ----------

function getFilteredMenu() {
  return menu.filter((item) => {
    let matchesCategory = true;
    if (activeCategoryFilter !== "all") {
      const itemCat = String(item.category || "Food").toLowerCase();
      const filterCat = activeCategoryFilter.toLowerCase();
      matchesCategory =
        itemCat === filterCat ||
        (filterCat.startsWith("drink") && itemCat.startsWith("drink")) ||
        (filterCat.startsWith("food") && itemCat.startsWith("food"));
    }

    const q = currentSearchQuery.trim().toLowerCase();
    if (!q) return matchesCategory;

    const localizedName = getLocalizedField(item, "name").toLowerCase();
    const englishName = (item.translations?.en?.name || (typeof item.name === "object" ? item.name.en : item.name) || "").toLowerCase();
    const localizedDesc = getLocalizedField(item, "description").toLowerCase();
    const localizedIng = getLocalizedIngredients(item).toLowerCase();

    const matchesSearch =
      localizedName.includes(q) ||
      englishName.includes(q) ||
      localizedDesc.includes(q) ||
      localizedIng.includes(q);

    return matchesCategory && matchesSearch;
  });
}

function renderMenu() {
  const container = document.getElementById("menuContainer");
  if (!container) return;
  container.innerHTML = "";

  if (menu.length === 0) {
    container.innerHTML = `<p class="empty-note">${escapeHtml(t("menu.noResultsDesc"))}</p>`;
    return;
  }

  const filteredItems = getFilteredMenu();

  if (filteredItems.length === 0) {
    container.innerHTML = `
      <div class="no-results-box" style="text-align:center;padding:32px 16px;">
        <div class="no-results-icon" style="font-size:36px;margin-bottom:8px;">🔍</div>
        <h3>${escapeHtml(t("menu.noResultsTitle"))}</h3>
        <p style="color:var(--ink-soft);font-size:14px;">${escapeHtml(t("menu.noResultsDesc"))}</p>
        <button id="clearAllFiltersBtn" class="secondary-btn" style="width:auto;padding:8px 20px;margin-top:12px;">${escapeHtml(t("menu.resetFilters"))}</button>
      </div>
    `;
    const clearBtn = document.getElementById("clearAllFiltersBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        currentSearchQuery = "";
        activeCategoryFilter = "all";
        const searchInput = document.getElementById("menuSearchInput");
        if (searchInput) searchInput.value = "";
        const searchClearBtn = document.getElementById("searchClearBtn");
        if (searchClearBtn) searchClearBtn.style.display = "none";

        document.querySelectorAll("#categoryFilterBar .menu-filter-button").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.category === "all");
        });
        renderMenu();
      });
    }
    return;
  }

  const categories = [...new Set(filteredItems.map((m) => m.category || "Food"))];

  categories.forEach((cat) => {
    const heading = document.createElement("h2");
    heading.className = "category-heading";
    const isDrink = String(cat).toLowerCase().startsWith("drink");
    const catIcon = isDrink ? "🥤" : "🍔";
    const localizedCatTitle = isDrink ? t("menu.catDrinks", "Drinks") : t("menu.catFood", "Food");
    heading.textContent = `${catIcon} ${localizedCatTitle}`;
    container.appendChild(heading);

    filteredItems
      .filter((m) => (m.category || "Food") === cat)
      .forEach((item) => container.appendChild(renderMenuRow(item)));
  });
}

function renderMenuRow(item) {
  const row = document.createElement("div");
  row.className = "menu-row" + (item.available ? "" : " unavailable");
  const imageUrl = item.image || PLACEHOLDER_IMAGE;

  const localizedName = getLocalizedField(item, "name");
  const localizedDesc = getLocalizedField(item, "description");
  const localizedIngredients = getLocalizedIngredients(item);
  const currentItemQty = cart[item.id] || 0;

  row.innerHTML = `
    <div class="item-img-wrap" data-lightbox-id="${item.id}" title="Tap to preview">
      <img class="item-img" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(localizedName)}" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';" />
      <span class="zoom-badge">🔍</span>
    </div>
    
    <div class="item-main-info">
      <h3 class="item-name">${escapeHtml(localizedName)}</h3>
      ${localizedDesc ? `<p class="item-desc">${escapeHtml(localizedDesc)}</p>` : ""}
      ${localizedIngredients ? `<p class="item-ingredients">${escapeHtml(localizedIngredients)}</p>` : ""}
      ${!item.available ? `<span class="badge out">${escapeHtml(t("menu.outOfStock"))}</span>` : ""}
    </div>

    <div class="item-action-col">
      <span class="item-price">${formatPrice(item.cost)}</span>
      ${
        item.available
          ? `
        <div class="quantity-control">
          <button type="button" class="quantity-button" data-action="dec" data-id="${item.id}" aria-label="Decrease quantity">−</button>
          <span class="quantity-value" id="qty-${item.id}">${currentItemQty}</span>
          <button type="button" class="quantity-button plus" data-action="inc" data-id="${item.id}" aria-label="Increase quantity" ${currentItemQty >= MAX_ITEM_QUANTITY ? "disabled" : ""}>+</button>
        </div>
        <button type="button" class="add-btn" data-action="add" data-id="${item.id}">${escapeHtml(t("menu.add"))}</button>
      `
          : `<span class="badge out" style="margin:0;">${escapeHtml(t("menu.outOfStock"))}</span>`
      }
    </div>
  `;

  return row;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function openLightbox(item) {
  if (!item) return;
  const modal = document.getElementById("lightboxModal");
  const img = document.getElementById("lightboxImg");
  if (img) {
    img.src = item.image || PLACEHOLDER_IMAGE;
    img.onerror = () => { img.src = PLACEHOLDER_IMAGE; };
  }
  safeSetText("lightboxTitle", getLocalizedField(item, "name"));
  safeSetText("lightboxPrice", formatPrice(item.cost));
  safeSetText("lightboxDesc", getLocalizedField(item, "description") || "");
  safeSetText("lightboxIngredients", getLocalizedIngredients(item));
  if (modal) modal.classList.add("show");
}

function closeLightbox() {
  const modal = document.getElementById("lightboxModal");
  if (modal) modal.classList.remove("show");
}

function changeQty(itemId, delta) {
  const current = cart[itemId] || 0;
  if (delta > 0 && current >= MAX_ITEM_QUANTITY) {
    showToast(t("cart.maxQtyWarning"));
    return;
  }
  const next = Math.max(0, Math.min(MAX_ITEM_QUANTITY, current + delta));
  cart[itemId] = next;
  safeSetText(`qty-${itemId}`, next);

  const plusBtn = document.querySelector(`.quantity-button.plus[data-id="${itemId}"]`);
  if (plusBtn) {
    plusBtn.disabled = next >= MAX_ITEM_QUANTITY;
  }
}

function addToCart(itemId) {
  const current = cart[itemId] || 0;
  if (current >= MAX_ITEM_QUANTITY) {
    showToast(t("cart.maxQtyWarning"));
    return;
  }
  cart[itemId] = current === 0 ? 1 : current;
  safeSetText(`qty-${itemId}`, cart[itemId]);
  
  const plusBtn = document.querySelector(`.quantity-button.plus[data-id="${itemId}"]`);
  if (plusBtn) {
    plusBtn.disabled = cart[itemId] >= MAX_ITEM_QUANTITY;
  }

  updateCartBar();
  flashAddButton(itemId);
}

function flashAddButton(itemId) {
  const btn = document.querySelector(`.add-btn[data-id="${itemId}"]`);
  if (!btn) return;
  const original = t("menu.add");
  btn.textContent = t("menu.added");
  setTimeout(() => (btn.textContent = original), 900);
}

function cartEntries() {
  return Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([itemId, qty]) => ({ item: menu.find((m) => m.id === itemId), qty }))
    .filter((e) => e.item);
}

function cartTotal() {
  return cartEntries().reduce((sum, e) => sum + (e.item.cost || e.item.price || 0) * e.qty, 0);
}

function updateCartBar() {
  const entries = cartEntries();
  const count = entries.reduce((s, e) => s + e.qty, 0);
  const bar = document.getElementById("cartBar");
  safeSetText("cartCount", count);
  safeSetText("cartTotal", formatPrice(cartTotal()));

  const viewBtn = document.getElementById("viewCartBtn");
  if (viewBtn) {
    if (currentViewMode === "ADD_ITEMS_MODE") {
      viewBtn.textContent = t("addModal.confirmBtn");
    } else {
      viewBtn.textContent = t("cart.viewOrder");
    }
  }

  if (bar) bar.classList.toggle("show", count > 0);
}

function renderCartSheet() {
  const linesEl = document.getElementById("cartLines");
  const entries = cartEntries();
  if (linesEl) {
    if (entries.length === 0) {
      linesEl.innerHTML = `<p class="empty-note">${escapeHtml(t("cart.empty"))}</p>`;
    } else {
      linesEl.innerHTML = entries
        .map(
          (e) => `
        <div class="cart-line">
          <span class="cart-line-name">${e.qty} × ${escapeHtml(getLocalizedField(e.item, "name"))}</span>
          <span class="cart-line-price">${formatPrice(e.qty * (e.item.cost || e.item.price || 0))}</span>
        </div>`
        )
        .join("");
    }
  }

  safeSetText("cartSheetTotal", formatPrice(cartTotal()));
  const placeBtn = document.getElementById("placeOrderBtn");
  if (placeBtn) placeBtn.disabled = entries.length === 0;

  const errEl = document.getElementById("custOrderError");
  if (errEl) errEl.classList.remove("show");
}

function queuePendingOrder(payload) {
  const queue = JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || "[]");
  queue.push({ ...payload, queuedAt: Date.now() });
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(queue));
}

function pendingOrderCount() {
  return JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || "[]").length;
}

async function syncPendingOrders() {
  if (!navigator.onLine) return;
  const queue = JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY) || "[]");
  if (queue.length === 0) return;
  const remaining = [];
  for (const payload of queue) {
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-customer-token": customerId,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) remaining.push(payload);
    } catch {
      remaining.push(payload);
    }
  }
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(remaining));
  if (remaining.length === 0) {
    showToast(t("toasts.orderSuccess"));
    loadCustomerActiveOrder();
  }
}

// ---------- PLACE NEW ORDER ----------

async function placeOrder() {
  if (isSubmittingOrder) return;

  const entries = cartEntries();
  if (entries.length === 0) return;

  const nameInput = document.getElementById("custNameInput");
  const suggestionInput = document.getElementById("custSuggestionInput");
  const errorEl = document.getElementById("custOrderError");

  if (errorEl) errorEl.classList.remove("show");

  const customerName = (nameInput?.value || "").trim();
  if (!customerName) {
    if (errorEl) {
      errorEl.textContent = t("cart.nameError");
      errorEl.classList.add("show");
    }
    if (nameInput) nameInput.focus();
    return;
  }

  localStorage.setItem(CUST_NAME_STORAGE_KEY, customerName);

  const customerSuggestion = (suggestionInput?.value || "").trim();

  const payload = {
    tableNumber,
    customerId,
    customerName,
    customerSuggestion,
    customerLanguage: currentLang,
    items: entries.map((e) => ({ itemId: e.item.id, qty: e.qty })),
  };

  const btn = document.getElementById("placeOrderBtn");
  isSubmittingOrder = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("cart.sending");
  }

  if (!navigator.onLine) {
    queuePendingOrder(payload);
    cart = {};
    if (suggestionInput) suggestionInput.value = "";

    renderMenu();
    updateCartBar();
    closeSheet("cartSheet");
    showToast(t("toasts.offlineQueued"));

    isSubmittingOrder = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `🛒 <span>${escapeHtml(t("cart.placeOrder"))}</span>`;
    }
    return;
  }

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-customer-token": customerId,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Unable to send order");
    }

    const order = await res.json();

    cart = {};
    if (suggestionInput) suggestionInput.value = "";

    renderMenu();
    updateCartBar();
    closeSheet("cartSheet");

    currentViewMode = "ORDER_ONLY";
    activeCustomerOrder = order;

    showToast(`${t("toasts.orderSuccess")}, ${customerName}! (${order.dailyOrderNumber})`);
    renderAppViews();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || "Unable to send order";
      errorEl.classList.add("show");
    } else {
      showToast(err.message || "Unable to send order");
    }
  } finally {
    isSubmittingOrder = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `🛒 <span>${escapeHtml(t("cart.placeOrder"))}</span>`;
    }
  }
}

// ---------- BILLING & PAYMENTS ----------

async function loadBill() {
  const billOrders = document.getElementById("billOrders");
  if (billOrders) billOrders.innerHTML = '<p class="empty-note">Loading...</p>';
  try {
    const res = await fetch(`/api/orders?table=${encodeURIComponent(tableNumber)}`, {
      headers: { "x-customer-token": customerId },
    });
    const data = await res.json();
    renderBill(data.orders, data.unpaidTotal);
  } catch {
    if (billOrders) billOrders.innerHTML = '<p class="empty-note">Could not load bill while offline.</p>';
    safeSetText("billTotal", formatPrice(0));
    const payBtn = document.getElementById("payBtn");
    if (payBtn) payBtn.disabled = true;
  }
}

function renderBill(orders, unpaidTotal) {
  const billOrders = document.getElementById("billOrders");
  const pending = pendingOrderCount();

  if (billOrders) {
    if ((!orders || orders.length === 0) && pending === 0) {
      billOrders.innerHTML = `<p class="empty-note">${escapeHtml(t("bill.noOrders"))}</p>`;
    } else {
      billOrders.innerHTML = (orders || [])
        .map((o) => {
          const orderNum = o.dailyOrderNumber || `#${String(o.seq || 1).padStart(3, "0")}`;
          const timeStr = o.orderDate && o.orderTime ? `${o.orderDate} · ${o.orderTime}` : new Date(o.createdAt).toLocaleString();

          let requestHtml = "";
          if (o.customerSuggestion) {
            requestHtml = `<div style="font-size:12px;color:var(--mustard);font-style:italic;margin-top:4px;">${escapeHtml(t("cart.specialReqLabel"))}: "${escapeHtml(o.customerSuggestion)}"</div>`;
          }

          return `
          <div class="order-history-item">
            <div class="oh-top">
              <strong>${escapeHtml(t("cart.sheetTitle"))} ${escapeHtml(orderNum)}</strong>
              <span class="status-tag ${o.status}">${o.status}</span>
            </div>
            <div class="oh-time-tag">📅 ${escapeHtml(timeStr)} · ${escapeHtml(t("cart.nameLabel"))}: <strong>${escapeHtml(o.customerName || "Guest")}</strong></div>
            <div>${(o.items || []).map((l) => `${l.qty} × ${escapeHtml(l.customerName || l.name)}`).join(", ")}</div>
            ${requestHtml}
            <div style="margin-top:6px;font-weight:700;color:var(--red);">${formatPrice(o.total)}</div>
          </div>`;
        })
        .join("");

      if (pending > 0) {
        billOrders.innerHTML += `<p class="pending-note">${pending} order(s) waiting to send...</p>`;
      }
    }
  }

  safeSetText("billTotal", formatPrice(unpaidTotal || 0));
  const payBtn = document.getElementById("payBtn");
  if (payBtn) payBtn.disabled = (unpaidTotal || 0) <= 0;
}

async function payBill() {
  const btn = document.getElementById("payBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }
  try {
    const res = await fetch(`/api/orders?table=${encodeURIComponent(tableNumber)}`, {
      headers: { "x-customer-token": customerId },
    });
    const data = await res.json();
    const unpaid = (data.orders || []).filter((o) => o.status !== "paid" && o.status !== "cancelled");
    for (const order of unpaid) {
      await fetch(`/api/orders/${order.id}/pay`, {
        method: "POST",
        headers: { "x-customer-token": customerId },
      });
    }
    showToast(t("toasts.orderSuccess"));
    await loadBill();
    await loadCustomerActiveOrder();
  } catch {
    showToast("Payment failed. Please check connection.");
  } finally {
    if (btn) btn.textContent = t("bill.payNow");
  }
}

function setupOfflineHandling() {
  const banner = document.getElementById("offlineBanner");
  function update() {
    if (banner) banner.classList.toggle("show", !navigator.onLine);
    if (navigator.onLine) syncPendingOrders();
  }
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
  setInterval(() => {
    if (navigator.onLine) syncPendingOrders();
  }, 15000);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
}

function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.style.cssText =
      "position:fixed;left:50%;bottom:110px;transform:translateX(-50%);background:#192520;color:#f4f5f0;padding:10px 18px;border-radius:8px;font-size:13.5px;z-index:2100;max-width:85vw;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,0.25);";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = "1";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.style.opacity = "0"), 3500);
}

function openSheet(id) {
  const backdrop = document.getElementById("sheetBackdrop");
  const el = document.getElementById(id);
  if (backdrop) backdrop.classList.add("show");
  if (el) el.classList.add("show");
}

function closeSheet(id) {
  const backdrop = document.getElementById("sheetBackdrop");
  const el = document.getElementById(id);
  if (backdrop) backdrop.classList.remove("show");
  if (el) el.classList.remove("show");
}

function wireSearchAndFilters() {
  const searchInput = document.getElementById("menuSearchInput");
  const clearBtn = document.getElementById("searchClearBtn");

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      currentSearchQuery = e.target.value;
      if (clearBtn) {
        clearBtn.style.display = currentSearchQuery.trim().length > 0 ? "inline-flex" : "none";
      }
      renderMenu();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      currentSearchQuery = "";
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
      clearBtn.style.display = "none";
      renderMenu();
    });
  }

  document.querySelectorAll("#categoryFilterBar .menu-filter-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#categoryFilterBar .menu-filter-button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      currentSearchQuery = "";
      if (searchInput) searchInput.value = "";
      if (clearBtn) clearBtn.style.display = "none";

      activeCategoryFilter = btn.dataset.category || "all";
      renderMenu();
    });
  });
}

function wireEvents() {
  const menuContainer = document.getElementById("menuContainer");
  if (menuContainer) {
    menuContainer.addEventListener("click", (e) => {
      const imgWrap = e.target.closest("[data-lightbox-id]");
      if (imgWrap) {
        const item = menu.find((m) => m.id === imgWrap.dataset.lightboxId);
        if (item) openLightbox(item);
        return;
      }

      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === "inc") changeQty(id, 1);
      if (action === "dec") changeQty(id, -1);
      if (action === "add") addToCart(id);
      if (action === "inc" || action === "dec") updateCartBar();
    });
  }

  safeAddListener("viewCartBtn", "click", () => {
    if (currentViewMode === "ADD_ITEMS_MODE") {
      openAddItemsConfirmationModal();
    } else {
      renderCartSheet();
      openSheet("cartSheet");
    }
  });

  safeAddListener("backToMyOrderTopBtn", "click", () => {
    currentViewMode = "ORDER_ONLY";
    cart = {};
    renderAppViews();
    showToast(t("orderStatus.myOrderTitle"));
  });

  safeAddListener("viewBillBtn", "click", () => {
    closeSheet("cartSheet");
    loadBill();
    openSheet("billSheet");
  });

  safeAddListener("placeOrderBtn", "click", placeOrder);
  safeAddListener("payBtn", "click", payBill);

  const starsContainer = document.getElementById("servedFeedbackStars");
  if (starsContainer) {
    starsContainer.addEventListener("mouseleave", () => {
      updateFeedbackStars(selectedFeedbackRating);
    });

    document.querySelectorAll("#servedFeedbackStars .feedback-star").forEach((btn) => {
      btn.addEventListener("mouseenter", () => {
        const hoverRating = parseInt(btn.dataset.rating, 10);
        previewFeedbackStars(hoverRating);
      });

      btn.addEventListener("click", () => {
        const rating = parseInt(btn.dataset.rating, 10);
        updateFeedbackStars(rating);
        btn.classList.add("just-selected");
        setTimeout(() => btn.classList.remove("just-selected"), 280);
      });
    });
  }

  safeAddListener("submitServedCommentBtn", "click", submitServedFeedbackComment);
  safeAddListener("startNewOrderAfterFeedbackBtn", "click", resetForNewOrderAfterFeedback);

  safeAddListener("closeEditModalBtn", "click", () => closeModalOverlay("editOrderModal"));
  safeAddListener("cancelEditOrderBtn", "click", () => closeModalOverlay("editOrderModal"));
  safeAddListener("saveEditedOrderBtn", "click", saveEditedOrder);

  safeAddListener("closeConfirmAddModalBtn", "click", () => closeModalOverlay("confirmAddItemsModal"));
  safeAddListener("cancelConfirmAddBtn", "click", () => closeModalOverlay("confirmAddItemsModal"));
  safeAddListener("submitConfirmAddBtn", "click", submitAddItemsToOrder);

  const cancelReasonInput = document.getElementById("custCancelReasonInput");
  const cancelConfirmBtn = document.getElementById("confirmCancelOrderBtn");
  if (cancelReasonInput && cancelConfirmBtn) {
    cancelReasonInput.addEventListener("input", () => {
      cancelConfirmBtn.disabled = cancelReasonInput.value.trim().length === 0;
    });
  }

  safeAddListener("closeCancelModalBtn", "click", () => closeModalOverlay("cancelOrderModal"));
  safeAddListener("keepOrderBtn", "click", () => closeModalOverlay("cancelOrderModal"));
  safeAddListener("confirmCancelOrderBtn", "click", confirmCancelOrder);

  safeAddListener("closeCancellationAlertBtn", "click", () => {
    closeModalOverlay("customerCancellationAlertModal");
    activeCustomerOrder = null;
    currentViewMode = "MENU_INITIAL";
    renderAppViews();
    renderDeviceHistory();
  });

  safeAddListener("statusAlertOkBtn", "click", () => closeModalOverlay("statusAlertModal"));

  safeAddListener("toggleHistoryViewBtn", "click", () => {
    const list = document.getElementById("historyOrdersList");
    const btn = document.getElementById("toggleHistoryViewBtn");
    if (!list || !btn) return;
    const isHidden = list.style.display === "none";
    list.style.display = isHidden ? "block" : "none";
    btn.textContent = isHidden ? t("history.toggleHide", "Hide") : t("history.toggleShow", "Show");
  });

  safeAddListener("lightboxCloseBtn", "click", closeLightbox);
  const lightboxModal = document.getElementById("lightboxModal");
  if (lightboxModal) {
    lightboxModal.addEventListener("click", (e) => {
      if (e.target.id === "lightboxModal") closeLightbox();
    });
  }

  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const parentSheet = e.target.closest(".sheet");
      if (parentSheet) closeSheet(parentSheet.id);
    })
  );

  const sheetBackdrop = document.getElementById("sheetBackdrop");
  if (sheetBackdrop) {
    sheetBackdrop.addEventListener("click", () => {
      closeSheet("cartSheet");
      closeSheet("billSheet");
    });
  }
}

init();