// ---------------------------------------------------------------------------
// Security Middleware, RBAC Permission Matrix & Cryptographic Helpers
// ---------------------------------------------------------------------------
const crypto = require("crypto");

const SESSION_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_PERIOD_MS = 15 * 60 * 1000; // 15 minutes

const loginAttempts = new Map(); // IP -> { count, lockedUntil }

// ---------- Role Definitions ----------
const ROLES = {
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  WAITER: "WAITER",
  KITCHEN_STAFF: "KITCHEN_STAFF",
  CASHIER: "CASHIER",
};

// ---------- Permission Definitions ----------
const PERMISSIONS = {
  VIEW_DASHBOARD: "VIEW_DASHBOARD",
  VIEW_ORDERS: "VIEW_ORDERS",
  ACCEPT_ORDERS: "ACCEPT_ORDERS",
  SERVE_ORDERS: "SERVE_ORDERS",
  CANCEL_ORDERS: "CANCEL_ORDERS",
  VIEW_HISTORY: "VIEW_HISTORY",
  MANAGE_MENU: "MANAGE_MENU",
  VIEW_AUDIT_LOGS: "VIEW_AUDIT_LOGS",
  MANAGE_STAFF: "MANAGE_STAFF",
  CHANGE_PASSWORD: "CHANGE_PASSWORD",
  VIEW_REPORTS: "VIEW_REPORTS",
  EXPORT_REPORTS: "EXPORT_REPORTS",
};

// ---------- Role-to-Permissions Mapping ----------
const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.MANAGER]: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.ACCEPT_ORDERS,
    PERMISSIONS.SERVE_ORDERS,
    PERMISSIONS.CANCEL_ORDERS,
    PERMISSIONS.VIEW_HISTORY,
    PERMISSIONS.MANAGE_MENU,
    PERMISSIONS.CHANGE_PASSWORD,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.EXPORT_REPORTS,
  ],
  [ROLES.WAITER]: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.ACCEPT_ORDERS,
    PERMISSIONS.SERVE_ORDERS,
    PERMISSIONS.VIEW_HISTORY,
    PERMISSIONS.CHANGE_PASSWORD,
  ],
  [ROLES.KITCHEN_STAFF]: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.ACCEPT_ORDERS,
    PERMISSIONS.SERVE_ORDERS,
    PERMISSIONS.VIEW_HISTORY,
    PERMISSIONS.CHANGE_PASSWORD,
  ],
  [ROLES.CASHIER]: [
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.VIEW_HISTORY,
    PERMISSIONS.CHANGE_PASSWORD,
  ],
};

function hasPermission(role, permission) {
  const allowed = ROLE_PERMISSIONS[role] || [];
  return allowed.includes(permission);
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

// ---------- Password Hashing (PBKDF2-SHA512) ----------
function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(32).toString("hex");
  }
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  const { hash } = hashPassword(password, storedSalt);
  const bufferA = Buffer.from(hash, "hex");
  const bufferB = Buffer.from(storedHash, "hex");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

// ---------- Session Generator ----------
function generateSession(user) {
  return {
    sessionId: crypto.randomBytes(32).toString("hex"),
    csrfToken: crypto.randomBytes(24).toString("hex"),
    userId: user.id,
    username: user.username,
    fullName: user.fullName || user.username,
    role: user.role || ROLES.WAITER,
    permissions: getPermissionsForRole(user.role),
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
}

// ---------- Rate Limiting Middleware ----------
function checkLoginRateLimit(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
  const now = Date.now();
  const attempt = loginAttempts.get(ip);

  if (attempt && attempt.lockedUntil && attempt.lockedUntil > now) {
    const remainingMins = Math.ceil((attempt.lockedUntil - now) / 60000);
    return res.status(429).json({
      error: `Too many failed attempts. Please try again in ${remainingMins} minute(s).`,
    });
  }

  next();
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  attempt.count++;

  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.lockedUntil = now + LOCKOUT_PERIOD_MS;
    attempt.count = 0;
  }
  loginAttempts.set(ip, attempt);
}

function resetLoginFailure(ip) {
  loginAttempts.delete(ip);
}

// ---------- Cookie Parser Helper ----------
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;

  cookieHeader.split(";").forEach((cookie) => {
    let [name, ...rest] = cookie.split("=");
    name = name?.trim();
    if (!name) return;
    const value = rest.join("=").trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// ---------- Magic Bytes Image Validator ----------
function validateImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "gif";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}

// ---------- Security HTTP Headers Middleware ----------
function applySecurityHeaders(req, res, next) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "1; mode=block");

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https: blob:; " +
      "connect-src 'self' https: wss:; " +
      "media-src 'self' data: blob:; " +
      "frame-ancestors 'none';"
  );
  next();
}

module.exports = {
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
};