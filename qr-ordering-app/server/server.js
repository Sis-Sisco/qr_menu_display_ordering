const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { connectDB, getCollections } = require("./db");
const {
  ROLES,
  PERMISSIONS,
  SESSION_INACTIVITY_MS,
  hasPermission,
  getPermissionsForRole,
  hashPassword,
  verifyPassword,
  generateSession,
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailure,
  parseCookies,
  validateImageBuffer,
  applySecurityHeaders,
} = require("./security");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE_NAME = "qr_admin_session";
const APP_URL = process.env.APP_URL || "";
const JSON_DB_PATH = path.join(__dirname, "data", "db.json");
const FEEDBACK_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 Hours
const MAX_ITEM_QUANTITY = 10;

app.enable("trust proxy");

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const UPLOADS_DIR = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Production HTTP -> HTTPS Redirect
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-proto"] !== "https"
  ) {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

app.use(applySecurityHeaders);
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Centralized Business Date & Timezone (Africa/Addis_Ababa)
const TIMEZONE = "Africa/Addis_Ababa";

function getEthiopiaDateTime(date = new Date()) {
  if (!date) return null;
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  if (isNaN(d.getTime())) return null;

  const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateKey = dateKeyFormatter.format(d);

  const fullDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const orderDate = fullDateFormatter.format(d);

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const orderTime = timeFormatter.format(d);

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
  });
  const orderDay = dayFormatter.format(d);

  return {
    dateKey,
    orderDate,
    orderTime,
    orderDay,
    isoTimestamp: d.toISOString(),
  };
}

function formatDailyOrderNumber(seq) {
  return `#${String(seq).padStart(3, "0")}`;
}

const SPECIAL_REQUEST_DICTIONARY = [
  { keywords: ["ስኳር ትንሽ", "ትንሽ ስኳር", "sukkara xiqqaa", "sukkaara xiqqeessi", "ሽኮር ውሑድ", "ውሑድ ሽኮር", "سكر قليل", "قليل من السكر", "less sugar"], translation: "Less sugar" },
  { keywords: ["ያለ ስኳር", "ስኳር አይግባ", "sukkara malee", "ብዘይ ሽኮር", "بدون سكر", "من غير سكر", "no sugar"], translation: "No sugar" },
  { keywords: ["ጨው ትንሽ", "ትንሽ ጨው", "soogidda xiqqaa", "ጨው ውሑድ", "ውሑድ ጨው", "ملح قليل", "قليل الملح", "less salt"], translation: "Less salt" },
  { keywords: ["ያለ ጨው", "soogidda malee", "ብዘይ ጨው", "بدون ملح", "no salt"], translation: "No salt" },
  { keywords: ["የማያቃጥል", "ያለ ቃሪያ", "ቃሪያ አይግባ", "qaraa malee", "ዘየቃጽል", "ብዘይ በርበረ", "غير حار", "بدون شطة", "بدون فلفل", "no spicy", "not spicy"], translation: "Not spicy / No chili" },
  { keywords: ["ያለ ሽንኩርት", "ሽንኩርት አይግባ", "qullubbii malee", "ብዘይ ሽጉርቲ", "بدون بصل", "no onion"], translation: "No onions" },
  { keywords: ["ያለ በረዶ", "በረዶ አይግባ", "cabaqii malee", "ብዘይ በረድ", "بدون ثلج", "no ice"], translation: "No ice" },
  { keywords: ["ተጨማሪ ሶስ", "soosii dabalataa", "ተወሳኺ ሶስ", "صلصة زيادة", "صلصة إضافية", "extra sauce"], translation: "Extra sauce" },
];

function translateSpecialRequestToEnglish(text) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text.trim().toLowerCase();
  for (const entry of SPECIAL_REQUEST_DICTIONARY) {
    if (entry.keywords.some((kw) => cleaned.includes(kw.toLowerCase()))) {
      return entry.translation;
    }
  }
  return text.trim();
}

async function recordAuditLog(req, action, details, username = "system", role = "system") {
  try {
    const { auditLogs } = getCollections();
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const { orderDate, orderTime, isoTimestamp } = getEthiopiaDateTime();

    await auditLogs.insertOne({
      id: "log_" + crypto.randomBytes(6).toString("hex"),
      timestamp: `${orderDate} ${orderTime}`,
      iso: isoTimestamp,
      username,
      role,
      action,
      details,
      ip: String(ip).replace(/^::ffff:/, ""),
    });
  } catch (err) {
    console.warn("[Audit Log Write Error]", err.message);
  }
}

function normalizeTranslations(item) {
  const translations = item.translations && typeof item.translations === "object" ? { ...item.translations } : {};

  const enName = translations.en?.name || (typeof item.name === "object" ? item.name.en : item.name) || "";
  const enDesc = translations.en?.description || (typeof item.description === "object" ? item.description.en : item.description) || "";
  const enIng = translations.en?.ingredients || (typeof item.ingredients === "object" && !Array.isArray(item.ingredients) ? item.ingredients.en : item.ingredients) || [];

  translations.en = { name: enName, description: enDesc, ingredients: enIng };

  const langs = ["ar", "am", "om", "ti"];
  langs.forEach((l) => {
    if (!translations[l]) {
      const name = typeof item.name === "object" ? item.name[l] : "";
      const desc = typeof item.description === "object" ? item.description[l] : "";
      const ing = typeof item.ingredients === "object" && !Array.isArray(item.ingredients) ? item.ingredients[l] : [];
      if (name || desc || (ing && ing.length > 0)) {
        translations[l] = { name: name || enName, description: desc || enDesc, ingredients: ing || enIng };
      }
    }
  });

  return translations;
}

function publicMenuItem(item) {
  const translations = normalizeTranslations(item);
  const canonicalEnglishName = translations.en?.name || item.name || "Item";

  return {
    id: item.id || (item._id ? item._id.toString() : makeId("item")),
    name: canonicalEnglishName,
    translations,
    category: item.category || "Food",
    cost: parseFloat(item.cost || item.price || 0),
    currency: item.currency || "ETB",
    priceOptions: item.priceOptions || [],
    available: item.available !== undefined ? !!item.available : true,
    image: item.image || "",
  };
}

function sanitizeUser(u) {
  const { id, fullName, username, role, status, createdAt, updatedAt, lastLoginAt, disabledAt } = u;
  return { id, fullName: fullName || username, username, role, status: status || "ACTIVE", createdAt, updatedAt, lastLoginAt, disabledAt };
}

function filterOrderForRole(order, userRole) {
  const sanitized = { ...order };
  if (sanitized._id && !sanitized.id) sanitized.id = sanitized._id;
  if (userRole === ROLES.CASHIER) {
    delete sanitized.customerSuggestion;
    delete sanitized.specialRequest;
  }
  return sanitized;
}

function makeId(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

function safeDeleteUpload(imageUrl) {
  if (imageUrl && imageUrl.startsWith("/uploads/")) {
    const filename = path.basename(imageUrl);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error("Error deleting image:", e.message);
      }
    }
  }
}

// Authentication & RBAC Middleware
async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE_NAME] || req.headers["x-session-id"];

    if (!sessionId) {
      return res.status(401).json({ error: "Authentication required. Please sign in." });
    }

    const { sessions, users } = getCollections();
    const session = await sessions.findOne({ sessionId });

    if (!session) {
      return res.status(401).json({ error: "Session expired or invalid. Please sign in." });
    }

    const user = await users.findOne({ id: session.userId });
    if (!user || user.status === "DISABLED") {
      await sessions.deleteOne({ sessionId });
      return res.status(401).json({ error: "Your account is currently disabled. Please contact an administrator." });
    }

    const now = Date.now();
    if (now - session.lastActive > SESSION_INACTIVITY_MS) {
      await sessions.deleteOne({ sessionId });
      return res.status(401).json({ error: "Session expired due to inactivity. Please sign in." });
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const clientCsrfToken = req.headers["x-csrf-token"];
      if (!clientCsrfToken || clientCsrfToken !== session.csrfToken) {
        return res.status(403).json({ error: "Invalid or missing CSRF token. Request rejected." });
      }
    }

    await sessions.updateOne({ sessionId }, { $set: { lastActive: now } });

    req.user = {
      id: user.id,
      username: user.username,
      fullName: user.fullName || user.username,
      role: user.role,
      sessionId: sessionId,
    };

    next();
  } catch (err) {
    res.status(500).json({ error: "Authentication verification failed." });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: `Access denied. Requires '${permission}' permission.` });
    }
    next();
  };
}

async function findMenuItemById(itemId) {
  const { menuItems } = getCollections();
  let menuItem = await menuItems.findOne({ $or: [{ id: itemId }, { _id: itemId }] });
  if (!menuItem && fs.existsSync(JSON_DB_PATH)) {
    const json = JSON.parse(fs.readFileSync(JSON_DB_PATH, "utf-8"));
    menuItem = (json.menu || []).find((m) => m.id === itemId);
  }
  return menuItem;
}

function getCustomerToken(req) {
  return (
    req.headers["x-customer-token"] ||
    req.body.customerId ||
    req.query.customer ||
    ""
  ).trim();
}

// ---------- SIGNED TABLE SESSIONS (customer URL cannot be edited) ----------
// The QR code carries a token "<table>.<signature>". Only the server knows the
// secret, so a customer cannot change the table number in the URL. Once verified,
// the table is kept in an HttpOnly cookie and every customer route reads it from
// there instead of trusting anything the browser sends.
const TABLE_COOKIE_NAME = "qr_table";
const TABLE_COOKIE_MAX_AGE_S = 12 * 60 * 60; // 12 hours

const QR_SECRET = (() => {
  if (process.env.QR_SECRET) return process.env.QR_SECRET;
  const secretPath = path.join(__dirname, "data", "qr-secret.key");
  try {
    if (fs.existsSync(secretPath)) {
      const saved = fs.readFileSync(secretPath, "utf-8").trim();
      if (saved) return saved;
    }
  } catch (e) {}
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  } catch (e) {
    console.warn("⚠️  Could not save QR secret; table QR codes will stop working after a restart. Set QR_SECRET in your environment.");
  }
  return generated;
})();

function signTable(table) {
  return crypto.createHmac("sha256", QR_SECRET).update("table:" + table).digest("base64url").slice(0, 22);
}

function makeTableToken(table) {
  const clean = String(table).trim();
  return `${clean}.${signTable(clean)}`;
}

// Returns the table number if the token is authentic, otherwise null.
function verifyTableToken(token) {
  if (typeof token !== "string" || token.length > 64) return null;
  const idx = token.lastIndexOf(".");
  if (idx < 1) return null;
  const table = token.slice(0, idx);
  const given = Buffer.from(token.slice(idx + 1));
  const expected = Buffer.from(signTable(table));
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? table : null;
}

function getTableFromCookie(req) {
  try {
    return verifyTableToken(parseCookies(req)[TABLE_COOKIE_NAME] || "");
  } catch (e) {
    return null;
  }
}

// Customer routes: the table always comes from the verified cookie.
function requireTableSession(req, res, next) {
  const table = getTableFromCookie(req);
  if (!table) {
    return res.status(403).json({ error: "Table not verified. Please scan the QR code on your table." });
  }
  req.query.table = table;
  if (req.body && typeof req.body === "object") req.body.tableNumber = table;
  next();
}

// Customer opens the QR link (?t=<token>) or reloads later (cookie only).
app.get("/api/table-session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const provided = typeof req.query.t === "string" ? req.query.t : "";
  let table = null;

  if (provided) {
    table = verifyTableToken(provided);
    if (!table) {
      return res.status(403).json({ error: "This table link is not valid. Please scan the QR code on your table." });
    }
    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `${TABLE_COOKIE_NAME}=${encodeURIComponent(makeTableToken(table))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TABLE_COOKIE_MAX_AGE_S}${isHttps ? "; Secure" : ""}`
    );
  } else {
    table = getTableFromCookie(req);
  }

  if (!table) {
    return res.status(401).json({ error: "Please scan the QR code on your table." });
  }
  res.json({ table });
});

// Admin/Manager only: signed QR tokens for the QR generator page.
app.get("/api/admin/tables/qr", requireAuth, requirePermission(PERMISSIONS.MANAGE_MENU), async (req, res) => {
  try {
    const { tables } = getCollections();
    let list = await tables.find({}).sort({ number: 1 }).toArray();
    if (!list || list.length === 0) {
      list = [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }, { number: "5" }];
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(list.map((t) => ({ number: String(t.number), token: makeTableToken(t.number) })));
  } catch (err) {
    res.status(500).json({ error: "Failed to generate table QR tokens." });
  }
});

// ---------- CUSTOMER ENDPOINTS ----------

app.get("/api/menu", async (req, res) => {
  try {
    const { menuItems } = getCollections();
    let items = await menuItems.find({}).toArray();

    if (!items || items.length === 0) {
      if (fs.existsSync(JSON_DB_PATH)) {
        const raw = fs.readFileSync(JSON_DB_PATH, "utf-8");
        const json = JSON.parse(raw);
        items = json.menu || [];
      }
    }

    res.json(items.map(publicMenuItem));
  } catch (err) {
    res.status(500).json({ error: "Failed to load menu items." });
  }
});

app.get("/api/tables", async (req, res) => {
  try {
    const { tables } = getCollections();
    let tableList = await tables.find({}).sort({ number: 1 }).toArray();

    if (!tableList || tableList.length === 0) {
      tableList = [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }, { number: "5" }];
    }

    res.json(tableList);
  } catch (err) {
    res.status(500).json({ error: "Failed to load tables." });
  }
});

app.get("/api/customer/active-order", requireTableSession, async (req, res) => {
  const table = req.query.table;
  const token = getCustomerToken(req);

  if (!table || !token) {
    return res.status(400).json({ error: "Table and customer session token are required." });
  }

  try {
    const { orders } = getCollections();
    
    const activeOrder = await orders.findOne(
      {
        tableNumber: String(table).trim(),
        customerId: token,
        status: { $in: ["pending", "accepted"] },
      },
      { sort: { createdAt: -1 } }
    );

    const latestServedOrder = await orders.findOne(
      {
        tableNumber: String(table).trim(),
        customerId: token,
        status: { $in: ["served", "paid"] },
      },
      { sort: { createdAt: -1 } }
    );

    const latestCancelledOrder = await orders.findOne(
      {
        tableNumber: String(table).trim(),
        customerId: token,
        status: "cancelled",
      },
      { sort: { updatedAt: -1 } }
    );

    res.json({
      activeOrder: activeOrder || null,
      latestServedOrder: latestServedOrder || null,
      latestCancelledOrder: latestCancelledOrder || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load active order." });
  }
});

// Customer: Place Order
app.post("/api/orders", requireTableSession, async (req, res) => {
  const { tableNumber, customerId, customerName, customerSuggestion, customerLanguage, items } = req.body;

  const cleanName = typeof customerName === "string" ? customerName.trim() : "";
  if (!cleanName) {
    return res.status(400).json({ error: "Please enter your name before placing your order." });
  }
  if (cleanName.length > 50) {
    return res.status(400).json({ error: "Customer name cannot exceed 50 characters." });
  }

  const cleanLang = ["en", "ar", "am", "om", "ti"].includes(customerLanguage) ? customerLanguage : "en";
  const cleanSuggestion = typeof customerSuggestion === "string" ? customerSuggestion.trim().slice(0, 300) : "";
  const staffEnglishSuggestion = translateSpecialRequestToEnglish(cleanSuggestion);

  if (!tableNumber || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Table number and items are required." });
  }

  const secureCustomerId = customerId && typeof customerId === "string" && customerId.length >= 10
    ? String(customerId).slice(0, 80)
    : makeId("cust") + "_" + crypto.randomBytes(8).toString("hex");

  try {
    const { orders, dailyCounters } = getCollections();
    const { dateKey, orderDate, orderTime, orderDay, isoTimestamp } = getEthiopiaDateTime();

    const counterDoc = await dailyCounters.findOneAndUpdate(
      { dateKey },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    const dailySeq = counterDoc.seq;
    const dailyOrderNumber = formatDailyOrderNumber(dailySeq);

    const lineItems = [];
    for (const line of items) {
      const parsedQty = parseInt(line.qty, 10);
      if (!line.itemId || isNaN(parsedQty) || parsedQty <= 0) {
        return res.status(400).json({ error: "Invalid item structure or quantity." });
      }

      const qty = Math.min(MAX_ITEM_QUANTITY, Math.max(1, parsedQty));

      const menuItem = await findMenuItemById(line.itemId);
      if (!menuItem) {
        return res.status(400).json({ error: "One or more ordered items do not exist." });
      }
      if (!menuItem.available) {
        const trans = normalizeTranslations(menuItem);
        const itemName = trans[cleanLang]?.name || trans.en?.name || menuItem.name;
        return res.status(400).json({ error: `${itemName} is currently out of stock.` });
      }

      const trans = normalizeTranslations(menuItem);
      const canonicalEnglishName = trans.en?.name || menuItem.name || "Item";
      const localizedCustomerName = trans[cleanLang]?.name || canonicalEnglishName;

      lineItems.push({
        itemId: menuItem.id || menuItem._id.toString(),
        name: canonicalEnglishName,
        customerName: localizedCustomerName,
        customerLanguage: cleanLang,
        category: menuItem.category || "Food",
        price: menuItem.cost || menuItem.price || 0,
        qty,
      });
    }

    const total = lineItems.reduce((sum, l) => sum + l.price * l.qty, 0);

    const initialHistoryEvent = {
      eventType: "ORDER_CREATED",
      previousStatus: null,
      newStatus: "pending",
      actorId: secureCustomerId,
      actorName: cleanName,
      actorRole: "CUSTOMER",
      date: orderDate,
      time: orderTime,
      timestamp: isoTimestamp,
      details: "Order placed by customer via table QR code",
      reason: null,
    };

    const newOrder = {
      id: makeId("ord"),
      dailySeq,
      dailyOrderNumber,
      dateKey,
      orderDay,
      orderDate,
      orderTime,
      tableNumber: String(tableNumber).trim().slice(0, 10),
      customerId: secureCustomerId,
      customerLanguage: cleanLang,
      customerName: cleanName,
      customerSuggestion: cleanSuggestion,
      specialRequest: {
        originalLanguage: cleanLang,
        originalText: cleanSuggestion,
        staffEnglish: staffEnglishSuggestion,
      },
      items: lineItems,
      total: Math.round(total * 100) / 100,
      status: "pending",

      statusHistory: [initialHistoryEvent],

      pendingAt: isoTimestamp,
      pendingTimeStr: orderTime,
      acceptedAt: null,
      acceptedTimeStr: null,
      acceptedBy: null,
      acceptedByName: null,
      acceptedByRole: null,
      servedAt: null,
      servedTimeStr: null,
      servedBy: null,
      servedByName: null,
      servedByRole: null,
      feedbackExpiresAt: null,
      cancelledAt: null,
      cancelledTimeStr: null,
      cancelledBy: null,
      cancelledByName: null,
      cancelledByRole: null,
      cancellationReason: null,
      paidAt: null,
      paidTimeStr: null,
      feedback: null,

      createdAt: isoTimestamp,
      updatedAt: isoTimestamp,
    };

    await orders.insertOne(newOrder);
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: "Failed to create order: " + err.message });
  }
});

app.get("/api/orders", requireTableSession, async (req, res) => {
  const { table } = req.query;
  const token = getCustomerToken(req);

  if (!table) {
    return res.status(400).json({ error: "Table number is required." });
  }

  try {
    const { orders } = getCollections();
    const query = { tableNumber: String(table) };

    if (token) {
      query.customerId = token;
    }

    const tableOrders = await orders.find(query).sort({ createdAt: -1 }).toArray();

    const unpaidTotal = tableOrders
      .filter((o) => o.status !== "paid" && o.status !== "cancelled")
      .reduce((s, o) => s + o.total, 0);

    res.json({
      orders: tableOrders,
      unpaidTotal: Math.round(unpaidTotal * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load orders." });
  }
});

// Customer: Edit Pending Order
app.post("/api/orders/:id/customer-edit", async (req, res) => {
  const { id } = req.params;
  const token = getCustomerToken(req);
  const { items, customerSuggestion, customerLanguage } = req.body;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Customer identifier required." });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Order must contain at least one item." });
  }

  try {
    const { orders } = getCollections();
    const order = await orders.findOne({ id });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.customerId !== token) {
      return res.status(403).json({ error: "You are not authorized to edit this order." });
    }

    if (order.status !== "pending") {
      return res.status(409).json({
        locked: true,
        error: "This order can no longer be modified because it is already being prepared or completed.",
      });
    }

    const cleanLang = ["en", "ar", "am", "om", "ti"].includes(customerLanguage) ? customerLanguage : order.customerLanguage || "en";
    const cleanSuggestion = typeof customerSuggestion === "string" ? customerSuggestion.trim().slice(0, 300) : (order.customerSuggestion || "");
    const staffEnglishSuggestion = translateSpecialRequestToEnglish(cleanSuggestion);

    const updatedLineItems = [];
    for (const line of items) {
      const parsedQty = parseInt(line.qty, 10);
      if (isNaN(parsedQty) || parsedQty <= 0) continue;

      const qty = Math.min(MAX_ITEM_QUANTITY, Math.max(1, parsedQty));
      const menuItem = await findMenuItemById(line.itemId);
      if (!menuItem) {
        return res.status(400).json({ error: "One or more items do not exist." });
      }

      const trans = normalizeTranslations(menuItem);
      const canonicalEnglishName = trans.en?.name || menuItem.name || "Item";
      const localizedCustomerName = trans[cleanLang]?.name || canonicalEnglishName;

      updatedLineItems.push({
        itemId: menuItem.id || menuItem._id.toString(),
        name: canonicalEnglishName,
        customerName: localizedCustomerName,
        customerLanguage: cleanLang,
        category: menuItem.category || "Food",
        price: menuItem.cost || menuItem.price || 0,
        qty,
      });
    }

    if (updatedLineItems.length === 0) {
      return res.status(400).json({ error: "Order must contain at least one item with valid quantity." });
    }

    const total = updatedLineItems.reduce((sum, l) => sum + l.price * l.qty, 0);
    const now = getEthiopiaDateTime();

    const editHistoryEvent = {
      eventType: "CUSTOMER_EDIT",
      previousStatus: "pending",
      newStatus: "pending",
      actorId: token,
      actorName: order.customerName || "Customer",
      actorRole: "CUSTOMER",
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Customer updated order items (New total: ${Math.round(total * 100) / 100} ETB)`,
      reason: null,
    };

    const updatedDoc = await orders.findOneAndUpdate(
      { id, status: "pending", customerId: token },
      {
        $set: {
          items: updatedLineItems,
          total: Math.round(total * 100) / 100,
          customerSuggestion: cleanSuggestion,
          customerLanguage: cleanLang,
          specialRequest: {
            originalLanguage: cleanLang,
            originalText: cleanSuggestion,
            staffEnglish: staffEnglishSuggestion,
          },
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: editHistoryEvent },
      },
      { returnDocument: "after" }
    );

    if (!updatedDoc) {
      return res.status(409).json({
        locked: true,
        error: "This order has already been accepted and can no longer be changed.",
      });
    }

    res.json(updatedDoc);
  } catch (err) {
    res.status(500).json({ error: "Failed to update order: " + err.message });
  }
});

// Customer: Add Items to Existing Pending Order
app.post("/api/orders/:id/items", async (req, res) => {
  const { id } = req.params;
  const token = getCustomerToken(req);
  const { items, customerLanguage } = req.body;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Customer identifier required." });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Please select at least one item to add." });
  }

  try {
    const { orders } = getCollections();
    const order = await orders.findOne({ id });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.customerId !== token) {
      return res.status(403).json({ error: "You are not authorized to modify this order." });
    }

    if (order.status !== "pending") {
      return res.status(409).json({
        locked: true,
        error: "This order can no longer be modified because it is already being prepared or completed.",
      });
    }

    const cleanLang = ["en", "ar", "am", "om", "ti"].includes(customerLanguage) ? customerLanguage : order.customerLanguage || "en";
    const currentItemsMap = new Map();
    (order.items || []).forEach((it) => {
      currentItemsMap.set(it.itemId, { ...it });
    });

    let additionalCost = 0;

    for (const line of items) {
      const parsedQty = parseInt(line.qty, 10);
      if (isNaN(parsedQty) || parsedQty <= 0) continue;

      const menuItem = await findMenuItemById(line.itemId);
      if (!menuItem) {
        return res.status(400).json({ error: "One or more items do not exist." });
      }

      const trans = normalizeTranslations(menuItem);
      if (!menuItem.available) {
        const itemName = trans[cleanLang]?.name || trans.en?.name || menuItem.name;
        return res.status(400).json({ error: `${itemName} is currently out of stock.` });
      }

      const itemCost = menuItem.cost || menuItem.price || 0;

      if (currentItemsMap.has(menuItem.id)) {
        const existing = currentItemsMap.get(menuItem.id);
        const newQty = Math.min(MAX_ITEM_QUANTITY, existing.qty + parsedQty);
        const actualAdded = newQty - existing.qty;
        additionalCost += itemCost * actualAdded;
        existing.qty = newQty;
      } else {
        const qty = Math.min(MAX_ITEM_QUANTITY, Math.max(1, parsedQty));
        additionalCost += itemCost * qty;
        const canonicalEnglishName = trans.en?.name || menuItem.name || "Item";
        const localizedCustomerName = trans[cleanLang]?.name || canonicalEnglishName;

        currentItemsMap.set(menuItem.id, {
          itemId: menuItem.id || menuItem._id.toString(),
          name: canonicalEnglishName,
          customerName: localizedCustomerName,
          customerLanguage: cleanLang,
          category: menuItem.category || "Food",
          price: itemCost,
          qty,
        });
      }
    }

    const mergedItems = Array.from(currentItemsMap.values());
    const newTotal = mergedItems.reduce((sum, l) => sum + l.price * l.qty, 0);
    const now = getEthiopiaDateTime();

    const addItemsHistoryEvent = {
      eventType: "ADD_ITEMS",
      previousStatus: "pending",
      newStatus: "pending",
      actorId: token,
      actorName: order.customerName || "Customer",
      actorRole: "CUSTOMER",
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Customer added items (+${Math.round(additionalCost * 100) / 100} ETB). New total: ${Math.round(newTotal * 100) / 100} ETB`,
      reason: null,
    };

    const updatedOrder = await orders.findOneAndUpdate(
      { id, status: "pending", customerId: token },
      {
        $set: {
          items: mergedItems,
          total: Math.round(newTotal * 100) / 100,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: addItemsHistoryEvent },
      },
      { returnDocument: "after" }
    );

    if (!updatedOrder) {
      return res.status(409).json({
        locked: true,
        error: "This order has already been accepted and can no longer be changed.",
      });
    }

    res.json({
      order: updatedOrder,
      previousTotal: order.total,
      additionalTotal: Math.round(additionalCost * 100) / 100,
      newTotal: updatedOrder.total,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to add items: " + err.message });
  }
});

// Customer: Cancel Order
app.post("/api/orders/:id/cancel-by-customer", async (req, res) => {
  const { id } = req.params;
  const token = getCustomerToken(req);
  const { cancellationReason } = req.body;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Customer identifier required." });
  }

  const cleanReason = typeof cancellationReason === "string" ? cancellationReason.trim().slice(0, 300) : "";
  if (!cleanReason) {
    return res.status(400).json({ error: "Please provide a reason for cancelling this order." });
  }

  try {
    const { orders } = getCollections();
    const order = await orders.findOne({ id });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.customerId !== token) {
      return res.status(403).json({ error: "You are not authorized to cancel this order." });
    }

    if (order.status !== "pending") {
      return res.status(409).json({
        locked: true,
        error: "This order can no longer be cancelled because it is already being prepared or served.",
      });
    }

    const now = getEthiopiaDateTime();

    const cancelHistoryEvent = {
      eventType: "ORDER_CANCELLED",
      previousStatus: "pending",
      newStatus: "cancelled",
      actorId: token,
      actorName: order.customerName || "Customer",
      actorRole: "CUSTOMER",
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: "Order cancelled by customer",
      reason: cleanReason,
    };

    const cancelledDoc = await orders.findOneAndUpdate(
      { id, status: "pending", customerId: token },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now.isoTimestamp,
          cancelledTimeStr: now.orderTime,
          cancelledBy: token,
          cancelledByName: order.customerName || "Customer",
          cancelledByRole: "CUSTOMER",
          cancellationReason: cleanReason,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: cancelHistoryEvent },
      },
      { returnDocument: "after" }
    );

    if (!cancelledDoc) {
      return res.status(409).json({
        locked: true,
        error: "This order has already been accepted by staff and cannot be cancelled.",
      });
    }

    await recordAuditLog(
      req,
      "CANCEL_ORDER",
      `Order ${order.dailyOrderNumber} cancelled by customer: ${order.customerName} (Reason: ${cleanReason})`,
      order.customerName || "Customer",
      "CUSTOMER"
    );

    res.json({ message: "Order cancelled successfully.", order: cancelledDoc });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel order: " + err.message });
  }
});

// Customer: Feedback
app.post("/api/orders/:id/feedback", async (req, res) => {
  const { id } = req.params;
  const token = getCustomerToken(req);
  const { comment, rating } = req.body;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Customer session token required." });
  }

  const cleanComment = typeof comment === "string" ? comment.trim().slice(0, 1000) : "";
  const parsedRating = parseInt(rating, 10);
  const hasValidRating = !isNaN(parsedRating) && parsedRating >= 1 && parsedRating <= 5;
  const hasValidComment = cleanComment.length > 0;

  if (!hasValidRating && !hasValidComment) {
    return res.status(400).json({ error: "Please provide a rating or write a comment before submitting." });
  }

  try {
    const { orders } = getCollections();
    const order = await orders.findOne({ id });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.customerId !== token) {
      return res.status(403).json({ error: "You are not authorized to submit feedback for this order." });
    }

    if (order.status !== "served" && order.status !== "paid") {
      return res.status(400).json({ error: "Feedback can only be submitted for served orders." });
    }

    if (order.feedback) {
      return res.status(409).json({ error: "Feedback has already been submitted for this order. Thank you!" });
    }

    const servedTimeMs = new Date(order.servedAt || order.updatedAt || order.createdAt).getTime();
    const expiresMs = order.feedbackExpiresAt ? new Date(order.feedbackExpiresAt).getTime() : (servedTimeMs + FEEDBACK_WINDOW_MS);
    const nowMs = Date.now();

    if (nowMs > expiresMs) {
      return res.status(410).json({ error: "The 2-hour feedback period for this order has ended." });
    }

    const now = getEthiopiaDateTime();
    const feedbackData = {
      rating: hasValidRating ? parsedRating : null,
      comment: cleanComment,
      submittedAt: now.isoTimestamp,
      submittedTimeStr: now.orderTime,
    };

    const feedbackHistoryEvent = {
      eventType: "FEEDBACK_SUBMITTED",
      previousStatus: order.status,
      newStatus: order.status,
      actorId: token,
      actorName: order.customerName || "Customer",
      actorRole: "CUSTOMER",
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Customer submitted feedback: ${hasValidRating ? `${parsedRating}★` : ""} ${cleanComment ? `("${cleanComment}")` : ""}`.trim(),
      reason: null,
    };

    const updated = await orders.findOneAndUpdate(
      { id, customerId: token, feedback: null },
      {
        $set: {
          feedback: feedbackData,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: feedbackHistoryEvent },
      },
      { returnDocument: "after" }
    );

    await recordAuditLog(
      req,
      "SERVICE_FEEDBACK",
      `Order ${order.dailyOrderNumber} feedback from ${order.customerName}: ${hasValidRating ? `${parsedRating} stars` : ""} ${cleanComment ? `("${cleanComment}")` : ""}`.trim(),
      order.customerName || "Customer",
      "CUSTOMER"
    );

    res.json({ message: "Thank you for your feedback!", feedback: feedbackData, order: updated });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit feedback: " + err.message });
  }
});

app.post("/api/orders/:id/pay", async (req, res) => {
  const { id } = req.params;
  const token = getCustomerToken(req);

  try {
    const { orders } = getCollections();
    const now = getEthiopiaDateTime();

    const query = { id, status: { $nin: ["paid", "cancelled"] } };
    if (token) query.customerId = token;

    const payHistoryEvent = {
      eventType: "ORDER_PAID",
      previousStatus: "served",
      newStatus: "paid",
      actorId: token || "customer_or_cashier",
      actorName: "Customer / Cashier",
      actorRole: "CUSTOMER",
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: "Order marked as paid",
      reason: null,
    };

    const result = await orders.findOneAndUpdate(
      query,
      {
        $set: {
          status: "paid",
          paidAt: now.isoTimestamp,
          paidTimeStr: now.orderTime,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: payHistoryEvent },
      },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(400).json({ error: "Order not found, already paid, or cancelled." });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Payment processing failed." });
  }
});

// ---------- STAFF / ADMIN AUTHENTICATION ----------

app.post("/api/admin/login", checkLoginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const { users, sessions } = getCollections();
    const user = await users.findOne({ username: String(username).trim().toLowerCase() });

    if (!user || !verifyPassword(password, user.passwordHash, user.salt)) {
      recordLoginFailure(ip);
      await recordAuditLog(req, "LOGIN_FAILED", `Failed login attempt for user: ${username}`, username, "UNKNOWN");
      return res.status(401).json({ error: "Invalid username or password." });
    }

    if (user.status === "DISABLED") {
      await recordAuditLog(req, "LOGIN_BLOCKED", `Disabled account login attempt: ${username}`, user.username, user.role);
      return res.status(403).json({ error: "Your account is currently disabled. Please contact an administrator." });
    }

    resetLoginFailure(ip);

    const session = generateSession(user);
    const now = getEthiopiaDateTime();

    await sessions.insertOne(session);

    await users.updateOne(
      { id: user.id },
      { $set: { lastLoginAt: `${now.orderDate} ${now.orderTime}` } }
    );

    await recordAuditLog(req, "LOGIN_SUCCESS", `Staff signed in (${user.role})`, user.username, user.role);

    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${isHttps ? "; Secure" : ""}`
    );

    res.json({
      message: "Login successful",
      csrfToken: session.csrfToken,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName || user.username,
        role: user.role,
        permissions: getPermissionsForRole(user.role),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Authentication system error." });
  }
});

app.post("/api/admin/logout", requireAuth, async (req, res) => {
  try {
    const { sessions } = getCollections();
    if (req.user && req.user.sessionId) {
      await sessions.deleteOne({ sessionId: req.user.sessionId });
    }
    await recordAuditLog(req, "LOGOUT", `Staff signed out`, req.user.username, req.user.role);
  } catch (e) {}

  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ message: "Logged out successfully." });
});

app.post("/api/admin/change-password", requireAuth, requirePermission(PERMISSIONS.CHANGE_PASSWORD), async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required." });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters long." });
  }

  try {
    const { users, sessions } = getCollections();
    const user = await users.findOne({ id: req.user.id });
    if (!user) return res.status(404).json({ error: "User account not found." });

    if (!verifyPassword(currentPassword, user.passwordHash, user.salt)) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const { hash, salt } = hashPassword(newPassword);
    await users.updateOne(
      { id: user.id },
      { $set: { passwordHash: hash, salt: salt, updatedAt: new Date().toISOString() } }
    );

    await sessions.deleteMany({ userId: user.id, sessionId: { $ne: req.user.sessionId } });
    await recordAuditLog(req, "PASSWORD_CHANGED", "Staff updated password", req.user.username, req.user.role);

    res.json({ message: "Password successfully changed." });
  } catch (err) {
    res.status(500).json({ error: "Password update failed." });
  }
});

// ---------- STAFF MANAGEMENT CRUD ----------

app.get("/api/admin/staff", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  try {
    const { users } = getCollections();
    const list = await users.find({}).toArray();
    res.json(list.map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve staff list." });
  }
});

app.post("/api/admin/staff", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  const { fullName, username, password, role, status } = req.body;

  if (!fullName || !username || !password || !role) {
    return res.status(400).json({ error: "Full name, username, password, and role are required." });
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const cleanRole = String(role).toUpperCase();

  if (!Object.values(ROLES).includes(cleanRole)) {
    return res.status(400).json({ error: "Invalid role selected." });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters long." });
  }

  try {
    const { users } = getCollections();
    const exists = await users.findOne({ username: cleanUsername });
    if (exists) {
      return res.status(400).json({ error: "Username already exists." });
    }

    const { hash, salt } = hashPassword(password);
    const newStaff = {
      id: makeId("usr"),
      fullName: String(fullName).trim(),
      username: cleanUsername,
      role: cleanRole,
      status: status === "DISABLED" ? "DISABLED" : "ACTIVE",
      passwordHash: hash,
      salt: salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
    };

    await users.insertOne(newStaff);
    await recordAuditLog(req, "CREATE_STAFF", `Created staff: ${newStaff.username} (${newStaff.role})`, req.user.username, req.user.role);

    res.status(201).json({ message: "Staff account created successfully.", staff: sanitizeUser(newStaff) });
  } catch (err) {
    res.status(500).json({ error: "Failed to create staff account." });
  }
});

app.put("/api/admin/staff/:id", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  const { fullName, role, status } = req.body;

  try {
    const { users, sessions } = getCollections();
    const updateDoc = { updatedAt: new Date().toISOString() };

    if (fullName !== undefined) updateDoc.fullName = String(fullName).trim();
    if (role !== undefined) {
      const cleanRole = String(role).toUpperCase();
      if (!Object.values(ROLES).includes(cleanRole)) return res.status(400).json({ error: "Invalid role." });
      updateDoc.role = cleanRole;
    }
    if (status !== undefined) {
      updateDoc.status = status === "DISABLED" ? "DISABLED" : "ACTIVE";
      if (updateDoc.status === "DISABLED") {
        updateDoc.disabledAt = new Date().toISOString();
        await sessions.deleteMany({ userId: req.params.id });
      }
    }

    const result = await users.findOneAndUpdate(
      { id: req.params.id },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ error: "Staff member not found." });

    await recordAuditLog(req, "UPDATE_STAFF", `Updated staff: ${result.username}`, req.user.username, req.user.role);
    res.json({ message: "Staff account updated.", staff: sanitizeUser(result) });
  } catch (err) {
    res.status(500).json({ error: "Failed to update staff member." });
  }
});

app.post("/api/admin/staff/:id/toggle-status", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  try {
    const { users, sessions } = getCollections();
    const user = await users.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: "Staff member not found." });

    if (user.id === req.user.id) {
      return res.status(400).json({ error: "You cannot disable your own active account." });
    }

    const nextStatus = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    const updateDoc = {
      status: nextStatus,
      updatedAt: new Date().toISOString(),
      ...(nextStatus === "DISABLED" ? { disabledAt: new Date().toISOString() } : {}),
    };

    if (nextStatus === "DISABLED") {
      await sessions.deleteMany({ userId: user.id });
    }

    const result = await users.findOneAndUpdate(
      { id: user.id },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    await recordAuditLog(
      req,
      nextStatus === "ACTIVE" ? "ENABLE_STAFF" : "DISABLE_STAFF",
      `${nextStatus === "ACTIVE" ? "Enabled" : "Disabled"} staff: ${user.username}`,
      req.user.username,
      req.user.role
    );

    res.json({ message: `Staff account ${nextStatus.toLowerCase()}.`, staff: sanitizeUser(result) });
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle staff status." });
  }
});

app.post("/api/admin/staff/:id/reset-password", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters long." });
  }

  try {
    const { users, sessions } = getCollections();
    const { hash, salt } = hashPassword(newPassword);

    const result = await users.findOneAndUpdate(
      { id: req.params.id },
      { $set: { passwordHash: hash, salt: salt, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ error: "Staff member not found." });

    await sessions.deleteMany({ userId: result.id });
    await recordAuditLog(req, "RESET_STAFF_PASSWORD", `Reset password for staff: ${result.username}`, req.user.username, req.user.role);

    res.json({ message: "Staff password reset successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset password." });
  }
});

app.delete("/api/admin/staff/:id", requireAuth, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res) => {
  try {
    const { users, sessions } = getCollections();
    const user = await users.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: "Staff member not found." });

    if (user.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own administrator account." });
    }

    await users.deleteOne({ id: user.id });
    await sessions.deleteMany({ userId: user.id });
    await recordAuditLog(req, "DELETE_STAFF", `Deleted staff account: ${user.username}`, req.user.username, req.user.role);

    res.json({ message: "Staff account deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete staff member." });
  }
});

// ---------- ORDER MANAGEMENT & SALES REPORTING ----------

app.get("/api/admin/orders/today", requireAuth, requirePermission(PERMISSIONS.VIEW_ORDERS), async (req, res) => {
  try {
    const { orders, sessions } = getCollections();
    const { dateKey, orderDate, orderTime } = getEthiopiaDateTime();

    const todayOrders = await orders
      .find({ dateKey })
      .sort({ createdAt: 1 })
      .toArray();

    const sanitizedOrders = todayOrders.map((o) => filterOrderForRole(o, req.user.role));

    const pending = sanitizedOrders.filter((o) => o.status === "pending").length;
    const accepted = sanitizedOrders.filter((o) => o.status === "accepted").length;
    const served = sanitizedOrders.filter((o) => o.status === "served" || o.status === "paid").length;
    const cancelled = sanitizedOrders.filter((o) => o.status === "cancelled").length;
    const totalCount = sanitizedOrders.length;
    const totalRevenue = sanitizedOrders
      .filter((o) => o.status !== "cancelled")
      .reduce((sum, o) => sum + o.total, 0);

    const activeSession = await sessions.findOne({ sessionId: req.user.sessionId });

    res.json({
      dateKey,
      todayFormatted: orderDate,
      currentTime: orderTime,
      serverTimestamp: new Date().toISOString(),
      csrfToken: activeSession ? activeSession.csrfToken : "",
      user: {
        id: req.user.id,
        username: req.user.username,
        fullName: req.user.fullName,
        role: req.user.role,
        permissions: getPermissionsForRole(req.user.role),
      },
      summary: {
        pending,
        accepted,
        served,
        cancelled,
        totalCount,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
      },
      orders: sanitizedOrders,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load today's live orders." });
  }
});

// The Admin report sends <input type="datetime-local"> values such as "2026-09-27T00:00"
// (no timezone). They are restaurant wall-clock times, so interpret them in Africa/Addis_Ababa
// (UTC+3, no DST) instead of the server's own timezone. Values that already carry a timezone
// ("Z" or an offset) are left untouched.
function parseReportDateTime(value) {
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) {
    const withSeconds = /T\d{2}:\d{2}$/.test(str) ? `${str}:00` : str;
    return new Date(`${withSeconds}+03:00`);
  }
  return new Date(str);
}

// Helper: Build MongoDB Query for History & Reports
function buildHistoryQuery(params) {
  const { from, to, fromDateTime, toDateTime, status, staffRole, search } = params;
  const query = {};

  if (fromDateTime || toDateTime) {
    query.createdAt = {};
    if (fromDateTime) {
      query.createdAt.$gte = parseReportDateTime(fromDateTime).toISOString();
    }
    if (toDateTime) {
      const toDateObj = parseReportDateTime(toDateTime);
      toDateObj.setSeconds(59, 999);
      query.createdAt.$lte = toDateObj.toISOString();
    }
  } else if (from || to) {
    query.dateKey = {};
    if (from) query.dateKey.$gte = String(from);
    if (to) query.dateKey.$lte = String(to);
  }

  if (status && status !== "all") {
    if (status === "served") {
      query.status = { $in: ["served", "paid"] };
    } else {
      query.status = status;
    }
  }

  if (staffRole && staffRole !== "all") {
    const r = String(staffRole).toUpperCase();
    query.$or = [
      { acceptedByRole: r },
      { servedByRole: r },
      { cancelledByRole: r },
      { "statusHistory.actorRole": r },
    ];
  }

  if (search) {
    const q = String(search).trim().replace(/^#/, "");
    const searchConditions = [
      { dailyOrderNumber: { $regex: q, $options: "i" } },
      { id: { $regex: q, $options: "i" } },
      { customerName: { $regex: q, $options: "i" } },
      { tableNumber: { $regex: q, $options: "i" } },
      { "items.name": { $regex: q, $options: "i" } },
      { acceptedByName: { $regex: q, $options: "i" } },
      { servedByName: { $regex: q, $options: "i" } },
      { cancelledByName: { $regex: q, $options: "i" } },
      { "statusHistory.actorName": { $regex: q, $options: "i" } },
    ];

    if (query.$or) {
      query.$and = [{ $or: query.$or }, { $or: searchConditions }];
      delete query.$or;
    } else {
      query.$or = searchConditions;
    }
  }

  return query;
}

app.get("/api/admin/orders/history", requireAuth, requirePermission(PERMISSIONS.VIEW_HISTORY), async (req, res) => {
  try {
    const { orders } = getCollections();
    const query = buildHistoryQuery(req.query);

    const historyOrders = await orders.find(query).sort({ createdAt: -1 }).toArray();
    const sanitizedOrders = historyOrders.map((o) => filterOrderForRole(o, req.user.role));

    const totalOrders = sanitizedOrders.length;
    const pendingCount = sanitizedOrders.filter((o) => o.status === "pending").length;
    const acceptedCount = sanitizedOrders.filter((o) => o.status === "accepted").length;
    const servedCount = sanitizedOrders.filter((o) => o.status === "served" || o.status === "paid").length;
    const cancelledCount = sanitizedOrders.filter((o) => o.status === "cancelled").length;

    const completedSales = sanitizedOrders
      .filter((o) => o.status === "served" || o.status === "paid")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    const cancelledValue = sanitizedOrders
      .filter((o) => o.status === "cancelled")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    const totalRevenue = sanitizedOrders
      .filter((o) => o.status !== "cancelled")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    const grossOrderValue = sanitizedOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    res.json({
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      completedSales: Math.round(completedSales * 100) / 100,
      cancelledValue: Math.round(cancelledValue * 100) / 100,
      grossOrderValue: Math.round(grossOrderValue * 100) / 100,
      counts: {
        pending: pendingCount,
        accepted: acceptedCount,
        served: servedCount,
        cancelled: cancelledCount,
      },
      orders: sanitizedOrders,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load order history: " + err.message });
  }
});

// ---------- ENHANCED MULTI-SHEET EXCEL REPORT EXPORT (.xlsx) ----------

// Export helpers (read-only formatting; nothing here touches stored orders)
const EXPORT_EMPTY = "—";

function exportText(value) {
  if (value === null || value === undefined) return EXPORT_EMPTY;
  const str = String(value).trim();
  return str === "" || str === "undefined" || str === "null" ? EXPORT_EMPTY : str;
}

// "01:25 PM" in Africa/Addis_Ababa. Uses the stored ISO instant when present, otherwise
// tidies the stored display string (e.g. "1:25:03 PM" -> "01:25 PM").
function exportTime(iso, storedText) {
  const d = iso ? new Date(iso) : null;
  if (d && !isNaN(d.getTime())) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  }
  const m = String(storedText || "").trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]} ${m[3].toUpperCase()}` : EXPORT_EMPTY;
}

const EXPORT_ROLE_LABELS = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  WAITER: "Waiter",
  KITCHEN_STAFF: "Kitchen Staff",
  CASHIER: "Cashier",
  CUSTOMER: "Customer",
};

function exportRoleLabel(role) {
  if (!role) return EXPORT_EMPTY;
  const key = String(role).toUpperCase();
  return EXPORT_ROLE_LABELS[key] || String(role);
}

function exportItemName(item) {
  if (!item) return EXPORT_EMPTY;
  const n = item.name;
  const resolved = n && typeof n === "object" ? n.en || Object.values(n).find(Boolean) : n;
  return exportText(resolved || item.customerName);
}

function exportStatusLabel(status) {
  let label = String(status || "").toUpperCase();
  if (label === "ACCEPTED") label = "ACCEPTED / IN PROGRESS";
  if (label === "SERVED" || label === "PAID") label = "SERVED / PAID";
  return label || EXPORT_EMPTY;
}

app.get("/api/admin/orders/export", requireAuth, requirePermission(PERMISSIONS.EXPORT_REPORTS), async (req, res) => {
  try {
    const { orders } = getCollections();
    const query = buildHistoryQuery(req.query);

    const reportOrders = await orders.find(query).sort({ createdAt: -1 }).toArray();
    const sanitizedOrders = reportOrders.map((o) => filterOrderForRole(o, req.user.role));

    const totalOrders = sanitizedOrders.length;
    const pendingCount = sanitizedOrders.filter((o) => o.status === "pending").length;
    const acceptedCount = sanitizedOrders.filter((o) => o.status === "accepted").length;
    const servedCount = sanitizedOrders.filter((o) => o.status === "served" || o.status === "paid").length;
    const cancelledCount = sanitizedOrders.filter((o) => o.status === "cancelled").length;

    const completedSales = sanitizedOrders
      .filter((o) => o.status === "served" || o.status === "paid")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    const cancelledValue = sanitizedOrders
      .filter((o) => o.status === "cancelled")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    const grossOrderValue = sanitizedOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    // Real category for order lines that predate the stored `category` field (looked up, never guessed)
    const categoryById = new Map();
    try {
      const missingIds = new Set();
      sanitizedOrders.forEach((o) =>
        (o.items || []).forEach((i) => {
          if (!i.category && i.itemId) missingIds.add(i.itemId);
        })
      );
      if (missingIds.size > 0) {
        const { menuItems } = getCollections();
        const found = await menuItems.find({ id: { $in: [...missingIds] } }).toArray();
        found.forEach((m) => {
          if (m.category) categoryById.set(m.id, m.category);
        });
      }
    } catch (e) {
      // Category lookup is best-effort; missing values are exported as "—"
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Yabi Cafe & Restaurant Ordering System";
    workbook.lastModifiedBy = req.user.fullName || req.user.username;
    workbook.created = new Date();
    workbook.modified = new Date();

    const headerFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF18231F" },
    };
    const headerFont = {
      name: "Calibri",
      size: 11,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };

    // ==========================================
    // SHEET 1: Report Summary
    // ==========================================
    const summarySheet = workbook.addWorksheet("Report Summary", {
      views: [{ showGridLines: true }],
    });

    summarySheet.columns = [
      { header: "Metric", key: "metric", width: 34 },
      { header: "Value", key: "value", width: 38 },
    ];

    const currentEt = getEthiopiaDateTime();
    const fromFilterText = req.query.fromDateTime || req.query.from || "All Time";
    const toFilterText = req.query.toDateTime || req.query.to || "All Time";
    const statusFilterText = req.query.status ? String(req.query.status).toUpperCase() : "ALL";
    const staffRoleFilterText = req.query.staffRole ? String(req.query.staffRole).toUpperCase() : "ALL";

    summarySheet.addRows([
      { metric: "Report Name", value: "Sales & Order Status Audit Report" },
      { metric: "Generated Date & Time", value: `${currentEt.orderDate} ${currentEt.orderTime} (Addis Ababa)` },
      { metric: "Generated By", value: `${req.user.fullName || req.user.username} (${req.user.role})` },
      { metric: "Filter Range (From)", value: fromFilterText },
      { metric: "Filter Range (To)", value: toFilterText },
      { metric: "Status Filter", value: statusFilterText },
      { metric: "Staff / Actor Filter", value: staffRoleFilterText },
      { metric: "----------------------------------------", value: "----------------------------------------" },
      { metric: "Total Orders Count", value: totalOrders },
      { metric: "Pending Orders", value: pendingCount },
      { metric: "Accepted / In Progress Orders", value: acceptedCount },
      { metric: "Served / Paid Orders", value: servedCount },
      { metric: "Cancelled Orders", value: cancelledCount },
      { metric: "----------------------------------------", value: "----------------------------------------" },
      { metric: "Completed Sales (ETB)", value: `${completedSales.toFixed(2)} ETB` },
      { metric: "Cancelled Value (ETB)", value: `${cancelledValue.toFixed(2)} ETB` },
      { metric: "Gross Total Value (ETB)", value: `${grossOrderValue.toFixed(2)} ETB` },
    ]);

    summarySheet.getRow(1).eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "left" };
    });

    // ==========================================
    // SHEET 2: Customer & Order Details
    // ==========================================
    const detailsSheet = workbook.addWorksheet("Customer & Order Details", {
      views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
    });

    detailsSheet.columns = [
      { header: "Order Number", key: "orderNumber", width: 14 },
      { header: "Customer Name", key: "customerName", width: 22 },
      { header: "Table Number", key: "tableNumber", width: 12 },
      { header: "Ordered Menu", key: "orderedMenu", width: 40 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Customer Spent (ETB)", key: "customerSpent", width: 20 },
      { header: "Order Day", key: "orderDay", width: 14 },
      { header: "Order Date", key: "orderDate", width: 26 },
      { header: "Order Time", key: "orderTime", width: 14 },
      { header: "Order Status", key: "orderStatus", width: 16 },
      { header: "Customer Special Request", key: "specialRequest", width: 30 },
      { header: "Customer Advice After Served", key: "customerAdvice", width: 34 },
      { header: "Cancelled By", key: "cancelledBy", width: 20 },
      { header: "Cancellation Reason", key: "cancellationReason", width: 30 },
      { header: "Cancellation Day", key: "cancellationDay", width: 16 },
      { header: "Cancellation Date", key: "cancellationDate", width: 26 },
      { header: "Cancellation Time", key: "cancellationTime", width: 18 },
      { header: "Served Day", key: "servedDay", width: 16 },
      { header: "Served Date", key: "servedDate", width: 26 },
      { header: "Served Time", key: "servedTime", width: 18 },
      // Added columns (existing columns above keep their position)
      { header: "Cancelled By (Name)", key: "cancelledByName", width: 22 },
      { header: "Special Request (Original)", key: "specialRequestOriginal", width: 30 },
      { header: "Completed Sales Value (ETB)", key: "completedSalesValue", width: 22 },
    ];

    detailsSheet.getRow(1).eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    sanitizedOrders.forEach((o) => {
      const orderNum = o.dailyOrderNumber || "#" + (o.dailySeq || 1);
      const itemsListStr = (o.items || [])
        .map((i) => `${exportItemName(i)} × ${i.qty}`)
        .join(", ") || "—";

      const totalQty = (o.items || []).reduce((sum, i) => sum + (i.qty || 0), 0);
      const customerSpentFormatted = Number((o.total || 0).toFixed(2));

      const createdDt = getEthiopiaDateTime(o.createdAt || o.pendingAt);
      const orderDayVal = o.orderDay || createdDt?.orderDay || "—";
      const orderDateVal = o.orderDate || createdDt?.orderDate || o.dateKey || "—";
      const orderTimeVal = exportTime(o.createdAt || o.pendingAt, o.orderTime);

      const statusDisplay = exportStatusLabel(o.status);

      // Cashiers never receive special-request text (see filterOrderForRole), so say so
      // instead of showing "—", which would wrongly read as "no request".
      const requestHidden = req.user.role === ROLES.CASHIER;
      const srText = requestHidden
        ? "Not visible to Cashier role"
        : exportText(o.specialRequest?.staffEnglish || o.customerSuggestion);
      const srOriginal = requestHidden
        ? "Not visible to Cashier role"
        : exportText(o.specialRequest?.originalText || o.customerSuggestion);

      let adviceText = "—";
      if (o.feedback) {
        const ratingPart = o.feedback.rating ? `${o.feedback.rating}★` : "";
        const commentPart = o.feedback.comment ? `"${o.feedback.comment}"` : "";
        adviceText = [ratingPart, commentPart].filter(Boolean).join(" - ") || "—";
      }

      // Cancellation metadata
      let cancelledByVal = "—";
      let cancellationReasonVal = "—";
      let cancelDayVal = "—";
      let cancelDateVal = "—";
      let cancelTimeVal = "—";

      let cancelledByNameVal = "—";
      if (o.status === "cancelled" || o.cancelledAt) {
        // Prefer the fields on the order; fall back to the recorded status-history event.
        const cancelEvent = (Array.isArray(o.statusHistory) ? o.statusHistory : [])
          .filter((ev) => ev && ev.newStatus === "cancelled")
          .pop();
        const cancelRole = o.cancelledByRole || cancelEvent?.actorRole;
        const cancelName = o.cancelledByName || cancelEvent?.actorName;

        cancelledByVal = exportRoleLabel(cancelRole);
        cancelledByNameVal = exportText(cancelName);
        cancellationReasonVal = exportText(o.cancellationReason || cancelEvent?.reason);

        const cancelDt = getEthiopiaDateTime(o.cancelledAt || cancelEvent?.timestamp);
        if (cancelDt) {
          cancelDayVal = cancelDt.orderDay;
          cancelDateVal = cancelDt.orderDate;
          cancelTimeVal = exportTime(o.cancelledAt || cancelEvent?.timestamp, o.cancelledTimeStr);
        } else if (o.cancelledTimeStr) {
          cancelTimeVal = exportTime(null, o.cancelledTimeStr);
        }
      }

      // Served metadata
      let servedDayVal = "—";
      let servedDateVal = "—";
      let servedTimeVal = "—";

      if (o.status === "served" || o.status === "paid" || o.servedAt) {
        const servedDt = getEthiopiaDateTime(o.servedAt);
        if (servedDt) {
          servedDayVal = servedDt.orderDay;
          servedDateVal = servedDt.orderDate;
          servedTimeVal = exportTime(o.servedAt, o.servedTimeStr);
        } else if (o.servedTimeStr) {
          servedTimeVal = exportTime(null, o.servedTimeStr);
        }
      }

      const row = detailsSheet.addRow({
        orderNumber: orderNum,
        customerName: exportText(o.customerName),
        tableNumber: exportText(o.tableNumber),
        orderedMenu: itemsListStr,
        quantity: totalQty,
        customerSpent: customerSpentFormatted,
        orderDay: orderDayVal,
        orderDate: orderDateVal,
        orderTime: orderTimeVal,
        orderStatus: statusDisplay,
        specialRequest: srText,
        customerAdvice: adviceText,
        cancelledBy: cancelledByVal,
        cancellationReason: cancellationReasonVal,
        cancellationDay: cancelDayVal,
        cancellationDate: cancelDateVal,
        cancellationTime: cancelTimeVal,
        servedDay: servedDayVal,
        servedDate: servedDateVal,
        servedTime: servedTimeVal,
        cancelledByName: cancelledByNameVal,
        specialRequestOriginal: srOriginal,
        // Same rule as the summary: only served / paid orders count as completed sales
        completedSalesValue:
          o.status === "served" || o.status === "paid" ? Number((o.total || 0).toFixed(2)) : 0,
      });

      row.getCell("customerSpent").numFmt = '#,##0.00 "ETB"';
      row.getCell("completedSalesValue").numFmt = '#,##0.00 "ETB"';
      // Wrap and top-align every cell so long requests, advice and reasons stay readable
      row.eachCell((cell) => {
        cell.alignment = { wrapText: true, vertical: "top" };
      });
    });

    detailsSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: detailsSheet.columns.length },
    };

    // ==========================================
    // SHEET 3: Order Items
    // ==========================================
    const itemsSheet = workbook.addWorksheet("Order Items", {
      views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
    });

    itemsSheet.columns = [
      { header: "Order Number", key: "orderNumber", width: 14 },
      { header: "Customer Name", key: "customerName", width: 22 },
      { header: "Table Number", key: "tableNumber", width: 12 },
      { header: "Menu Item", key: "menuItem", width: 28 },
      { header: "Category", key: "category", width: 14 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Unit Price (ETB)", key: "unitPrice", width: 18 },
      { header: "Item Total (ETB)", key: "itemTotal", width: 18 },
      { header: "Order Day", key: "orderDay", width: 14 },
      { header: "Order Date", key: "orderDate", width: 26 },
      { header: "Order Time", key: "orderTime", width: 14 },
      { header: "Order Status", key: "orderStatus", width: 16 },
    ];

    itemsSheet.getRow(1).eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    sanitizedOrders.forEach((o) => {
      const orderNum = o.dailyOrderNumber || "#" + (o.dailySeq || 1);
      const createdDt = getEthiopiaDateTime(o.createdAt || o.pendingAt);
      const orderDayVal = o.orderDay || createdDt?.orderDay || "—";
      const orderDateVal = o.orderDate || createdDt?.orderDate || o.dateKey || "—";
      const orderTimeVal = exportTime(o.createdAt || o.pendingAt, o.orderTime);

      const statusDisplay = exportStatusLabel(o.status);

      (o.items || []).forEach((item) => {
        const itemQty = Number(item.qty || 1);
        const unitPrice = Number(item.price || 0);
        const itemSubtotal = Number((itemQty * unitPrice).toFixed(2));
        const itemCat = item.category || categoryById.get(item.itemId) || "—";

        const row = itemsSheet.addRow({
          orderNumber: orderNum,
          customerName: exportText(o.customerName),
          tableNumber: exportText(o.tableNumber),
          menuItem: exportItemName(item),
          category: itemCat,
          quantity: itemQty,
          unitPrice: unitPrice,
          itemTotal: itemSubtotal,
          orderDay: orderDayVal,
          orderDate: orderDateVal,
          orderTime: orderTimeVal,
          orderStatus: statusDisplay,
        });

        row.getCell("unitPrice").numFmt = '#,##0.00 "ETB"';
        row.getCell("itemTotal").numFmt = '#,##0.00 "ETB"';
        row.eachCell((cell) => {
          cell.alignment = { wrapText: true, vertical: "top" };
        });
      });
    });

    itemsSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: itemsSheet.columns.length },
    };

    // ==========================================
    // SHEET 4: Status History
    // ==========================================
    const historySheet = workbook.addWorksheet("Status History", {
      views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
    });

    historySheet.columns = [
      { header: "Order Number", key: "orderNumber", width: 14 },
      { header: "Order ID", key: "orderId", width: 18 },
      { header: "Event", key: "eventType", width: 22 },
      { header: "Previous Status", key: "prevStatus", width: 16 },
      { header: "New Status", key: "newStatus", width: 16 },
      { header: "Actor Name", key: "actorName", width: 22 },
      { header: "Actor Role", key: "actorRole", width: 16 },
      { header: "Date", key: "date", width: 26 },
      { header: "Time", key: "time", width: 14 },
      { header: "Details / Reason", key: "details", width: 36 },
      { header: "Timestamp (ISO)", key: "timestamp", width: 24 },
    ];

    historySheet.getRow(1).eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    sanitizedOrders.forEach((o) => {
      const orderNum = o.dailyOrderNumber || "#" + (o.dailySeq || 1);
      const events = Array.isArray(o.statusHistory) && o.statusHistory.length > 0
        ? o.statusHistory
        : [
            {
              eventType: "ORDER_CREATED",
              previousStatus: "—",
              newStatus: "pending",
              actorName: o.customerName || "Customer",
              actorRole: "CUSTOMER",
              date: o.orderDate || o.dateKey,
              time: o.orderTime || "",
              details: "Order placed by customer",
              timestamp: o.createdAt || "",
            },
            ...(o.acceptedAt
              ? [{
                  eventType: "ORDER_ACCEPTED",
                  previousStatus: "pending",
                  newStatus: "accepted",
                  actorName: o.acceptedByName || "Staff",
                  actorRole: o.acceptedByRole || "STAFF",
                  date: o.orderDate || o.dateKey,
                  time: o.acceptedTimeStr || "",
                  details: "Order accepted into prep",
                  timestamp: o.acceptedAt,
                }]
              : []),
            ...(o.servedAt
              ? [{
                  eventType: "ORDER_SERVED",
                  previousStatus: "accepted",
                  newStatus: "served",
                  actorName: o.servedByName || "Staff",
                  actorRole: o.servedByRole || "STAFF",
                  date: o.orderDate || o.dateKey,
                  time: o.servedTimeStr || "",
                  details: "Order served to table",
                  timestamp: o.servedAt,
                }]
              : []),
            ...(o.cancelledAt
              ? [{
                  eventType: "ORDER_CANCELLED",
                  previousStatus: o.acceptedAt ? "accepted" : "pending",
                  newStatus: "cancelled",
                  actorName: o.cancelledByName || "Staff",
                  actorRole: o.cancelledByRole || "STAFF",
                  date: o.orderDate || o.dateKey,
                  time: o.cancelledTimeStr || "",
                  details: o.cancellationReason || "Order cancelled",
                  timestamp: o.cancelledAt,
                }]
              : []),
          ];

      events.forEach((ev) => {
        historySheet.addRow({
          orderNumber: orderNum,
          orderId: o.id,
          eventType: ev.eventType || "STATUS_CHANGE",
          prevStatus: ev.previousStatus || "—",
          newStatus: ev.newStatus || "—",
          actorName: ev.actorName || "—",
          actorRole: ev.actorRole || "—",
          date: ev.date || o.orderDate || "—",
          time: ev.time || "—",
          details: ev.reason || ev.details || "—",
          timestamp: ev.timestamp || "—",
        });
      });
    });

    historySheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: historySheet.columns.length },
    };

    // ==========================================
    // Navigation guide (added below the existing summary rows; nothing above is changed)
    // ==========================================
    const topWrap = { wrapText: true, vertical: "top" };
    const searchFilterText = req.query.search ? String(req.query.search).trim() : "";
    if (searchFilterText) {
      summarySheet.addRow({ metric: "Search Filter", value: searchFilterText });
    }
    summarySheet.addRow({ metric: "", value: "" });
    const guideHeader = summarySheet.addRow({ metric: "Sheets in this workbook", value: "Contents (click to open)" });
    guideHeader.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
    });
    [
      [detailsSheet, "One row per order — filter by customer, table, status, date, cancellation"],
      [itemsSheet, "One row per menu item — filter by menu item, category, quantity, price"],
      [historySheet, "Every status change of each order (audit trail)"],
    ].forEach(([sheet, description]) => {
      const rowCount = Math.max(sheet.rowCount - 1, 0);
      const r = summarySheet.addRow({
        metric: { text: sheet.name, hyperlink: `#'${sheet.name}'!A1` },
        value: `${rowCount} row(s) — ${description}`,
      });
      r.getCell(1).font = { name: "Calibri", size: 11, underline: true, color: { argb: "FF1F5FBF" } };
      r.eachCell((cell) => (cell.alignment = topWrap));
    });
    const noteRow = summarySheet.addRow({
      metric: "Note",
      value:
        "\"Customer Spent (ETB)\" shows each order's value, including cancelled orders. Only Served / Paid orders count as Completed Sales; use \"Completed Sales Value (ETB)\" on the details sheet to reconcile with the summary.",
    });
    noteRow.eachCell((cell) => (cell.alignment = topWrap));

    summarySheet.properties.tabColor = { argb: "FF18231F" };
    detailsSheet.properties.tabColor = { argb: "FF2E7D5B" };
    itemsSheet.properties.tabColor = { argb: "FF2E6FBF" };
    historySheet.properties.tabColor = { argb: "FF8A6D3B" };

    const fileNameDate = currentEt.dateKey;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Restaurant_Sales_Report_${fileNameDate}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: "Failed to generate Excel report: " + err.message });
  }
});

app.post("/api/admin/orders/:id/accept", requireAuth, requirePermission(PERMISSIONS.ACCEPT_ORDERS), async (req, res) => {
  try {
    const { orders } = getCollections();
    const now = getEthiopiaDateTime();

    const acceptEvent = {
      eventType: "ORDER_ACCEPTED",
      previousStatus: "pending",
      newStatus: "accepted",
      actorId: req.user.id,
      actorName: req.user.fullName || req.user.username,
      actorRole: req.user.role,
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Order accepted into preparation by ${req.user.fullName || req.user.username} (${req.user.role})`,
      reason: null,
    };

    const order = await orders.findOneAndUpdate(
      { id: req.params.id, status: "pending" },
      {
        $set: {
          status: "accepted",
          acceptedAt: now.isoTimestamp,
          acceptedTimeStr: now.orderTime,
          acceptedBy: req.user.id,
          acceptedByName: req.user.fullName || req.user.username,
          acceptedByRole: req.user.role,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: acceptEvent },
      },
      { returnDocument: "after" }
    );

    if (!order) return res.status(400).json({ error: "Order not found or not in pending state." });

    await recordAuditLog(
      req,
      "ACCEPT_ORDER",
      `Accepted Order ${order.dailyOrderNumber} by ${order.acceptedByName} (${order.acceptedByRole})`,
      req.user.username,
      req.user.role
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to accept order." });
  }
});

app.post("/api/admin/orders/:id/serve", requireAuth, requirePermission(PERMISSIONS.SERVE_ORDERS), async (req, res) => {
  try {
    const { orders } = getCollections();
    const now = getEthiopiaDateTime();
    const feedbackExpiresAt = new Date(Date.now() + FEEDBACK_WINDOW_MS).toISOString();

    const serveEvent = {
      eventType: "ORDER_SERVED",
      previousStatus: "accepted",
      newStatus: "served",
      actorId: req.user.id,
      actorName: req.user.fullName || req.user.username,
      actorRole: req.user.role,
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Order marked as served by ${req.user.fullName || req.user.username} (${req.user.role})`,
      reason: null,
    };

    const order = await orders.findOneAndUpdate(
      { id: req.params.id, status: "accepted" },
      {
        $set: {
          status: "served",
          servedAt: now.isoTimestamp,
          servedTimeStr: now.orderTime,
          feedbackExpiresAt: feedbackExpiresAt,
          servedBy: req.user.id,
          servedByName: req.user.fullName || req.user.username,
          servedByRole: req.user.role,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: serveEvent },
      },
      { returnDocument: "after" }
    );

    if (!order) return res.status(400).json({ error: "Order not found or not in accepted state." });

    await recordAuditLog(
      req,
      "SERVE_ORDER",
      `Served Order ${order.dailyOrderNumber} by ${order.servedByName} (${order.servedByRole})`,
      req.user.username,
      req.user.role
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to mark order as served." });
  }
});

app.post("/api/admin/orders/:id/cancel", requireAuth, requirePermission(PERMISSIONS.CANCEL_ORDERS), async (req, res) => {
  const { reason } = req.body;
  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 300) : "";

  if (!cleanReason) {
    return res.status(400).json({ error: "Cancellation reason is required." });
  }

  try {
    const { orders } = getCollections();
    const now = getEthiopiaDateTime();

    const cancelEvent = {
      eventType: "ORDER_CANCELLED",
      previousStatus: "pending_or_accepted",
      newStatus: "cancelled",
      actorId: req.user.id,
      actorName: req.user.fullName || req.user.username,
      actorRole: req.user.role,
      date: now.orderDate,
      time: now.orderTime,
      timestamp: now.isoTimestamp,
      details: `Cancelled by staff: ${cleanReason}`,
      reason: cleanReason,
    };

    const order = await orders.findOneAndUpdate(
      { id: req.params.id, status: { $nin: ["served", "paid"] } },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now.isoTimestamp,
          cancelledTimeStr: now.orderTime,
          cancelledBy: req.user.id,
          cancelledByName: req.user.fullName || req.user.username,
          cancelledByRole: req.user.role,
          cancellationReason: cleanReason,
          updatedAt: now.isoTimestamp,
        },
        $push: { statusHistory: cancelEvent },
      },
      { returnDocument: "after" }
    );

    if (!order) return res.status(400).json({ error: "Order not found or already completed/served." });

    await recordAuditLog(
      req,
      "CANCEL_ORDER",
      `Cancelled Order ${order.dailyOrderNumber} by ${req.user.fullName || req.user.username} (${req.user.role}) - Reason: ${cleanReason}`,
      req.user.username,
      req.user.role
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel order: " + err.message });
  }
});

// ---------- MENU MANAGEMENT (RBAC) ----------

app.get("/api/admin/menu", async (req, res) => {
  try {
    const { menuItems } = getCollections();
    let items = await menuItems.find({}).toArray();

    if (!items || items.length === 0) {
      if (fs.existsSync(JSON_DB_PATH)) {
        const json = JSON.parse(fs.readFileSync(JSON_DB_PATH, "utf-8"));
        items = json.menu || [];
      }
    }

    res.json(items.map(publicMenuItem));
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve menu." });
  }
});

app.post("/api/admin/upload", requireAuth, requirePermission(PERMISSIONS.MANAGE_MENU), async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== "string") {
      return res.status(400).json({ error: "No image payload provided." });
    }

    const matches = data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: "Invalid image format." });
    }

    const buffer = Buffer.from(matches[2], "base64");
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Image size exceeds 5MB limit." });
    }

    const ext = validateImageBuffer(buffer);
    if (!ext) {
      return res.status(400).json({ error: "Invalid image format. Allowed: JPG, PNG, WEBP, GIF." });
    }

    const fileName = `item_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${ext}`;
    const safePath = path.join(UPLOADS_DIR, path.basename(fileName));

    fs.writeFileSync(safePath, buffer);
    await recordAuditLog(req, "UPLOAD_IMAGE", `Uploaded product photo: ${fileName}`, req.user.username, req.user.role);

    res.json({ url: `/uploads/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to save image: " + err.message });
  }
});

app.post("/api/admin/menu", requireAuth, requirePermission(PERMISSIONS.MANAGE_MENU), async (req, res) => {
  const { name, category, description, ingredients, cost, available, image, translations } = req.body;

  const costNum = parseFloat(cost);
  if (isNaN(costNum) || costNum < 0) {
    return res.status(400).json({ error: "Valid non-negative item cost is required." });
  }

  const enName = typeof name === "string" ? name.trim() : (translations?.en?.name || "").trim();
  if (!enName) {
    return res.status(400).json({ error: "English product name is required." });
  }

  const formattedTranslations = translations && typeof translations === "object" ? { ...translations } : {};
  if (!formattedTranslations.en) {
    formattedTranslations.en = {
      name: enName,
      description: typeof description === "string" ? description.trim() : "",
      ingredients: Array.isArray(ingredients) ? ingredients : [],
    };
  }

  try {
    const { menuItems } = getCollections();
    const newItem = {
      id: makeId("item"),
      name: enName,
      translations: formattedTranslations,
      category: category === "Drinks" ? "Drinks" : "Food",
      cost: costNum,
      available: available !== undefined ? !!available : true,
      image: image ? String(image).trim() : "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await menuItems.insertOne(newItem);
    await recordAuditLog(req, "ADD_MENU_ITEM", `Added item: ${enName} (${newItem.cost} ETB)`, req.user.username, req.user.role);

    res.status(201).json(publicMenuItem(newItem));
  } catch (err) {
    res.status(500).json({ error: "Failed to add menu item." });
  }
});

app.put("/api/admin/menu/:id", requireAuth, requirePermission(PERMISSIONS.MANAGE_MENU), async (req, res) => {
  try {
    const { menuItems } = getCollections();
    const existing = await menuItems.findOne({ $or: [{ id: req.params.id }, { _id: req.params.id }] });
    if (!existing) return res.status(404).json({ error: "Item not found." });

    const { name, category, cost, available, image, translations } = req.body;
    const updateDoc = { updatedAt: new Date().toISOString() };

    if (category !== undefined) updateDoc.category = category === "Drinks" ? "Drinks" : "Food";
    if (cost !== undefined) {
      const num = parseFloat(cost);
      if (isNaN(num) || num < 0) return res.status(400).json({ error: "Cost must be positive." });
      updateDoc.cost = num;
    }
    if (available !== undefined) updateDoc.available = !!available;
    if (image !== undefined) {
      if (existing.image && existing.image !== image && existing.image.startsWith("/uploads/")) {
        safeDeleteUpload(existing.image);
      }
      updateDoc.image = String(image).trim();
    }

    if (translations && typeof translations === "object") {
      const existingTrans = existing.translations || {};
      const mergedTrans = { ...existingTrans };

      Object.keys(translations).forEach((lang) => {
        mergedTrans[lang] = {
          name: translations[lang]?.name !== undefined ? translations[lang].name : (existingTrans[lang]?.name || ""),
          description: translations[lang]?.description !== undefined ? translations[lang].description : (existingTrans[lang]?.description || ""),
          ingredients: translations[lang]?.ingredients !== undefined ? translations[lang].ingredients : (existingTrans[lang]?.ingredients || []),
        };
      });

      updateDoc.translations = mergedTrans;
      updateDoc.name = mergedTrans.en?.name || existing.name;
    } else if (name !== undefined) {
      updateDoc.name = String(name).trim();
      const existingTrans = existing.translations || {};
      if (existingTrans.en) {
        existingTrans.en.name = updateDoc.name;
        updateDoc.translations = existingTrans;
      }
    }

    const result = await menuItems.findOneAndUpdate(
      { $or: [{ id: req.params.id }, { _id: req.params.id }] },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const itemName = result.translations?.en?.name || result.name;
    await recordAuditLog(req, "EDIT_MENU_ITEM", `Edited item: ${itemName}`, req.user.username, req.user.role);
    res.json(publicMenuItem(result));
  } catch (err) {
    res.status(500).json({ error: "Failed to update menu item." });
  }
});

app.delete("/api/admin/menu/:id", requireAuth, requirePermission(PERMISSIONS.MANAGE_MENU), async (req, res) => {
  try {
    const { menuItems } = getCollections();
    const removed = await menuItems.findOneAndDelete({ $or: [{ id: req.params.id }, { _id: req.params.id }] });
    if (!removed) return res.status(404).json({ error: "Item not found." });

    if (removed.image) {
      safeDeleteUpload(removed.image);
    }
    const itemName = removed.translations?.en?.name || removed.name;
    await recordAuditLog(req, "DELETE_MENU_ITEM", `Deleted item: ${itemName}`, req.user.username, req.user.role);

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete item." });
  }
});

// ---------- AUDIT LOGS ----------

app.get("/api/admin/audit-logs", requireAuth, requirePermission(PERMISSIONS.VIEW_AUDIT_LOGS), async (req, res) => {
  try {
    const { auditLogs } = getCollections();
    const logs = await auditLogs.find({}).sort({ iso: -1 }).limit(500).toArray();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to load audit logs." });
  }
});

app.all("/api/*", (req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

// Auto-populate MongoDB from db.json on startup
async function syncDatabaseFromJSON() {
  try {
    const { menuItems, tables, users } = getCollections();

    if (fs.existsSync(JSON_DB_PATH)) {
      const raw = fs.readFileSync(JSON_DB_PATH, "utf-8");
      const data = JSON.parse(raw);

      const currentCount = await menuItems.countDocuments();
      if (currentCount < (data.menu || []).length) {
        for (const item of data.menu || []) {
          await menuItems.updateOne(
            { id: item.id },
            { $set: publicMenuItem(item) },
            { upsert: true }
          );
        }
        console.log(`[MongoDB] Synchronized ${(data.menu || []).length} menu items from db.json.`);
      }

      const tableCount = await tables.countDocuments();
      if (tableCount === 0) {
        for (const t of data.tables || [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }, { number: "5" }]) {
          await tables.updateOne({ number: String(t.number) }, { $setOnInsert: { number: String(t.number) } }, { upsert: true });
        }
      }

      for (const u of data.users || []) {
        await users.updateOne({ username: u.username.toLowerCase() }, { $setOnInsert: u }, { upsert: true });
      }
    }
  } catch (e) {
    console.warn("[MongoDB Sync Warning]", e.message);
  }
}

// Bootstrap & Start Server
async function startServer() {
  try {
    await connectDB();
    await syncDatabaseFromJSON();

    const CERT_DIR = path.join(__dirname, "..", "certificates");
    const KEY_PATH = path.join(CERT_DIR, "server-key.pem");
    const CERT_PATH = path.join(CERT_DIR, "server-cert.pem");

    let server;
    const isDirectHttps = fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);

    if (isDirectHttps) {
      try {
        const httpsOptions = {
          key: fs.readFileSync(KEY_PATH),
          cert: fs.readFileSync(CERT_PATH),
        };
        server = https.createServer(httpsOptions, app);
        console.log(`[HTTPS] Direct SSL Certificates loaded.`);
      } catch (e) {
        server = http.createServer(app);
      }
    } else {
      server = http.createServer(app);
    }

    server.listen(PORT, "0.0.0.0", () => {
      const detectedIP = getLocalIPv4();
      const origin = APP_URL || `http://${detectedIP}:${PORT}`;
      console.log(`\n======================================================`);
      console.log(` 🍽️  Multilingual Restaurant Ordering System Running`);
      console.log(` Production URL: ${APP_URL || `http://${detectedIP}:${PORT}`}`);
      console.log(` Customer Menu:  ${origin}/?table=1`);
      console.log(` Staff Portal:   ${origin}/admin.html`);
      console.log(` QR Generator:   ${origin}/qr-generator.html`);
      console.log(`======================================================\n`);
    });
  } catch (err) {
    console.error("FATAL: Database connection failed:", err);
    process.exit(1);
  }
}

startServer();