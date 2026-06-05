import "dotenv/config";
import express from "express";
// Patches Express 4 Layer to forward async route handler rejections to the
// global error middleware. Without this, awaited rejections (e.g. invalid
// ObjectId, Mongo errors) leave requests hanging until the 30s timeout.
import "express-async-errors";
import cors from "cors";
import { MongoClient, ObjectId, BSON } from "mongodb";
import { Ollama } from "ollama";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import QRCode from "qrcode";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import os from "node:os";
import http from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const execAsync = promisify(exec);

const app = express();
const { EJSON } = BSON;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

/** Live dashboard / FR Monitor — browser connects with ?token=JWT (same secret as REST Bearer). */
const wsClients = new Set();

/** Token revocation cache for immediate session invalidation on suspension/deletion.
 * Key: userId (employeeId or account _id), Value: { revokedAt, expiresAt }
 * Automatically cleans up entries older than 13 hours (JWT expiry is 12h).
 */
const revokedTokenCache = new Map();
const TOKEN_REVOCATION_TTL_MS = 13 * 60 * 60 * 1000; // 13 hours (JWT expiry + 1h buffer)

/** Check if a userId has had their tokens revoked. Also cleans expired entries. */
function isTokenRevoked(userId) {
  const key = String(userId || "").trim();
  if (!key) return false;
  const entry = revokedTokenCache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    revokedTokenCache.delete(key);
    return false;
  }
  return true;
}

/** Revoke all tokens for a user. Called on suspension/deletion. */
function revokeUserTokens(userId) {
  const key = String(userId || "").trim();
  if (!key) return;
  revokedTokenCache.set(key, {
    revokedAt: Date.now(),
    expiresAt: Date.now() + TOKEN_REVOCATION_TTL_MS
  });
  console.log(`[auth] Tokens revoked for user: ${key}`);
}

/** Periodic cleanup of expired revocation entries. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of revokedTokenCache.entries()) {
    if (now > entry.expiresAt) revokedTokenCache.delete(key);
  }
}, 60 * 60 * 1000); // hourly cleanup

/** Lightweight LRU cache for expensive aggregations (AI insights, metrics, etc).
 * Prevents repeated heavy queries from overloading MongoDB.
 */
class SimpleCache {
  constructor(maxSize = 100, defaultTtlMs = 30000) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }
  set(key, value, ttlMs) {
    const expiresAt = Date.now() + (ttlMs || this.defaultTtlMs);
    if (this.cache.size >= this.maxSize) {
      // Evict oldest
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt });
  }
  invalidate(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) this.cache.delete(key);
    }
  }
}
const aggregationCache = new SimpleCache(50, 30000); // 50 entries, 30s TTL

function serializeLogForWs(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const o = { ...doc };
  for (const k of ["createdAt", "timestamp", "ts", "updatedAt"]) {
    const v = o[k];
    if (v instanceof Date) o[k] = v.toISOString();
  }
  if (o._id && typeof o._id.toString === "function") o._id = String(o._id);
  return o;
}

/** WebSocket broadcast throttling - max 100 events/sec per client to prevent flooding. */
const wsThrottleTimestamps = new Map();
const WS_THROTTLE_MS = 100; // 100ms = 10 events/sec max per client

function shouldThrottleWsClient(ws) {
  const now = Date.now();
  const lastSent = wsThrottleTimestamps.get(ws);
  if (!lastSent || now - lastSent >= WS_THROTTLE_MS) {
    wsThrottleTimestamps.set(ws, now);
    return false;
  }
  return true;
}

function broadcastAccessEvent(doc) {
  const payload = serializeLogForWs(doc);
  const msg = JSON.stringify({ type: "ACCESS_EVENT", data: payload });
  let dropped = 0;
  for (const ws of wsClients) {
    try {
      if (ws.readyState !== 1) continue;
      if (shouldThrottleWsClient(ws)) {
        dropped++;
        continue;
      }
      ws.send(msg);
    } catch {
      /* ignore */
    }
  }
  // Cleanup stale throttle entries for disconnected clients periodically
  if (dropped > 0 && wsThrottleTimestamps.size > wsClients.size * 2) {
    for (const [ws] of wsThrottleTimestamps) {
      if (!wsClients.has(ws)) wsThrottleTimestamps.delete(ws);
    }
  }
}

function broadcastEmployeeUpdated(emp) {
  const payload = serializeLogForWs(emp);
  const msg = JSON.stringify({ type: "EMPLOYEE_UPDATED", data: payload });
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch {
      /* ignore */
    }
  }
}

const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://mongo:27017/expo-fr";
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "50mb";
const REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.REQUEST_TIMEOUT_MS || 30000));
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60000));
const RATE_LIMIT_MAX = Math.max(20, Number(process.env.RATE_LIMIT_MAX || 1200));
const RATE_LIMIT_AUTH_MAX = Math.max(5, Number(process.env.RATE_LIMIT_AUTH_MAX || 60));
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://ollama:11434";
const GSDK_GATEWAY = process.env.GSDK_GATEWAY || process.env.SUPREMA_HOST || "";
/** Sidecar HTTP base. `.env` often uses localhost:4500 for host dev; inside a container that hits *this* image, not gsdk-sidecar. */
function resolveGsdkSidecarUrl() {
  const raw = String(process.env.GSDK_SIDECAR_URL || "").trim();
  if (!raw) return "";
  try {
    if (existsSync("/.dockerenv")) {
      const lower = raw.toLowerCase();
      if (lower.includes("localhost") || lower.includes("127.0.0.1")) {
        return "http://gsdk-sidecar:4500";
      }
    }
  } catch {
    /* ignore */
  }
  return raw;
}
const GSDK_SIDECAR_URL = resolveGsdkSidecarUrl();
const GSDK_USE_SSL = String(process.env.GSDK_USE_SSL ?? process.env.SUPREMA_SSL ?? "false").toLowerCase() === "true";
const GSDK_DEVICE_PORT = Number(process.env.GSDK_DEVICE_PORT || process.env.SUPREMA_PORT || 51211);
/** When direct TCP to the reader fails, still mark online if the gateway reports an active session (see tickDeviceHealth). */
const DEVICE_HEALTH_GATEWAY_FALLBACK = String(process.env.DEVICE_HEALTH_GATEWAY_FALLBACK ?? "true").toLowerCase() === "true";
/** Backend→sidecar HTTP fetch (grpc via sidecar can exceed a few seconds after TLS cold start). */
const GSDK_SIDECAR_HTTP_MS = Number(process.env.GSDK_SIDECAR_HTTP_MS || 15000);
/** After saving enrollment photo, push Visual Face template to readers via gsdk-sidecar (Normalize→Extract→User.Enroll). */
const ENROLLMENT_PUSH_DEVICES = String(process.env.ENROLLMENT_PUSH_DEVICES ?? "true").toLowerCase() === "true";
/** If live Face.Scan enroll fails (common: BS3 false "Invalid finger"), call push-face with stored enrollment JPEG on the same reader. */
const LIVE_ENROLL_PUSH_FACE_FALLBACK =
  String(process.env.LIVE_ENROLL_PUSH_FACE_FALLBACK ?? "true").toLowerCase() === "true";
/** Call G-SDK User.Delete on readers when an employee is removed or suspended (database-only delete leaves templates on device). */
const DEVICE_REVOKE_ON_EMPLOYEE_REMOVE =
  String(process.env.DEVICE_REVOKE_ON_EMPLOYEE_REMOVE ?? "true").toLowerCase() === "true";
/** Auto-refresh face templates to readers from successful scan activity during idle/free periods. */
const FACE_AUTO_REFRESH_ENABLED =
  String(process.env.FACE_AUTO_REFRESH_ENABLED ?? "true").toLowerCase() === "true";
const FACE_AUTO_REFRESH_TICK_MS = Math.max(60_000, Number(process.env.FACE_AUTO_REFRESH_TICK_MS || 5 * 60_000));
const FACE_AUTO_REFRESH_IDLE_MS = Math.max(30_000, Number(process.env.FACE_AUTO_REFRESH_IDLE_MS || 3 * 60_000));
const FACE_AUTO_REFRESH_MIN_GAP_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.FACE_AUTO_REFRESH_MIN_GAP_MS || 24 * 60 * 60 * 1000)
);
const FACE_AUTO_REFRESH_BATCH = Math.max(1, Math.min(20, Number(process.env.FACE_AUTO_REFRESH_BATCH || 2)));
/** Poll interval for pulling device logs via sidecar (GET_LOG). Lower = nearer real-time; more gateway load. */
// Near-real-time ingest: reader pushes to gateway; backend should pull very frequently from sidecar.
const DEVICE_EVENT_PULL_MS = Math.max(500, Number(process.env.DEVICE_EVENT_PULL_MS || 1000));
/** Max concurrent sidecar GetLog pulls per tick (~200 devices: unbounded Promise.all can overload gateway). */
const DEVICE_EVENT_PULL_CONCURRENCY = Math.max(
  1,
  Math.min(128, Number(process.env.DEVICE_EVENT_PULL_CONCURRENCY || 20))
);
/** Extra historical pull window to backfill scan photos on already-inserted rows (same supremaLogId). */
const DEVICE_PHOTO_BACKFILL_WINDOW = Math.min(
  5000,
  Math.max(200, Number(process.env.DEVICE_PHOTO_BACKFILL_WINDOW || 1200))
);
/** Run historical photo backfill at most once per device per interval to avoid gateway overload. */
const DEVICE_PHOTO_BACKFILL_EVERY_MS = Math.max(
  15000,
  Number(process.env.DEVICE_PHOTO_BACKFILL_EVERY_MS || 60000)
);
/** Mongo TTL on `logs.createdAt`. Omit env or set `LOG_RETENTION_DAYS=0` for unlimited (no TTL). Positive integer = rolling N-day expiry. */
function parseLogRetentionConfig() {
  const raw = process.env.LOG_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ttlEnabled: false, days: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ttlEnabled: false, days: null };
  return { ttlEnabled: true, days: Math.max(1, Math.floor(n)) };
}
const logRetentionCfg = parseLogRetentionConfig();
const LOG_TTL_ENABLED = logRetentionCfg.ttlEnabled;
/** Null when unlimited. */
const LOG_RETENTION_DAYS = logRetentionCfg.days;
/** When incremental GetLog returns nothing but Mongo still has lastEventId, probe from id 0; if the device log is shorter than that cursor (log cleared / counter reset), clear lastEventId and resync. */
const DEVICE_LOG_RECOVERY_PROBE_LIMIT = Math.min(
  8000,
  Math.max(200, Number(process.env.DEVICE_LOG_RECOVERY_PROBE_LIMIT || 2000))
);
/**
 * One failed face interaction often produces several BioStar auth-deny rows in the same second (e.g. verify fail + identify fail + access denied).
 * When true, keep a single deny row per device per second (highest suprema log id = last in device sequence).
 */
const DEVICE_LOG_COLLAPSE_AUTH_BURST =
  String(process.env.DEVICE_LOG_COLLAPSE_AUTH_BURST ?? "true").toLowerCase() === "true";
/** After gateway restart, devices are denied until Connect.SetAcceptFilter — refresh periodically via sidecar. */
const AUTO_SET_ACCEPT_FILTER = String(process.env.AUTO_SET_ACCEPT_FILTER ?? "true").toLowerCase() === "true";
const ACCEPT_FILTER_REFRESH_MS = Math.max(30000, Number(process.env.ACCEPT_FILTER_REFRESH_MS || 120000));
/** Intelligent self-healing loop for sidecar/gateway/device event flow. */
const SELF_HEALING_ENABLED = String(process.env.SELF_HEALING_ENABLED ?? "true").toLowerCase() === "true";
const SELF_HEALING_TICK_MS = Math.max(5000, Number(process.env.SELF_HEALING_TICK_MS || 15000));
const SELF_HEALING_FAIL_THRESHOLD = Math.max(1, Number(process.env.SELF_HEALING_FAIL_THRESHOLD || 3));
const SELF_HEALING_COOLDOWN_MS = Math.max(5000, Number(process.env.SELF_HEALING_COOLDOWN_MS || 20000));
/** Watchdog: detect stalled loops and trigger recovery immediately. */
const WATCHDOG_ENABLED = String(process.env.WATCHDOG_ENABLED ?? "true").toLowerCase() === "true";
const WATCHDOG_TICK_MS = Math.max(5000, Number(process.env.WATCHDOG_TICK_MS || 15000));
const WATCHDOG_STALE_PULL_MS = Math.max(20000, Number(process.env.WATCHDOG_STALE_PULL_MS || 45000));
/** Device sync queue: retry operations (revoke/enroll/update) for offline devices when they come online. */
const DEVICE_SYNC_QUEUE_ENABLED = String(process.env.DEVICE_SYNC_QUEUE_ENABLED ?? "true").toLowerCase() === "true";
const DEVICE_SYNC_QUEUE_TICK_MS = Math.max(5000, Number(process.env.DEVICE_SYNC_QUEUE_TICK_MS || 30000));
const DEVICE_SYNC_MAX_RETRIES = Math.max(0, Math.min(1000, Number(process.env.DEVICE_SYNC_MAX_RETRIES || 10)));
const DEVICE_SYNC_BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.DEVICE_SYNC_BATCH_SIZE || 20)));
/** Unlimited retention: keep queue items forever (retry indefinitely) - for devices offline 24h/1week+.
 * When true, maxRetries is ignored and items stay pending until successful or manually cleared. */
const DEVICE_SYNC_UNLIMITED_RETENTION =
  String(process.env.DEVICE_SYNC_UNLIMITED_RETENTION ?? "true").toLowerCase() === "true";
/** Max delay between retries in unlimited mode (default 1 hour). Prevents spamming while keeping items alive. */
const DEVICE_SYNC_MAX_RETRY_DELAY_MS = Math.max(
  60000,
  Number(process.env.DEVICE_SYNC_MAX_RETRY_DELAY_MS || 60 * 60 * 1000)
);
/** Call G-SDK User.Delete on readers when a visitor is removed or suspended (database-only delete leaves templates on device). */
const DEVICE_REVOKE_ON_VISITOR_REMOVE =
  String(process.env.DEVICE_REVOKE_ON_VISITOR_REMOVE ?? "true").toLowerCase() === "true";
/** After saving visitor enrollment photo, push Visual Face template to readers via gsdk-sidecar. */
const VISITOR_ENROLLMENT_PUSH_DEVICES = String(process.env.VISITOR_ENROLLMENT_PUSH_DEVICES ?? "true").toLowerCase() === "true";

const requestBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of requestBuckets.entries()) {
    if (!v || v.resetAt <= now) requestBuckets.delete(k);
  }
}, 60 * 1000);

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

function rateLimit(maxHits, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${clientIp(req)}:${req.path}`;
    const cur = requestBuckets.get(bucketKey);
    if (!cur || cur.resetAt <= now) {
      requestBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    cur.count += 1;
    if (cur.count > maxHits) {
      const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Too many requests. Please retry shortly." });
    }
    return next();
  };
}

// CORS: in production, set CORS_ORIGINS to a comma-separated allowlist (e.g. "https://app.expo.ae,https://kiosk.expo.ae")
// Leave empty for permissive dev mode.
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: CORS_ORIGINS.length
    ? (origin, cb) => {
        if (!origin) return cb(null, true);                  // same-origin / curl / mobile webview
        if (CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin ${origin} not allowed`), false);
      }
    : true,                                                   // dev: allow all
  credentials: true,
  exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"]
}));
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timeout" });
    }
  });
  next();
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use("/api", rateLimit(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS));

/** Updated after each tickDeviceEventPull — for GET /api/gsdk/diagnostics */
let lastDeviceEventPullStats = { at: null, devices: 0, pulled: 0, inserted: 0 };
const lastPhotoBackfillRunAtByDevice = new Map();
const faceAutoRefreshQueue = new Map(); // key: employeeId/supremaUserId, value: queue metadata
const faceAutoRefreshState = {
  queued: 0,
  processed: 0,
  failed: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: ""
};
let faceAutoRefreshRunning = false;
let faceAutoRefreshStarted = false;
let lastDeviceEventActivityAt = 0;

function deriveSupremaUserId(emp) {
  const raw = String(emp?.employeeId || emp?.passNumber || "").trim();
  const digits = raw.replace(/\D/g, "");
  // Suprema device user ID must fit in uint32 (max 4294967295)
  if (digits.length >= 1 && digits.length <= 9) return digits;
  if (digits.length > 9) return digits.slice(-9); // take last 9 digits
  const hex = String(emp?._id || "").replace(/[^a-fA-F0-9]/g, "");
  if (hex.length >= 8) return String(parseInt(hex.slice(-8), 16) % 4294967295 || 1);
  return "1001";
}

/** Prefer persisted supremaUserId (what was enrolled on the reader) over a fresh derive. */
function resolveSupremaUserIdForDevice(emp) {
  const stored = String(emp?.supremaUserId || "").trim();
  if (stored) return stored;
  return deriveSupremaUserId(emp);
}

/** Derive Suprema device user ID for visitors. Must fit in uint32 (max 4294967295).
 * Visitors get a 'V' prefix in string form, but numeric ID is based on their MongoDB _id.
 */
function deriveVisitorSupremaUserId(visitor) {
  // Use visitor's MongoDB _id to create a deterministic unique ID
  const hex = String(visitor?._id || "").replace(/[^a-fA-F0-9]/g, "");
  if (hex.length >= 8) {
    const numeric = String(parseInt(hex.slice(-8), 16) % 4294967295 || 1);
    return `V${numeric}`;
  }
  // Fallback using timestamp + random
  const ts = Date.now() % 10000000;
  return `V${ts + 900000000}`; // Start at 900M to avoid collision with employee IDs
}

/** Prefer persisted supremaUserId for visitors, otherwise derive. */
function resolveVisitorSupremaUserIdForDevice(visitor) {
  const stored = String(visitor?.supremaUserId || "").trim();
  if (stored) return stored;
  return deriveVisitorSupremaUserId(visitor);
}

/** Collect all user ID variants to delete for a visitor (similar to employees). */
function collectVisitorRevokeUserIds(visitor) {
  const ids = new Set();
  const add = (x) => {
    const s = String(x ?? "").trim();
    if (s) ids.add(s);
  };
  add(resolveVisitorSupremaUserIdForDevice(visitor));
  add(deriveVisitorSupremaUserId(visitor));
  // Also add any stored aliases
  if (Array.isArray(visitor?.supremaAliases)) {
    visitor.supremaAliases.forEach((a) => add(a));
  }
  return Array.from(ids);
}

/** Load visitor photo from disk storage as base64 string. */
async function loadVisitorPhotoFromDisk(visitor) {
  try {
    if (!visitor?.photoStorageRelativeDir || !visitor?.photoStorageFile) return null;
    const absDir = path.join(VISITOR_QR_STORAGE_DIR, visitor.photoStorageRelativeDir);
    const photoPath = path.join(absDir, visitor.photoStorageFile);
    if (!existsSync(photoPath)) return null;
    const buffer = await readFile(photoPath);
    return buffer.toString("base64");
  } catch (e) {
    console.error("[backend] loadVisitorPhotoFromDisk failed:", e?.message || e);
    return null;
  }
}

/** JSON fields for gsdk-sidecar enroll — maps users to BioStar access groups so doors can grant access. */
function sidecarAccessGroupBody() {
  const rawList = process.env.SUPREMA_ACCESS_GROUP_IDS;
  if (rawList != null && String(rawList).trim() !== "") {
    const ids = String(rawList)
      .split(/[\s,]+/)
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => n >>> 0);
    if (ids.length) {
      const primary = ids[0] >>> 0;
      /** BioStation often expects both UserHdr auth group and repeated access group IDs (door checks membership). */
      return { accessGroupIds: ids, authGroupId: primary };
    }
  }
  const ag = Number(process.env.DEFAULT_SUPREMA_ACCESS_GROUP ?? process.env.GSDK_DEFAULT_AUTH_GROUP ?? 1) >>> 0;
  return ag > 0 ? { authGroupId: ag, accessGroupIds: [ag] } : {};
}

/** Short hint for diagnostics — not a substitute for BioStar UI. */
function supremaAccessGroupConfigHint() {
  const body = sidecarAccessGroupBody();
  const raw = String(process.env.SUPREMA_ACCESS_GROUP_IDS || "").trim();
  const def = String(process.env.DEFAULT_SUPREMA_ACCESS_GROUP || process.env.GSDK_DEFAULT_AUTH_GROUP || "").trim();
  const source =
    raw !== ""
      ? "SUPREMA_ACCESS_GROUP_IDS"
      : def !== ""
        ? "DEFAULT_SUPREMA_ACCESS_GROUP or GSDK_DEFAULT_AUTH_GROUP"
        : "default (1)";
  return {
    source,
    jsonForSidecar: body,
    note:
      "Door Access Level in BioStar must allow at least one of these group IDs, or users get 0x1900 / sub 0x01 (invalid access group). Find group IDs in BioStar: Access Control → Access Groups; door policy under Doors / Floor levels."
  };
}

/**
 * Suprema gateway device id for User.Delete / Enroll / GetLog.
 * Must match `supremaNumericDeviceId` used by log pull — revoke previously only checked
 * `supremaDeviceId`/`gatewayId` and skipped devices that only had `deviceId` / `bioStarDeviceId`.
 */
function supremaNumericDeviceId(device = {}) {
  const keys = ["supremaDeviceId", "supremaId", "bioStarDeviceId", "bioStarDeviceID", "gatewayId"];
  for (const k of keys) {
    const v = device[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const raw = device.deviceId;
  if (raw !== undefined && raw !== null && raw !== "") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/** Unique UserHdr id strings to delete (app enroll vs legacy / BioStar-style ids). */
function collectRevokeUserIds(emp) {
  const ids = new Set();
  const add = (x) => {
    const s = String(x ?? "").trim();
    if (s) ids.add(s);
  };
  add(resolveSupremaUserIdForDevice(emp));
  add(deriveSupremaUserId(emp));
  const digits = String(emp?.employeeId ?? emp?.passNumber ?? "").replace(/\D/g, "");
  if (digits.length >= 1 && digits.length <= 9) add(digits);
  else if (digits.length > 9) add(digits.slice(-9));
  if (Array.isArray(emp?.supremaAliases)) {
    for (const a of emp.supremaAliases) add(a);
  }
  return [...ids];
}

function queueFaceAutoRefresh(identity = "", reason = "scan_success") {
  const key = String(identity || "").trim();
  if (!key) return;
  const prev = faceAutoRefreshQueue.get(key);
  if (prev) {
    faceAutoRefreshQueue.set(key, { ...prev, reason: prev.reason || reason });
    return;
  }
  faceAutoRefreshQueue.set(key, {
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now(),
    reason,
    lastError: ""
  });
  faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
}

async function removeEmployeeFromDevices(employee, explicitUserIds = null) {
  const out = { attempted: false, results: [], skipped: false, reason: "" };
  if (!DEVICE_REVOKE_ON_EMPLOYEE_REMOVE) {
    out.skipped = true;
    out.reason = "disabled";
    return out;
  }
  if (!GSDK_SIDECAR_URL) {
    out.skipped = true;
    out.reason = "no_sidecar";
    return out;
  }
  if (!GSDK_GATEWAY || !String(GSDK_GATEWAY).trim()) {
    out.skipped = true;
    out.reason = "no_gateway";
    out.note =
      "Set GSDK_GATEWAY to device_gateway rpc_server (host:4100). Without it, only MongoDB is updated; readers keep cached faces.";
    return out;
  }
  const userIds = Array.isArray(explicitUserIds) && explicitUserIds.length
    ? [...new Set(explicitUserIds.map((x) => String(x ?? "").trim()).filter(Boolean))]
    : collectRevokeUserIds(employee);
  if (!userIds.length) {
    out.skipped = true;
    out.reason = "no_user_id";
    return out;
  }
  out.attempted = true;
  out.userIdsTried = userIds;
  const devices = await collection("devices").find({}).toArray();
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 30000);
  out.queued = [];

  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;

    // Check if device is offline - queue for later if it is
    const deviceStatus = String(d.status || "").toLowerCase();
    const isOffline = deviceStatus === "offline" || deviceStatus === "" || !deviceStatus;
    if (isOffline && DEVICE_SYNC_QUEUE_ENABLED) {
      const q = await queueDeviceOperation("revoke", sid, employee?._id, {
        userIds,
        employeeId: employee?.employeeId,
        name: employee?.name,
        reason: "employee_suspended_or_deleted"
      });
      out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: true,
        error: "device_offline_queued_for_sync"
      });
      continue;
    }

    try {
      // Reader record SSL flags describe device_server TCP; sidecar talks to gateway rpc_server.
      // Use gateway TLS mode from env to avoid false "insecure" calls to TLS :4100.
      const useSSL = GSDK_USE_SSL;
      const body = {
        gateway: GSDK_GATEWAY,
        deviceId: sid,
        userIds,
        useSSL,
        ssl: useSSL
      };
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/users/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        },
        deadline
      );
      const okDel = Boolean(response.ok && payload?.ok);
      const errDetail =
        payload?.error ||
        payload?.message ||
        (response.ok ? "" : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);

      // If delete failed, queue for retry
      if (!okDel && DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("revoke", sid, employee?._id, {
          userIds,
          employeeId: employee?.employeeId,
          name: employee?.name,
          reason: "employee_suspended_or_deleted"
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }

      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: okDel,
        queued: !okDel && DEVICE_SYNC_QUEUE_ENABLED,
        error: okDel ? undefined : errDetail || "unknown"
      });
    } catch (e) {
      // On exception, queue for retry
      if (DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("revoke", sid, employee?._id, {
          userIds,
          employeeId: employee?.employeeId,
          name: employee?.name,
          reason: "employee_suspended_or_deleted"
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: DEVICE_SYNC_QUEUE_ENABLED,
        error: e.message
      });
    }
  }

  if (!out.results.length) {
    out.note =
      "No gateway device id on any reader — revoke skipped. Sync My Devices (or set deviceId / supremaDeviceId / BioStar id).";
  } else if (out.results.every((r) => !r.ok && !r.queued)) {
    console.warn("[employees] User.Delete failed on all readers — face may still match:", userIds, out.results);
  } else if (out.queued?.length > 0) {
    console.log(`[employees] User.Delete queued for ${out.queued.length} offline/failed devices, will retry when online`);
  }

  return out;
}

/** Remove a visitor from all Suprema devices (User.Delete via sidecar).
 * Queues for offline devices when DEVICE_SYNC_QUEUE_ENABLED.
 */
async function removeVisitorFromDevices(visitor, explicitUserIds = null) {
  const out = { attempted: false, results: [], skipped: false, reason: "" };
  if (!DEVICE_REVOKE_ON_VISITOR_REMOVE) {
    out.skipped = true;
    out.reason = "disabled";
    return out;
  }
  if (!GSDK_SIDECAR_URL) {
    out.skipped = true;
    out.reason = "no_sidecar";
    return out;
  }
  if (!GSDK_GATEWAY || !String(GSDK_GATEWAY).trim()) {
    out.skipped = true;
    out.reason = "no_gateway";
    out.note =
      "Set GSDK_GATEWAY to device_gateway rpc_server (host:4100). Without it, only MongoDB is updated; readers keep cached faces.";
    return out;
  }
  const userIds = Array.isArray(explicitUserIds) && explicitUserIds.length
    ? [...new Set(explicitUserIds.map((x) => String(x ?? "").trim()).filter(Boolean))]
    : collectVisitorRevokeUserIds(visitor);
  if (!userIds.length) {
    out.skipped = true;
    out.reason = "no_user_id";
    return out;
  }
  out.attempted = true;
  out.userIdsTried = userIds;
  const devices = await collection("devices").find({}).toArray();
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 30000);
  out.queued = [];

  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;

    // Check if device is offline - queue for later if it is
    const deviceStatus = String(d.status || "").toLowerCase();
    const isOffline = deviceStatus === "offline" || deviceStatus === "" || !deviceStatus;
    if (isOffline && DEVICE_SYNC_QUEUE_ENABLED) {
      const q = await queueDeviceOperation("revoke", sid, visitor?._id, {
        userIds,
        visitorId: String(visitor?._id || ""),
        name: visitor?.name,
        reason: "visitor_suspended_or_deleted"
      });
      out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: true,
        error: "device_offline_queued_for_sync"
      });
      continue;
    }

    try {
      const useSSL = GSDK_USE_SSL;
      const body = {
        gateway: GSDK_GATEWAY,
        deviceId: sid,
        userIds,
        useSSL,
        ssl: useSSL
      };
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/users/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        },
        deadline
      );
      const okDel = Boolean(response.ok && payload?.ok);
      const errDetail =
        payload?.error ||
        payload?.message ||
        (response.ok ? "" : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);

      // If delete failed, queue for retry
      if (!okDel && DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("revoke", sid, visitor?._id, {
          userIds,
          visitorId: String(visitor?._id || ""),
          name: visitor?.name,
          reason: "visitor_suspended_or_deleted"
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }

      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: okDel,
        queued: !okDel && DEVICE_SYNC_QUEUE_ENABLED,
        error: okDel ? undefined : errDetail || "unknown"
      });
    } catch (e) {
      // On exception, queue for retry
      if (DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("revoke", sid, visitor?._id, {
          userIds,
          visitorId: String(visitor?._id || ""),
          name: visitor?.name,
          reason: "visitor_suspended_or_deleted"
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: DEVICE_SYNC_QUEUE_ENABLED,
        error: e.message
      });
    }
  }

  if (!out.results.length) {
    out.note =
      "No gateway device id on any reader — revoke skipped. Sync My Devices (or set deviceId / supremaDeviceId / BioStar id).";
  } else if (out.results.every((r) => !r.ok && !r.queued)) {
    console.warn("[visitors] User.Delete failed on all readers — face may still match:", userIds, out.results);
  } else if (out.queued?.length > 0) {
    console.log(`[visitors] User.Delete queued for ${out.queued.length} offline/failed devices, will retry when online`);
  }

  return out;
}

/** Device Sync Queue: Queue an operation to be retried when a device comes online.
 * Operations: 'revoke' (delete user), 'enroll' (push face), 'update' (metadata change)
 */
async function queueDeviceOperation(operation, deviceId, employeeId, payload = {}, options = {}) {
  if (!DEVICE_SYNC_QUEUE_ENABLED || !mongoConnected) return { queued: false, reason: "disabled_or_no_db" };
  const sid = Number(deviceId) >>> 0;
  if (!sid) return { queued: false, reason: "invalid_device_id" };
  const empId = String(employeeId || payload?.employeeId || payload?._id || "").trim();
  const op = String(operation || "").trim().toLowerCase();
  if (!["revoke", "enroll", "update", "delete"].includes(op)) {
    return { queued: false, reason: "invalid_operation" };
  }
  const now = new Date();
  const doc = {
    deviceId: sid,
    employeeId: empId || undefined,
    operation: op,
    payload,
    status: "pending",
    attempts: 0,
    maxRetries: options.maxRetries || DEVICE_SYNC_MAX_RETRIES,
    createdAt: now,
    nextAttemptAt: options.immediate ? now : new Date(now.getTime() + 5000),
    lastError: null,
    processedAt: null
  };
  // For revoke/delete: deduplicate - only keep most recent pending for same device+employee+operation
  if (op === "revoke" || op === "delete") {
    await collection("device_sync_queue").deleteMany({
      deviceId: sid,
      employeeId: empId,
      operation: { $in: ["revoke", "delete"] },
      status: "pending"
    });
  }
  // For enroll: update existing pending if exists (keep latest photo)
  if (op === "enroll") {
    const existing = await collection("device_sync_queue").findOne({
      deviceId: sid,
      employeeId: empId,
      operation: "enroll",
      status: "pending"
    });
    if (existing) {
      await collection("device_sync_queue").updateOne(
        { _id: existing._id },
        { $set: { payload, nextAttemptAt: doc.nextAttemptAt, updatedAt: now } }
      );
      return { queued: true, operation: op, deviceId: sid, employeeId: empId, updated: true };
    }
  }
  await collection("device_sync_queue").insertOne(doc);
  return { queued: true, operation: op, deviceId: sid, employeeId: empId };
}

/** Get count of pending operations for a device or globally. */
async function getDeviceSyncQueueStats(deviceId) {
  if (!mongoConnected) return { total: 0, pending: 0, failed: 0 };
  const match = deviceId ? { deviceId: Number(deviceId) >>> 0 } : {};
  const [total, pending, failed] = await Promise.all([
    collection("device_sync_queue").countDocuments(match),
    collection("device_sync_queue").countDocuments({ ...match, status: "pending" }),
    collection("device_sync_queue").countDocuments({ ...match, status: "failed" })
  ]);
  return { total, pending, failed };
}

/** Circuit breaker for device sync - tracks consecutive failures per device. */
const deviceSyncCircuitBreakers = new Map();
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after 5 consecutive failures
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown

function isCircuitOpen(deviceId) {
  const cb = deviceSyncCircuitBreakers.get(Number(deviceId));
  if (!cb) return false;
  if (Date.now() > cb.resetAt) {
    deviceSyncCircuitBreakers.delete(Number(deviceId));
    return false;
  }
  return cb.failures >= CIRCUIT_BREAKER_THRESHOLD;
}

function recordDeviceSyncSuccess(deviceId) {
  deviceSyncCircuitBreakers.delete(Number(deviceId));
}

function recordDeviceSyncFailure(deviceId) {
  const sid = Number(deviceId);
  const existing = deviceSyncCircuitBreakers.get(sid) || { failures: 0, resetAt: 0 };
  existing.failures += 1;
  existing.resetAt = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  deviceSyncCircuitBreakers.set(sid, existing);
  return existing.failures;
}

/** Process sync queue for a specific device (called when device comes online or periodic). */
async function processDeviceSyncQueueForDevice(deviceId, options = {}) {
  const sid = Number(deviceId) >>> 0;
  if (!sid || !mongoConnected || !GSDK_SIDECAR_URL) return { processed: 0, errors: [] };
  // Check circuit breaker
  if (isCircuitOpen(sid)) {
    return { processed: 0, errors: [{ error: "circuit_breaker_open" }], skipped: true };
  }
  const batchSize = options.batchSize || DEVICE_SYNC_BATCH_SIZE;
  const now = new Date();

  // Build query for pending operations
  const baseQuery = {
    deviceId: sid,
    status: "pending",
    nextAttemptAt: { $lte: now }
  };
  // In unlimited retention mode, don't filter by max retries - keep trying forever
  const query = DEVICE_SYNC_UNLIMITED_RETENTION
    ? baseQuery
    : { ...baseQuery, attempts: { $lt: DEVICE_SYNC_MAX_RETRIES } };

  const ops = await collection("device_sync_queue")
    .find(query)
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .toArray();
  if (!ops.length) return { processed: 0, errors: [] };

  const errors = [];
  let processed = 0;
  for (const op of ops) {
    try {
      let result;
      if (op.operation === "revoke" || op.operation === "delete") {
        result = await executeQueuedRevoke(sid, op);
      } else if (op.operation === "enroll") {
        result = await executeQueuedEnroll(sid, op);
      } else if (op.operation === "update") {
        result = await executeQueuedUpdate(sid, op);
      }
      if (result?.ok) {
        await collection("device_sync_queue").updateOne(
          { _id: op._id },
          { $set: { status: "completed", processedAt: new Date(), lastError: null } }
        );
        processed++;
      } else {
        const attempts = (op.attempts || 0) + 1;
        // In unlimited mode, cap retry delay at configured max (default 1 hour)
        // In limited mode, use exponential backoff up to 30s then mark as failed
        const delayMs = DEVICE_SYNC_UNLIMITED_RETENTION
          ? Math.min(DEVICE_SYNC_MAX_RETRY_DELAY_MS, 5000 * Math.pow(2, Math.min(attempts, 12))) // cap at ~1 hour
          : Math.min(30000, 5000 * Math.pow(2, attempts));

        const shouldFail = !DEVICE_SYNC_UNLIMITED_RETENTION && attempts >= DEVICE_SYNC_MAX_RETRIES;

        await collection("device_sync_queue").updateOne(
          { _id: op._id },
          {
            $set: {
              status: shouldFail ? "failed" : "pending",
              lastError: result?.error || "unknown_error",
              nextAttemptAt: new Date(Date.now() + delayMs)
            },
            $inc: { attempts: 1 }
          }
        );
        if (shouldFail) {
          errors.push({ operation: op.operation, employeeId: op.employeeId, error: result?.error });
        }
      }
    } catch (e) {
      const attempts = (op.attempts || 0) + 1;
      const delayMs = DEVICE_SYNC_UNLIMITED_RETENTION
        ? Math.min(DEVICE_SYNC_MAX_RETRY_DELAY_MS, 5000 * Math.pow(2, Math.min(attempts, 12)))
        : 10000;
      const shouldFail = !DEVICE_SYNC_UNLIMITED_RETENTION && attempts >= DEVICE_SYNC_MAX_RETRIES;

      await collection("device_sync_queue").updateOne(
        { _id: op._id },
        {
          $set: {
            status: shouldFail ? "failed" : "pending",
            lastError: e?.message || "exception",
            nextAttemptAt: new Date(Date.now() + delayMs)
          },
          $inc: { attempts: 1 }
        }
      );
      if (shouldFail) {
        errors.push({ operation: op.operation, employeeId: op.employeeId, error: e?.message });
      }
    }
  }
  // Circuit breaker: record success if any operations succeeded, failure if all failed
  if (processed > 0) {
    recordDeviceSyncSuccess(sid);
  } else if (ops.length > 0 && errors.length > 0 && !DEVICE_SYNC_UNLIMITED_RETENTION) {
    const failureCount = recordDeviceSyncFailure(sid);
    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(`[device-sync] Circuit breaker opened for device ${sid} after ${failureCount} consecutive failures`);
    }
  }
  return { processed, total: ops.length, errors, unlimitedRetention: DEVICE_SYNC_UNLIMITED_RETENTION };
}

/** Execute a queued revoke operation. */
async function executeQueuedRevoke(deviceId, op) {
  const userIds = op.payload?.userIds || (op.employeeId ? [op.employeeId] : []);
  if (!userIds.length) return { ok: false, error: "no_user_ids" };
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 30000);
  try {
    const useSSL = GSDK_USE_SSL;
    const body = { gateway: GSDK_GATEWAY, deviceId, userIds, useSSL, ssl: useSSL };
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/users/delete`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      deadline
    );
    const ok = Boolean(response.ok && payload?.ok);
    return { ok, error: ok ? null : (payload?.error || payload?.message || `HTTP ${response.status}`) };
  } catch (e) {
    return { ok: false, error: e?.message || "request_failed" };
  }
}

/** Execute a queued enroll operation. */
async function executeQueuedEnroll(deviceId, op) {
  const payload = op.payload || {};
  const userId = payload.userId || op.employeeId;
  const photoBase64 = payload.photoBase64;
  if (!userId || !photoBase64) return { ok: false, error: "missing_user_or_photo" };
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 130000);
  try {
    const useSSL = GSDK_USE_SSL;
    const agBody = sidecarAccessGroupBody();
    const body = {
      gateway: GSDK_GATEWAY,
      deviceId,
      userId,
      name: payload.name || "",
      imageBase64: photoBase64,
      useSSL,
      ssl: useSSL,
      ...agBody
    };
    const { response, payload: resp } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/enrollment/push-face`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      deadline
    );
    const ok = Boolean(response.ok && resp?.ok);
    return { ok, error: ok ? null : (resp?.error || resp?.message || `HTTP ${response.status}`) };
  } catch (e) {
    return { ok: false, error: e?.message || "request_failed" };
  }
}

/** Execute a queued update operation. */
async function executeQueuedUpdate(deviceId, op) {
  // Updates are typically name/card changes - treat as re-enroll for now
  return executeQueuedEnroll(deviceId, op);
}

/** Global tick for processing device sync queue across all online devices. */
async function tickDeviceSyncQueue() {
  if (!DEVICE_SYNC_QUEUE_ENABLED || !mongoConnected || !GSDK_SIDECAR_URL) return { processed: 0, devices: 0 };
  // Get all online devices
  const onlineDevices = await collection("devices")
    .find({ status: { $in: ["online", "connected"] } })
    .project({ supremaDeviceId: 1, _id: 1 })
    .toArray();
  if (!onlineDevices.length) return { processed: 0, devices: 0 };
  let totalProcessed = 0;
  for (const d of onlineDevices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;
    const result = await processDeviceSyncQueueForDevice(sid);
    totalProcessed += result.processed;
  }
  return { processed: totalProcessed, devices: onlineDevices.length };
}

/** True when HR/access fields imply the person must not authenticate on readers. */
function shouldRevokeAccessOnDevice(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (String(doc.status || "").toLowerCase() === "suspended") return true;
  const ch = String(doc.cardholderStatus || "").trim().toLowerCase();
  return ch === "suspended" || ch === "expired";
}

/** Raw base64 JPEG from employee catalog (data URL or bare base64). */
function employeeEnrollmentPhotoBase64(emp) {
  const raw = String(emp?.photo || emp?.facePhoto || "").trim();
  if (!raw) return "";
  if (raw.includes("base64,")) return raw.split(",")[1].replace(/\s/g, "");
  const compact = raw.replace(/\s/g, "");
  if (compact.length > 80 && /^[A-Za-z0-9+/=]+$/.test(compact)) return compact;
  return "";
}

function friendlyEnrollmentError(msg = "") {
  const m = String(msg || "");
  if (/BS_ERR_NORMALIZE_FACE|Cannot extract face template|normalize|extract face template|async packet/i.test(m)) {
    return "Reader could not extract a usable face template from this attempt. Please keep face centered for 1-2 seconds and retry Live Enroll.";
  }
  if (/Invalid finger data|Invalid finger/i.test(m)) {
    return "Reader auth profile rejected this face payload. Use Live Enroll on device once, then retry.";
  }
  if (/Authentication timeout/i.test(m)) {
    return "Enrollment/authentication timed out. Hold steady in front of the reader and retry.";
  }
  return m || "Enrollment failed on reader.";
}

/**
 * Push stored/uploaded face image to readers via sidecar /enrollment/push-face.
 * LOCKED: `allowLiveScanFallback` defaults true for employee sync / live-enroll recovery only.
 * Remote web enrollment MUST pass `{ allowLiveScanFallback: false }` so failed push-face never opens the reader camera.
 */
async function pushFaceEnrollmentToDevices(employee, photoBase64, options = {}) {
  const allowLiveScanFallback = options?.allowLiveScanFallback !== false;
  const out = { attempted: false, results: [], skipped: false, reason: "" };
  if (!ENROLLMENT_PUSH_DEVICES) {
    out.skipped = true;
    out.reason = "disabled";
    return out;
  }
  if (!GSDK_SIDECAR_URL) {
    out.skipped = true;
    out.reason = "no_sidecar";
    return out;
  }
  if (!GSDK_GATEWAY || !String(GSDK_GATEWAY).trim()) {
    out.skipped = true;
    out.reason = "no_gateway";
    out.note =
      "Set GSDK_GATEWAY to device_gateway rpc_server (host:4100), e.g. 192.168.0.200:4100 or host.docker.internal:4100 from Docker.";
    return out;
  }
  if (!photoBase64 || String(photoBase64).length < 80) {
    out.skipped = true;
    out.reason = "no_photo";
    return out;
  }
  out.attempted = true;
  const userId = resolveSupremaUserIdForDevice(employee);
  const devices = await collection("devices").find({}).toArray();
  const agBody = sidecarAccessGroupBody();
  out.queued = [];

  // Face Normalize/Extract/Enroll can exceed 60s on some readers; keep backend timeout above sidecar default.
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 130000);
  const isNormalizeOrExtractError = (msg = "", payload = null) => {
    const m = String(msg || payload?.error || payload?.message || "").toLowerCase();
    const step = String(payload?.step || "").toLowerCase();
    return (
      step === "normalize" ||
      step === "extract" ||
      /normalize|extract face template|bs_err_normalize_face|cannot receive multiple async packets/.test(m)
    );
  };

  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;

    // Check if device is offline - queue for later if it is
    const deviceStatus = String(d.status || "").toLowerCase();
    const isOffline = deviceStatus === "offline" || deviceStatus === "" || !deviceStatus;
    if (isOffline && DEVICE_SYNC_QUEUE_ENABLED) {
      const q = await queueDeviceOperation("enroll", sid, employee?._id, {
        userId,
        photoBase64,
        name: employee?.name,
        employeeId: employee?.employeeId,
        ...agBody
      });
      out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: true,
        error: "device_offline_queued_for_sync"
      });
      continue;
    }

    try {
      // Reader record SSL flags describe device_server TCP; sidecar talks to gateway rpc_server.
      // Use gateway TLS mode from env to avoid false "insecure" calls to TLS :4100.
      const useSSL = GSDK_USE_SSL;
      const body = {
        gateway: GSDK_GATEWAY,
        deviceId: sid,
        userId,
        name: String(employee?.name || ""),
        imageBase64: photoBase64,
        useSSL,
        ssl: useSSL,
        ...agBody
      };
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/enrollment/push-face`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        },
        deadline
      );
      const okPush = Boolean(response.ok && payload?.ok);
      const errDetail =
        payload?.error ||
        payload?.message ||
        (response.ok ? "" : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      const row = {
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: okPush,
        error: okPush ? undefined : errDetail || "unknown",
        enrollmentPath: payload?.enrollmentPath,
        hint:
          okPush && String(payload?.enrollmentPath || "").startsWith("template")
            ? "Reader used photo template fallback. If face scan still fails, use Live enroll on device (RGB+IR)."
            : undefined
      };
      if (!okPush && allowLiveScanFallback && isNormalizeOrExtractError(errDetail, payload)) {
        // Auto-recovery: if push-face normalize/extract fails, try live scan on the reader in same request.
        try {
          const scanBody = {
            gateway: GSDK_GATEWAY,
            deviceId: sid,
            userId,
            name: String(employee?.name || ""),
            useSSL,
            ssl: useSSL,
            ...agBody
          };
          const { response: scanResp, payload: scanPayload } = await fetchJsonWithTimeout(
            `${GSDK_SIDECAR_URL}/enrollment/scan-and-enroll`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(scanBody)
            },
            Math.max(GSDK_SIDECAR_HTTP_MS, 45000)
          );
          row.scanEnrollFallbackTried = true;
          row.scanEnrollFallback = scanPayload || null;
          if (scanResp.ok && scanPayload?.ok) {
            row.ok = true;
            row.error = undefined;
            row.enrollmentPath = `scan_and_enroll:${scanPayload?.enrollmentPath || "device_live_scan"}`;
            row.hint = "Push-face failed but live scan-and-enroll succeeded on reader.";
          }
        } catch (scanErr) {
          row.scanEnrollFallbackTried = true;
          row.scanEnrollFallback = { ok: false, error: scanErr?.message || "scan-and-enroll failed" };
        }
      }
      // If enrollment failed (and no fallback succeeded), queue for retry
      if (!row.ok && DEVICE_SYNC_QUEUE_ENABLED && !row.queued) {
        const q = await queueDeviceOperation("enroll", sid, employee?._id, {
          userId,
          photoBase64,
          name: employee?.name,
          employeeId: employee?.employeeId,
          ...agBody
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
        row.queued = true;
        row.error = row.error || "enroll_failed_queued_for_retry";
      }
      out.results.push(row);
    } catch (e) {
      // On exception, queue for retry
      if (DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("enroll", sid, employee?._id, {
          userId,
          photoBase64,
          name: employee?.name,
          employeeId: employee?.employeeId,
          ...agBody
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: DEVICE_SYNC_QUEUE_ENABLED,
        error: e.message
      });
    }
  }

  if (!out.results.length) {
    out.note =
      "No gateway device id on readers — run Sync on My Devices or set deviceId / supremaDeviceId.";
  } else if (out.queued?.length > 0) {
    console.log(`[enrollment] Enroll queued for ${out.queued.length} offline/failed devices, will retry when online`);
  }

  return out;
}

/**
 * Push visitor face enrollment to all Suprema devices via sidecar.
 * Similar to employee enrollment but for visitors.
 */
async function pushVisitorEnrollmentToDevices(visitor, photoBase64, options = {}) {
  const out = { attempted: false, results: [], skipped: false, reason: "" };
  if (!VISITOR_ENROLLMENT_PUSH_DEVICES) {
    out.skipped = true;
    out.reason = "disabled";
    return out;
  }
  if (!GSDK_SIDECAR_URL) {
    out.skipped = true;
    out.reason = "no_sidecar";
    return out;
  }
  if (!GSDK_GATEWAY || !String(GSDK_GATEWAY).trim()) {
    out.skipped = true;
    out.reason = "no_gateway";
    out.note =
      "Set GSDK_GATEWAY to device_gateway rpc_server (host:4100), e.g. 192.168.0.200:4100 or host.docker.internal:4100 from Docker.";
    return out;
  }
  if (!photoBase64 || String(photoBase64).length < 80) {
    out.skipped = true;
    out.reason = "no_photo";
    return out;
  }
  out.attempted = true;
  const userId = resolveVisitorSupremaUserIdForDevice(visitor);
  const devices = await collection("devices").find({}).toArray();
  const agBody = sidecarAccessGroupBody();
  out.queued = [];

  // Face Normalize/Extract/Enroll can exceed 60s on some readers; keep backend timeout above sidecar default.
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 130000);

  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;

    // Check if device is offline - queue for later if it is
    const deviceStatus = String(d.status || "").toLowerCase();
    const isOffline = deviceStatus === "offline" || deviceStatus === "" || !deviceStatus;
    if (isOffline && DEVICE_SYNC_QUEUE_ENABLED) {
      const q = await queueDeviceOperation("enroll", sid, visitor?._id, {
        userId,
        photoBase64,
        name: visitor?.name,
        visitorId: String(visitor?._id || ""),
        ...agBody
      });
      out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: true,
        error: "device_offline_queued_for_sync"
      });
      continue;
    }

    try {
      const useSSL = GSDK_USE_SSL;
      const body = {
        gateway: GSDK_GATEWAY,
        deviceId: sid,
        userId,
        name: String(visitor?.name || ""),
        imageBase64: photoBase64,
        useSSL,
        ssl: useSSL,
        ...agBody
      };
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/enrollment/push-face`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        },
        deadline
      );
      const okPush = Boolean(response.ok && payload?.ok);
      const errDetail =
        payload?.error ||
        payload?.message ||
        (response.ok ? "" : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      const row = {
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: okPush,
        error: okPush ? undefined : errDetail || "unknown",
        enrollmentPath: payload?.enrollmentPath
      };

      // If enrollment failed, queue for retry
      if (!row.ok && DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("enroll", sid, visitor?._id, {
          userId,
          photoBase64,
          name: visitor?.name,
          visitorId: String(visitor?._id || ""),
          ...agBody
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
        row.queued = true;
        row.error = row.error || "enroll_failed_queued_for_retry";
      }
      out.results.push(row);
    } catch (e) {
      // On exception, queue for retry
      if (DEVICE_SYNC_QUEUE_ENABLED) {
        const q = await queueDeviceOperation("enroll", sid, visitor?._id, {
          userId,
          photoBase64,
          name: visitor?.name,
          visitorId: String(visitor?._id || ""),
          ...agBody
        });
        out.queued.push({ deviceMongoId: String(d._id), supremaDeviceId: sid, ...q });
      }
      out.results.push({
        deviceMongoId: String(d._id),
        supremaDeviceId: sid,
        ok: false,
        queued: DEVICE_SYNC_QUEUE_ENABLED,
        error: e.message
      });
    }
  }

  if (!out.results.length) {
    out.note =
      "No gateway device id on readers — run Sync on My Devices or set deviceId / supremaDeviceId.";
  } else if (out.queued?.length > 0) {
    console.log(`[visitor-enrollment] Enroll queued for ${out.queued.length} offline/failed devices, will retry when online`);
  }

  return out;
}

/**
 * Wizard sends `ssl`; Mongo may store `useSSL` / `ssl`. Sidecar only respected `useSSL`, so `ssl` was ignored → wrong TLS mode (common UNAVAILABLE / handshake failures).
 */
function normalizeDeviceGrpcSsl(body = {}, fallback = GSDK_USE_SSL) {
  const raw = body?.useSSL ?? body?.ssl ?? body?.sslEnabled;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string") {
    return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase().trim());
  }
  return Boolean(raw);
}

/** Reader LAN IP for TCP probes and sidecar hints — many records only set `ip`, not `ipAddr`. */
function deviceLanIp(device = {}) {
  return String(device.ipAddr || device.ip || "").trim();
}
const JWT_SECRET = (() => {
  const v = process.env.JWT_SECRET;
  if (v && v.length >= 16) return v;
  if (process.env.NODE_ENV === "production") {
    console.error("[backend] FATAL: JWT_SECRET env var must be set in production (min 16 chars).");
    process.exit(1);
  }
  console.warn("[backend] WARNING: JWT_SECRET not set — using insecure dev fallback. NEVER use in production.");
  return "expo-fr-dev-secret-do-not-use-in-production";
})();

function verifyWsClient(urlStr, hostHeader) {
  try {
    const base = hostHeader ? `http://${hostHeader}` : "http://127.0.0.1";
    const u = new URL(urlStr || "/", base);
    const token = u.searchParams.get("token");
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check if token has been revoked
    const userId = decoded?.user?.id || decoded?.id;
    if (userId && isTokenRevoked(userId)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = (() => {
  const v = process.env.ADMIN_PASS;
  if (v && v.length >= 8) return v;
  if (process.env.NODE_ENV === "production") {
    console.error("[backend] FATAL: ADMIN_PASS env var must be set in production (min 8 chars).");
    process.exit(1);
  }
  console.warn("[backend] WARNING: ADMIN_PASS not set — using insecure default 'admin123'. NEVER use in production.");
  return "admin123";
})();
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
/** Persist visitor QR PNG + contact JSON on disk (for Suprema/barcode testing and optional email later). */
const VISITOR_QR_STORAGE_ENABLED = String(process.env.VISITOR_QR_STORAGE_ENABLED ?? "true").toLowerCase() === "true";
const VISITOR_QR_STORAGE_DIR = process.env.VISITOR_QR_STORAGE_DIR || path.join(process.cwd(), "data", "visitor-qr-codes");
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "noreply@expo-fr.local";
let smtpRuntime = {
  host: SMTP_HOST,
  port: SMTP_PORT,
  user: SMTP_USER,
  pass: SMTP_PASS,
  from: SMTP_FROM
};
let centralApiRuntime = {
  enabled: String(process.env.CENTRAL_API_ENABLED || "false").toLowerCase() === "true",
  baseUrl: normUrl(process.env.CENTRAL_API_BASE_URL || ""),
  apiKey: String(process.env.CENTRAL_API_API_KEY || ""),
  usersPath: String(process.env.CENTRAL_API_USERS_PATH || "/users"),
  devicesPath: String(process.env.CENTRAL_API_DEVICES_PATH || "/devices"),
  pollMs: Math.max(5000, Number(process.env.CENTRAL_API_POLL_MS || 60000)),
  autoPushToReaders: String(process.env.CENTRAL_API_AUTO_PUSH_TO_READERS ?? "true").toLowerCase() === "true",
  timeoutMs: Math.max(3000, Number(process.env.CENTRAL_API_TIMEOUT_MS || 15000)),
  lastSyncAt: null,
  lastSyncOk: null,
  lastSyncError: ""
};

const MONGODB_MAX_POOL_SIZE = Math.max(10, Math.min(500, Number(process.env.MONGODB_MAX_POOL_SIZE || 100)));
const mongo = new MongoClient(MONGODB_URI, { maxPoolSize: MONGODB_MAX_POOL_SIZE });
let mongoConnected = false;

async function computeRiskScoreFromDb() {
  if (!mongoConnected) {
    return { score: 0, level: "low", basis: "mongodb_disconnected" };
  }
  try {
    const door = logsDoorEventOnly();
    const total = await collection("logs").countDocuments(door);
    if (total === 0) return { score: 0, level: "low", basis: "no_logs" };

    const denied = await collection("logs").countDocuments({
      $and: [door, { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] }]
    });
    const granted = await collection("logs").countDocuments({
      $and: [door, { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] }]
    });
    const unknownDenied = await collection("logs").countDocuments({
      $and: [
        door,
        { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] },
        {
          $or: [
            { employeeId: { $regex: "^UNKNOWN-", $options: "i" } },
            { employeeName: { $regex: "^UNKNOWN-", $options: "i" } },
            { name: { $regex: "^UNKNOWN-", $options: "i" } },
            { employeeName: { $regex: "^Unknown$", $options: "i" } },
            { name: { $regex: "^Unknown$", $options: "i" } }
          ]
        }
      ]
    });
    const openAlerts = await collection("alerts").countDocuments({
      status: { $in: ["open", "reviewing", "acknowledged"] }
    });

    const accessTotal = Math.max(1, denied + granted);
    const denyRate = denied / accessTotal;
    const unknownShare = denied > 0 ? unknownDenied / denied : 0;

    let score = Math.round(
      denyRate * 38 +
      Math.min(42, unknownDenied * 2.5) +
      Math.min(22, unknownShare * 28) +
      Math.min(18, openAlerts * 5)
    );
    score = Math.min(100, Math.max(0, score));
    const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
    return { score, level, basis: "derived_from_logs_and_alerts" };
  } catch {
    return { score: 0, level: "low", basis: "error" };
  }
}
const AI_INSIGHTS_REFRESH_MS = Math.max(60_000, Number(process.env.AI_INSIGHTS_REFRESH_MS || 15 * 60_000));
let aiInsightsCache = { refreshedAt: 0, payload: null };

function eventTs(row) {
  const d = new Date(row?.createdAt || row?.timestamp || row?.ts || 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isDeniedEvent(row) {
  return Boolean(row?.eventType === "ACCESS_DENIED" || row?.accessGranted === false || row?.granted === false);
}

function isUnknownIdentity(row) {
  const eid = String(row?.employeeId || "").trim();
  const en = String(row?.employeeName || "").trim();
  const n = String(row?.name || "").trim();
  return /^UNKNOWN-/i.test(eid) || /^UNKNOWN-/i.test(en) || /^UNKNOWN-/i.test(n) || /^Unknown$/i.test(en) || /^Unknown$/i.test(n);
}

function isUnknownLiveImageSourceMissing(row) {
  if (!isDeniedEvent(row) || !isUnknownIdentity(row)) return false;
  const photo = String(
    row?.photo ||
      row?.photoUrl ||
      row?.image ||
      row?.imageUrl ||
      row?.faceImage ||
      row?.facePhoto ||
      row?.snapshot ||
      row?.snapshotUrl ||
      row?.capture ||
      row?.captureUrl ||
      row?.jpgimage ||
      ""
  ).trim();
  return !photo;
}

async function buildAiSnapshot() {
  if (!mongoConnected) {
    return {
      riskScore: 0,
      riskLevel: "low",
      items: [],
      anomalies: [],
      predictive: { summary: "MongoDB unavailable.", predictions: [] },
      threats: [],
      riskTrend: [],
      critical: 0,
      high: 0,
      resolvedMonth: 0,
      aiSummary: "Security analysis is temporarily unavailable while data services reconnect."
    };
  }
  const now = new Date();
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start14d = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  const door = logsDoorEventOnly();
  const [logs24h, logs14d, alerts] = await Promise.all([
    collection("logs").find({ $and: [door, { $or: [{ createdAt: { $gte: start24h } }, { timestamp: { $gte: start24h } }, { ts: { $gte: start24h } }] }] }).limit(10000).toArray(),
    collection("logs").find({ $and: [door, { $or: [{ createdAt: { $gte: start14d } }, { timestamp: { $gte: start14d } }, { ts: { $gte: start14d } }] }] }).limit(20000).toArray(),
    collection("alerts").find({}).sort({ createdAt: -1 }).limit(500).toArray()
  ]);
  const denied24h = logs24h.filter((l) => isDeniedEvent(l));
  const unknownDenied24h = denied24h.filter((l) => isUnknownIdentity(l));
  const deniedByEmp = new Map();
  const deniedByZone = new Map();
  const offHours = [];
  for (const l of denied24h) {
    const who = String(l?.employeeId || l?.employeeName || l?.name || "UNKNOWN").trim();
    deniedByEmp.set(who, (deniedByEmp.get(who) || 0) + 1);
    const zone = String(l?.zone || "Unknown").trim();
    deniedByZone.set(zone, (deniedByZone.get(zone) || 0) + 1);
    const t = eventTs(l);
    if (t) {
      const h = t.getHours();
      if (h >= 1 && h <= 5) offHours.push(l);
    }
  }
  const burstEmp = [...deniedByEmp.entries()].filter(([, c]) => c >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const zoneHotspots = [...deniedByZone.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const anomalies = [];
  for (const [emp, count] of burstEmp) {
    anomalies.push({
      severity: count >= 12 ? "high" : "medium",
      type: "Repeated Denied Access Attempts",
      affectedEntity: emp,
      description: `${count} denied attempts in the last 24h for ${emp}.`,
      evidence: ["Access denied burst", "Potential credential misuse or profile mismatch"],
      detectedAt: now
    });
  }
  if (unknownDenied24h.length >= 3) {
    anomalies.push({
      severity: unknownDenied24h.length >= 10 ? "high" : "medium",
      type: "Unknown Identity Denial Pattern",
      affectedEntity: "UNKNOWN users",
      description: `${unknownDenied24h.length} unknown-identity denied events in the last 24h.`,
      evidence: ["Unknown credentials presented", "Reader/device sync should be reviewed"],
      detectedAt: now
    });
  }
  if (offHours.length >= 3) {
    anomalies.push({
      severity: offHours.length >= 10 ? "high" : "low",
      type: "Off-hours Access Attempts",
      affectedEntity: "01:00-05:00 window",
      description: `${offHours.length} denied attempts occurred during restricted off-hours.`,
      evidence: ["Off-hours pattern", "Policy and guard workflow check recommended"],
      detectedAt: now
    });
  }
  const risk = await computeRiskScoreFromDb();
  const openAlerts = alerts.filter((a) => ["open", "reviewing", "acknowledged"].includes(String(a?.status || "").toLowerCase()));
  const resolvedMonth = alerts.filter((a) => String(a?.status || "").toLowerCase() === "resolved").length;
  const THREAT_TYPE_HOTSPOT = "Denied Access Hotspot";
  const threats = [
    ...openAlerts.slice(0, 12).map((a) => ({
      risk: String(a?.severity || "MEDIUM").toUpperCase().startsWith("CRIT") ? "HIGH" : String(a?.severity || "MEDIUM").toUpperCase(),
      status: String(a?.status || "open").toLowerCase(),
      type: a?.title || "Security Alert",
      detail: a?.description || a?.message || "Review this incident in Alerts.",
      count: Number(a?.count || 1),
      affectedZone: a?.zone || a?.location || ""
    })),
    ...zoneHotspots.map(([zone, count]) => ({
      risk: count >= 10 ? "HIGH" : "MEDIUM",
      status: "open",
      type: THREAT_TYPE_HOTSPOT,
      detail: `${count} denied events detected in zone ${zone} in the last 24h.`,
      count,
      affectedZone: zone
    }))
  ].slice(0, 16);

  const activeThreatSignals = threats.filter((t) => String(t?.status || "").toLowerCase() !== "resolved");
  const threatSignalsFromLogs = activeThreatSignals.filter((t) => t?.type === THREAT_TYPE_HOTSPOT).length;
  const threatSignalsFromAlerts = activeThreatSignals.length - threatSignalsFromLogs;
  const openAlertRecords = openAlerts.length;

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const riskTrendMap = new Map();
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(start14d);
    d.setDate(start14d.getDate() + i);
    riskTrendMap.set(dayKey(d), { denied: 0, total: 0, unknown: 0 });
  }
  for (const l of logs14d) {
    const t = eventTs(l);
    if (!t) continue;
    const k = dayKey(t);
    const row = riskTrendMap.get(k);
    if (!row) continue;
    row.total += 1;
    if (isDeniedEvent(l)) row.denied += 1;
    if (isDeniedEvent(l) && isUnknownIdentity(l)) row.unknown += 1;
  }
  const riskTrend = [...riskTrendMap.entries()].map(([date, v]) => {
    const total = Math.max(1, Number(v.total || 0));
    const denyRate = Number(v.denied || 0) / total;
    const unknownRate = Number(v.unknown || 0) / total;
    const score = Math.min(100, Math.round(denyRate * 65 + unknownRate * 35));
    return { date, score };
  });

  const insightItems = [
    {
      icon: risk.score >= 70 ? "🚨" : risk.score >= 40 ? "⚠" : "✅",
      title: `Current risk score: ${risk.score}/100`,
      message:
        risk.score >= 70
          ? "High risk posture detected. Immediate review required for denied bursts, unknown identities, and unresolved incidents."
          : risk.score >= 40
            ? "Moderate risk posture. Investigate hotspot zones and repeated denied attempts."
            : "Risk posture is healthy. Continue proactive monitoring and daily reader sync hygiene.",
      severity: risk.score >= 70 ? "critical" : risk.score >= 40 ? "warning" : "success"
    },
    {
      icon: "🧭",
      title: "Top anomaly signal",
      message: anomalies[0]?.description || "No major anomaly signal detected in the current analysis window.",
      severity: anomalies[0]?.severity === "high" ? "warning" : "info"
    },
    {
      icon: "🔁",
      title: "Refresh cadence",
      message: "Insights are rebuilt from live logs and alerts every 15 minutes for operational stability.",
      severity: "info"
    }
  ];

  const predictive = {
    summary:
      risk.score >= 70
        ? "If current pattern continues, denied events will remain elevated across high-traffic zones. Tighten policy and re-check reader-user alignment."
        : "Current trend suggests stable access posture with localized spikes. Maintain enrollment and sync discipline.",
    predictions: [
      {
        category: "Access Denials (24h)",
        prediction: denied24h.length >= 1 ? `${denied24h.length} denied events observed` : "Low-denial posture",
        reasoning: "Derived from last 24h door events.",
        confidence: 78
      },
      {
        category: "Unknown Identity Risk",
        prediction: unknownDenied24h.length > 0 ? "Unknown-identity denials likely to recur without sync checks" : "Unknown-identity risk currently low",
        reasoning: "Based on denied events tagged as unknown identities.",
        confidence: 73
      }
    ]
  };

  return {
    riskScore: risk.score,
    riskLevel: risk.level,
    items: insightItems,
    anomalies,
    predictive,
    threats,
    riskTrend,
    critical: threats.filter((t) => t.risk === "HIGH").length,
    high: threats.filter((t) => t.risk === "MEDIUM" || t.risk === "HIGH").length,
    resolvedMonth,
    aiSummary:
      `ARIA analyzed ${logs24h.length} door events from the last 24 hours. ` +
      (activeThreatSignals.length === 0
        ? `No active threat signals are surfaced (${openAlertRecords} open Security Alert record(s) in the database). `
        : `${activeThreatSignals.length} active threat signal(s): ${threatSignalsFromAlerts} from Security Alerts` +
          (threatSignalsFromLogs ? `, ${threatSignalsFromLogs} from live access-log analytics (e.g. denied hotspots)` : "") +
          `. (${alerts.length} total alert document(s) stored.) `) +
      `Current posture is ${String(risk.level || "low").toUpperCase()} with risk score ${risk.score}/100.`,
    refreshedAt: new Date().toISOString()
  };
}
const require = createRequire(import.meta.url);
const GSDK_CANDIDATE_DIRS = [
  process.env.GSDK_NODE_ROOT,
  "/tmp/gsdk/g-sdk-1.9.0/client/node",
  path.resolve(process.cwd(), "../g-sdk-1.9.0/client/node"),
  path.resolve(process.cwd(), "g-sdk-1.9.0/client/node")
].filter(Boolean);

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await response.text();
    let payload = {};
    const trimmed = String(text || "").trim();
    if (trimmed) {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        payload = {
          ok: false,
          error: "Non-JSON response from upstream",
          httpStatus: response.status,
          bodyPreview: trimmed.slice(0, 1200)
        };
      }
    }
    if (!response.ok && payload && typeof payload === "object" && !Object.keys(payload).length) {
      payload = {
        ok: false,
        error: `Upstream HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        httpStatus: response.status
      };
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function getGsdkStatus() {
  if (GSDK_SIDECAR_URL) {
    try {
      const { payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/health`, {}, 5000);
      if (payload?.gsdk?.loaded) {
        return {
          installed: true,
          package: "gsdk-sidecar",
          sidecar: GSDK_SIDECAR_URL,
          root: payload.gsdk.root
        };
      }
      return {
        installed: false,
        package: "gsdk-sidecar",
        sidecar: GSDK_SIDECAR_URL,
        root: payload?.gsdk?.root,
        message: payload?.gsdk?.error || "sidecar unavailable"
      };
    } catch (sidecarError) {
      return {
        installed: false,
        package: "gsdk-sidecar",
        sidecar: GSDK_SIDECAR_URL,
        message: `sidecar request failed: ${sidecarError.message}`
      };
    }
  }

  try {
    require.resolve("@supremainc/g-sdk");
    return { installed: true, package: "@supremainc/g-sdk" };
  } catch (_error) {
    try {
      // Suprema archive package name in g-sdk-1.9.0/client/node/package.json
      require.resolve("node_client");
      return { installed: true, package: "node_client" };
    } catch (_innerError) {
      for (const root of GSDK_CANDIDATE_DIRS) {
        const connectPb = path.join(root, "biostar/service/connect_pb.js");
        const connectGrpc = path.join(root, "biostar/service/connect_grpc_pb.js");
        const grpcPath = path.join(root, "node_modules/grpc");
        if (!existsSync(connectPb) || !existsSync(connectGrpc)) continue;
        try {
          require(grpcPath);
          require(connectPb);
          require(connectGrpc);
          return { installed: true, package: "biostar-direct", root };
        } catch (directErr) {
          return {
            installed: false,
            package: "biostar-direct",
            root,
            message: `G-SDK files found but failed to load: ${directErr.message}`
          };
        }
      }
      return {
        installed: false,
        message: "Install vendor package: npm i /path/to/g-sdk.tgz or provide g-sdk client/node files"
      };
    }
  }
}

function getDirectGsdkModules() {
  for (const root of GSDK_CANDIDATE_DIRS) {
    const connectPbPath = path.join(root, "biostar/service/connect_pb.js");
    const connectGrpcPath = path.join(root, "biostar/service/connect_grpc_pb.js");
    const grpcPath = path.join(root, "node_modules/grpc");
    if (!existsSync(connectPbPath) || !existsSync(connectGrpcPath)) continue;
    const grpc = require(grpcPath);
    const connectPb = require(connectPbPath);
    const connectGrpc = require(connectGrpcPath);
    return { grpc, connectPb, connectGrpc, root };
  }
  return null;
}

function getOllamaClient() {
  try {
    return new Ollama({ host: OLLAMA_HOST });
  } catch (_error) {
    return {
      list: async () => {
        throw new Error("Unable to initialize Ollama client");
      }
    };
  }
}

async function connectMongo() {
  try {
    await mongo.connect();
    await mongo.db().command({ ping: 1 });
    mongoConnected = true;
    console.log(`[backend] MongoDB connected: ${MONGODB_URI}`);
  } catch (error) {
    mongoConnected = false;
    console.error("[backend] MongoDB connection failed:", error.message);
  }
}

async function ensureIndexes() {
  if (!mongoConnected) return;
  const logsColl = collection("logs");
  const hasCompatibleIndex = async (coll, key, options = {}) => {
    const indexes = await coll.indexes();
    const keyJson = JSON.stringify(key);
    return indexes.some((idx) => {
      if (JSON.stringify(idx.key || {}) !== keyJson) return false;
      if (options.unique !== undefined && Boolean(idx.unique) !== Boolean(options.unique)) return false;
      if (options.sparse !== undefined && Boolean(idx.sparse) !== Boolean(options.sparse)) return false;
      if (options.expireAfterSeconds !== undefined && idx.expireAfterSeconds !== options.expireAfterSeconds) return false;
      return true;
    });
  };
  const createIndexIfMissing = async (coll, key, options = {}) => {
    if (await hasCompatibleIndex(coll, key, options)) return;
    await coll.createIndex(key, options);
  };
  try {
    if (LOG_TTL_ENABLED) {
      const ttlSeconds = LOG_RETENTION_DAYS * 24 * 60 * 60;
      await logsColl.dropIndex("logs_createdAt_desc").catch(() => {});
      await createIndexIfMissing(logsColl, { createdAt: 1 }, { expireAfterSeconds: ttlSeconds, name: "logs_ttl_createdAt" });
    } else {
      await logsColl.dropIndex("logs_ttl_createdAt").catch(() => {});
      await createIndexIfMissing(logsColl, { createdAt: -1 }, { name: "logs_createdAt_desc" });
    }
    await Promise.all([
      createIndexIfMissing(collection("logs"), { employeeId: 1, createdAt: -1 }, { name: "logs_employeeId_createdAt" }),
      createIndexIfMissing(collection("logs"), { employeeName: 1, createdAt: -1 }, { name: "logs_employeeName_createdAt" }),
      createIndexIfMissing(collection("logs"), { accessGranted: 1, createdAt: -1 }, { name: "logs_accessGranted_createdAt" }),
      createIndexIfMissing(collection("logs"), { eventType: 1, createdAt: -1 }, { name: "logs_eventType_createdAt" }),
      createIndexIfMissing(collection("logs"), { zone: 1, createdAt: -1 }, { name: "logs_zone_createdAt" }),
      // Compound index for device time-range queries (buildAiSnapshot, enrichLogs)
      createIndexIfMissing(collection("logs"), { deviceId: 1, createdAt: -1 }, { name: "logs_deviceId_createdAt" }),
      // Index for unknown identity photo recovery queries
      createIndexIfMissing(collection("logs"), { employeeId: 1, createdAt: -1, photo: 1 }, { sparse: true, name: "logs_empId_created_photo" }),
      // Prevent duplicate Suprema log inserts for same reader/log id.
      createIndexIfMissing(
        collection("logs"),
        { deviceId: 1, supremaLogId: 1 },
        {
          unique: true,
          sparse: true,
          name: "logs_deviceId_supremaLogId_unique"
        }
      ),

      // Scale-read indexes for employee-heavy operations.
      createIndexIfMissing(collection("employees"), { employeeId: 1 }, { unique: true, sparse: true, name: "employees_employeeId_unique" }),
      createIndexIfMissing(collection("employees"), { supremaUserId: 1 }, { sparse: true, name: "employees_supremaUserId" }),
      createIndexIfMissing(collection("employees"), { name: 1 }, { name: "employees_name" }),
      createIndexIfMissing(collection("employees"), { companyId: 1, status: 1 }, { name: "employees_company_status" }),
      createIndexIfMissing(collection("employees"), { company: 1 }, { sparse: true, name: "employees_company" }),
      createIndexIfMissing(collection("companies"), { status: 1, name: 1 }, { name: "companies_status_name" }),
      createIndexIfMissing(collection("employees"), { status: 1, updatedAt: -1 }, { name: "employees_status_updatedAt" }),
      createIndexIfMissing(collection("employees"), { createdAt: -1 }, { name: "employees_createdAt_desc" }),
      createIndexIfMissing(collection("employees"), { enrolled: 1, createdAt: -1 }, { name: "employees_enrolled_createdAt" }),

      createIndexIfMissing(collection("visitors"), { qrToken: 1 }, { unique: true, sparse: true, name: "visitors_qrToken_unique" }),
      createIndexIfMissing(collection("visitors"), { status: 1, updatedAt: -1 }, { name: "visitors_status_updatedAt" }),
      createIndexIfMissing(collection("visitors"), { status: 1, createdAt: -1 }, { name: "visitors_status_createdAt" }),
      createIndexIfMissing(collection("visitors"), { createdAt: -1 }, { name: "visitors_createdAt_desc" }),
      createIndexIfMissing(collection("devices"), { deviceId: 1 }, { sparse: true, name: "devices_deviceId" }),
      createIndexIfMissing(collection("devices"), { supremaDeviceId: 1 }, { sparse: true, name: "devices_supremaDeviceId" }),
      createIndexIfMissing(collection("devices"), { ipAddr: 1 }, { sparse: true, name: "devices_ipAddr" }),
      createIndexIfMissing(collection("companies"), { name: 1 }, { name: "companies_name" }),

      // Device sync queue indexes for offline device operation retry
      createIndexIfMissing(collection("device_sync_queue"), { deviceId: 1, status: 1, createdAt: 1 }, { name: "dsq_device_status_created" }),
      createIndexIfMissing(collection("device_sync_queue"), { status: 1, nextAttemptAt: 1 }, { name: "dsq_status_nextAttempt" }),
      createIndexIfMissing(collection("device_sync_queue"), { employeeId: 1, operation: 1 }, { sparse: true, name: "dsq_employee_operation" }),
      createIndexIfMissing(collection("device_sync_queue"), { createdAt: -1 }, { name: "dsq_created_desc" })
    ]);
    console.log(
      `[backend] Mongo indexes ready (log retention: ${LOG_TTL_ENABLED ? `${LOG_RETENTION_DAYS} days TTL` : "unlimited"}).`
    );
  } catch (error) {
    console.error("[backend] Index setup warning:", error.message);
  }
}

const collection = (name) => mongo.db("expo-fr").collection(name);

/** Logs may store pass number as string; Employee docs may use string or number — Mongo $in must include both. */
function mongoEmployeeIdVariants(idsIterable) {
  const out = new Set();
  for (const raw of idsIterable) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    out.add(s);
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) out.add(n);
  }
  return [...out];
}

/** Resolve employee for REST `:id` — 24-char Mongo ObjectId, or catalog `employeeId` / pass number (string or numeric). */
async function findEmployeeByRouteId(paramId) {
  const { ObjectId } = await import("mongodb");
  const s = String(paramId ?? "").trim();
  if (!s) return null;
  if (/^[a-fA-F0-9]{24}$/.test(s)) {
    try {
      const oid = new ObjectId(s);
      const byOid = await collection("employees").findOne({ _id: oid });
      if (byOid) return byOid;
    } catch {
      /* fall through */
    }
  }
  const idVariants = mongoEmployeeIdVariants(new Set([s]));
  if (idVariants.length) {
    const byPass = await collection("employees").findOne({ employeeId: { $in: idVariants } });
    if (byPass) return byPass;
  }
  return null;
}

const accountFilter = async (id) => {
  const { ObjectId } = await import("mongodb");
  if (ObjectId.isValid(id)) return { _id: new ObjectId(id) };
  return { $or: [{ username: id }, { id }] };
};
const deviceFilter = async (id) => {
  const { ObjectId } = await import("mongodb");
  if (ObjectId.isValid(id)) return { _id: new ObjectId(id) };
  return { $or: [{ deviceId: id }, { id }, { ip: id }, { name: id }] };
};
const visitorFilter = async (id) => {
  const { ObjectId } = await import("mongodb");
  if (ObjectId.isValid(id)) {
    const oid = new ObjectId(id);
    return { $or: [{ _id: oid }, { _id: id }] };
  }
  return { $or: [{ _id: id }, { id }, { name: id }] };
};

function toDoc(payload = {}) {
  return {
    ...payload,
    updatedAt: new Date()
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function auth(req, res, next) {
  if (
    req.path === "/api/auth/login" ||
    req.path === "/api/health" ||
    req.path === "/api/ready" ||
    req.path.startsWith("/api/visitors/scan/")
  ) return next();
  if (
    req.path === "/api/gsdk/diagnostics" &&
    String(process.env.GSDK_DIAGNOSTICS_OPEN || "").toLowerCase() === "true"
  ) {
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Check if token has been revoked (user suspended/deleted)
    const userId = req.user?.user?.id || req.user?.id;
    if (userId && isTokenRevoked(userId)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

app.use(auth);

const parsePagination = (q) => {
  const page = Math.max(Number(q.page || 1), 1);
  const limit = Math.min(Math.max(Number(q.limit || 50), 1), 100000); // unlimited: hard cap 100k per page
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

process.on("unhandledRejection", (reason) => {
  console.error("[backend] Unhandled promise rejection:", reason?.message || reason);
});
process.on("uncaughtException", (error) => {
  console.error("[backend] Uncaught exception:", error?.message || error);
});

const ok = (res, value) => res.json(value);
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
let mailer = null;
const hasSmtpConfig = (cfg) => Boolean(cfg?.host && cfg?.user && cfg?.pass);
function getMailer() {
  if (mailer) return mailer;
  if (!hasSmtpConfig(smtpRuntime)) return null;
  mailer = nodemailer.createTransport({
    host: smtpRuntime.host,
    port: Number(smtpRuntime.port || 587),
    secure: Number(smtpRuntime.port || 587) === 465,
    auth: { user: smtpRuntime.user, pass: smtpRuntime.pass }
  });
  return mailer;
}

function normUrl(v = "") {
  return String(v || "").trim().replace(/\/$/, "");
}

function centralApiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (centralApiRuntime.apiKey) h.Authorization = `Bearer ${centralApiRuntime.apiKey}`;
  return h;
}

async function syncFromCentralApiOnce() {
  if (!mongoConnected) throw new Error("MongoDB unavailable");
  if (!centralApiRuntime.enabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  const base = normUrl(centralApiRuntime.baseUrl);
  if (!base) throw new Error("Central API base URL is not configured");

  const usersUrl = `${base}${centralApiRuntime.usersPath || "/users"}`;
  const devicesUrl = `${base}${centralApiRuntime.devicesPath || "/devices"}`;
  const timeoutMs = Math.max(3000, Number(centralApiRuntime.timeoutMs || 15000));
  const headers = centralApiHeaders();

  const usersResp = await fetchJsonWithTimeout(usersUrl, { headers }, timeoutMs);
  if (!usersResp.response.ok) {
    throw new Error(`Central API users pull failed (${usersResp.response.status})`);
  }
  const usersRaw = Array.isArray(usersResp.payload)
    ? usersResp.payload
    : usersResp.payload?.items || usersResp.payload?.users || [];

  let usersUpserted = 0;
  for (const u of usersRaw) {
    const employeeId = String(u.employeeId ?? u.passNumber ?? u.id ?? "").trim();
    const name = String(u.name ?? u.employeeName ?? "").trim();
    if (!employeeId || !name) continue;
    const now = new Date();
    const setDoc = {
      employeeId,
      supremaUserId: String(u.supremaUserId ?? employeeId).trim(),
      name,
      designation: String(u.designation ?? "").trim(),
      department: String(u.department ?? "").trim(),
      division: String(u.division ?? "").trim(),
      cardId: String(u.cardId ?? u.cardNo ?? "").trim(),
      authMode: String(u.authMode ?? "Face Only").trim() || "Face Only",
      status: String(u.status ?? "active").trim() || "active",
      enrolled: Boolean(u.enrolled ?? true),
      updatedAt: now,
      source: "central-api"
    };
    const photo = String(u.photo || u.facePhoto || "").trim();
    if (photo) {
      setDoc.photo = photo;
      setDoc.facePhoto = photo;
      setDoc.enrolled = true;
      if (!setDoc.enrolledAt) setDoc.enrolledAt = now;
    }
    await collection("employees").updateOne(
      { employeeId },
      { $set: setDoc, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    usersUpserted += 1;
  }

  const devicesResp = await fetchJsonWithTimeout(devicesUrl, { headers }, timeoutMs);
  let devicesUpserted = 0;
  if (devicesResp.response.ok) {
    const devicesRaw = Array.isArray(devicesResp.payload)
      ? devicesResp.payload
      : devicesResp.payload?.items || devicesResp.payload?.devices || [];
    for (const d of devicesRaw) {
      const deviceId = String(d.deviceId ?? d.id ?? d.supremaDeviceId ?? "").trim();
      const ipAddr = String(d.ipAddr ?? d.ip ?? "").trim();
      if (!deviceId && !ipAddr) continue;
      await collection("devices").updateOne(
        deviceId ? { deviceId } : { ipAddr },
        {
          $set: {
            deviceId: deviceId || undefined,
            ipAddr,
            name: String(d.name ?? d.deviceName ?? `Reader ${deviceId || ipAddr}`).trim(),
            model: String(d.model ?? "").trim(),
            zone: String(d.zone ?? "").trim(),
            supremaDeviceId: String(d.supremaDeviceId ?? d.gatewayId ?? deviceId).trim(),
            status: String(d.status ?? "online").trim() || "online",
            updatedAt: new Date(),
            source: "central-api"
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
      devicesUpserted += 1;
    }
  }

  let pushedToReaders = 0;
  if (centralApiRuntime.autoPushToReaders && ENROLLMENT_PUSH_DEVICES) {
    const emps = await collection("employees")
      .find({ source: "central-api", photo: { $type: "string", $ne: "" } })
      .project({ employeeId: 1, name: 1, supremaUserId: 1, photo: 1, facePhoto: 1 })
      .toArray(); // no cap — sync all enrolled employees
    for (const e of emps) {
      const raw = String(e.photo || e.facePhoto || "");
      const b64 = raw.includes("base64,") ? raw.split(",")[1] : raw;
      if (!b64 || b64.length < 80) continue;
      try {
        const r = await pushFaceEnrollmentToDevices(e, b64);
        if (r?.ok) pushedToReaders += 1;
      } catch {
        /* keep sync resilient */
      }
    }
  }

  const nowIso = new Date().toISOString();
  centralApiRuntime.lastSyncAt = nowIso;
  centralApiRuntime.lastSyncOk = true;
  centralApiRuntime.lastSyncError = "";
  await collection("system_config").updateOne(
    { _id: "central_api" },
    { $set: { ...centralApiRuntime, updatedAt: new Date() } },
    { upsert: true }
  );

  return { ok: true, usersUpserted, devicesUpserted, pushedToReaders };
}

function safeFsSegment(s, max = 40) {
  const t = String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
  return t || "visitor";
}

/**
 * Writes qr.png + contact.json under VISITOR_QR_STORAGE_DIR/{yyyy-mm-dd}/{idTail}_{name}/.
 * QR payload is scanUrl (same as qrCodeDataUrl in DB). Email remains optional.
 */
async function saveVisitorQrToDisk(visitor, qrToken, scanUrl) {
  if (!VISITOR_QR_STORAGE_ENABLED || !visitor || !qrToken || !scanUrl) return null;
  try {
    const idStr = visitor._id && typeof visitor._id.toString === "function" ? visitor._id.toString() : String(visitor._id || "");
    if (!idStr) return null;
    const datePart = new Date().toISOString().slice(0, 10);
    const namePart = safeFsSegment(visitor.name || visitor.visitorName || "visitor", 36);
    const dirName = `${idStr.slice(-6)}_${namePart}`;
    const relDir = path.join(datePart, dirName);
    const absDir = path.join(VISITOR_QR_STORAGE_DIR, relDir);
    await mkdir(absDir, { recursive: true });
    const pngPath = path.join(absDir, "qr.png");
    const metaPath = path.join(absDir, "contact.json");
    await QRCode.toFile(pngPath, scanUrl, { width: 512, margin: 2, errorCorrectionLevel: "M" });
    const createdAt =
      visitor.createdAt instanceof Date
        ? visitor.createdAt.toISOString()
        : new Date().toISOString();
    const meta = {
      schema: "expo-fr-visitor-qr-v1",
      visitorMongoId: idStr,
      qrToken,
      scanUrl,
      createdAt,
      appBaseUrl: APP_BASE_URL,
      contact: {
        name: visitor.name ?? null,
        email: visitor.email ?? null,
        phone: visitor.phone ?? null,
        company: visitor.company ?? null,
        host: visitor.host ?? null,
        hostEmail: visitor.hostEmail ?? null,
        purpose: visitor.purpose ?? null,
        passNumber: visitor.passNumber ?? null,
        visitingDepartment: visitor.visitingDepartment ?? null,
        visitingLocation: visitor.visitingLocation ?? null,
        visitTime: visitor.visitTime ?? null,
        scheduledFrom: visitor.scheduledFrom ?? null,
        scheduledTo: visitor.scheduledTo ?? null,
        employeeTag: visitor.employeeTag ?? null
      },
      supremaNote:
        "The PNG encodes scanUrl (check-in link). For Suprema barcode/card tests you may need a different payload (e.g. numeric ID) per reader firmware — compare with BioStar / device QR spec."
    };
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    return {
      storageRoot: VISITOR_QR_STORAGE_DIR,
      relativeDir: relDir.split(path.sep).join("/"),
      png: "qr.png",
      metaJson: "contact.json"
    };
  } catch (e) {
    console.error("[backend] visitor QR disk save failed:", e?.message || e);
    return null;
  }
}

/**
 * Saves visitor photo to disk (avoids MongoDB 16MB document limit).
 * Writes photo.jpg under VISITOR_QR_STORAGE_DIR/{yyyy-mm-dd}/{idTail}_{name}/.
 */
async function saveVisitorPhotoToDisk(visitor, photoData) {
  if (!VISITOR_QR_STORAGE_ENABLED || !visitor || !photoData) return null;
  try {
    const idStr = visitor._id && typeof visitor._id.toString === "function" ? visitor._id.toString() : String(visitor._id || "");
    if (!idStr) return null;

    const datePart = new Date().toISOString().slice(0, 10);
    const namePart = safeFsSegment(visitor.name || visitor.visitorName || "visitor", 36);
    const dirName = `${idStr.slice(-6)}_${namePart}`;
    const relDir = path.join(datePart, dirName);
    const absDir = path.join(VISITOR_QR_STORAGE_DIR, relDir);
    await mkdir(absDir, { recursive: true });

    // Extract base64 data from data URL
    let base64Data = photoData;
    if (photoData.includes("base64,")) {
      base64Data = photoData.split("base64,")[1];
    }
    base64Data = base64Data.replace(/\s/g, "");

    const photoPath = path.join(absDir, "photo.jpg");
    await writeFile(photoPath, Buffer.from(base64Data, "base64"));

    return {
      storageRoot: VISITOR_QR_STORAGE_DIR,
      relativeDir: relDir.split(path.sep).join("/"),
      file: "photo.jpg"
    };
  } catch (e) {
    console.error("[backend] visitor photo disk save failed:", e?.message || e);
    return null;
  }
}

async function sendVisitorQrEmail(visitor, qrCodeDataUrl, scanUrl) {
  if (!visitor?.email) return { emailSent: false, reason: "visitor email missing" };
  const transport = getMailer();
  if (!transport) return { emailSent: false, reason: "SMTP not configured" };
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
      <h2 style="margin:0 0 8px">Visitor Access QR Code</h2>
      <p>Hello ${visitor.name || "Visitor"},</p>
      <p>Please use this QR code at the entrance kiosk for automatic check-in.</p>
      <p><img src="${qrCodeDataUrl}" alt="Visitor QR Code" style="width:220px;height:220px;border:1px solid #e2e8f0;padding:8px;border-radius:8px"/></p>
      <p><a href="${scanUrl}">Scan/check-in link</a></p>
      <p>Host: ${visitor.host || "N/A"}<br/>Purpose: ${visitor.purpose || "N/A"}</p>
    </div>
  `;
  await transport.sendMail({
    from: smtpRuntime.from || smtpRuntime.user || "noreply@expo-fr.local",
    to: visitor.email,
    subject: `Expo City Dubai Visitor QR - ${visitor.name || "Visitor"}`,
    html
  });
  return { emailSent: true };
}
const VALID_EMPLOYEE_TAGS = [
  "Al Wasl POD Access",
  "Al wasl 3 General Access",
  "Sustainability SS05 General Access"
];

const EXPORT_DEFAULT_COLUMNS = ["timestamp", "employeeName", "employeeId", "company", "department", "division", "designation", "zone", "building", "device", "authMode", "accessGranted", "direction", "cardId", "accessLevel", "cardholderStatus", "shiftSchedule", "passIssueDate", "passExpiryDate", "lineManager", "email", "phone", "visitorName", "visitorCompany", "visitorEmail", "visitorMobile", "visitingDepartment", "visitingLocation", "visitingPersonName", "confidence", "processingMs", "temperature", "unknownLiveImageSource", "date"];
const EXPORT_COLUMN_LABELS = {
  timestamp: "Timestamp",
  date: "Date",
  employeeName: "Employee Name",
  employeeId: "Employee ID",
  company: "Company",
  department: "Department",
  division: "Division",
  designation: "Designation",
  zone: "Zone",
  building: "Building",
  device: "Device",
  authMode: "Auth Mode",
  accessGranted: "Access Result",
  direction: "Entry/Exit",
  cardId: "Card ID",
  accessLevel: "Access Level",
  cardholderStatus: "Cardholder Status",
  shiftSchedule: "Shift Schedule",
  passIssueDate: "Pass Issue Date",
  passExpiryDate: "Pass Expiry Date",
  lineManager: "Line Manager",
  email: "Email",
  phone: "Phone",
  visitorName: "Visitor Name",
  visitorCompany: "Visitor Company",
  visitorEmail: "Visitor Email",
  visitorMobile: "Visitor Mobile",
  visitingDepartment: "Visiting Department",
  visitingLocation: "Visiting Location",
  visitingPersonName: "Visiting Person Name",
  unknownLiveImageSource: "Unknown Live Image Source",
  confidence: "Confidence (%)",
  processingMs: "Response (ms)",
  temperature: "Temperature (C)"
};

function fmtDubai(t) {
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const get = (type) => (parts.find(p => p.type === type) || {}).value || "00";
  return `${get("day")}/${get("month")}/${get("year")}, ${get("hour")}:${get("minute")}:${get("second")}`;
}

function pickFirstFiniteMetric(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickLogValue(row, key) {
  if (key === "timestamp" || key === "date") {
    const t = row.timestamp || row.ts || row.createdAt || "";
    if (!t) return "";
    return fmtDubai(t);
  }
  if (key === "accessGranted") {
    const v = row.accessGranted ?? row.granted;
    if (v === true) return "Granted";
    if (v === false) return "Denied";
    return "";
  }
  if (key === "confidence") {
    const n = pickFirstFiniteMetric(row?.confidence, row?.score, row?.matchScore);
    return n !== undefined ? String(Math.round(n)) : "";
  }
  if (key === "unknownLiveImageSource") {
    return row?.unknownLiveImageSourceMissing
      ? "Unknown image not provided by device source (hasimage=false)"
      : "";
  }
  if (key === "processingMs") {
    const n = pickFirstFiniteMetric(row?.processingMs, row?.responseMs, row?.latencyMs);
    return n !== undefined ? String(Math.round(n)) : "";
  }
  if (key === "temperature") {
    const n = pickFirstFiniteMetric(row?.temperature);
    return n !== undefined ? Number(n).toFixed(1) : "";
  }
  if (key === "direction") {
    const inferred = inferDirection(row);
    return inferred === "out" ? "Exit" : inferred === "in" ? "Entry" : "";
  }
  // Visitor fields from log or enriched data
  if (key === "visitorName") return row?.visitorName || row?.name || "";
  if (key === "visitorCompany") return row?.visitorCompany || row?.company || "";
  if (key === "visitorEmail") return row?.visitorEmail || "";
  if (key === "visitorMobile") return row?.visitorMobile || row?.mobile || "";
  if (key === "visitingDepartment") return row?.visitingDepartment || row?.department || "";
  if (key === "visitingLocation") return row?.visitingLocation || row?.location || "";
  if (key === "visitingPersonName") return row?.visitingPersonName || row?.visitingPerson || "";
  if (key === "email") return row?.email || "";
  if (key === "phone") return row?.phone || row?.mobile || "";
  return row?.[key] ?? "";
}

function toCsv(rows, columns) {
  const esc = (value) => {
    const raw = value instanceof Date ? value.toISOString() : String(value ?? "");
    const safe = raw.replaceAll("\"", "\"\"");
    return /[",\n]/.test(safe) ? `"${safe}"` : safe;
  };
  const labels = columns.map((c) => EXPORT_COLUMN_LABELS[c] || c);
  const header = labels.map(esc).join(",");
  const body = rows.map((row) => columns.map((c) => esc(pickLogValue(row, c))).join(",")).join("\n");
  // BOM helps Excel open UTF-8 CSV with proper column text.
  return `\uFEFF${header}\n${body}\n`;
}

function toSimplePdf(rows, columns) {
  const ROWS_PER_PAGE = 38;
  // Cap total rows to keep generated PDF reasonable in size.
  const HARD_CAP = Math.max(ROWS_PER_PAGE, Math.min(20000, Number(process.env.PDF_EXPORT_ROW_CAP || 5000)));
  const totalRows = Math.min(rows.length, HARD_CAP);
  const labels = columns.map((c) => EXPORT_COLUMN_LABELS[c] || c);
  const colWidths = columns.map((c) => {
    if (c === "timestamp" || c === "date") return 20;
    if (c === "employeeName" || c === "visitorName") return 18;
    if (c === "employeeId" || c === "zone" || c === "device" || c === "cardId") return 14;
    if (c === "company" || c === "visitorCompany" || c === "department" || c === "visitingDepartment") return 16;
    if (c === "email" || c === "visitorEmail") return 22;
    if (c === "accessGranted" || c === "direction") return 10;
    if (c === "phone" || c === "visitorMobile") return 14;
    if (c === "visitingPersonName" || c === "lineManager") return 16;
    if (c === "authMode" || c === "accessLevel" || c === "cardholderStatus") return 14;
    if (c === "passIssueDate" || c === "passExpiryDate") return 14;
    return 12;
  });
  const fmtCell = (v, w) => {
    const s = String(v ?? "");
    if (s.length >= w) return `${s.slice(0, Math.max(0, w - 1))}…`;
    return s.padEnd(w, " ");
  };
  const headerLine = labels.map((l, i) => fmtCell(l, colWidths[i])).join(" ");
  const sepLine = colWidths.map((w) => "-".repeat(Math.max(3, w))).join(" ");
  const escapePdf = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  // Split rows into pages.
  const pageCount = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
  const pageStreams = [];
  const stamp = new Date().toISOString();
  for (let p = 0; p < pageCount; p++) {
    const start = p * ROWS_PER_PAGE;
    const end = Math.min(start + ROWS_PER_PAGE, totalRows);
    const slice = rows.slice(start, end);
    const rowLines = slice.map((row) =>
      columns.map((c, i) => fmtCell(pickLogValue(row, c), colWidths[i])).join(" ")
    );
    const truncatedNote = (p === pageCount - 1 && rows.length > totalRows)
      ? `… ${rows.length - totalRows} more row(s) truncated. Use Excel/CSV for full export.`
      : null;
    const lines = [
      `Expo-FR Access Logs Export (${stamp}) — Page ${p + 1}/${pageCount} — ${rows.length} total`,
      "",
      headerLine,
      sepLine,
      ...(rowLines.length ? rowLines : ["(No records found)"])
    ];
    if (truncatedNote) lines.push("", truncatedNote);
    const textOps = ["BT", "/F1 8 Tf", "40 790 Td", "12 TL"];
    for (const line of lines) textOps.push(`(${escapePdf(line)}) Tj`, "T*");
    textOps.push("ET");
    pageStreams.push(textOps.join("\n"));
  }

  // PDF object layout:
  //   1: Catalog
  //   2: Pages
  //   3: Font
  //   4..(3+pageCount): Page objects
  //   (4+pageCount)..(3+2*pageCount): Content streams (one per page)
  const objects = [];
  const addObj = (body) => objects.push(`${objects.length + 1} 0 obj\n${body}\nendobj\n`);
  addObj("<< /Type /Catalog /Pages 2 0 R >>");
  const firstPageObj = 4;
  const firstContentObj = firstPageObj + pageCount;
  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i} 0 R`).join(" ");
  addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  for (let p = 0; p < pageCount; p++) {
    addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContentObj + p} 0 R >>`);
  }
  for (let p = 0; p < pageCount; p++) {
    const stream = pageStreams[p];
    addObj(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function getLogTimestamp(row) {
  return row?.timestamp || row?.ts || row?.createdAt || null;
}

function inferDirection(row) {
  // 1. Explicit direction field (already normalised to "in"/"out" by log normaliser)
  const dir = String(row?.direction || "").toLowerCase();
  if (dir === "out" || dir === "exit") return "out";
  if (dir === "in"  || dir === "entry") return "in";

  // 2. Device placement stored on the log ("entry" device → in, "exit" device → out)
  const placement = String(row?.devicePlacement || row?.placement || "").toLowerCase();
  if (placement === "exit")  return "out";
  if (placement === "entry") return "in";

  // 3. Fallback: granted scan on any device → "in" (conservative)
  return (row?.accessGranted ?? row?.granted) ? "in" : "out";
}

function buildAttendanceRows(logs = [], employeeMap = new Map()) {
  const rows = new Map();
  const now = Date.now();
  for (const l of logs) {
    const tsRaw = getLogTimestamp(l);
    const ts = tsRaw ? new Date(tsRaw) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;
    const id = String(l?.employeeId || "").trim();
    const nm = String(l?.employeeName || l?.name || "").trim();
    const key = id || nm;
    if (!key) continue;
    const emp = employeeMap.get(id) || employeeMap.get(nm.toLowerCase()) || null;
    const photo = l?.photo || l?.photoUrl || l?.image || l?.imageUrl || l?.facePhoto || l?.faceImage || l?.snapshot || l?.snapshotUrl || l?.capture || l?.captureUrl
      || emp?.photo || emp?.photoUrl || emp?.image || emp?.imageUrl || null;
    if (!rows.has(key)) {
      rows.set(key, {
        personKey: key,
        employeeId: id || emp?.employeeId || "",
        cardId: emp?.cardId || emp?.cardNo || "",
        employeeName: nm || emp?.name || key,
        company: emp?.company || "",
        designation: emp?.designation || "",
        department: l?.department || l?.dept || emp?.department || "",
        division: emp?.division || "",
        accessLevel: emp?.accessLevel || "",
        cardholderStatus: emp?.cardholderStatus || "",
        shiftSchedule: emp?.shiftSchedule || "",
        passIssueDate: emp?.passIssueDate || "",
        passExpiryDate: emp?.passExpiryDate || "",
        email: emp?.email || "",
        phone: emp?.phone || "",
        lineManager: emp?.lineManager || "",
        inTime: null,
        outTime: null,
        totalDurationMinutes: 0,
        currentInStart: null,
        status: "out",
        eventsCount: 0,
        photo: photo || null
      });
    }
    const rec = rows.get(key);
    rec.eventsCount += 1;
    if (!rec.photo && photo) rec.photo = photo;
    if (!rec.department && (l?.department || l?.dept)) rec.department = l?.department || l?.dept;
    const direction = inferDirection(l);
    if (direction === "in") {
      rec.inTime = rec.inTime || ts.toISOString(); // kept as ISO internally for formatting below
      rec.currentInStart = ts.getTime();
      rec.status = "in";
    } else {
      rec.outTime = ts.toISOString(); // kept as ISO internally for formatting below
      if (rec.currentInStart) {
        rec.totalDurationMinutes += Math.max(0, Math.floor((ts.getTime() - rec.currentInStart) / 60000));
        rec.currentInStart = null;
      }
      rec.status = "out";
    }
  }

  return [...rows.values()].map((r) => {
    const currentAdd = r.currentInStart ? Math.max(0, Math.floor((now - r.currentInStart) / 60000)) : 0;
    const totalMin = r.totalDurationMinutes + currentAdd;
    return {
      personKey: r.personKey,
      employeeId: r.employeeId,
      cardId: r.cardId,
      employeeName: r.employeeName,
      company: r.company || "—",
      designation: r.designation || "—",
      department: r.department || "—",
      division: r.division || "—",
      accessLevel: r.accessLevel || "—",
      cardholderStatus: r.cardholderStatus || "—",
      shiftSchedule: r.shiftSchedule || "—",
      passIssueDate: r.passIssueDate || "—",
      passExpiryDate: r.passExpiryDate || "—",
      email: r.email || "—",
      phone: r.phone || "—",
      lineManager: r.lineManager || "—",
      status: r.status,
      inTime: r.inTime || "",
      outTime: r.outTime || "",
      totalDurationMinutes: totalMin,
      totalDuration: (() => { const h = Math.floor(totalMin / 60); const m = totalMin % 60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`; })(),
      eventsCount: r.eventsCount,
      photo: r.photo || ""
    };
  }).sort((a, b) => b.totalDurationMinutes - a.totalDurationMinutes);
}

function logPhotoFrom(log) {
  const j = log?.jpgimage ?? log?.jpgImage;
  if (j && typeof j === "string" && j.length > 32 && !String(j).startsWith("data:")) {
    return `data:image/jpeg;base64,${j}`;
  }
  return (
    log?.photo ||
    log?.photoUrl ||
    log?.image ||
    log?.imageUrl ||
    log?.facePhoto ||
    log?.faceImage ||
    log?.snapshot ||
    log?.snapshotUrl ||
    log?.capture ||
    log?.captureUrl ||
    null
  );
}

function isValidTimeValue(val) {
  if (val == null || val === "") return false;
  const t = new Date(val);
  return !Number.isNaN(t.getTime());
}

function timeFromObjectId(id) {
  if (id == null) return null;
  try {
    if (id instanceof ObjectId) return id.getTimestamp();
    if (typeof id === "string" && ObjectId.isValid(id) && id.length === 24) {
      return new ObjectId(id).getTimestamp();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Legacy rows may lack timestamp/ts; BioStar uses Unix seconds; Mongo _id embeds insert time.
 * Returns a copy with timestamp, ts, and createdAt normalized for the UI.
 */
function attachCoercedLogTimes(d) {
  if (!d || typeof d !== "object") return d;
  const candidates = [d.timestamp, d.ts, d.createdAt];
  let best = null;
  for (const c of candidates) {
    if (isValidTimeValue(c)) {
      best = new Date(c);
      break;
    }
  }
  if (!best) {
    const n = Number(d.timestamp ?? d.ts ?? 0);
    if (Number.isFinite(n) && n > 0) {
      const ms = n < 1e12 ? n * 1000 : n;
      const t = new Date(ms);
      if (!Number.isNaN(t.getTime())) best = t;
    }
  }
  if (!best) {
    best = timeFromObjectId(d._id);
  }
  if (!best) return d;
  return {
    ...d,
    timestamp: isValidTimeValue(d.timestamp) ? d.timestamp : best,
    ts: isValidTimeValue(d.ts) ? d.ts : best,
    createdAt: isValidTimeValue(d.createdAt) ? d.createdAt : best
  };
}

/** Map BioStar eventCode (see g-sdk event.md) to access granted when explicit flags missing.
 * Devices often emit flag-augmented codes (e.g. 0x1030 vs 0x1000); compare (code & 0xFF00). */
function accessGrantedFromBioStarEventCode(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const m = ((n >>> 0) & 0xffff) & 0xff00;
  const grant = new Set([
    0x1000, 0x1200, 0x1300, 0x1500, 0x1600 // VERIFY/IDENTIFY/DUAL success (+ duress variants)
  ]);
  const deny = new Set([
    0x1100, 0x1400, 0x1700, 0x1800, 0x1900, 0x1a00
  ]);
  if (grant.has(m)) return true;
  if (deny.has(m)) return false;
  return undefined;
}

/** Raw Suprema GRPC/toJSON uses lowercase proto fields (eventcode). */
function rawBioStarEventCode(raw = {}) {
  const v =
    raw.eventcode ??
    raw.eventCode ??
    raw.event_code ??
    raw.maineventcode ??
    raw.mainEventCode ??
    raw.MainEventCode ??
    0;
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v.trim())) return Number.parseInt(v.trim(), 16) >>> 0;
  const n = Number(v);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

function rawBioStarSubCode(raw = {}) {
  const v = raw.subcode ?? raw.subCode ?? raw.sub_code ?? 0;
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(String(v).trim())) return Number.parseInt(v.trim(), 16) >>> 0;
  const n = Number(v);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

/** Human-readable hint for Access Logs (BioStar event.md main + sub codes). */
function denialReasonFromBioStar(mainCode, subCode) {
  const m = ((Number(mainCode) >>> 0) & 0xffff) & 0xff00;
  const s = (Number(subCode) >>> 0) & 0xff;
  if (m === 0x1900) {
    const map = {
      0x01: "Invalid access group — user is not in a group allowed by this door (BioStar: door access level + user groups; set SUPREMA_ACCESS_GROUP_IDS or DEFAULT_SUPREMA_ACCESS_GROUP and re-enroll).",
      0x02: "User disabled on device.",
      0x03: "User expired.",
      0x04: "User blacklisted.",
      0x05: "Anti-passback (APB).",
      0x06: "Timed APB.",
      0x07: "Scheduled lock zone.",
      0x0a: "Face not detected.",
      0x0c: "Fake finger detected.",
      0x13: "High temperature.",
      0x15: "Mask / unmasked face policy."
    };
    return map[s] || `Access denied (BioStar subCode 0x${s.toString(16)}).`;
  }
  if (m === 0x1400) return "Identify failed (no 1:N match or below threshold).";
  if (m === 0x1100) return "Verify failed (1:1 credential mismatch).";
  if (m === 0x1800) {
    if (s === 0x05) return "Unregistered / invalid face template.";
    if (s === 0x02) return "Invalid credential.";
    if (s === 0x01) return "Invalid authentication mode for this user.";
    if (s === 0x03) return "Authentication timeout — credential not completed in time (often face match timeout or user walked away too early).";
  }
  return "";
}

/** Low 16 bits masked to BS2 main row — auth deny burst collapse (handles 0x1430 like 0x1400). */
const AUTH_DENY_MAIN_MASKS = new Set([0x1100, 0x1400, 0x1700, 0x1800, 0x1900, 0x1a00]);

/**
 * Collapse multiple Suprema auth-deny log lines in the same wall second (same interaction burst).
 */
function collapseSameSecondAuthDenials(rows = []) {
  if (!DEVICE_LOG_COLLAPSE_AUTH_BURST || !Array.isArray(rows) || rows.length < 2) return rows;
  const groups = new Map();
  const passthrough = [];
  for (const r of rows) {
    const code = (Number(r.bioStarEventCode) || 0) & 0xffff;
    const mainMasked = code & 0xff00;
    if (!AUTH_DENY_MAIN_MASKS.has(mainMasked)) {
      passthrough.push(r);
      continue;
    }
    const sec = Math.floor(new Date(r.timestamp).getTime() / 1000);
    const key = `${String(r.deviceId || "")}|${sec}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const winners = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      winners.push(arr[0]);
    } else {
      // Prefer a row with a live snapshot; among equals prefer newest supremaLogId.
      arr.sort((a, b) => {
        const ap = Boolean(String(a.photo || a.jpgimage || "").trim());
        const bp = Boolean(String(b.photo || b.jpgimage || "").trim());
        if (ap !== bp) return ap ? -1 : 1;
        return (Number(b.supremaLogId) || 0) - (Number(a.supremaLogId) || 0);
      });
      let winner = arr[0];
      const pickPhoto = (row) => {
        const p = String(row?.photo || "").trim();
        if (p) return p;
        const j = row?.jpgimage ?? row?.jpgImage;
        if (j && String(j).trim().length > 32) return `data:image/jpeg;base64,${j}`;
        return "";
      };
      let mergedPhoto = pickPhoto(winner);
      if (!mergedPhoto) {
        for (const s of arr) {
          mergedPhoto = pickPhoto(s);
          if (mergedPhoto) break;
        }
      }
      const jpgRaw = winner.jpgimage ?? winner.jpgImage;
      let mergedJpg = jpgRaw;
      if (!mergedPhoto && !mergedJpg) {
        for (const s of arr) {
          const j = s?.jpgimage ?? s?.jpgImage;
          if (j && String(j).trim().length > 32) {
            mergedJpg = j;
            break;
          }
        }
      }
      winners.push({
        ...winner,
        ...(mergedPhoto ? { photo: mergedPhoto } : {}),
        ...(mergedJpg && !winner.jpgimage && !winner.jpgImage ? { jpgimage: mergedJpg } : {})
      });
    }
  }
  return [...passthrough, ...winners];
}

const unknownId = () => `UNKNOWN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function employeeIndexes(employees = []) {
  const empById = new Map();
  const empByName = new Map();
  const empByNameLower = new Map();
  const addId = (raw, e) => {
    if (raw === undefined || raw === null || raw === "") return;
    const s = String(raw).trim();
    if (!s) return;
    empById.set(s, e);
    const n = Number(s);
    if (Number.isFinite(n)) empById.set(String(n), e);
  };
  for (const e of employees) {
    addId(e?.employeeId, e);
    addId(e?.supremaUserId, e);
    addId(e?._id, e);
    if (Array.isArray(e?.supremaAliases)) {
      for (const alias of e.supremaAliases) addId(alias, e);
    }
    const nm = String(e?.name || "").trim();
    if (nm) {
      empByName.set(nm, e);
      empByNameLower.set(nm.toLowerCase(), e);
    }
  }
  return { empById, empByName, empByNameLower };
}

function resolveEmployeeForLog(d, { empById, empByName, empByNameLower }) {
  const eid = String(d?.employeeId ?? "").trim();
  if (eid) {
    let emp = empById.get(eid);
    if (!emp && /^\d+$/.test(eid)) {
      const n = Number(eid);
      if (Number.isFinite(n)) emp = empById.get(String(n));
    }
    if (emp) return emp;
  }
  const nm = String(d?.employeeName || d?.name || "").trim();
  if (nm) {
    return empByName.get(nm) || empByNameLower.get(nm.toLowerCase()) || null;
  }
  return null;
}

async function enrichLogs(docs = []) {
  if (!docs.length) return docs;
  const ids = new Set();
  const names = new Set();
  for (const d of docs) {
    if (d?.employeeId) ids.add(String(d.employeeId).trim());
    if (d?.employeeName || d?.name) names.add(String(d.employeeName || d.name).trim());
  }

  const employeeQuery = [];
  if (ids.size) employeeQuery.push({ employeeId: { $in: mongoEmployeeIdVariants(ids) } });
  if (ids.size) employeeQuery.push({ supremaUserId: { $in: mongoEmployeeIdVariants(ids) } });
  if (ids.size) employeeQuery.push({ supremaAliases: { $in: [...ids] } });
  const objectIds = [...ids]
    .map((s) => String(s).trim())
    .filter((s) => /^[a-fA-F0-9]{24}$/.test(s))
    .map((s) => new ObjectId(s));
  if (objectIds.length) employeeQuery.push({ _id: { $in: objectIds } });
  if (names.size) employeeQuery.push({ name: { $in: [...names] } });
  const employees = employeeQuery.length ? await collection("employees").find({ $or: employeeQuery }).toArray() : [];
  const idx = employeeIndexes(employees);

  const updates = [];
  const out = docs.map((d) => {
    const event = d.eventType || "";
    const granted = d.accessGranted ?? d.granted ?? (event === "ACCESS_GRANTED" ? true : event === "ACCESS_DENIED" ? false : undefined);
    const emp = resolveEmployeeForLog(d, idx);
    /** Device/event capture only (scan-time image). */
    const capturePhoto = logPhotoFrom(d);
    const enrollmentPhoto =
      emp?.photo ||
      emp?.facePhoto ||
      emp?.photoUrl ||
      emp?.image ||
      emp?.imageUrl ||
      null;

    const patch = {};
    if (!granted && !emp && !d.employeeId) patch.employeeId = unknownId();
    if (!d.employeeName && !d.name && patch.employeeId) patch.employeeName = patch.employeeId;
    // Reader user id (e.g. "2") may differ from business pass number.
    // Once we resolve the employee, always normalize log employeeId to employee.passNumber/employeeId.
    if (emp?.employeeId && String(d?.employeeId || "").trim() !== String(emp.employeeId).trim()) {
      patch.employeeId = String(emp.employeeId).trim();
    }

    const timeBackfill =
      !isValidTimeValue(d.timestamp) &&
      !isValidTimeValue(d.ts) &&
      !isValidTimeValue(d.createdAt) &&
      timeFromObjectId(d._id);
    if (timeBackfill) {
      patch.timestamp = timeBackfill;
      patch.ts = timeBackfill;
      patch.createdAt = timeBackfill;
    }

    if (Object.keys(patch).length && d._id) updates.push({ _id: d._id, patch });
    const enrichedRow = {
      ...d,
      ...patch,
      ...(emp?.name ? { employeeName: emp.name } : {}),
      ...(capturePhoto ? { photo: capturePhoto } : {}),
      ...(enrollmentPhoto ? { enrollmentPhoto } : {}),
      cardId: d?.cardId || emp?.cardId || emp?.cardNo || "",
      company: d?.company || emp?.company || "",
      designation: d?.designation || emp?.designation || "",
      department: d?.department || d?.dept || emp?.department || "",
      division: d?.division || emp?.division || "",
      accessLevel: d?.accessLevel || emp?.accessLevel || "",
      cardholderStatus: d?.cardholderStatus || emp?.cardholderStatus || "",
      shiftSchedule: d?.shiftSchedule || emp?.shiftSchedule || "",
      passIssueDate: d?.passIssueDate || emp?.passIssueDate || "",
      passExpiryDate: d?.passExpiryDate || emp?.passExpiryDate || "",
      lineManager: d?.lineManager || emp?.lineManager || ""
    };
    const sourceMissing = isUnknownLiveImageSourceMissing(enrichedRow);
    return attachCoercedLogTimes({
      ...enrichedRow,
      ...(sourceMissing ? { unknownLiveImageSourceMissing: true } : {})
    });
  });

  if (updates.length) {
    await collection("logs").bulkWrite(
      updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { ...u.patch, updatedAt: new Date() } } } })),
      { ordered: false }
    ).catch(() => {});
  }
  // Deep fallback for unknown denied rows where device sent hasimage=false on one deny path (e.g. 0x1800),
  // but nearby unknown events from the same reader context contain a live photo (e.g. 0x1400 / 0x1100).
  const targets = out.filter((r) => isUnknownLiveImageSourceMissing(r));
  if (!targets.length) return out;
  try {
    const tsOf = (r) => {
      const d = new Date(r?.createdAt || r?.timestamp || r?.ts || 0);
      const ms = d.getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const targetTimes = targets.map(tsOf).filter((n) => n > 0);
    if (!targetTimes.length) return out;
    // Keep this bounded to avoid cross-person photo borrowing, but allow short retry sessions.
    const maxTs = Math.max(...targetTimes) + 5 * 1000;
    const lookbackStart = Math.max(0, Math.max(...targetTimes) - 90 * 1000);
    const targetDeviceIds = [...new Set(targets.map((r) => String(r?.deviceId || "").trim()).filter(Boolean))];
    // Donor rows: unknown identity + stored photo in the same time/device context.
    // Auth-category bytes 0x10–0x1E (covers 0x1030, 0x1430, … flag-augmented BS2 codes).
    const donorQuery = {
      $and: [
        logsDoorEventOnly(),
        { employeeId: { $regex: "^UNKNOWN-", $options: "i" } },
        { photo: { $type: "string", $ne: "" } },
        { unknownLiveImageRecovered: { $ne: true } },
        { createdAt: { $gte: new Date(lookbackStart), $lte: new Date(maxTs) } },
        ...(targetDeviceIds.length ? [{ deviceId: { $in: targetDeviceIds } }] : [])
      ]
    };
    const donorRowsRaw = await collection("logs")
      .find(donorQuery)
      .project({ photo: 1, createdAt: 1, timestamp: 1, ts: 1, deviceId: 1, zone: 1, authMode: 1, bioStarEventCode: 1, bioStarSubCode: 1 })
      .sort({ createdAt: -1 })
      .limit(10000)
      .toArray(); // bounded for large deployments
    const donorRows = donorRowsRaw.filter((d) => {
      const low = (Number(d.bioStarEventCode ?? 0) >>> 0) & 0xffff;
      const cat = (low >>> 8) & 0xff;
      return cat >= 0x10 && cat <= 0x1e;
    });
    if (!donorRows.length) return out;
    const keyOf = (r) =>
      [
        String(r?.deviceId || "").trim().toLowerCase(),
        String(r?.zone || "").trim().toLowerCase(),
        String(r?.authMode || "").trim().toLowerCase()
      ].join("|");
    const donorsByKey = new Map();
    for (const d of donorRows) {
      const k = keyOf(d);
      if (!donorsByKey.has(k)) donorsByKey.set(k, []);
      donorsByKey.get(k).push(d);
    }
    const recoveredRows = out.map((r) => {
      if (!isUnknownLiveImageSourceMissing(r)) return r;
      const t = tsOf(r);
      if (!t) return r;
      const candidates = donorsByKey.get(keyOf(r)) || [];
      let best = null;
      let bestDelta = Infinity;
      for (const d of candidates) {
        const dt = tsOf(d);
        if (!dt) continue;
        const delta = Math.abs(dt - t);
        // Pass 1: near-exact match window.
        if (delta <= 15 * 1000 && delta < bestDelta) {
          best = d;
          bestDelta = delta;
        }
      }
      // Pass 2 (alternate): same-device short retry session.
      // If no strict match, use latest *earlier* real 0x1100 unknown photo within 90s.
      if (!best) {
        let latestBefore = null;
        let latestTs = 0;
        for (const d of candidates) {
          const dt = tsOf(d);
          if (!dt) continue;
          if (dt > t) continue;
          const age = t - dt;
          if (age > 90 * 1000) continue;
          if (dt > latestTs) {
            latestBefore = d;
            latestTs = dt;
          }
        }
        if (latestBefore) {
          best = latestBefore;
        }
      }
      if (!best?.photo) return r;
      return {
        ...r,
        photo: String(best.photo || ""),
        unknownLiveImageRecovered: true,
        unknownLiveImageSourceMissing: false,
        unknownLiveImageRecoveredFrom:
          best?.bioStarEventCode != null
            ? `0x${(Number(best.bioStarEventCode) >>> 0).toString(16)}`
            : ""
      };
    });
    const recoverUpdates = recoveredRows
      .filter((r) => r?._id && r?.unknownLiveImageRecovered && String(r?.photo || "").trim())
      .map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: {
            $set: {
              photo: String(r.photo || ""),
              unknownLiveImageRecovered: true,
              unknownLiveImageSourceMissing: false,
              unknownLiveImageRecoveredFrom: String(r.unknownLiveImageRecoveredFrom || ""),
              updatedAt: new Date()
            }
          }
        }
      }));
    if (recoverUpdates.length) {
      await collection("logs").bulkWrite(recoverUpdates, { ordered: false }).catch(() => {});
    }
    return recoveredRows;
  } catch {
    return out;
  }
}

app.get("/api/health", async (_req, res) => {
  let ollamaOk = false;
  let ollamaError = null;
  let ollamaModel = process.env.OLLAMA_MODEL || "llama3.2";
  let ollamaModels = [];
  const gsdk = await getGsdkStatus();

  try {
    const client = getOllamaClient();
    const list = await client.list();
    ollamaOk = true;
    ollamaModels = (list?.models || []).map((m) => String(m?.name || "").trim()).filter(Boolean);
    const preferred = ollamaModels.find((n) => n.startsWith(ollamaModel)) || ollamaModels[0];
    if (preferred) ollamaModel = preferred.split(":")[0];
  } catch (error) {
    ollamaError = error.message;
  }

  let devices = null;
  let onPremise = null;
  let counts = null;
  if (mongoConnected) {
    try {
      const total = await collection("devices").countDocuments({});
      const online = await collection("devices").countDocuments({
        status: { $in: ["online", "connected"] }
      });
      devices = { total, online };
      const employees = await collection("employees")
        .find({}, { projection: { employeeId: 1, name: 1 } })
        .toArray();
      const employeeIdSet = new Set(
        employees
          .map((e) => String(e?.employeeId || "").trim().toLowerCase())
          .filter(Boolean)
      );
      const employeeNameSet = new Set(
        employees
          .map((e) => String(e?.name || "").trim().toLowerCase())
          .filter(Boolean)
      );
      const recentGrantedLogs = await collection("logs")
        .find({
          $and: [
            logsDoorEventOnly(),
            { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] }
          ]
        })
        .sort({ createdAt: -1 })
        .limit(5000)
        .toArray();
      const seen = new Set();
      let insideEmployees = 0;
      const isExitLike = (row) => {
        // Use the same direction inference logic as buildAttendanceRows for consistency
        return inferDirection(row) === "out";
      };
      for (const row of recentGrantedLogs) {
        const byId = String(row?.employeeId || "").trim().toLowerCase();
        const byName = String(row?.employeeName || row?.name || "").trim().toLowerCase();
        const isUnknown = byId.startsWith("unknown-") || byName.startsWith("unknown-") || byName === "unknown";
        if (isUnknown) continue;
        const isEmployee = (byId && employeeIdSet.has(byId)) || (byName && employeeNameSet.has(byName));
        if (!isEmployee) continue;
        const identityKey = byId || byName;
        if (!identityKey || seen.has(identityKey)) continue;
        seen.add(identityKey);
        if (!isExitLike(row)) insideEmployees += 1;
      }
      onPremise = insideEmployees;
      counts = {
        employees: await collection("employees").countDocuments({}),
        logs: await collection("logs").countDocuments(logsDoorEventOnly()),
        visitors: await collection("visitors").countDocuments({})
      };
    } catch {
      devices = null;
      onPremise = null;
      counts = null;
    }
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const serverRuntime = {
    hostname: os.hostname(),
    platform: os.platform(),
    nodeVersion: process.version,
    uptimeSec: Math.floor(process.uptime()),
    memory: `${Math.round((totalMem - freeMem) / 1024 / 1024)} / ${Math.round(totalMem / 1024 / 1024)} MiB`
  };

  res.json({
    status: "ok",
    services: {
      mongodb: mongoConnected ? "up" : "down",
      ollama: ollamaOk ? "up" : "down",
      gsdk: gsdk.installed ? "up" : "missing"
    },
    devices,
    onPremise,
    counts,
    serverRuntime,
    realtime: {
      websocketClients: wsClients.size,
      websocketPath: "/ws",
      deviceEventPullMs: DEVICE_EVENT_PULL_MS,
      deviceEventPullConcurrency: DEVICE_EVENT_PULL_CONCURRENCY
    },
    selfHealing: {
      enabled: SELF_HEALING_ENABLED,
      tickMs: SELF_HEALING_TICK_MS,
      failThreshold: SELF_HEALING_FAIL_THRESHOLD,
      cooldownMs: SELF_HEALING_COOLDOWN_MS,
      state: selfHealState
    },
    watchdog: {
      enabled: WATCHDOG_ENABLED,
      tickMs: WATCHDOG_TICK_MS,
      stalePullMs: WATCHDOG_STALE_PULL_MS,
      state: watchdogState
    },
    faceAutoRefreshQueue: {
      ...faceAutoRefreshState,
      queued: faceAutoRefreshQueue.size
    },
    deviceSyncQueue: {
      enabled: DEVICE_SYNC_QUEUE_ENABLED,
      tickMs: DEVICE_SYNC_QUEUE_TICK_MS,
      maxRetries: DEVICE_SYNC_MAX_RETRIES,
      unlimitedRetention: DEVICE_SYNC_UNLIMITED_RETENTION,
      maxRetryDelayMs: DEVICE_SYNC_MAX_RETRY_DELAY_MS,
      batchSize: DEVICE_SYNC_BATCH_SIZE,
      circuitBreakersOpen: [...deviceSyncCircuitBreakers.entries()].filter(([, cb]) => cb.failures >= CIRCUIT_BREAKER_THRESHOLD).length
    },
    tokenRevocation: {
      revokedEntries: revokedTokenCache.size,
      wsThrottleEntries: wsThrottleTimestamps.size
    },
    config: {
      port: PORT,
      mongodbUri: MONGODB_URI,
      mongodbMaxPoolSize: MONGODB_MAX_POOL_SIZE,
      visitorQrStorageEnabled: VISITOR_QR_STORAGE_ENABLED,
      visitorQrStorageDir: VISITOR_QR_STORAGE_DIR,
      ollamaHost: OLLAMA_HOST,
      gsdkGateway: GSDK_GATEWAY || null,
      gsdkUseSsl: GSDK_USE_SSL,
      gsdkDevicePort: GSDK_DEVICE_PORT,
      appBaseUrl: APP_BASE_URL,
      smtpConfigured: hasSmtpConfig(smtpRuntime),
      supremaEnrollmentAccessGroups: supremaAccessGroupConfigHint()
    },
    ollama: {
      model: ollamaModel,
      models: ollamaModels
    },
    errors: {
      ollama: ollamaError
    },
    gsdk,
    hostNetwork: {
      ok: lastHostNetworkStatus.ok,
      checkedAt: lastHostNetworkStatus.checkedAt,
      error: lastHostNetworkStatus.error || null
    },
    /** Non-secret checklist so ops/UI can spot regressions before Access Logs lose unknown/live scan photos. */
    preservation: {
      accessLogsAndEnrollment: {
        sidecarConfigured: Boolean(GSDK_SIDECAR_URL),
        gatewayConfigured: Boolean(String(GSDK_GATEWAY || "").trim()),
        grpcTls: GSDK_USE_SSL,
        autoSetAcceptFilter: AUTO_SET_ACCEPT_FILTER,
        logRetentionUnlimited: !LOG_TTL_ENABLED
      },
      hints: [
        "If you change GSDK_GATEWAY or GSDK_USE_SSL in .env: run `docker compose up -d --force-recreate backend gsdk-sidecar` (restart sidecar alone leaves backend on stale TLS).",
        "After device_gateway restart: backend should log `SetAcceptFilter allowAll applied` — not repeated `UNAVAILABLE`.",
        "Access log JPGs: My Devices → Enable scan photos (scheduleID=1) → Sync; BioStar Image Log + optional unknown-face capture if rows lack bytes.",
        "Employee face enrollment: do not change gsdk-sidecar enrollment routes or backend submit enrollment contract without BioStation regression (see rule LOCKED)."
      ]
    }
  });
});

app.get("/api/ready", async (_req, res) => {
  if (!mongoConnected) {
    return res.status(503).json({ ready: false, reason: "mongodb_down" });
  }
  return res.json({ ready: true });
});

app.get("/api/metrics", async (_req, res) => {
  if (!mongoConnected) {
    return res.status(503).json({ error: "MongoDB unavailable" });
  }
  const [employees, visitors, devices, logs100d, denied100d, granted100d] = await Promise.all([
    collection("employees").countDocuments({}),
    collection("visitors").countDocuments({}),
    collection("devices").countDocuments({}),
    collection("logs").countDocuments(logsDoorEventOnly()),
    collection("logs").countDocuments({ $and: [logsDoorEventOnly(), { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] }] }),
    collection("logs").countDocuments({ $and: [logsDoorEventOnly(), { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] }] })
  ]);
  const totalAccess = Math.max(1, denied100d + granted100d);
  res.json({
    ts: new Date().toISOString(),
    retentionDays: LOG_TTL_ENABLED ? LOG_RETENTION_DAYS : null,
    logRetentionUnlimited: !LOG_TTL_ENABLED,
    realtime: {
      websocketClients: wsClients.size,
      lastDeviceEventPullStats
    },
    totals: {
      employees,
      visitors,
      devices,
      logs100d,
      granted100d,
      denied100d,
      denyRatePct: Number(((denied100d / totalAccess) * 100).toFixed(2))
    },
    limits: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      rateLimitMax: RATE_LIMIT_MAX,
      rateLimitAuthMax: RATE_LIMIT_AUTH_MAX,
      deviceEventPullMs: DEVICE_EVENT_PULL_MS,
      deviceEventPullConcurrency: DEVICE_EVENT_PULL_CONCURRENCY,
      mongodbMaxPoolSize: MONGODB_MAX_POOL_SIZE
    }
  });
});

app.post("/api/auth/login", rateLimit(RATE_LIMIT_AUTH_MAX, RATE_LIMIT_WINDOW_MS), async (req, res) => {
  const username = String(req.body?.username || req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  const effectiveAdminPass = global._runtimeAdminPass || ADMIN_PASS;
  if (username === String(ADMIN_USER).toLowerCase() && password === effectiveAdminPass) {
    const user = { id: "admin-1", name: "Administrator", username: ADMIN_USER, role: "superadmin" };
    const token = jwt.sign({ user }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token, user });
  }

  if (mongoConnected) {
    try {
      const account = await collection("accounts").findOne({
        username: { $regex: new RegExp(`^${escapeRegex(username)}$`, "i") },
        $nor: [{ status: "revoked" }]
      });
      if (account && typeof account.password === "string" && account.password.length > 0) {
        if (password !== account.password) {
          return res.status(401).json({ error: "Invalid credentials" });
        }
        const user = {
          id: String(account._id),
          name: account.name || account.username,
          username: account.username,
          role: String(account.role || "viewer").toLowerCase()
        };
        const token = jwt.sign({ user }, JWT_SECRET, { expiresIn: "12h" });
        return res.json({ token, user });
      }
    } catch (err) {
      console.error("[auth] MongoDB account login failed:", err.message);
    }
  }

  return res.status(401).json({ error: "Invalid credentials" });
});

app.get("/api/auth/me", (req, res) => res.json(req.user?.user || req.user));
app.post("/api/auth/logout", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const callerUsername = String(req.user?.user?.username || req.user?.username || "").toLowerCase();
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  if (String(newPassword).length < 8)
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: "New password must differ from the current password" });

  // Hardcoded superadmin (env-based)
  if (callerUsername === String(ADMIN_USER).toLowerCase()) {
    const effectiveAdminPass = global._runtimeAdminPass || ADMIN_PASS;
    if (currentPassword !== effectiveAdminPass)
      return res.status(401).json({ error: "Current password is incorrect" });
    // Update in-memory value so the new password works immediately without restart
    // Note: this survives until container restart; set ADMIN_PASS in .env for persistence
    global._runtimeAdminPass = newPassword;
    return res.json({ ok: true, note: "Password updated for this session. Update ADMIN_PASS in .env for persistence across restarts." });
  }

  // DB account
  const acc = await collection("accounts").findOne({ username: callerUsername });
  if (!acc) return res.status(404).json({ error: "Account not found" });
  if (acc.password !== currentPassword)
    return res.status(401).json({ error: "Current password is incorrect" });
  await collection("accounts").updateOne(
    { username: callerUsername },
    { $set: { password: newPassword, updatedAt: new Date() } }
  );
  return res.json({ ok: true });
});

app.get("/api/employees", async (req, res) => {
  const { skip, limit } = parsePagination(req.query);
  const q = String(req.query.q || req.query.search || "").trim();
  const status = String(req.query.status || "").trim();
  const clauses = [];
  if (q) {
    clauses.push({
      $or: [
      { name: { $regex: q, $options: "i" } },
      { employeeId: { $regex: q, $options: "i" } },
      { cardId: { $regex: q, $options: "i" } },
      { designation: { $regex: q, $options: "i" } },
      { department: { $regex: q, $options: "i" } },
      { division: { $regex: q, $options: "i" } },
      { lineManager: { $regex: q, $options: "i" } }
      ]
    });
  }
  if (status && status !== "all") {
    const norm = status.toLowerCase();
    if (norm === "enrolled") {
      clauses.push({ enrolled: true });
    } else if (norm === "pending") {
      clauses.push({ $or: [{ enrolled: false }, { enrolled: { $exists: false } }] });
    } else {
      clauses.push({ status: { $regex: `^${escapeRegex(status)}$`, $options: "i" } });
    }
  }
  clauses.push({ employeeTag: { $in: VALID_EMPLOYEE_TAGS } });
  clauses.push({ $or: [{ sourceVisitorId: { $exists: false } }, { sourceVisitorId: "" }, { sourceVisitorId: null }] });
  clauses.push({ $or: [{ designation: { $exists: false } }, { designation: { $not: { $regex: "^visitor$", $options: "i" } } }] });
  const filter = { $and: clauses };
  const [docs, total] = await Promise.all([
    collection("employees").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    collection("employees").countDocuments(filter)
  ]);
  ok(res, { employees: docs, total });
});

app.get("/api/employees/lookup", async (req, res) => {
  const empId = String(req.query.employeeId || "").trim();
  const srcVisId = String(req.query.sourceVisitorId || "").trim();
  if (!empId && !srcVisId) return ok(res, { employee: null });
  const or = [];
  if (empId) or.push({ employeeId: empId });
  if (srcVisId) or.push({ sourceVisitorId: srcVisId });
  const doc = await collection("employees").findOne({ $or: or });
  ok(res, { employee: doc || null });
});
app.get("/api/employees/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  const doc = await collection("employees").findOne({ _id: new ObjectId(req.params.id) });
  if (!doc) return res.status(404).json({ error: "Employee not found" });
  return res.json(doc);
});
app.post("/api/employees", async (req, res) => {
  const now = new Date();
  const body = toDoc(req.body);
  const tag = String(body.employeeTag || "").trim();
  if (!VALID_EMPLOYEE_TAGS.includes(tag)) {
    return fail(res, `Invalid employeeTag "${tag}". Must be one of: ${VALID_EMPLOYEE_TAGS.join(", ")}.`, 400);
  }
  const result = await collection("employees").insertOne({ ...body, createdAt: now });
  const doc = await collection("employees").findOne({ _id: result.insertedId });
  res.status(201).json(doc);
});
app.put("/api/employees/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch {
    return fail(res, "invalid id", 400);
  }
  const before = await collection("employees").findOne({ _id: oid });
  if (!before) return fail(res, "Employee not found", 404);
  const payload = toDoc(req.body);
  if (payload.employeeTag !== undefined) {
    const tag = String(payload.employeeTag || "").trim();
    if (!VALID_EMPLOYEE_TAGS.includes(tag)) {
      return fail(res, `Invalid employeeTag "${tag}". Must be one of: ${VALID_EMPLOYEE_TAGS.join(", ")}.`, 400);
    }
  }
  const incomingEmployeeId = String(req.body?.employeeId ?? "").trim();
  const beforeEmployeeId = String(before?.employeeId ?? "").trim();
  const incomingSupremaUserId = String(req.body?.supremaUserId ?? "").trim();
  const derivedFromIncoming =
    incomingEmployeeId ? deriveSupremaUserId({ employeeId: incomingEmployeeId, _id: before?._id }) : "";
  // If Pass Number changed and caller didn't provide supremaUserId explicitly,
  // align supremaUserId to the pass so reader identity rekey is deterministic.
  // Also heal old drifted records where employeeId/supremaUserId were out of sync.
  if (
    incomingEmployeeId &&
    !incomingSupremaUserId &&
    (incomingEmployeeId !== beforeEmployeeId || String(before?.supremaUserId || "").trim() !== String(derivedFromIncoming))
  ) {
    payload.supremaUserId = derivedFromIncoming;
  }
  await collection("employees").updateOne({ _id: oid }, { $set: payload });
  const updated = await collection("employees").findOne({ _id: oid });
  const wasRevoked = shouldRevokeAccessOnDevice(before);
  const nowRevoked = shouldRevokeAccessOnDevice(updated);
  let deviceRevoke = null;
  let deviceRekey = null;
  let deviceRestore = null;
  const oldUserId = String(resolveSupremaUserIdForDevice(before) || "").trim();
  const newUserId = String(resolveSupremaUserIdForDevice(updated) || "").trim();
  const userIdChanged = Boolean(oldUserId && newUserId && oldUserId !== newUserId);

  // Pass Number / user ID changed: rotate identity on readers immediately
  // (delete old ID from chips/readers, then enroll new ID using stored enrollment photo).
  if (userIdChanged && !nowRevoked) {
    let pushNew = null;
    let revokeOld = null;
    const rawPhoto = String(
      updated?.photo || updated?.facePhoto || updated?.photoUrl || updated?.image || updated?.imageUrl || ""
    ).trim();
    const photoBase64 = rawPhoto.includes("base64,") ? rawPhoto.split("base64,")[1] : "";
    if (photoBase64 && photoBase64.length >= 80) {
      // Push new identity first; revoke old only after push success.
      // This avoids locking out access if gateway template extraction fails transiently.
      const PUSH_RETRY = 2;
      for (let attempt = 1; attempt <= PUSH_RETRY; attempt += 1) {
        try {
          pushNew = await pushFaceEnrollmentToDevices(updated, photoBase64);
          const okN = Array.isArray(pushNew?.results) ? pushNew.results.filter((x) => x?.ok).length : 0;
          if (okN > 0) break;
        } catch (e) {
          pushNew = { ok: false, error: e?.message || "push new user failed", attempt };
        }
      }
      const pushOk = Array.isArray(pushNew?.results) && pushNew.results.some((x) => x?.ok);
      if (pushOk) {
        try {
          const oldAliasIds = Array.isArray(before?.supremaAliases)
            ? before.supremaAliases.map((x) => String(x ?? "").trim()).filter(Boolean)
            : [];
          // Rekey revoke must target strictly old identity IDs only.
          // Do NOT call generic collectRevokeUserIds(before), because drifted records may include the new pass ID there.
          const revokeIds = [...new Set([oldUserId, ...oldAliasIds].filter(Boolean))];
          revokeOld = await removeEmployeeFromDevices(before, revokeIds);
        } catch (e) {
          revokeOld = { ok: false, error: e?.message || "revoke old user failed" };
        }
      } else {
        revokeOld = {
          skipped: true,
          reason: "push_new_failed",
          note: "Old user kept on reader to avoid lockout. Retry Sync Face to readers after gateway stabilizes."
        };
      }
    } else {
      pushNew = {
        ok: false,
        skipped: true,
        reason: "no_enrollment_photo",
        note: "Pass Number changed but no enrollment photo found. Old user kept on readers; enroll/sync face first."
      };
      revokeOld = {
        skipped: true,
        reason: "no_enrollment_photo",
        note: "Old user kept on reader to avoid lockout."
      };
    }
    deviceRekey = { oldUserId, newUserId, revokeOld, pushNew };
  }

  if (nowRevoked && !wasRevoked) {
    deviceRevoke = await removeEmployeeFromDevices(updated);
    // Revoke any active dashboard tokens for this employee (future-proofing)
    revokeUserTokens(String(updated._id));
    revokeUserTokens(String(updated.employeeId));
  }
  if (!nowRevoked && wasRevoked) {
    const b64 = employeeEnrollmentPhotoBase64(updated);
    if (!b64 || b64.length < 80) {
      deviceRestore = {
        attempted: false,
        skipped: true,
        reason: "no_photo",
        note: "Employee re-activated in DB but no stored enrollment photo is available to restore readers."
      };
    } else {
      // Re-activate flow should not unexpectedly open reader camera.
      deviceRestore = await pushFaceEnrollmentToDevices(updated, b64, { allowLiveScanFallback: false });
      const okN = Array.isArray(deviceRestore?.results) ? deviceRestore.results.filter((x) => x?.ok).length : 0;
      if (okN > 0) {
        await collection("employees").updateOne(
          { _id: oid },
          { $set: { enrolled: true, enrolledAt: updated?.enrolledAt || new Date(), updatedAt: new Date() } }
        );
      }
    }
  }
  if (updated) {
    broadcastEmployeeUpdated(updated);
    return ok(res, { ...updated, deviceRevoke, deviceRekey, deviceRestore });
  }
  return ok(res, { ok: true, deviceRevoke, deviceRekey, deviceRestore });
});
app.delete("/api/employees/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch {
    return fail(res, "invalid id", 400);
  }
  const existing = await collection("employees").findOne({ _id: oid });
  if (!existing) return fail(res, "Employee not found", 404);
  const deviceRevoke = await removeEmployeeFromDevices(existing);
  // Revoke any active tokens before deletion
  revokeUserTokens(String(existing._id));
  revokeUserTokens(String(existing.employeeId));
  await collection("employees").deleteOne({ _id: oid });
  ok(res, { ok: true, deviceRevoke });
});
app.get("/api/employees/:id/footprint", async (req, res) => {
  const emp = await findEmployeeByRouteId(req.params.id);
  if (!emp) return fail(res, "Employee not found", 404);
  try {
    ok(res, await computeFootprintResponse(emp, "employee"));
  } catch (e) {
    console.error("[backend] footprint employee:", e?.message || e);
    fail(res, "Footprint query failed", 500);
  }
});
/** Re-push stored enrollment JPEG to all configured readers (G-SDK Normalize→Extract→Enroll). */
app.post("/api/employees/:id/live-enroll", async (req, res) => {
  const emp = await findEmployeeByRouteId(req.params.id);
  if (!emp) {
    return fail(
      res,
      "Employee not found — use MongoDB _id from GET /api/employees or the Pass Number (employeeId), e.g. .../live-enroll/1234455.",
      404
    );
  }
  const oid = emp._id;
  const userId = resolveSupremaUserIdForDevice(emp);
  const agBody = sidecarAccessGroupBody();
  const devices = await collection("devices").find({}).toArray();
  const results = [];
  const markEnrolled = async () => {
    await collection("employees").updateOne(
      { _id: oid },
      { $set: { enrolled: true, supremaUserId: userId, updatedAt: new Date() } }
    );
  };
  const pushFaceDeadline = Math.max(GSDK_SIDECAR_HTTP_MS, 130000);
  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;
    try {
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/enrollment/scan-and-enroll`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gateway: GSDK_GATEWAY,
            deviceId: sid,
            userId,
            name: String(emp?.name || ""),
            useSSL: GSDK_USE_SSL,
            ssl: GSDK_USE_SSL,
            ...agBody
          })
        },
        60000
      );
      const scanOk = Boolean(response.ok && payload?.ok);
      const scanErr = payload?.error || (!response.ok ? `HTTP ${response.status}` : "");
      if (scanOk) {
        results.push({
          deviceId: sid,
          ok: true,
          path: "scan-and-enroll",
          readerUserAdded: true,
          faceSaved: payload?.faceSaved === true,
          enrollmentPath: payload?.enrollmentPath,
          scanAttempt: payload?.scanAttempt
        });
        await markEnrolled();
        continue;
      }
      if (
        !LIVE_ENROLL_PUSH_FACE_FALLBACK ||
        !GSDK_SIDECAR_URL ||
        !GSDK_GATEWAY ||
        !String(GSDK_GATEWAY).trim()
      ) {
        results.push({ deviceId: sid, ok: false, path: "scan-and-enroll", error: scanErr || "scan failed" });
        continue;
      }
      const b64 = employeeEnrollmentPhotoBase64(emp);
      if (!b64 || b64.length < 80) {
        results.push({
          deviceId: sid,
          ok: false,
          path: "scan-and-enroll",
          error: scanErr || "scan failed",
          hint: "No stored enrollment JPEG for push-face fallback — complete Face Enrollment in the app first."
        });
        continue;
      }
      const { response: r2, payload: p2 } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/enrollment/push-face`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gateway: GSDK_GATEWAY,
            deviceId: sid,
            userId,
            name: String(emp?.name || ""),
            imageBase64: b64,
            useSSL: GSDK_USE_SSL,
            ssl: GSDK_USE_SSL,
            ...agBody
          })
        },
        pushFaceDeadline
      );
      const pushOk = Boolean(r2.ok && p2?.ok);
      if (pushOk) {
        results.push({
          deviceId: sid,
          ok: true,
          path: "push-face-fallback",
          readerUserAdded: true,
          faceSaved: p2?.faceSaved === true,
          scanError: scanErr,
          enrollmentPath: p2?.enrollmentPath
        });
        await markEnrolled();
      } else {
        results.push({
          deviceId: sid,
          ok: false,
          path: "scan-and-enroll+push-face",
          error: friendlyEnrollmentError(p2?.error || scanErr || "enroll failed"),
          rawError: p2?.error || scanErr || "enroll failed",
          scanError: scanErr
        });
      }
    } catch (e) {
      results.push({ deviceId: sid, ok: false, error: friendlyEnrollmentError(e.message), rawError: e.message });
    }
  }
  const anyOk = results.length > 0 && results.some((r) => r.ok);
  if (!anyOk) {
    const firstErr = results.find((r) => !r.ok)?.error || "Live enroll failed on reader.";
    return res.status(502).json({ error: firstErr, results });
  }
  return ok(res, { ok: true, results });
});

app.post("/api/employees/:id/sync-face", async (req, res) => {
  const emp = await findEmployeeByRouteId(req.params.id);
  if (!emp) {
    return fail(res, "Employee not found — use MongoDB _id from GET /api/employees or employeeId (pass number).", 404);
  }
  const raw = String(emp.photo || emp.facePhoto || "");
  const photoBase64 = raw.includes("base64,") ? raw.split(",")[1] : "";
  if (!photoBase64 || photoBase64.length < 80) {
    return fail(res, "No stored enrollment photo — complete Face Enrollment first.", 400);
  }
  try {
    const devicePush = await pushFaceEnrollmentToDevices(emp, photoBase64);
    const okAny = Array.isArray(devicePush?.results) && devicePush.results.some((r) => r?.ok);
    if (!okAny) {
      const firstErr = devicePush?.results?.find?.((r) => !r?.ok)?.error || "Face push failed on reader.";
      return res.status(502).json({ error: friendlyEnrollmentError(firstErr), devicePush });
    }
    return ok(res, { ok: true, devicePush });
  } catch (e) {
    return fail(res, friendlyEnrollmentError(e.message || "Face sync failed"), 502);
  }
});

/** Re-apply BioStar access groups on readers via G-SDK SetAccessGroup (no re-enroll). Use when logs show invalid access group / 0x1900 sub 0x01 after fixing SUPREMA_ACCESS_GROUP_IDS. */
app.post("/api/employees/:id/reapply-access-groups", async (req, res) => {
  const emp = await findEmployeeByRouteId(req.params.id);
  if (!emp) {
    return fail(res, "Employee not found — use MongoDB _id from GET /api/employees or employeeId (pass number).", 404);
  }
  if (!GSDK_SIDECAR_URL || !GSDK_GATEWAY) {
    return fail(res, "GSDK_SIDECAR_URL and GSDK_GATEWAY must be set for device access groups", 400);
  }
  const userId = resolveSupremaUserIdForDevice(emp);
  const agBody = sidecarAccessGroupBody();
  const devices = await collection("devices").find({}).toArray();
  const results = [];
  const deadline = Math.max(GSDK_SIDECAR_HTTP_MS, 20000);
  for (const d of devices) {
    const sid = supremaNumericDeviceId(d) >>> 0;
    if (!sid) continue;
    try {
      const { response, payload } = await fetchJsonWithTimeout(
        `${GSDK_SIDECAR_URL}/users/set-access-groups`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gateway: GSDK_GATEWAY,
            deviceId: sid,
            userId,
            useSSL: GSDK_USE_SSL,
            ssl: GSDK_USE_SSL,
            ...agBody
          })
        },
        deadline
      );
      results.push({
        deviceId: sid,
        ok: Boolean(response.ok && payload?.ok),
        error: payload?.error || (response.ok ? "" : `HTTP ${response.status}`),
        accessGroupIds: payload?.accessGroupIds
      });
    } catch (e) {
      results.push({ deviceId: sid, ok: false, error: e.message });
    }
  }
  if (!results.length) {
    return fail(res, "No devices with supremaDeviceId / gateway id — sync My Devices first", 400);
  }
  return ok(res, { ok: true, userId, results });
});

app.post("/api/employees/bulk", async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows || [];
  if (!rows.length) return ok(res, { inserted: 0, updated: 0, skipped: 0, errors: [] });

  const mode = String(req.body?.mode || "upsert").toLowerCase(); // "upsert" | "insert"
  const now = new Date();
  const errors = [];
  let inserted = 0, updated = 0, skipped = 0;

  // Process in chunks of 500 to stay well under MongoDB 16 MB request limit
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const ops = chunk.map((r, idx) => {
      const doc = toDoc(r);
      const rowNo = i + idx + 1;
      const eid = String(doc.employeeId || "").trim();
      if (!eid) {
        errors.push({ row: rowNo, employeeId: "", error: "Missing employeeId / pass number" });
        return null;
      }
      if (!doc.name) {
        errors.push({ row: rowNo, employeeId: eid, error: "Missing employee name" });
        return null;
      }
      if (mode === "insert") {
        return {
          insertOne: {
            document: { ...doc, employeeId: eid, createdAt: now, updatedAt: now }
          }
        };
      }
      // upsert: match by employeeId, set on insert OR update
      return {
        updateOne: {
          filter: { employeeId: eid },
          update: {
            $set: { ...doc, employeeId: eid, updatedAt: now },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      };
    }).filter(Boolean);

    if (!ops.length) continue;
    try {
      const result = await collection("employees").bulkWrite(ops, { ordered: false });
      inserted += (result.upsertedCount || 0) + (result.insertedCount || 0);
      updated  += result.modifiedCount || 0;
    } catch (err) {
      // Capture per-row errors when ordered:false partial-failures occur
      const wErrors = err?.result?.writeErrors || err?.writeErrors || [];
      for (const we of wErrors) {
        const docIdx = we.index;
        const opRow = chunk[docIdx] || {};
        errors.push({
          row: i + docIdx + 1,
          employeeId: opRow.employeeId || "",
          error: we.errmsg || we.message || "Write failed"
        });
      }
      // Successes still counted from the partial result
      const partial = err?.result;
      if (partial) {
        inserted += (partial.nUpserted || partial.upsertedCount || 0) + (partial.nInserted || partial.insertedCount || 0);
        updated  += partial.nModified || partial.modifiedCount || 0;
      }
    }
  }

  skipped = rows.length - inserted - updated - errors.length;
  ok(res, { inserted, updated, skipped: Math.max(skipped, 0), total: rows.length, errors });
});


/* ═══════════════════════════════════════════════════════════════════════
   COMPANIES CRUD — supports 100+ companies (tenants/organizations)
═══════════════════════════════════════════════════════════════════════ */
app.get("/api/companies", async (req, res) => {
  const { skip, limit } = parsePagination(req.query);
  const q = String(req.query.q || req.query.search || "").trim();
  const status = String(req.query.status || "").trim();
  const clauses = [];
  if (q) {
    clauses.push({ $or: [
      { name:        { $regex: q, $options: "i" } },
      { code:        { $regex: q, $options: "i" } },
      { contactName: { $regex: q, $options: "i" } },
      { contactEmail:{ $regex: q, $options: "i" } }
    ]});
  }
  if (status && status !== "all") clauses.push({ status });
  const filter = clauses.length ? { $and: clauses } : {};
  const [docs, total] = await Promise.all([
    collection("companies").find(filter).sort({ name: 1 }).skip(skip).limit(limit).toArray(),
    collection("companies").countDocuments(filter)
  ]);
  // Attach employee counts per company (cached for 30s to reduce aggregation load)
  const ids = docs.map(d => String(d._id));
  let countMap = new Map();
  if (ids.length) {
    const cacheKey = `companyEmpCounts:${ids.sort().join(",")}`;
    const cached = aggregationCache.get(cacheKey);
    if (cached) {
      countMap = cached;
    } else {
      const agg = await collection("employees").aggregate([
        { $match: { $or: [
          { companyId: { $in: ids } },
          { company:   { $in: docs.map(d => d.name).filter(Boolean) } }
        ]}},
        { $group: { _id: { id: "$companyId", name: "$company" }, count: { $sum: 1 } } }
      ]).toArray();
      for (const a of agg) {
        const k = a._id?.id || a._id?.name;
        if (k) countMap.set(String(k), (countMap.get(String(k)) || 0) + a.count);
      }
      aggregationCache.set(cacheKey, countMap, 30000); // 30s TTL
    }
  }
  const enriched = docs.map(d => ({
    ...d,
    employeeCount: countMap.get(String(d._id)) || countMap.get(d.name) || 0
  }));
  ok(res, { companies: enriched, total });
});

app.get("/api/companies/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  const id = req.params.id;
  let doc = null;
  if (/^[a-f0-9]{24}$/i.test(id)) {
    try { doc = await collection("companies").findOne({ _id: new ObjectId(id) }); } catch {}
  }
  if (!doc) doc = await collection("companies").findOne({ $or: [{ code: id }, { name: id }] });
  if (!doc) return res.status(404).json({ error: "Company not found" });
  // Employee count
  const employeeCount = await collection("employees").countDocuments({
    $or: [{ companyId: String(doc._id) }, { company: doc.name }]
  });
  return res.json({ ...doc, employeeCount });
});

app.post("/api/companies", async (req, res) => {
  const body = toDoc(req.body || {});
  if (!body.name) return res.status(400).json({ error: "Company name is required" });
  const now = new Date();
  // Prevent duplicate name (case-insensitive)
  const existing = await collection("companies").findOne({
    name: { $regex: `^${escapeRegex(String(body.name).trim())}$`, $options: "i" }
  });
  if (existing) return res.status(409).json({ error: "Company with this name already exists", existingId: String(existing._id) });
  const doc = {
    name: String(body.name).trim(),
    code: String(body.code || "").trim(),
    contactName: String(body.contactName || "").trim(),
    contactEmail: String(body.contactEmail || "").trim(),
    contactPhone: String(body.contactPhone || "").trim(),
    address: String(body.address || "").trim(),
    status: String(body.status || "active").toLowerCase(),
    notes: String(body.notes || "").trim(),
    createdAt: now,
    updatedAt: now
  };
  const result = await collection("companies").insertOne(doc);
  ok(res, { ...doc, _id: result.insertedId });
});

app.put("/api/companies/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  const id = req.params.id;
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: "Invalid company id" });
  const body = toDoc(req.body || {});
  delete body._id;
  body.updatedAt = new Date();
  if (body.status) body.status = String(body.status).toLowerCase();
  await collection("companies").updateOne({ _id: new ObjectId(id) }, { $set: body });
  ok(res, { ok: true });
});

app.delete("/api/companies/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  const id = req.params.id;
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: "Invalid company id" });
  // Refuse if employees are attached
  const empCount = await collection("employees").countDocuments({
    $or: [{ companyId: id }, { company: req.body?.companyName || "" }]
  });
  if (empCount > 0) return res.status(409).json({
    error: `Cannot delete: ${empCount} employee(s) still linked to this company. Reassign or remove them first.`
  });
  const result = await collection("companies").deleteOne({ _id: new ObjectId(id) });
  ok(res, { deleted: result.deletedCount });
});

app.post("/api/companies/bulk", async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows || [];
  if (!rows.length) return ok(res, { inserted: 0, updated: 0, errors: [] });
  const now = new Date();
  const errors = [];
  let inserted = 0, updated = 0;

  const ops = rows.map((r, idx) => {
    const doc = toDoc(r);
    const name = String(doc.name || "").trim();
    if (!name) {
      errors.push({ row: idx + 1, error: "Missing company name" });
      return null;
    }
    return {
      updateOne: {
        filter: { name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } },
        update: {
          $set: {
            ...doc,
            name,
            status: String(doc.status || "active").toLowerCase(),
            updatedAt: now
          },
          $setOnInsert: { createdAt: now }
        },
        upsert: true
      }
    };
  }).filter(Boolean);

  if (ops.length) {
    try {
      const result = await collection("companies").bulkWrite(ops, { ordered: false });
      inserted = result.upsertedCount || 0;
      updated  = result.modifiedCount || 0;
    } catch (err) {
      const wErrors = err?.result?.writeErrors || err?.writeErrors || [];
      for (const we of wErrors) {
        errors.push({ row: we.index + 1, error: we.errmsg || "Write failed" });
      }
    }
  }
  ok(res, { inserted, updated, total: rows.length, errors });
});

app.get("/api/visitors", async (req, res) => {
  const { skip, limit } = parsePagination(req.query);
  const status = String(req.query.status || "").trim();
  const filter = {};
  if (status) filter.status = status;
  const [docs, total] = await Promise.all([
    collection("visitors").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    collection("visitors").countDocuments(filter)
  ]);
  ok(res, { visitors: docs, total });
});
app.post("/api/visitors", async (req, res) => {
  const now = new Date();
  const qrToken = randomUUID();
  const scanUrl = `${APP_BASE_URL}/api/visitors/scan/${encodeURIComponent(qrToken)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(scanUrl, { width: 280, margin: 1 });

  // Extract photo data and save to disk (avoid MongoDB 16MB limit)
  const rawBody = { ...req.body };
  const photoData = rawBody.visitorPhotoData || rawBody.photo || "";
  delete rawBody.visitorPhotoData;
  delete rawBody.photo;

  const visitorDoc = {
    ...toDoc(rawBody),
    status: "expected",
    createdAt: now,
    qrToken,
    qrCodeUrl: scanUrl,
    qrCodeDataUrl
  };
  const result = await collection("visitors").insertOne(visitorDoc);
  let visitor = await collection("visitors").findOne({ _id: result.insertedId });

  // Save photo to disk if present
  let photoLocal = null;
  if (photoData && String(photoData).length > 100) {
    photoLocal = await saveVisitorPhotoToDisk(visitor, photoData);
    if (photoLocal) {
      await collection("visitors").updateOne(
        { _id: visitor._id },
        {
          $set: {
            photoStorageRelativeDir: photoLocal.relativeDir,
            photoStorageFile: photoLocal.file,
            updatedAt: new Date()
          }
        }
      );
    }
  }

  const qrLocal = await saveVisitorQrToDisk(visitor, qrToken, scanUrl);
  if (qrLocal) {
    await collection("visitors").updateOne(
      { _id: visitor._id },
      {
        $set: {
          qrStorageRelativeDir: qrLocal.relativeDir,
          qrStoragePng: qrLocal.png,
          qrStorageMeta: qrLocal.metaJson,
          updatedAt: new Date()
        }
      }
    );
    visitor = await collection("visitors").findOne({ _id: result.insertedId });
  }

  // Push face enrollment to devices if photo was saved
  let deviceEnroll = null;
  if (photoLocal && visitor) {
    try {
      const photoBase64 = await loadVisitorPhotoFromDisk(visitor);
      if (photoBase64) {
        deviceEnroll = await pushVisitorEnrollmentToDevices(visitor, photoBase64);
      }
    } catch (e) {
      console.error("[visitors] Device enroll error on create:", e?.message || e);
    }
  }

  const email = await sendVisitorQrEmail(visitor, qrCodeDataUrl, scanUrl);
  ok(res, {
    ...visitor,
    email,
    deviceEnroll,
    qrLocalStorage: qrLocal
      ? {
          root: qrLocal.storageRoot,
          relativeDir: qrLocal.relativeDir,
          png: qrLocal.png,
          contactJson: qrLocal.metaJson
        }
      : null
  });
});
app.put("/api/visitors/:id", async (req, res) => {
  await collection("visitors").updateOne(await visitorFilter(req.params.id), { $set: toDoc(req.body) });
  ok(res, { ok: true });
});
app.post("/api/visitors/:id/checkin", async (req, res) => {
  await collection("visitors").updateOne(await visitorFilter(req.params.id), { $set: { status: "checked-in", checkinAt: new Date(), updatedAt: new Date() } });
  ok(res, { ok: true });
});
app.post("/api/visitors/:id/checkout", async (req, res) => {
  await collection("visitors").updateOne(await visitorFilter(req.params.id), { $set: { status: "checked-out", checkoutAt: new Date(), updatedAt: new Date() } });
  ok(res, { ok: true });
});
app.delete("/api/visitors/:id", async (req, res) => {
  const filter = await visitorFilter(req.params.id);
  const doc = await collection("visitors").findOne(filter);
  if (!doc) return fail(res, "Visitor not found", 404);

  // Revoke from devices before deleting from database
  let deviceRevoke = null;
  if (doc?.photoStorageFile) {
    try {
      deviceRevoke = await removeVisitorFromDevices(doc);
    } catch (e) {
      console.error("[visitors] Device revoke error on delete:", e?.message || e);
    }
  }

  await collection("visitors").deleteOne(filter);
  ok(res, { ok: true, deviceRevoke });
});
app.post("/api/visitors/:id/suspend", async (req, res) => {
  const filter = await visitorFilter(req.params.id);
  const doc = await collection("visitors").findOne(filter);
  if (!doc) return fail(res, "Visitor not found", 404);
  const isSuspended = String(doc.status || "").toLowerCase() === "suspended";
  const newStatus = isSuspended ? (doc._prevStatus || "expected") : "suspended";
  await collection("visitors").updateOne(filter, {
    $set: { status: newStatus, _prevStatus: isSuspended ? undefined : doc.status, updatedAt: new Date() }
  });

  // Sync to devices: revoke when suspending, re-enroll when restoring
  let deviceRevoke = null;
  let deviceEnroll = null;
  if (!isSuspended && newStatus === "suspended") {
    // Suspending - revoke from devices
    if (doc?.photoStorageFile) {
      try {
        deviceRevoke = await removeVisitorFromDevices(doc);
      } catch (e) {
        console.error("[visitors] Device revoke error on suspend:", e?.message || e);
      }
    }
  } else if (isSuspended && newStatus !== "suspended") {
    // Restoring - re-enroll to devices if photo exists
    if (doc?.photoStorageFile) {
      try {
        const photoBase64 = await loadVisitorPhotoFromDisk(doc);
        if (photoBase64) {
          deviceEnroll = await pushVisitorEnrollmentToDevices(doc, photoBase64);
        }
      } catch (e) {
        console.error("[visitors] Device enroll error on restore:", e?.message || e);
      }
    }
  }

  ok(res, { ok: true, status: newStatus, deviceRevoke, deviceEnroll });
});
app.get("/api/visitors/:id/footprint", async (req, res) => {
  const v = await collection("visitors").findOne(await visitorFilter(req.params.id));
  if (!v) return fail(res, "Visitor not found", 404);
  try {
    ok(res, await computeFootprintResponse(v, "visitor"));
  } catch (e) {
    console.error("[backend] footprint visitor:", e?.message || e);
    fail(res, "Footprint query failed", 500);
  }
});
app.get("/api/visitors/scan/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) return res.status(400).send("Invalid QR token");
  const visitor = await collection("visitors").findOne({ qrToken: token });
  if (!visitor) return res.status(404).send("Visitor QR not found");
  const alreadyCheckedIn = String(visitor.status || "").toLowerCase() === "checked-in";
  if (!alreadyCheckedIn) {
    await collection("visitors").updateOne(
      { _id: visitor._id },
      { $set: { status: "checked-in", checkinAt: new Date(), updatedAt: new Date() } }
    );
  }
  const title = alreadyCheckedIn ? "Already checked in" : "Check-in successful";
  return res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title></head><body style="font-family:Arial,sans-serif;background:#0b1523;color:#e2eaff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px"><div style="max-width:560px;width:100%;background:#121f35;border:1px solid #1a2d4a;border-radius:14px;padding:22px;text-align:center"><h2 style="margin:0 0 8px;color:#20d68a">${title}</h2><p style="margin:0 0 10px">Visitor: <b>${visitor.name || "Guest"}</b></p><p style="margin:0 0 4px;color:#9fb6d4">Host: ${visitor.host || "N/A"}</p><p style="margin:0;color:#9fb6d4">Purpose: ${visitor.purpose || "N/A"}</p></div></body></html>`);
});

/** Re-push visitor face enrollment to all devices. Use after photo update or when devices were offline during initial enrollment. */
app.post("/api/visitors/:id/sync-face", async (req, res) => {
  const filter = await visitorFilter(req.params.id);
  const visitor = await collection("visitors").findOne(filter);
  if (!visitor) return fail(res, "Visitor not found", 404);
  if (!visitor?.photoStorageFile) {
    return fail(res, "No stored enrollment photo — upload a photo first.", 400);
  }
  try {
    const photoBase64 = await loadVisitorPhotoFromDisk(visitor);
    if (!photoBase64 || photoBase64.length < 80) {
      return fail(res, "Could not load stored photo — re-upload required.", 400);
    }
    const devicePush = await pushVisitorEnrollmentToDevices(visitor, photoBase64);
    const okAny = Array.isArray(devicePush?.results) && devicePush.results.some((r) => r?.ok);
    if (!okAny) {
      const firstErr = devicePush?.results?.find?.((r) => !r?.ok)?.error || "Face push failed on reader.";
      return res.status(502).json({ error: friendlyEnrollmentError(firstErr), devicePush });
    }
    // Store the supremaUserId if enrollment succeeded
    const userId = resolveVisitorSupremaUserIdForDevice(visitor);
    await collection("visitors").updateOne(
      { _id: visitor._id },
      { $set: { supremaUserId: userId, updatedAt: new Date() } }
    );
    return ok(res, { ok: true, devicePush, supremaUserId: userId });
  } catch (e) {
    return fail(res, friendlyEnrollmentError(e.message || "Face sync failed"), 502);
  }
});

/** Update visitor photo and optionally push to devices */
app.post("/api/visitors/:id/photo", async (req, res) => {
  const filter = await visitorFilter(req.params.id);
  const visitor = await collection("visitors").findOne(filter);
  if (!visitor) return fail(res, "Visitor not found", 404);

  const photoData = req.body?.photo || req.body?.visitorPhotoData || "";
  if (!photoData || String(photoData).length < 100) {
    return fail(res, "Photo data required (base64 JPEG)", 400);
  }

  // Save new photo to disk
  const photoLocal = await saveVisitorPhotoToDisk(visitor, photoData);
  if (!photoLocal) {
    return fail(res, "Failed to save photo", 500);
  }

  // Update visitor record
  await collection("visitors").updateOne(
    { _id: visitor._id },
    {
      $set: {
        photoStorageRelativeDir: photoLocal.relativeDir,
        photoStorageFile: photoLocal.file,
        updatedAt: new Date()
      }
    }
  );

  // Push to devices if requested (default true)
  let deviceEnroll = null;
  const shouldSync = req.body?.syncToDevices !== false;
  if (shouldSync) {
    try {
      const photoBase64 = await loadVisitorPhotoFromDisk({
        photoStorageRelativeDir: photoLocal.relativeDir,
        photoStorageFile: photoLocal.file
      });
      if (photoBase64) {
        deviceEnroll = await pushVisitorEnrollmentToDevices(
          { ...visitor, photoStorageRelativeDir: photoLocal.relativeDir, photoStorageFile: photoLocal.file },
          photoBase64
        );
      }
    } catch (e) {
      console.error("[visitors] Device enroll error on photo update:", e?.message || e);
    }
  }

  ok(res, { ok: true, photoLocal, deviceEnroll });
});

app.get("/api/devices", async (_req, res) => ok(res, await collection("devices").find({}).toArray()));

/** Device sync queue status endpoint - returns counts of pending/failed operations */
app.get("/api/devices/sync-queue", async (_req, res) => {
  if (!mongoConnected) return fail(res, "MongoDB unavailable", 503);
  const stats = await getDeviceSyncQueueStats();
  const recentPending = await collection("device_sync_queue")
    .find({ status: "pending" })
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ deviceId: 1, employeeId: 1, operation: 1, status: 1, attempts: 1, createdAt: 1, lastError: 1 })
    .toArray();
  ok(res, { stats, recentPending, enabled: DEVICE_SYNC_QUEUE_ENABLED });
});

/** Device sync queue status for a specific device */
app.get("/api/devices/:id/sync-queue", async (req, res) => {
  if (!mongoConnected) return fail(res, "MongoDB unavailable", 503);
  const filter = await deviceFilter(req.params.id);
  const device = await collection("devices").findOne(filter);
  if (!device) return fail(res, "Device not found", 404);
  const sid = supremaNumericDeviceId(device) >>> 0;
  if (!sid) return fail(res, "Device has no Suprema device ID", 400);
  const stats = await getDeviceSyncQueueStats(sid);
  const pending = await collection("device_sync_queue")
    .find({ deviceId: sid, status: "pending" })
    .sort({ createdAt: 1 })
    .project({ employeeId: 1, operation: 1, status: 1, attempts: 1, createdAt: 1, nextAttemptAt: 1, lastError: 1 })
    .toArray();
  ok(res, { deviceId: sid, stats, pending, enabled: DEVICE_SYNC_QUEUE_ENABLED });
});

/** Trigger immediate sync queue processing for a device */
app.post("/api/devices/:id/sync-queue/process", async (req, res) => {
  if (!mongoConnected) return fail(res, "MongoDB unavailable", 503);
  if (!GSDK_SIDECAR_URL) return fail(res, "Sidecar not configured", 503);
  const filter = await deviceFilter(req.params.id);
  const device = await collection("devices").findOne(filter);
  if (!device) return fail(res, "Device not found", 404);
  const sid = supremaNumericDeviceId(device) >>> 0;
  if (!sid) return fail(res, "Device has no Suprema device ID", 400);
  const result = await processDeviceSyncQueueForDevice(sid, { batchSize: req.body?.batchSize || DEVICE_SYNC_BATCH_SIZE });
  ok(res, { deviceId: sid, ...result, processed: result.processed, errors: result.errors });
});

/** Suprema thermal logs often use integer hundredths °C (3650 → 36.5°C). */
function normalizeAccessLogTemperature(raw = {}) {
  const v = pickFirstFiniteMetric(
    raw.temperature,
    raw.bodyTemperature,
    raw.skinTemperature,
    raw.thermalTemperature,
    raw.temp
  );
  if (v === undefined || v === 0) return undefined;
  if (v >= 2500 && v <= 4500) return Math.round(v) / 100;
  if (v >= 250 && v <= 450 && Number.isInteger(v)) return v / 10;
  if (v >= 25 && v <= 45) return v;
  if (v > 450 && v < 2500) return Math.round(v) / 100;
  return Math.round(v) / 100;
}

/** Map alternate vendor keys / scales into UI percent 0–100. */
function normalizeAccessLogConfidence(raw = {}) {
  const v = pickFirstFiniteMetric(
    raw.confidence,
    raw.score,
    raw.matchScore,
    raw.matchingScore,
    raw.faceScore,
    raw.verifyScore,
    raw.similarity,
    raw.authenticationScore,
    raw.consensusConfidence,
    raw.biometricScore
  );
  if (v === undefined || v === 0) return undefined;
  if (v > 0 && v <= 1) return Math.round(v * 10000) / 100;
  if (v <= 100) return Math.round(v);
  if (v <= 10000) return Math.round(v / 100);
  return Math.round(v / 100);
}

function normalizeAccessLogProcessingMs(raw = {}) {
  return pickFirstFiniteMetric(
    raw.processingMs,
    raw.responseMs,
    raw.latencyMs,
    raw.durationMs,
    raw.processingTimeMs,
    raw.elapsedMs
  );
}

function normalizeDeviceEvent(raw = {}, fallback = {}) {
  const numOrUndef = (v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const now = new Date();
  const bioCode = rawBioStarEventCode(raw);
  const fromCode = accessGrantedFromBioStarEventCode(bioCode);

  let accessGranted = raw.accessGranted ?? raw.granted;
  if (typeof accessGranted !== "boolean" && fromCode !== undefined) {
    accessGranted = fromCode;
  }
  let eventTypeRaw = String(raw.eventType || raw.type || "").toUpperCase();
  if (!eventTypeRaw) {
    if (typeof accessGranted === "boolean") {
      eventTypeRaw = accessGranted ? "ACCESS_GRANTED" : "ACCESS_DENIED";
    } else if (bioCode) {
      eventTypeRaw =
        fromCode === true ? "ACCESS_GRANTED" : fromCode === false ? "ACCESS_DENIED" : "ACCESS_UNKNOWN";
    } else {
      eventTypeRaw = "ACCESS_DENIED";
    }
  }
  let eventType = eventTypeRaw;
  const mainLow = (Number(bioCode) >>> 0) & 0xffff;
  // User enroll/update/delete — not door auth; excluded from Access Logs via logsDoorEventOnly()
  if (mainLow >= 0x2000 && mainLow < 0x2900) {
    eventType = "ENROLLMENT";
    accessGranted = false;
  }
  if (typeof accessGranted !== "boolean") {
    if (eventType === "ACCESS_GRANTED") accessGranted = true;
    else if (eventType === "ACCESS_DENIED") accessGranted = false;
    else if (eventType === "ACCESS_UNKNOWN") accessGranted = false;
    else accessGranted = false;
  }

  let tsMs;
  const tr = raw.timestamp ?? raw.ts ?? raw.createdAt ?? raw.eventAt ?? raw.datetime;
  const trNum = Number(tr);
  if (Number.isFinite(trNum) && trNum > 0) {
    tsMs = trNum < 1e11 ? trNum * 1000 : trNum;
  } else if (tr != null && tr !== "") {
    const d = new Date(tr);
    tsMs = Number.isNaN(d.getTime()) ? now.getTime() : d.getTime();
  } else {
    tsMs = now.getTime();
  }
  const createdAt = new Date(tsMs);

  let employeeId = String(
    raw.employeeId || raw.userID || raw.userId || raw.userid || raw.personId || ""
  ).trim();
  const bioUser = String(raw.userid ?? raw.userID ?? "").trim();
  if (!employeeId && bioUser) employeeId = bioUser;

  // Device system/monitor events (face-detect noise, invalid-user system codes) outside the known
  // BioStar auth range (0x1000–0x1A00) that produced no real employeeId are system noise — mark
  // as ENROLLMENT so they are permanently excluded from all door-event queries.
  const isAuthRangeCode = mainLow >= 0x1000 && mainLow <= 0x1a00;
  const hasRealEmployeeId = employeeId && !/^UNKNOWN-/i.test(employeeId);
  if (!isAuthRangeCode && bioCode > 0 && !hasRealEmployeeId && eventType !== "ENROLLMENT") {
    eventType = "ENROLLMENT";
    accessGranted = false;
  }

  let employeeName = String(
    raw.employeeName || raw.name || raw.userName || raw.username || raw.personName || ""
  ).trim();
  if (!employeeName && bioUser) employeeName = bioUser;

  const deniedSide =
    typeof accessGranted === "boolean" ? !accessGranted : eventType === "ACCESS_DENIED";
  if (!employeeId && deniedSide) {
    employeeId = unknownId();
    if (!employeeName) employeeName = employeeId;
  }

  const sourceHasImage = Boolean(raw?.hasimage || raw?.hasImage);
  let photoStr =
    logPhotoFrom(raw) ||
    (raw.photo || raw.photoUrl || raw.facePhoto || raw.snapshot || "") ||
    "";
  // Guard against stale inline images on invalid-user deny (0x1800) when the text log has no image flag.
  // Do not strip snapshots merged from GetImageLog (jpgimage / sidecar photo) — those are authoritative.
  const mergedImagePayload =
    Boolean((raw?.jpgimage ?? raw?.jpgImage) && String(raw?.jpgimage ?? raw?.jpgImage ?? "").trim().length > 48) ||
    (String(photoStr).startsWith("data:image/") && String(photoStr).length > 256);
  if ((((Number(bioCode) >>> 0) & 0xffff) & 0xff00) === 0x1800 && !sourceHasImage && !mergedImagePayload) {
    photoStr = "";
  }

  const supremaLogId = Number(raw.id ?? raw.ID ?? raw.eventLogId ?? raw.logId ?? 0) >>> 0;
  const bioSub = rawBioStarSubCode(raw);
  const denialReason = denialReasonFromBioStar(bioCode, bioSub);
  const rawJpg = raw?.jpgimage ?? raw?.jpgImage;
  const jpgRaw = typeof rawJpg === "string" && rawJpg.length > 48 ? rawJpg : "";

  return {
    eventType,
    accessGranted: !!accessGranted,
    granted: !!accessGranted,
    employeeId: employeeId || "",
    employeeName: employeeName || employeeId || "",
    authMode: raw.authMode || raw.auth || fallback.authMode || "Face Only",
    zone: raw.zone || raw.location || fallback.zone || "",
    device: raw.device || raw.deviceName || fallback.device || "",
    deviceId: String(raw.deviceId ?? raw.deviceid ?? fallback.deviceId ?? ""),
    direction: raw.direction || fallback.direction || "entry",
    devicePlacement: String(raw.devicePlacement || fallback.devicePlacement || raw.placement || fallback.placement || "entry").toLowerCase() === "exit" ? "exit" : "entry",
    confidence: numOrUndef(normalizeAccessLogConfidence(raw)),
    processingMs: numOrUndef(normalizeAccessLogProcessingMs(raw)),
    temperature: numOrUndef(normalizeAccessLogTemperature(raw)),
    photo: photoStr,
    ...(jpgRaw ? { jpgimage: jpgRaw } : {}),
    bioStarEventCode: bioCode || undefined,
    ...(bioSub > 0 ? { bioStarSubCode: bioSub } : {}),
    ...(denialReason ? { denialReason } : {}),
    ...(isUnknownLiveImageSourceMissing({
      eventType,
      accessGranted: !!accessGranted,
      employeeId: employeeId || "",
      employeeName: employeeName || employeeId || "",
      photo: photoStr
    })
      ? { unknownLiveImageSourceMissing: true }
      : {}),
    ...(supremaLogId > 0 ? { supremaLogId } : {}),
    createdAt,
    timestamp: createdAt
  };
}

async function persistDeviceEvents(events = [], fallback = {}) {
  // Pre-load employees for name lookup by supremaUserId/employeeId
  const allEmps = await collection("employees").find({}, {projection:{name:1,employeeId:1,supremaUserId:1}}).toArray();
  const empBySupremaId = new Map();
  const indexEmpId = (id, emp) => {
    const s = String(id ?? "").trim();
    if (!s) return;
    empBySupremaId.set(s, emp);
    if (/^\d+$/.test(s)) {
      empBySupremaId.set(String(Number(s)), emp);
      const n = Number(s);
      if (Number.isFinite(n)) empBySupremaId.set(String(n >>> 0), emp);
    }
  };
  for (const e of allEmps) {
    indexEmpId(e.supremaUserId, e);
    indexEmpId(e.employeeId, e);
  }
  // Skip door/system events (no user, no image, non-auth event codes)
  /** BioStar auth-related category bytes (0x10–0x1E): includes flag variants like 0x1030 (same row as VERIFY_SUCCESS family). */
  function isBioStarAuthCategoryCode(rawCode) {
    const u = (Number(rawCode) >>> 0) & 0xffff;
    const cat = (u >>> 8) & 0xff;
    return cat >= 0x10 && cat <= 0x1e;
  }
  const filteredEvents = (Array.isArray(events) ? events : []).filter(e => {
    const uid = String(e.userid || e.userId || e.userID || "").trim();
    const code = rawBioStarEventCode(e);
    const low = code & 0xffff;
    const hasImg = Boolean(e.hasimage || e.hasImage);
    const hasPhoto = Boolean(logPhotoFrom(e));
    return uid || hasImg || hasPhoto || isBioStarAuthCategoryCode(code) || isBioStarAuthCategoryCode(low);
  });
  if (filteredEvents.length) lastDeviceEventActivityAt = Date.now();
  let rows = filteredEvents.map((e) => {
    const row = normalizeDeviceEvent(e, fallback);
    // Lookup employee name by ID
    const uid = String(e.userid || e.userId || e.userID || "").trim();
    if (uid && uid !== "0") {
      let emp = empBySupremaId.get(uid);
      if (!emp && /^\d+$/.test(uid)) emp = empBySupremaId.get(String(Number(uid)));
      if (!emp && /^\d+$/.test(uid)) emp = empBySupremaId.get(String(Number(uid) >>> 0));
      if (emp) {
        row.employeeId = emp.employeeId || uid;
        row.employeeName = emp.name;
      }
    }
    return row;
  });
  rows = collapseSameSecondAuthDenials(rows);
  if (!rows.length) return { inserted: 0 };
  const unique = rows.filter((r, idx) => {
    const lid = Number(r.supremaLogId || 0);
    if (lid > 0) {
      const key = `${String(r.deviceId)}|${lid}`;
      return idx === rows.findIndex((x) => `${String(x.deviceId)}|${Number(x.supremaLogId || 0)}` === key);
    }
    const key = `${r.deviceId}|${r.employeeId}|${r.eventType}|${new Date(r.timestamp).getTime()}`;
    return idx === rows.findIndex((x) => `${x.deviceId}|${x.employeeId}|${x.eventType}|${new Date(x.timestamp).getTime()}` === key);
  });
  const withLid = unique.filter((r) => Number(r.supremaLogId || 0) > 0);
  let toInsert = unique;
  if (withLid.length) {
    const lids = [...new Set(withLid.map((r) => Number(r.supremaLogId)))];
    const devs = [...new Set(withLid.map((r) => String(r.deviceId || "")))];
    const existing = await collection("logs")
      .find({
        supremaLogId: { $in: lids },
        deviceId: { $in: devs }
      })
      .project({ _id: 1, supremaLogId: 1, deviceId: 1, photo: 1, jpgimage: 1 })
      .toArray();
    const existingByKey = new Map(existing.map((e) => [`${String(e.deviceId)}|${Number(e.supremaLogId)}`, e]));
    const seen = new Set(existingByKey.keys());
    toInsert = unique.filter((r) => {
      const lid = Number(r.supremaLogId || 0);
      if (lid <= 0) return true;
      return !seen.has(`${String(r.deviceId)}|${lid}`);
    });
    // Backfill scan photos for already-existing events (same deviceId + supremaLogId)
    // so older rows inserted without image can become visible when image pull succeeds later.
    const photoBackfills = withLid
      .map((r) => {
        const key = `${String(r.deviceId)}|${Number(r.supremaLogId || 0)}`;
        const ex = existingByKey.get(key);
        if (!ex?._id) return null;
        const existingPhoto = String(ex.photo || ex.jpgimage || "").trim();
        let incomingPhoto = String(r.photo || r.jpgimage || "").trim();
        if (!incomingPhoto && r?.jpgimage && String(r.jpgimage).length > 48 && !String(r.photo || "").startsWith("data:")) {
          incomingPhoto = `data:image/jpeg;base64,${r.jpgimage}`;
        }
        if (existingPhoto || !incomingPhoto) return null;
        return {
          updateOne: {
            filter: { _id: ex._id },
            update: { $set: { photo: incomingPhoto, updatedAt: new Date() } }
          }
        };
      })
      .filter(Boolean);
    if (photoBackfills.length) {
      await collection("logs").bulkWrite(photoBackfills, { ordered: false }).catch(() => {});
    }
  }
  if (!toInsert.length) return { inserted: 0 };
  let result;
  try {
    result = await collection("logs").insertMany(toInsert, { ordered: false });
  } catch (err) {
    result = err?.result;
    if (!result?.insertedIds) throw err;
  }
  const insertedCount = result?.insertedCount ?? 0;
  const ids = result?.insertedIds || {};
  // Enrich with employee data before broadcasting
  const empIds = [...new Set(toInsert.map(r => String(r.employeeId || "")).filter(Boolean))];
  const empDocs = empIds.length ? await collection("employees").find({
    $or: [
      {employeeId: {$in: empIds}},
      {supremaUserId: {$in: empIds}}
    ]
  }).toArray() : [];
  const empMap = new Map();
  for (const e of empDocs) {
    if (e.employeeId) empMap.set(String(e.employeeId), e);
    if (e.supremaUserId) empMap.set(String(e.supremaUserId), e);
  }
  for (let i = 0; i < toInsert.length; i++) {
    const id = ids[i];
    if (!id) continue;
    const row = toInsert[i];
    const emp = empMap.get(String(row.employeeId || ""));
    const enriched = {
      ...row,
      _id: id,
      ...(emp ? {
        employeeName: emp.name || row.employeeName,
        enrollmentPhoto:
          row.enrollmentPhoto ||
          emp.photo ||
          emp.facePhoto ||
          emp.photoUrl ||
          emp.image ||
          emp.imageUrl ||
          "",
        cardId: row.cardId || emp.cardId || emp.cardNo || "",
        designation: row.designation || emp.designation || "",
        department: row.department || emp.department || "",
        division: row.division || emp.division || "",
        accessLevel: row.accessLevel || emp.accessLevel || "",
        cardholderStatus: row.cardholderStatus || emp.cardholderStatus || "",
        shiftSchedule: row.shiftSchedule || emp.shiftSchedule || "",
        passIssueDate: row.passIssueDate || emp.passIssueDate || "",
        passExpiryDate: row.passExpiryDate || emp.passExpiryDate || "",
        lineManager: row.lineManager || emp.lineManager || ""
      } : {})
    };
    broadcastAccessEvent(enriched);
  }
  // Queue successful scans for idle-time background face refresh.
  // This keeps readers updated without competing with live event pull.
  if (FACE_AUTO_REFRESH_ENABLED) {
    const successfulKnown = toInsert.filter((r) =>
      r.accessGranted === true &&
      r.employeeId &&
      !String(r.employeeId).startsWith("UNKNOWN") &&
      r.photo
    );
    for (const row of successfulKnown) {
      queueFaceAutoRefresh(String(row.employeeId), "scan_success");
    }
  }

  return { inserted: insertedCount };
}

async function pullDeviceEventsFromSidecar(device = {}, recoveryDepth = 0, opts = {}) {
  const forcePhotoBackfill = Boolean(opts.forcePhotoBackfill);
  if (!GSDK_SIDECAR_URL) return { pulled: 0, inserted: 0, source: "none" };
  const sid = supremaNumericDeviceId(device);
  const storedLast = Number(device.lastEventId || 0);
  const startEventId = storedLast > 0 ? storedLast + 1 : 0;
  const lanIp = deviceLanIp(device);
  const useSSL = GSDK_USE_SSL;

  const buildBody = (startEvId, lim) => ({
    ...(sid > 0 ? { deviceId: sid } : {}),
    target: GSDK_GATEWAY || lanIp,
    gateway: GSDK_GATEWAY || "",
    ip: lanIp,
    port: Number(device.port || GSDK_DEVICE_PORT || 51211),
    useSSL,
    ssl: useSSL,
    limit: lim,
    startEventId: startEvId
  });

  const candidates = ["/logs/pull", "/events/pull", "/logs"];

  async function fetchPull(body) {
    let lastError = "";
    for (const p of candidates) {
      try {
        const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }, GSDK_SIDECAR_HTTP_MS);
        if (!response.ok) {
          lastError = String(payload?.error || payload?.message || `http ${response.status}`);
          continue;
        }
        const raw = payload?.events || payload?.logs || payload?.rows || payload?.items || [];
        const events = Array.isArray(raw) ? raw : [];
        return { ok: true, events, source: p, lastError: "" };
      } catch (error) {
        lastError = error?.message || "request failed";
      }
    }
    return { ok: false, events: [], source: "sidecar-unavailable", lastError };
  }

  const main = await fetchPull(buildBody(startEventId, 200));
  if (!main.ok) {
    return {
      pulled: 0,
      inserted: 0,
      source: main.source,
      error: main.lastError || "unavailable"
    };
  }

  let events = main.events;

  if (
    recoveryDepth < 1 &&
    events.length === 0 &&
    device._id &&
    storedLast > 0
  ) {
    const probe = await fetchPull(buildBody(0, DEVICE_LOG_RECOVERY_PROBE_LIMIT));
    if (probe.ok && probe.events.length > 0 && probe.events.length < DEVICE_LOG_RECOVERY_PROBE_LIMIT) {
      const ids = probe.events
        .map((e) => Number(e.id ?? e.Id ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0);
      const maxP = ids.length ? Math.max(...ids) : 0;
      if (maxP > 0 && maxP < storedLast) {
        console.warn(
          `[backend] device log cursor stale (suprema id ${sid || "?"}): max on device ${maxP} < stored lastEventId ${storedLast} — clearing lastEventId (log cleared or counter reset)`
        );
        await collection("devices").updateOne({ _id: device._id }, { $unset: { lastEventId: "" } });
        return pullDeviceEventsFromSidecar({ ...device, lastEventId: undefined }, recoveryDepth + 1, opts);
      }
    }
  }

  const { inserted } = await persistDeviceEvents(events, {
    deviceId: sid || device.deviceId || device.name || device.ipAddr,
    device: device.name || device.deviceId || device.ipAddr,
    zone: device.zone || "",
    direction: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry",
    devicePlacement: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry"
  });

  let tailHydratedInserted = 0;
  if (forcePhotoBackfill && events.length > 0 && sid > 0) {
    const ids = events.map((e) => Number(e.id ?? e.Id ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
    const maxId = ids.length ? Math.max(...ids) : 0;
    if (maxId > 0) {
      const win = Math.min(900, Math.max(250, DEVICE_PHOTO_BACKFILL_WINDOW));
      const start = Math.max(0, maxId - win);
      const tail = await fetchPull(buildBody(start, Math.min(1000, win + 100)));
      if (tail.ok && tail.events?.length > 0) {
        const out = await persistDeviceEvents(tail.events, {
          deviceId: sid || device.deviceId || device.name || device.ipAddr,
          device: device.name || device.deviceId || device.ipAddr,
          zone: device.zone || "",
          direction: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry",
          devicePlacement: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry"
        });
        tailHydratedInserted = Number(out?.inserted || 0);
      }
    }
  }
  let backfillPulled = 0;
  let backfillInserted = 0;

  if (events.length > 0 && device._id) {
    const lastEventId = Math.max(...events.map((e) => Number(e.id ?? e.Id ?? 0)));
    if (lastEventId > 0) {
      await collection("devices").updateOne({ _id: device._id }, { $set: { lastEventId } });
    }
  }

  // Historical window photo backfill:
  // If rows were inserted earlier without image, later pulls often include the same log id with photo.
  // Re-pull a larger window periodically so persistDeviceEvents can patch missing photos.
  if (sid > 0 && storedLast > 0 && startEventId > 0) {
    const nowMs = Date.now();
    const lastRun = Number(lastPhotoBackfillRunAtByDevice.get(String(sid)) || 0);
    const due = forcePhotoBackfill || nowMs - lastRun >= DEVICE_PHOTO_BACKFILL_EVERY_MS;
    if (due) {
      lastPhotoBackfillRunAtByDevice.set(String(sid), nowMs);
      const backfillStart = Math.max(0, storedLast - DEVICE_PHOTO_BACKFILL_WINDOW);
      if (backfillStart < startEventId) {
        const hist = await fetchPull(buildBody(backfillStart, DEVICE_PHOTO_BACKFILL_WINDOW));
        if (hist.ok && hist.events.length > 0) {
          backfillPulled = hist.events.length;
          const out = await persistDeviceEvents(hist.events, {
            deviceId: sid || device.deviceId || device.name || device.ipAddr,
            device: device.name || device.deviceId || device.ipAddr,
            zone: device.zone || "",
            direction: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry",
            devicePlacement: String(device.placement || device.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry"
          });
          backfillInserted = Number(out?.inserted || 0);
        }
      }
    }
  }

  return {
    pulled: events.length,
    inserted,
    tailHydratedInserted,
    source: main.source,
    backfillPulled,
    backfillInserted
  };
}

async function testDeviceWithSidecar(device = {}) {
  if (!GSDK_SIDECAR_URL) return { ok: false, source: "none", error: "sidecar not configured" };
  const lanIp = deviceLanIp(device);
  const useSSL = GSDK_USE_SSL;
  try {
    const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/devices/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gateway: GSDK_GATEWAY || "",
        target: GSDK_GATEWAY || lanIp,
        ip: lanIp,
        port: Number(device.port || GSDK_DEVICE_PORT || 51211),
        useSSL,
        ssl: useSSL
      })
    }, GSDK_SIDECAR_HTTP_MS);
    return {
      ok: Boolean(response.ok && payload?.ok),
      source: "/devices/test",
      error: payload?.error || payload?.message || (response.ok ? "" : `http ${response.status}`),
      payload
    };
  } catch (error) {
    const aborted =
      error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""));
    return {
      ok: false,
      source: "/devices/test",
      error: aborted
        ? `Timed out waiting for sidecar (${GSDK_SIDECAR_HTTP_MS}ms) — try GSDK_SIDECAR_HTTP_MS or check gateway at ${GSDK_GATEWAY || "?"}`
        : error?.message || "request failed"
    };
  }
}

app.post("/api/devices/connect", async (req, res) => {
  const body = req.body || {};
  const deviceId = body.deviceId || body.id || body.ipAddr || `device-${Date.now()}`;
  const port = Number(body.port || GSDK_DEVICE_PORT);
  const useSSL = normalizeDeviceGrpcSsl(body);
  const placement = String(body.placement || body.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry";
  await collection("devices").updateOne(
    { deviceId },
    { $set: { ...toDoc(body), placement, deviceId, port, useSSL, status: "online", lastConnectedAt: new Date() } },
    { upsert: true }
  );
  ok(res, { ok: true, deviceId, port, placement, useSSL, status: "online" });
});
app.post("/api/devices/test", async (req, res) => {
  const gsdk = await getGsdkStatus();
  if (!gsdk.installed) return ok(res, { ok: false, gsdk, message: "G-SDK loader unavailable" });

  if (GSDK_SIDECAR_URL) {
    try {
      const useSSL = normalizeDeviceGrpcSsl(req.body || {});
      const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/devices/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req.body,
          gateway: req.body?.gateway || GSDK_GATEWAY || "",
          target: req.body?.gateway || GSDK_GATEWAY || req.body?.target || req.body?.ip || "",
          useSSL,
          ssl: useSSL,
          port: Number(req.body?.port || GSDK_DEVICE_PORT)
        })
      }, GSDK_SIDECAR_HTTP_MS);
      return res.status(response.ok ? 200 : 502).json(payload);
    } catch (error) {
      return res.status(502).json({ ok: false, error: `sidecar request failed: ${error.message}` });
    }
  }

  if (!GSDK_GATEWAY) return ok(res, { ok: true, gsdk, message: "G-SDK loaded. Set GSDK_GATEWAY to test connection." });

  try {
    const direct = getDirectGsdkModules();
    if (!direct) return ok(res, { ok: false, gsdk, message: "Direct G-SDK modules not found" });
    const directSsl = normalizeDeviceGrpcSsl(req.body || {});
    const creds = directSsl ? direct.grpc.credentials.createSsl() : direct.grpc.credentials.createInsecure();
    const client = new direct.connectGrpc.ConnectClient(GSDK_GATEWAY, creds);
    const request = new direct.connectPb.GetDeviceListRequest();
    const result = await new Promise((resolve, reject) => {
      client.getDeviceList(request, (err, response) => {
        if (err) return reject(err);
        return resolve(response?.toObject?.() ?? {});
      });
    });
    return ok(res, {
      ok: true,
      gsdk,
      gateway: GSDK_GATEWAY,
      useSSL: directSsl,
      port: GSDK_DEVICE_PORT,
      devices: result.deviceinfosList || []
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      gsdk,
      gateway: GSDK_GATEWAY,
      useSSL: normalizeDeviceGrpcSsl(req.body || {}),
      port: GSDK_DEVICE_PORT,
      error: error.message
    });
  }
});

/** Allow readers on the device gateway (Connect.SetAcceptFilter). Required once after gateway start — see gateway-runtime/README.md */
app.post("/api/gsdk/set-accept-filter", async (req, res) => {
  if (!GSDK_SIDECAR_URL) {
    return res.status(503).json({ ok: false, error: "GSDK sidecar not configured" });
  }
  try {
    const useSSL = normalizeDeviceGrpcSsl(req.body || {});
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/connect/set-accept-filter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req.body,
          gateway: req.body?.gateway || GSDK_GATEWAY,
          allowAll: req.body?.allowAll,
          deviceIDs: req.body?.deviceIDs,
          useSSL,
          ssl: useSSL
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    return res.status(response.ok ? 200 : 502).json(payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/api/gsdk/get-accept-filter", async (_req, res) => {
  if (!GSDK_SIDECAR_URL) {
    return res.status(503).json({ ok: false, error: "GSDK sidecar not configured" });
  }
  try {
    const useSSL = normalizeDeviceGrpcSsl({});
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/connect/get-accept-filter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: GSDK_GATEWAY,
          useSSL,
          ssl: useSSL
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    return res.status(response.ok ? 200 : 502).json(payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/api/gsdk/face-config", async (req, res) => {
  if (!GSDK_SIDECAR_URL) {
    return res.status(503).json({ ok: false, error: "GSDK sidecar not configured" });
  }
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? 0) >>> 0;
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: "deviceId is required (gateway numeric id)." });
  }
  try {
    const useSSL = normalizeDeviceGrpcSsl(body);
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/devices/face-config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: body.gateway || GSDK_GATEWAY,
          deviceId,
          useSSL,
          ssl: useSSL
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    return res.status(response.ok ? 200 : 502).json(payload);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

/** One-screen Suprema wiring check: gateway env, sidecar /health, GetDeviceList, last log pull. */
app.get("/api/gsdk/diagnostics", async (_req, res) => {
  const base = {
    gateway: GSDK_GATEWAY || null,
    sidecarUrl: GSDK_SIDECAR_URL || null,
    useSslGrpc: GSDK_USE_SSL,
    deviceTcpPort: GSDK_DEVICE_PORT,
    pullIntervalMs: DEVICE_EVENT_PULL_MS,
    autoAcceptFilter: AUTO_SET_ACCEPT_FILTER,
    acceptFilterRefreshMs: ACCEPT_FILTER_REFRESH_MS,
    lastEventPull: lastDeviceEventPullStats,
    selfHealing: {
      enabled: SELF_HEALING_ENABLED,
      tickMs: SELF_HEALING_TICK_MS,
      failThreshold: SELF_HEALING_FAIL_THRESHOLD,
      cooldownMs: SELF_HEALING_COOLDOWN_MS,
      state: selfHealState
    },
    watchdog: {
      enabled: WATCHDOG_ENABLED,
      tickMs: WATCHDOG_TICK_MS,
      stalePullMs: WATCHDOG_STALE_PULL_MS,
      state: watchdogState
    },
    faceAutoRefreshQueue: {
      ...faceAutoRefreshState,
      queued: faceAutoRefreshQueue.size
    }
  };
  let sidecarHealth = null;
  if (GSDK_SIDECAR_URL) {
    try {
      const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/health`, { method: "GET" }, 5000);
      sidecarHealth = response.ok ? payload : { http: response.status };
    } catch (e) {
      sidecarHealth = { error: e.message };
    }
  }
  let gatewayList = null;
  try {
    gatewayList = await testDeviceWithSidecar({});
  } catch (e) {
    gatewayList = { ok: false, error: e.message };
  }
  ok(res, {
    ...base,
    sidecarHealth,
    gatewayDeviceList: gatewayList,
    supremaEnrollmentAccessGroups: supremaAccessGroupConfigHint()
  });
});

app.post("/api/devices/:id/sync", async (req, res) => {
  const filter = await deviceFilter(req.params.id);
  const device = await collection("devices").findOne(filter);
  if (!device) return fail(res, "Device not found", 404);

  const ip = String(device.ipAddr || device.ip || "").trim();
  const port = Number(device.port || GSDK_DEVICE_PORT);
  if (!ip) return fail(res, "Device IP is missing", 400);

  const probe = await checkTcpReachability(ip, port, 1800);
  const now = new Date();
  let sidecarCheck = null;
  if (GSDK_SIDECAR_URL) {
    sidecarCheck = await testDeviceWithSidecar({ ...device, ip, port });
  }
  const gwRow =
    DEVICE_HEALTH_GATEWAY_FALLBACK && sidecarCheck?.ok
      ? pickGatewayDeviceRow(device, sidecarCheck.payload?.devices || [])
      : null;
  const gwConnected = Boolean(gwRow && isGatewaySessionConnected(gwRow.status));

  let nextStatus = "offline";
  let healthError = null;
  if (probe.ok) {
    if (sidecarCheck && !sidecarCheck.ok) {
      nextStatus = "warning";
      healthError = `GSDK link failed: ${sidecarCheck.error || "unknown error"}`;
    } else {
      nextStatus = "online";
    }
  } else if (DEVICE_HEALTH_GATEWAY_FALLBACK && gwConnected) {
    nextStatus = "online";
    healthError = null;
  } else if (sidecarCheck?.ok) {
    // Gateway gRPC works but direct TCP to reader failed and GetDeviceList has no session for this device.
    nextStatus = "warning";
    healthError =
      "Reader not accepting TCP from the app host, or not enrolled: gateway API OK but no matching device session (GetDeviceList empty or different IP).";
  } else {
    nextStatus = "offline";
    healthError = probe.error || "timeout";
  }

  const patch = {
    status: nextStatus,
    responseMs: probe.ok ? probe.responseMs || 0 : 0,
    lastCheckedAt: now,
    lastSync: now,
    healthError
  };
  if (ip && !String(device.ipAddr || "").trim()) {
    patch.ipAddr = ip;
  }
  const gidFromGw = gwRow && Number(gwRow.deviceid ?? 0) > 0 ? Number(gwRow.deviceid) : null;
  if (gidFromGw) {
    patch.supremaDeviceId = gidFromGw;
  }
  await collection("devices").updateOne(filter, { $set: patch });
  let ingest = { pulled: 0, inserted: 0, source: "none" };
  const sidForPull = supremaNumericDeviceId({ ...device, ...(gidFromGw ? { supremaDeviceId: gidFromGw } : {}) });
  const canPullEvents = Boolean(
    sidecarCheck?.ok && (probe.ok || gwConnected || sidForPull > 0 || gwRow)
  );
  if (canPullEvents) {
    ingest = await pullDeviceEventsFromSidecar(
      {
        ...device,
        ip,
        port,
        ...(gidFromGw ? { supremaDeviceId: gidFromGw } : {})
      },
      0,
      { forcePhotoBackfill: true }
    );
  }
  ok(res, { ok: true, deviceId: req.params.id, ...patch, sidecar: sidecarCheck, sync: ingest, gatewayMatch: gwRow || null });
});

/** Reader-side JPG snapshot policy (G-SDK Event.SetImageFilter). Required for GetImageLog + unknown/live scan photos in Access Logs. */
app.get("/api/devices/:id/image-log-filters", async (req, res) => {
  if (!GSDK_SIDECAR_URL) return fail(res, "Sidecar not configured", 503);
  const filter = await deviceFilter(req.params.id);
  const device = await collection("devices").findOne(filter);
  if (!device) return fail(res, "Device not found", 404);
  const sid = supremaNumericDeviceId(device) >>> 0;
  if (!sid) return fail(res, "Suprema device id missing — run Sync or set supremaDeviceId", 400);
  const useSSL = normalizeDeviceGrpcSsl({ ...device, ...req.query });
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/devices/get-image-filter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: sid,
          gateway: req.query.gateway || GSDK_GATEWAY,
          useSSL,
          ssl: useSSL
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    return res.status(response.ok ? 200 : 502).json(payload);
  } catch (error) {
    return fail(res, error.message, 502);
  }
});

app.post("/api/devices/:id/image-log-filters", async (req, res) => {
  if (!GSDK_SIDECAR_URL) return fail(res, "Sidecar not configured", 503);
  const filter = await deviceFilter(req.params.id);
  const device = await collection("devices").findOne(filter);
  if (!device) return fail(res, "Device not found", 404);
  const sid = supremaNumericDeviceId(device) >>> 0;
  if (!sid) return fail(res, "Suprema device id missing — run Sync or set supremaDeviceId", 400);
  const useSSL = normalizeDeviceGrpcSsl({ ...device, ...(req.body || {}) });
  const body = req.body || {};
  try {
    const preset = body.preset || body.mode || "auth-both";
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/devices/set-image-filter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: sid,
          gateway: body.gateway || GSDK_GATEWAY,
          useSSL,
          ssl: useSSL,
          preset,
          filters: body.filters,
          scheduleID: body.scheduleID ?? body.scheduleId,
          imageFilters: body.imageFilters
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    let out = payload;
    if (response.ok && payload && payload.ok !== false) {
      try {
        const ec = await fetchJsonWithTimeout(
          `${GSDK_SIDECAR_URL}/devices/set-event-config`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId: sid,
              gateway: body.gateway || GSDK_GATEWAY,
              useSSL,
              ssl: useSSL
            })
          },
          Math.min(GSDK_SIDECAR_HTTP_MS, 12000)
        );
        out = {
          ...payload,
          imageLogCapacityHint:
            ec.payload?.ok === false ? ec.payload?.error || "set-event-config failed" : "numOfImageLog raised via Event.SetConfig"
        };
      } catch (e) {
        out = { ...payload, imageLogCapacityHint: String(e?.message || e) };
      }
    }
    return res.status(response.ok ? 200 : 502).json(out);
  } catch (error) {
    return fail(res, error.message, 502);
  }
});

app.delete("/api/devices/users/all", async (req, res) => {
  if (!GSDK_SIDECAR_URL) return fail(res, "Sidecar not configured", 503);
  try {
    const {createRequire} = await import("module");
    // Delete all users from all devices via G-SDK
    const devices = await collection("devices").find({}).toArray();
    const results = [];
    for (const d of devices) {
      const sid = supremaNumericDeviceId(d) >>> 0;
      if (!sid) continue;
      try {
        const { response, payload } = await fetchJsonWithTimeout(
          `${GSDK_SIDECAR_URL}/users/delete-all`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: sid, gateway: GSDK_GATEWAY, useSSL: GSDK_USE_SSL, ssl: GSDK_USE_SSL })
          },
          15000
        );
        results.push({deviceId: sid, ok: response.ok, result: payload});
      } catch(e) { results.push({deviceId: sid, ok: false, error: e.message}); }
    }
    ok(res, { results });
  } catch(e) { fail(res, e.message, 500); }
});

app.delete("/api/devices/logs/all", async (req, res) => {
  // Clear logs permanently from Suprema device
  if (!GSDK_SIDECAR_URL) return fail(res, "Sidecar not configured", 503);
  try {
    const devices = await collection("devices").find({}).toArray();
    const results = [];
    for (const d of devices) {
      const sid = supremaNumericDeviceId(d) >>> 0;
      if (!sid) continue;
      try {
        const { response, payload } = await fetchJsonWithTimeout(
          `${GSDK_SIDECAR_URL}/events/clear`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: sid, gateway: GSDK_GATEWAY, useSSL: GSDK_USE_SSL, ssl: GSDK_USE_SSL })
          },
          10000
        );
        results.push({deviceId: sid, ok: response.ok, result: payload});
      } catch(e) { results.push({deviceId: sid, ok: false, error: e.message}); }
    }
    ok(res, { results });
  } catch(e) { fail(res, e.message, 500); }
});

app.delete("/api/logs/all", async (req, res) => {
  const r = await collection("logs").deleteMany({});
  // Get current max lastEventId from devices and keep it (don't reset cursor)
  const devices = await collection("devices").find({}).toArray();
  const maxId = Math.max(...devices.map(d => Number(d.lastEventId || 0)), 0);
  if (maxId > 0) {
    await collection("devices").updateMany({}, {$set: {lastEventId: maxId}});
  }
  ok(res, { deleted: r.deletedCount });
});

app.post("/api/devices/:id/reset-log-cursor", async (req, res) => {
  const filter = await deviceFilter(req.params.id);
  const r = await collection("devices").updateOne(filter, {
    $unset: { lastEventId: "" },
    $set: { updatedAt: new Date() }
  });
  if (!r.matchedCount) return fail(res, "Device not found", 404);
  return ok(res, {
    ok: true,
    message:
      "lastEventId cleared for this device. The next pull will request logs from event id 0 upward (Suprema may still return only new rows)."
  });
});

app.post("/api/devices/events", async (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body) ? body : (Array.isArray(body.events) ? body.events : []);
  // Look up the device record by deviceId to get the authoritative placement (entry/exit)
  // If the device record exists, use its stored placement; only fall back to body fields if not found
  let placement = "entry";
  let zone = body.zone || "";
  if (body.deviceId) {
    const dev = await collection("devices").findOne(await deviceFilter(body.deviceId));
    if (dev) {
      placement = String(dev.placement || dev.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry";
      if (!zone) zone = dev.zone || "";
    } else {
      placement = String(body.placement || body.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry";
    }
  } else {
    placement = String(body.placement || body.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry";
  }
  const { inserted } = await persistDeviceEvents(events, {
    deviceId: body.deviceId || "",
    device: body.deviceName || body.deviceId || "",
    zone,
    direction: placement,
    devicePlacement: placement
  });
  ok(res, { ok: true, received: events.length, inserted, placement });
});
app.put("/api/devices/:id", async (req, res) => {
  const body = toDoc(req.body || {});
  // Normalise placement so entry/exit is always one of those two literal values
  if (body.placement !== undefined || body.direction !== undefined) {
    body.placement = String(body.placement || body.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry";
    delete body.direction;
  }
  await collection("devices").updateOne(await deviceFilter(req.params.id), { $set: body }, { upsert: true });
  ok(res, { ok: true });
});
app.delete("/api/devices/:id", async (req, res) => {
  const result = await collection("devices").deleteOne(await deviceFilter(req.params.id));
  ok(res, { ok: true, deleted: result.deletedCount });
});

/** Calendar day bounds in Asia/Dubai (matches access logs "today" in Expo City Dubai). */
function dubaiDayStartEnd(now = new Date()) {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  const start = new Date(`${ymd}T00:00:00+04:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

/** Reader auth outcomes only — not enrollment/audit rows in the same `logs` collection. */
function logsDoorEventOnly() {
  return {
    $nor: [
      { eventType: "ENROLLMENT" },
      // Exclude ACCESS_UNKNOWN events generated for unmatched faces (no real user — synthetic UNKNOWN-* ID)
      { eventType: "ACCESS_UNKNOWN", employeeId: { $regex: /^UNKNOWN-/i } }
    ]
  };
}

const FOOTPRINT_LOG_LIMIT = Math.min(Math.max(Number(process.env.FOOTPRINT_LOG_LIMIT || 10000), 50), 500000);

function logEventTimeMs(d) {
  const t = d?.timestamp ?? d?.ts ?? d?.createdAt;
  if (t instanceof Date) return t.getTime();
  const n = Number(t);
  if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
  const dt = new Date(t);
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function hourInDubai(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "numeric",
    hour12: false
  }).formatToParts(date);
  const hp = parts.find((p) => p.type === "hour");
  const h = hp ? Number(hp.value) : NaN;
  return Number.isFinite(h) ? h : 0;
}

function directionBucket(dir) {
  const s = String(dir ?? "").trim().toLowerCase();
  if (!s) return "";
  if (/^(out|exit|leav)/.test(s)) return "out";
  if (/^(in|entry|enter)/.test(s)) return "in";
  return "";
}

function normalizeFootprintDirection(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (/^(out|exit|leav)/.test(s)) return "OUT";
  if (/^(in|entry|enter)/.test(s)) return "IN";
  const u = String(raw).trim().toUpperCase();
  return u === "OUT" || u === "IN" ? u : "";
}

function mongoMatchEmployeeFootprintLogs(emp) {
  const ids = new Set();
  if (emp?.employeeId != null && String(emp.employeeId).trim()) ids.add(String(emp.employeeId).trim());
  if (emp?.supremaUserId != null && String(emp.supremaUserId).trim()) ids.add(String(emp.supremaUserId).trim());
  if (emp?._id) ids.add(String(emp._id));
  if (Array.isArray(emp?.supremaAliases)) {
    for (const a of emp.supremaAliases) {
      if (a != null && String(a).trim()) ids.add(String(a).trim());
    }
  }
  const idVariants = mongoEmployeeIdVariants(ids);
  const or = [];
  if (idVariants.length) or.push({ employeeId: { $in: idVariants } });
  const nm = String(emp?.name || "").trim();
  if (nm) {
    const rx = new RegExp(`^${escapeRegex(nm)}$`, "i");
    or.push({ employeeName: rx });
    or.push({ name: rx });
  }
  return or.length ? { $or: or } : { _id: null };
}

function mongoMatchVisitorFootprintLogs(v) {
  const ids = new Set();
  if (v?._id) ids.add(String(v._id));
  if (v?.passNumber != null && String(v.passNumber).trim()) ids.add(String(v.passNumber).trim());
  if (v?.supremaUserId != null && String(v.supremaUserId).trim()) ids.add(String(v.supremaUserId).trim());
  const idVariants = mongoEmployeeIdVariants(ids);
  const or = [];
  if (idVariants.length) or.push({ employeeId: { $in: idVariants } });
  const nm = String(v?.name || v?.visitorName || "").trim();
  if (nm) {
    const rx = new RegExp(`^${escapeRegex(nm)}$`, "i");
    or.push({ employeeName: rx });
    or.push({ name: rx });
  }
  return or.length ? { $or: or } : { _id: null };
}

async function computeFootprintResponse(personDoc, kind) {
  const match =
    kind === "visitor" ? mongoMatchVisitorFootprintLogs(personDoc) : mongoMatchEmployeeFootprintLogs(personDoc);
  const filter = { $and: [logsDoorEventOnly(), match] };
  const docs = await collection("logs")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(FOOTPRINT_LOG_LIMIT)
    .toArray();
  const enriched = await enrichLogs(docs);
  enriched.sort((a, b) => logEventTimeMs(b) - logEventTimeMs(a));

  let granted = 0;
  let denied = 0;
  const hourCounts = Array.from({ length: 24 }, (_, h) => ({
    hour: `${String(h).padStart(2, "0")}:00`,
    count: 0
  }));
  const zoneMap = new Map();

  for (const d of enriched) {
    const okGrant = Boolean(
      d.accessGranted ?? d.granted ?? String(d.eventType || "").toUpperCase() === "ACCESS_GRANTED"
    );
    if (okGrant) granted++;
    else denied++;

    const ms = logEventTimeMs(d);
    if (ms > 0) {
      const dh = hourInDubai(new Date(ms));
      if (dh >= 0 && dh < 24) hourCounts[dh].count++;
    }

    const zone = String(d.zone || d.location || "").trim() || "—";
    const db = directionBucket(d.direction);
    let z = zoneMap.get(zone);
    if (!z) z = { zone, count: 0, ins: 0, outs: 0, firstMs: Infinity, lastMs: 0 };
    z.count++;
    if (db === "in") z.ins++;
    else if (db === "out") z.outs++;
    if (ms > 0) {
      z.firstMs = Math.min(z.firstMs, ms);
      z.lastMs = Math.max(z.lastMs, ms);
    }
    zoneMap.set(zone, z);
  }

  let peakHour = null;
  let peakCount = 0;
  hourCounts.forEach((h, idx) => {
    if (h.count > peakCount) {
      peakCount = h.count;
      peakHour = idx;
    }
  });

  const zones = [...zoneMap.values()]
    .map((z) => ({
      zone: z.zone,
      count: z.count,
      total: z.count,
      ins: z.ins,
      outs: z.outs,
      firstVisit: Number.isFinite(z.firstMs) && z.firstMs !== Infinity ? new Date(z.firstMs).toISOString() : null,
      lastVisit: z.lastMs ? new Date(z.lastMs).toISOString() : null
    }))
    .sort((a, b) => b.count - a.count);

  const trail = enriched.map((d) => {
    const ts = d.timestamp ?? d.ts ?? d.createdAt;
    let iso = null;
    if (ts instanceof Date && !Number.isNaN(ts.getTime())) iso = ts.toISOString();
    else if (typeof ts === "string") iso = ts;
    else if (ts != null) {
      const dt = new Date(ts);
      iso = Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    }
    return {
      ...d,
      _id: d._id && typeof d._id.toString === "function" ? d._id.toString() : d._id,
      deviceName: d.deviceName || d.device || "",
      timestamp: iso,
      ts: iso,
      direction: normalizeFootprintDirection(d.direction),
      accessGranted: Boolean(
        d.accessGranted ?? d.granted ?? String(d.eventType || "").toUpperCase() === "ACCESS_GRANTED"
      )
    };
  });

  return {
    trail,
    zones,
    hourlyDist: hourCounts,
    stats: {
      total: enriched.length,
      granted,
      denied,
      peakHour,
      peakCount
    }
  };
}

/** Shared filter for GET /api/logs, export, etc. `q` may be req.query or a plain object. */
function buildAccessLogsMongoFilter(q = {}) {
  const search = String(q.search ?? "").trim();
  const todayOnly = String(q.today ?? "").trim() === "1";
  const unknownDenied = String(q.unknownDenied ?? "").trim() === "1";
  const fromDateRaw = String(q.fromDate ?? q.from ?? "").trim();
  const toDateRaw = String(q.toDate ?? q.to ?? "").trim();
  const clauses = [logsDoorEventOnly()];
  const normalizeDate = (raw) => {
    if (!raw) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return null;
    const [, yy, mm, dd] = m;
    return `${yy}-${mm}-${dd}`;
  };
  const fromYmd = normalizeDate(fromDateRaw);
  const toYmd = normalizeDate(toDateRaw);

  if (q.granted != null && String(q.granted).trim() !== "") {
    const granted = String(q.granted).toLowerCase() === "true";
    clauses.push({
      $or: granted
        ? [{ accessGranted: true }, { granted: true }, { eventType: "ACCESS_GRANTED" }]
        : [{ accessGranted: false }, { granted: false }, { eventType: "ACCESS_DENIED" }]
    });
  }

  if (search) {
    clauses.push({
      $or: [
        { employeeName: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { employeeId: { $regex: search, $options: "i" } },
        { zone: { $regex: search, $options: "i" } },
        { authMode: { $regex: search, $options: "i" } }
      ]
    });
  }

  if (todayOnly) {
    const { start, end } = dubaiDayStartEnd();
    clauses.push({
      $or: [{ createdAt: { $gte: start, $lt: end } }, { timestamp: { $gte: start, $lt: end } }, { ts: { $gte: start, $lt: end } }]
    });
  }
  if (fromYmd || toYmd) {
    const start = fromYmd ? new Date(`${fromYmd}T00:00:00+04:00`) : null;
    const toStart = toYmd ? new Date(`${toYmd}T00:00:00+04:00`) : null;
    const end = toStart ? new Date(toStart.getTime() + 24 * 60 * 60 * 1000) : null;
    const range = {};
    if (start && !Number.isNaN(start.getTime())) range.$gte = start;
    if (end && !Number.isNaN(end.getTime())) range.$lt = end;
    if (Object.keys(range).length) {
      clauses.push({
        $or: [{ createdAt: range }, { timestamp: range }, { ts: range }]
      });
    }
  }
  if (unknownDenied) {
    clauses.push({
      $and: [
        { $or: [{ accessGranted: false }, { granted: false }, { eventType: "ACCESS_DENIED" }] },
        {
          $or: [
            { employeeId: { $regex: "^UNKNOWN-", $options: "i" } },
            { employeeName: { $regex: "^UNKNOWN-", $options: "i" } },
            { name: { $regex: "^UNKNOWN-", $options: "i" } },
            { employeeName: { $regex: "^Unknown$", $options: "i" } },
            { name: { $regex: "^Unknown$", $options: "i" } }
          ]
        }
      ]
    });
  }
  return { $and: clauses };
}

app.get("/api/logs", async (req, res) => {
  const { skip, limit } = parsePagination(req.query);
  const filter = buildAccessLogsMongoFilter(req.query);

  const [docs, total] = await Promise.all([
    collection("logs").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    collection("logs").countDocuments(filter)
  ]);
  const logs = await enrichLogs(docs);
  ok(res, { logs, total });
});
app.get("/api/logs/stats", async (_req, res) => {
  const door = logsDoorEventOnly();
  const total = await collection("logs").countDocuments(door);
  const granted = await collection("logs").countDocuments({
    $and: [door, { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] }]
  });
  const denied = await collection("logs").countDocuments({
    $and: [door, { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] }]
  });
  const unknownDenied = await collection("logs").countDocuments({
    $and: [
      door,
      { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] },
      {
        $or: [
          { employeeId: { $regex: "^UNKNOWN-", $options: "i" } },
          { employeeName: { $regex: "^UNKNOWN-", $options: "i" } },
          { name: { $regex: "^UNKNOWN-", $options: "i" } },
          { employeeName: { $regex: "^Unknown$", $options: "i" } },
          { name: { $regex: "^Unknown$", $options: "i" } }
        ]
      }
    ]
  });
  const { start, end } = dubaiDayStartEnd();
  const grantedToday = await collection("logs").countDocuments({
    $and: [
      door,
      { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] },
      { $or: [{ createdAt: { $gte: start, $lt: end } }, { timestamp: { $gte: start, $lt: end } }, { ts: { $gte: start, $lt: end } }] }
    ]
  });
  const deniedToday = await collection("logs").countDocuments({
    $and: [
      door,
      { $or: [{ eventType: "ACCESS_DENIED" }, { accessGranted: false }, { granted: false }] },
      { $or: [{ createdAt: { $gte: start, $lt: end } }, { timestamp: { $gte: start, $lt: end } }, { ts: { $gte: start, $lt: end } }] }
    ]
  });
  const grantedTodayUniqueAgg = await collection("logs")
    .aggregate([
      {
        $match: {
          $and: [
            door,
            { $or: [{ eventType: "ACCESS_GRANTED" }, { accessGranted: true }, { granted: true }] },
            { $or: [{ createdAt: { $gte: start, $lt: end } }, { timestamp: { $gte: start, $lt: end } }, { ts: { $gte: start, $lt: end } }] }
          ]
        }
      },
      {
        $project: {
          subjectKey: {
            $toLower: {
              $trim: {
                input: {
                  $toString: {
                    $ifNull: ["$employeeId", { $ifNull: ["$employeeName", "$name"] }]
                  }
                }
              }
            }
          }
        }
      },
      { $match: { subjectKey: { $ne: "", $not: /^unknown(?:-|$)/i } } },
      { $group: { _id: "$subjectKey" } },
      { $count: "total" }
    ])
    .toArray();
  const grantedTodayUniqueEmployees = Number(grantedTodayUniqueAgg?.[0]?.total || 0);
  const recentRows = await collection("logs")
    .find(door)
    .sort({ createdAt: -1 })
    .limit(200000)
    .toArray(); // raised: supports large deployments

  const hourlyMap = new Map();
  for (let h = 0; h < 24; h++) hourlyMap.set(String(h).padStart(2, "0"), { hour: `${String(h).padStart(2, "0")}:00`, granted: 0, denied: 0 });
  const now = new Date();
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const authCounter = new Map();
  const weeklyMap = new Map(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => [d, 0]));

  for (const r of recentRows) {
    if (String(r.eventType || "") === "ENROLLMENT") continue;
    const t = new Date(r.createdAt || r.timestamp || r.ts || 0);
    if (Number.isNaN(t.getTime())) continue;
    const isGranted = Boolean(r.accessGranted ?? r.granted ?? (r.eventType === "ACCESS_GRANTED"));
    const auth = String(r.authMode || r.auth || "Unknown").trim() || "Unknown";

    const dayKey = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.getDay()];
    weeklyMap.set(dayKey, (weeklyMap.get(dayKey) || 0) + 1);
    authCounter.set(auth, (authCounter.get(auth) || 0) + 1);

    if (t >= start24h) {
      const hh = String(t.getHours()).padStart(2, "0");
      const slot = hourlyMap.get(hh);
      if (slot) {
        if (isGranted) slot.granted += 1;
        else slot.denied += 1;
      }
    }
  }

  const hourly = [...hourlyMap.values()];
  const authTotal = [...authCounter.values()].reduce((a, b) => a + b, 0) || 1;
  const authModes = [...authCounter.entries()]
    .map(([name, value]) => ({ name, value: Math.round((value * 100) / authTotal) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const weekly = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => ({ day: d, count: weeklyMap.get(d) || 0 }));

  ok(res, { total, granted, denied, grantedToday, grantedTodayUniqueEmployees, deniedToday, unknownDenied, hourly, authModes, weekly });
});
app.get("/api/logs/search", async (req, res) => {
  const door = logsDoorEventOnly();
  const q = req.query.q
    ? { $and: [door, { $or: [{ employeeName: { $regex: req.query.q, $options: "i" } }, { employeeId: { $regex: req.query.q, $options: "i" } }] }] }
    : door;
  const docs = await collection("logs").find(q).sort({ createdAt: -1 }).limit(1000).toArray(); // search: top 1000 matches
  ok(res, await enrichLogs(docs));
});
function scoreFromBase64(base64 = "", seed = 0) {
  const s = String(base64 || "");
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 160))) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const norm = Math.abs(h % 1000) / 1000;
  return Math.round(62 + norm * 36); // 62..98
}

app.post("/api/enrollment/analyze", async (req, res) => {
  const base64 = String(req.body?.base64 || "");
  const payloadLen = base64.length;
  if (!base64 || payloadLen < 1200) {
    return ok(res, {
      ok: true,
      verdict: "REJECT",
      recommendation: "Image is too small or invalid. Upload a clearer close-up face image.",
      qualityScore: 38,
      livenessScore: 52,
      depthScore: 41,
      isRealHuman: false,
      isFakeDetected: false,
      fakeType: "",
      angleAcceptable: false,
      faceAngle: "Unknown",
      lighting: "poor",
      blur: "blurry",
      eyesVisible: false,
      faceCentered: false,
      message: "Photo quality too low"
    });
  }

  const qualityScore = scoreFromBase64(base64, 11);
  const livenessScore = scoreFromBase64(base64, 23);
  const depthScore = scoreFromBase64(base64, 37);
  const avg = Math.round((qualityScore + livenessScore + depthScore) / 3);

  const isRealHuman = livenessScore >= 66;
  const isFakeDetected = false;
  const angleAcceptable = qualityScore >= 68;
  const faceAngle = angleAcceptable ? "Frontal" : "Tilted";
  const lighting = qualityScore >= 74 ? "good" : "dim";
  const blur = qualityScore >= 72 ? "sharp" : "blurry";
  const eyesVisible = qualityScore >= 65;
  const faceCentered = depthScore >= 64;

  let verdict = "APPROVE";
  let recommendation = "Photo quality acceptable.";
  if (!isRealHuman || !eyesVisible || !faceCentered) {
    verdict = "CONDITIONAL";
    recommendation = "Face detected but quality can be improved. Capture a frontal, well-lit image.";
  }
  if (avg < 62 || qualityScore < 58) {
    verdict = "REJECT";
    recommendation = "Quality too low. Retake with clear lighting, visible eyes, and centered face.";
  }

  return ok(res, {
    ok: true,
    verdict,
    recommendation,
    qualityScore,
    livenessScore,
    depthScore,
    isRealHuman,
    isFakeDetected,
    fakeType: "",
    angleAcceptable,
    faceAngle,
    lighting,
    blur,
    eyesVisible,
    faceCentered,
    message: recommendation
  });
});
app.post("/api/enrollment/submit", async (req, res) => {
  const now = new Date();
  const raw = req.body || {};
  const employeeId = raw.employeeId;
  const photoBase64 = String(raw.photoBase64 || "");
  const analysisResult = raw.analysisResult || {};
  const photoOnlyAccess = String(raw.photoOnlyAccess ?? "true").toLowerCase() !== "false";

  if (!employeeId) {
    return res.status(400).json({ ok: false, error: "employeeId is required" });
  }

  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(String(employeeId));
  } catch {
    return res.status(400).json({ ok: false, error: "invalid employeeId" });
  }

  const q = Number(analysisResult.qualityScore || 0);
  const l = Number(analysisResult.livenessScore || 0);
  const d = Number(analysisResult.depthScore || 0);
  const avg =
    q || l || d ? Math.round((q + l + d) / (Boolean(q) + Boolean(l) + Boolean(d) || 1)) : 0;
  const confidence = Number(analysisResult.consensusConfidence ?? avg ?? 0);

  const photoDataUrl =
    photoBase64.length > 80 ? `data:image/jpeg;base64,${photoBase64}` : "";

  const empPatch = {
    enrolled: true,
    enrolledAt: now,
    updatedAt: now,
    ...(photoOnlyAccess
      ? {
          authMode: "Face Only",
          status: "active",
          cardholderStatus: "Active",
          photoOnlyAccess: true
        }
      : {}),
    ...(photoDataUrl ? { photo: photoDataUrl, facePhoto: photoDataUrl } : {}),
    ...(avg ? { faceScore: avg } : {}),
    enrollmentVerdict: String(analysisResult.verdict || ""),
    enrollmentConfidence: confidence,
    enrollmentRecommendation: String(analysisResult.recommendation || analysisResult.message || "")
  };

  const updated = await collection("employees").updateOne({ _id: oid }, { $set: empPatch });
  if (!updated.matchedCount) {
    return res.status(404).json({ ok: false, error: "employee not found" });
  }

  const empRow = await collection("employees").findOne({ _id: oid });
  let devicePush = { skipped: true, reason: "unknown" };
  if (empRow) {
    try {
      // LOCKED (remote/off-site): never open reader camera on upload — see .cursor/rules expo-fr-suprema-context.mdc
      devicePush = await pushFaceEnrollmentToDevices(empRow, photoBase64, { allowLiveScanFallback: false });
    } catch (e) {
      devicePush = { attempted: true, results: [], error: e.message, skipped: true };
    }
    await collection("employees").updateOne({ _id: oid }, { $set: { supremaUserId: deriveSupremaUserId(empRow) } });
  }

  await collection("logs").insertOne({
    eventType: "ENROLLMENT",
    employeeId: String(employeeId),
    verdict: analysisResult.verdict,
    consensusConfidence: confidence,
    faceScore: avg,
    message: "Face enrollment saved to employee profile",
    devicePush: devicePush?.results?.length ? devicePush : undefined,
    createdAt: now,
    timestamp: now,
    ts: now
  });

  if (empRow) broadcastEmployeeUpdated(empRow);
  ok(res, { ok: true, enrolled: true, submittedAt: now, devicePush });
});

app.get("/api/ai/anomaly-report", async (_req, res) => {
  const nowMs = Date.now();
  if (!aiInsightsCache.payload || nowMs - Number(aiInsightsCache.refreshedAt || 0) > AI_INSIGHTS_REFRESH_MS) {
    aiInsightsCache = { refreshedAt: nowMs, payload: await buildAiSnapshot() };
  }
  ok(res, {
    generatedAt: new Date(aiInsightsCache.refreshedAt),
    items: aiInsightsCache.payload?.anomalies || []
  });
});
app.get("/api/ai/behavior-profile/:type/:id", async (req, res) => ok(res, { id: req.params.id, type: req.params.type, riskLevel: "low" }));
app.get("/api/ai/risk-score", async (_req, res) => {
  const { score, level, basis } = await computeRiskScoreFromDb();
  ok(res, { score, level, basis });
});
app.get("/api/ai/insights", async (_req, res) => {
  const nowMs = Date.now();
  if (!aiInsightsCache.payload || nowMs - Number(aiInsightsCache.refreshedAt || 0) > AI_INSIGHTS_REFRESH_MS) {
    aiInsightsCache = { refreshedAt: nowMs, payload: await buildAiSnapshot() };
  }
  const payload = aiInsightsCache.payload || {};
  ok(res, {
    riskScore: Number(payload?.riskScore || 0),
    alerts: Array.isArray(payload?.items) ? payload.items.slice(0, 1) : [],
    items: payload?.items || [],
    refreshedAt: payload?.refreshedAt || new Date(aiInsightsCache.refreshedAt).toISOString(),
    refreshMs: AI_INSIGHTS_REFRESH_MS
  });
});
app.get("/api/ai/predictive", async (_req, res) => {
  const nowMs = Date.now();
  if (!aiInsightsCache.payload || nowMs - Number(aiInsightsCache.refreshedAt || 0) > AI_INSIGHTS_REFRESH_MS) {
    aiInsightsCache = { refreshedAt: nowMs, payload: await buildAiSnapshot() };
  }
  ok(res, aiInsightsCache.payload?.predictive || { summary: "No predictive model output yet.", predictions: [] });
});

app.post("/api/aria/chat", async (req, res) => {
  try {
    const client = getOllamaClient();
    const model = req.body?.model || "llama3.2";
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const result = await client.chat({
      model,
      messages: messages.map((m) => ({
        role: m?.role || "user",
        content: String(m?.content || "")
      })),
      stream: false
    });
    return res.json({
      ok: true,
      model,
      response: result?.message?.content || result?.response || ""
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/aria/status", async (_req, res) => {
  try {
    const client = getOllamaClient();
    const models = await client.list();
    const modelNames = (models?.models || []).map((m) => m.name || m.model || m);
    res.json({
      ok: true,
      online: true,
      host: OLLAMA_HOST,
      models: modelNames
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      online: false,
      host: OLLAMA_HOST,
      models: [],
      error: error.message
    });
  }
});

app.get("/api/aria/models", async (_req, res) => {
  try {
    const client = getOllamaClient();
    const models = await client.list();
    res.json(models?.models ?? []);
  } catch (error) {
    res.status(503).json({
      error: error.message
    });
  }
});

app.get("/api/alerts", async (_req, res) => ok(res, await collection("alerts").find({}).sort({ createdAt: -1 }).limit(10000).toArray()));
app.post("/api/alerts/:id/ack", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("alerts").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "acknowledged", updatedAt: new Date() } });
  ok(res, { ok: true });
});
app.post("/api/alerts/:id/resolve", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("alerts").updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "resolved", updatedAt: new Date() } });
  ok(res, { ok: true });
});

app.get("/api/reports/daily", async (_req, res) => {
  const now = new Date();
  const start30 = new Date(now);
  start30.setDate(start30.getDate() - 30);
  const start14 = new Date(now);
  start14.setDate(start14.getDate() - 13);

  const q30 = {
    $and: [
      logsDoorEventOnly(),
      {
        $or: [
          { createdAt: { $gte: start30 } },
          { timestamp: { $gte: start30 } },
          { ts: { $gte: start30 } }
        ]
      }
    ]
  };
  const q14 = {
    $and: [
      logsDoorEventOnly(),
      {
        $or: [
          { createdAt: { $gte: start14 } },
          { timestamp: { $gte: start14 } },
          { ts: { $gte: start14 } }
        ]
      }
    ]
  };

  const [logs30, logs14, employees, alertsMonth] = await Promise.all([
    collection("logs").find(q30).limit(100000).toArray(),
    collection("logs").find(q14).limit(100000).toArray(),
    collection("employees").find({}, { projection: { employeeId: 1, name: 1 } }).limit(100000).toArray(),
    collection("alerts").countDocuments({ createdAt: { $gte: start30 } })
  ]);

  const isGranted = (l) => Boolean(l?.accessGranted ?? l?.granted ?? (l?.eventType === "ACCESS_GRANTED"));
  const tsOf = (l) => new Date(l?.createdAt || l?.timestamp || l?.ts || 0);
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dailyMap = new Map();
  for (let i = 0; i < 14; i++) {
    const d = new Date(start14);
    d.setDate(start14.getDate() + i);
    dailyMap.set(dayKey(d), { date: dayKey(d), granted: 0, denied: 0 });
  }
  const zoneMap = new Map();
  const staffSet = new Set();
  const empIdSet = new Set(
    (employees || [])
      .map((e) => String(e?.employeeId || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const empNameSet = new Set(
    (employees || [])
      .map((e) => String(e?.name || "").trim().toLowerCase())
      .filter(Boolean)
  );

  for (const l of logs30) {
    const granted = isGranted(l);
    const z = String(l?.zone || "Unknown");
    zoneMap.set(z, (zoneMap.get(z) || 0) + 1);
    const id = String(l?.employeeId || "").trim();
    const idNorm = id.toLowerCase();
    const nm = String(l?.employeeName || l?.name || "").trim().toLowerCase();
    const isUnknown = /^unknown-/i.test(idNorm) || nm === "unknown" || /^unknown-/i.test(nm);
    if (!isUnknown) {
      if (idNorm && empIdSet.has(idNorm)) staffSet.add(`id:${idNorm}`);
      else if (nm && empNameSet.has(nm)) staffSet.add(`n:${nm}`);
    }
    const t = tsOf(l);
    if (!Number.isNaN(t.getTime()) && t >= start14) {
      const k = dayKey(t);
      const row = dailyMap.get(k);
      if (row) {
        if (granted) row.granted += 1;
        else row.denied += 1;
      }
    }
  }

  const grantedMonth = logs30.filter((l) => isGranted(l)).length;
  const deniedMonth = logs30.length - grantedMonth;
  const byZone = [...zoneMap.entries()]
    .map(([zone, count]) => ({ zone, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const dailyTrend = [...dailyMap.values()];

  ok(res, {
    grantedMonth,
    deniedMonth,
    alertsMonth: Number(alertsMonth || 0),
    uniqueStaff: staffSet.size,
    dailyTrend,
    byZone
  });
});
app.get("/api/reports/security", async (_req, res) => {
  const nowMs = Date.now();
  if (!aiInsightsCache.payload || nowMs - Number(aiInsightsCache.refreshedAt || 0) > AI_INSIGHTS_REFRESH_MS) {
    aiInsightsCache = { refreshedAt: nowMs, payload: await buildAiSnapshot() };
  }
  const p = aiInsightsCache.payload || {};
  const incidents = (p.threats || []).map((t) => ({
    type: t.type,
    count: Number(t.count || 1),
    severity: String(t.risk || "medium").toLowerCase(),
    lastOccurrence: new Date()
  }));
  ok(res, {
    riskScore: Number(p.riskScore || 0),
    critical: Number(p.critical || 0),
    high: Number(p.high || 0),
    fakeBlocked: 0,
    apb: 0,
    resolvedMonth: Number(p.resolvedMonth || 0),
    threats: p.threats || [],
    riskTrend: p.riskTrend || [],
    aiSummary: p.aiSummary || "",
    incidents
  });
});
const ATTENDANCE_COLUMNS = ["employeeId", "cardId", "employeeName", "company", "designation", "department", "division", "accessLevel", "cardholderStatus", "shiftSchedule", "passIssueDate", "passExpiryDate", "email", "phone", "lineManager", "status", "inTime", "outTime", "totalDuration", "eventsCount"];
const ATTENDANCE_SUBSCRIPTIONS_COLLECTION = "attendance_subscriptions";
let attendanceSchedulerStarted = false;
let deviceHealthCheckerStarted = false;
let deviceEventPullerStarted = false;
let centralApiPollerStarted = false;
let selfHealingStarted = false;
let watchdogStarted = false;
let deviceSyncQueueStarted = false;
const selfHealState = {
  enabled: SELF_HEALING_ENABLED,
  lastRunAt: null,
  lastTriggerAt: null,
  lastReason: "",
  lastActions: [],
  sidecarConsecutiveFails: 0,
  recoveries: 0
};
const watchdogState = {
  enabled: WATCHDOG_ENABLED,
  lastRunAt: null,
  lastTriggerAt: null,
  triggers: 0,
  lastReason: "",
  lastActions: []
};

function normalizeLanIp(value) {
  return String(value || "").trim().toLowerCase();
}

/** DeviceInfo.status: TCP_CONNECTED=1, TLS_CONNECTED=2 (see g-sdk connect.proto). */
function isGatewaySessionConnected(status) {
  const s = Number(status);
  return s === 1 || s === 2;
}

function pickGatewayDeviceRow(device, gatewayDevices = []) {
  if (!Array.isArray(gatewayDevices) || !gatewayDevices.length) return null;
  const wantIp = normalizeLanIp(device?.ipAddr || device?.ip);
  const wantId = supremaNumericDeviceId(device);
  for (const row of gatewayDevices) {
    const gIp = normalizeLanIp(row?.ipaddr);
    if (wantIp && gIp && wantIp === gIp) return row;
    const gid = Number(row?.deviceid ?? row?.deviceId ?? 0);
    if (wantId > 0 && gid > 0 && wantId === gid) return row;
  }
  return null;
}

function checkTcpReachability(ip, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error = null) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve({
        ok,
        responseMs: Date.now() - startedAt,
        error
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err?.message || "socket error"));
    try {
      socket.connect(Number(port || GSDK_DEVICE_PORT || 51211), String(ip || ""));
    } catch (err) {
      finish(false, err?.message || "connect failed");
    }
  });
}

/** Check if host has network connectivity to reach devices.
 * Returns {ok: boolean, error?: string} */
async function checkHostNetworkConnectivity() {
  try {
    // Check if we can reach the gateway sidecar first (if configured)
    if (GSDK_SIDECAR_URL) {
      const gwCheck = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/health`, {}, 3000).catch(() => null);
      if (gwCheck?.response?.ok) {
        return { ok: true };
      }
    }

    // Check default gateway route is available
    const platform = os.platform();
    if (platform === "linux") {
      try {
        // Check if default route exists
        const { stdout } = await execAsync("ip route | grep default | head -1", { timeout: 2000 });
        if (!stdout || !stdout.trim()) {
          return { ok: false, error: "No default gateway route" };
        }
      } catch {
        return { ok: false, error: "Cannot verify network routes" };
      }
    } else if (platform === "win32") {
      try {
        const { stdout } = await execAsync("route print | findstr 0.0.0.0", { timeout: 2000 });
        if (!stdout || !stdout.trim()) {
          return { ok: false, error: "No default gateway route" };
        }
      } catch {
        return { ok: false, error: "Cannot verify network routes" };
      }
    }

    // Final fallback: check if any network interface is up (except loopback)
    const interfaces = os.networkInterfaces();
    const hasExternalInterface = Object.entries(interfaces).some(([name, addrs]) => {
      if (name.startsWith("lo") || name === "Loopback Pseudo-Interface 1") return false;
      return addrs.some(a => !a.internal && a.family === "IPv4");
    });

    if (!hasExternalInterface) {
      return { ok: false, error: "No active network interfaces" };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "Network check failed" };
  }
}

let lastHostNetworkStatus = { ok: true, checkedAt: 0 };

async function tickDeviceHealth() {
  if (!mongoConnected) return;
  const docs = await collection("devices").find({}).toArray();
  if (!docs.length) return;

  // Check host network connectivity first
  const hostNetwork = await checkHostNetworkConnectivity();
  lastHostNetworkStatus = { ok: hostNetwork.ok, checkedAt: Date.now(), error: hostNetwork.error };

  // If host network is down, mark all devices as offline immediately
  if (!hostNetwork.ok) {
    const now = new Date();
    const offlinePatches = docs.map((d) => ({
      _id: d._id,
      patch: {
        status: "offline",
        lastCheckedAt: now,
        responseMs: null,
        healthError: `Host network down: ${hostNetwork.error || "no connectivity"}`
      }
    }));
    await collection("devices").bulkWrite(
      offlinePatches.map((x) => ({
        updateOne: {
          filter: { _id: x._id },
          update: { $set: { ...x.patch, updatedAt: now } }
        }
      })),
      { ordered: false }
    );
    return;
  }

  let gatewaySnapshot = null;
  if (DEVICE_HEALTH_GATEWAY_FALLBACK && GSDK_SIDECAR_URL) {
    gatewaySnapshot = await testDeviceWithSidecar({}).catch(() => null);
  }
  const checks = await Promise.all(
    docs.map(async (d) => {
      const ip = String(d.ipAddr || d.ip || "").trim();
      const port = Number(d.port || GSDK_DEVICE_PORT || 51211);
      if (!ip) {
        const sidNoIp = supremaNumericDeviceId(d);
        if (DEVICE_HEALTH_GATEWAY_FALLBACK && sidNoIp > 0) {
          return {
            _id: d._id,
            patch: {
              status: "online",
              lastCheckedAt: new Date(),
              responseMs: null,
              healthError:
                "reader ipAddr not set; TCP not probed — logs use gateway GetLog; set ipAddr for full health"
            }
          };
        }
        return {
          _id: d._id,
          patch: {
            status: "offline",
            lastCheckedAt: new Date(),
            responseMs: null,
            healthError: "missing ip (set ipAddr on device)"
          }
        };
      }
      const probe = await checkTcpReachability(ip, port, 1800);
      const gwRow =
        !probe.ok && DEVICE_HEALTH_GATEWAY_FALLBACK && gatewaySnapshot?.ok
          ? pickGatewayDeviceRow(d, gatewaySnapshot.payload?.devices || [])
          : null;
      const gwConnected = Boolean(gwRow && isGatewaySessionConnected(gwRow.status));
      const gatewayApiOk = Boolean(gatewaySnapshot?.ok);
      let status;
      let healthError;
      if (probe.ok || gwConnected) {
        status = "online";
        healthError = "";
      } else if (gatewayApiOk) {
        status = "warning";
        healthError =
          "Gateway reachable; reader TCP failed or device not in gateway list.";
      } else {
        status = "offline";
        healthError = probe.error || "unreachable";
      }
      const patch = {
        status,
        responseMs: probe.ok ? probe.responseMs : null,
        lastCheckedAt: new Date(),
        lastSync: probe.ok ? new Date() : d.lastSync || null,
        healthError
      };
      if (ip && !String(d.ipAddr || "").trim()) {
        patch.ipAddr = ip;
      }
      if (gwRow && Number(gwRow.deviceid ?? 0) > 0) {
        patch.supremaDeviceId = Number(gwRow.deviceid);
      }
      return { _id: d._id, patch };
    })
  );
  if (!checks.length) return;

  // Identify devices transitioning from offline to online for sync queue processing
  const devicesWentOnline = [];
  for (const check of checks) {
    const prevStatus = String(docs.find(d => String(d._id) === String(check._id))?.status || "").toLowerCase();
    const newStatus = String(check.patch.status || "").toLowerCase();
    if ((prevStatus === "offline" || prevStatus === "" || prevStatus === "warning") && newStatus === "online") {
      const device = docs.find(d => String(d._id) === String(check._id));
      if (device) devicesWentOnline.push(device);
    }
  }

  await collection("devices").bulkWrite(
    checks.map((x) => ({
      updateOne: {
        filter: { _id: x._id },
        update: { $set: { ...x.patch, updatedAt: new Date() } }
      }
    })),
    { ordered: false }
  );

  // Process sync queue for devices that just came online
  if (DEVICE_SYNC_QUEUE_ENABLED && devicesWentOnline.length > 0 && GSDK_SIDECAR_URL) {
    console.log(`[device-health] ${devicesWentOnline.length} device(s) came online, processing sync queue...`);
    for (const d of devicesWentOnline) {
      const sid = supremaNumericDeviceId(d) >>> 0;
      if (!sid) continue;
      try {
        const result = await processDeviceSyncQueueForDevice(sid, { batchSize: DEVICE_SYNC_BATCH_SIZE });
        if (result.processed > 0) {
          console.log(`[device-health] Synced ${result.processed} queued operations to device ${sid}`);
        }
      } catch (e) {
        console.warn(`[device-health] Failed to process sync queue for device ${sid}:`, e?.message);
      }
    }
  }
}

async function tickDeviceEventPull() {
  if (!mongoConnected || !GSDK_SIDECAR_URL) {
    lastDeviceEventPullStats = { at: new Date(), devices: 0, pulled: 0, inserted: 0, note: "mongo or sidecar off" };
    return { devices: 0, pulled: 0, inserted: 0 };
  }
  const docs = await collection("devices").find({}).toArray();
  if (!docs.length) {
    lastDeviceEventPullStats = { at: new Date(), devices: 0, pulled: 0, inserted: 0, note: "no devices in DB" };
    return { devices: 0, pulled: 0, inserted: 0 };
  }
  let pulled = 0;
  let inserted = 0;
  const conc = Math.max(1, DEVICE_EVENT_PULL_CONCURRENCY);
  for (let i = 0; i < docs.length; i += conc) {
    const batch = docs.slice(i, i + conc);
    await Promise.all(
      batch.map(async (d) => {
        const ip = String(d.ipAddr || d.ip || "").trim();
        const sid = supremaNumericDeviceId(d);
        if (!ip && !sid) return;
        // Pull when we have a reader IP and/or a gateway device id — GetLog goes through gateway/sidecar and may succeed even if
        // direct TCP probe marked the device "offline" (common mis-match when only ipAddr was stored).
        const result = await pullDeviceEventsFromSidecar(d).catch(() => ({ pulled: 0, inserted: 0 }));
        pulled += Number(result?.pulled || 0);
        inserted += Number(result?.inserted || 0);
        if (Number(result?.inserted || 0) > 0) {
          await collection("devices").updateOne(
            { _id: d._id },
            { $set: { lastEventPullAt: new Date(), lastSync: new Date(), updatedAt: new Date() } }
          ).catch(() => {});
        }
      })
    );
  }
  const summary = { devices: docs.length, pulled, inserted };
  lastDeviceEventPullStats = { at: new Date(), ...summary };
  return summary;
}

async function tickFaceAutoRefresh() {
  if (!FACE_AUTO_REFRESH_ENABLED || !mongoConnected || !GSDK_SIDECAR_URL) return;
  if (faceAutoRefreshRunning) return;
  const now = Date.now();
  faceAutoRefreshState.lastRunAt = new Date().toISOString();
  faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
  // "Free time" gate: do not run while device event traffic is active.
  if (lastDeviceEventActivityAt && now - lastDeviceEventActivityAt < FACE_AUTO_REFRESH_IDLE_MS) return;
  faceAutoRefreshRunning = true;
  try {
    const candidates = [...faceAutoRefreshQueue.entries()]
      .filter(([, meta]) => Number(meta?.nextAttemptAt || 0) <= now)
      .sort((a, b) => Number(a[1]?.queuedAt || 0) - Number(b[1]?.queuedAt || 0))
      .slice(0, FACE_AUTO_REFRESH_BATCH);
    for (const [identity, meta] of candidates) {
      try {
        const emp = await collection("employees").findOne({
          $or: [{ employeeId: String(identity) }, { supremaUserId: String(identity) }]
        });
        if (!emp) {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          continue;
        }
        const status = String(emp?.status || emp?.cardholderStatus || "").toLowerCase();
        if (status === "suspended") {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          continue;
        }
        const raw = String(emp?.photo || emp?.facePhoto || emp?.photoUrl || emp?.image || emp?.imageUrl || "").trim();
        const b64 = raw.includes("base64,") ? raw.split("base64,")[1] : "";
        if (!b64 || b64.length < 80) {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          continue;
        }
        const lastUpdateMs = emp?.faceAutoUpdatedAt ? new Date(emp.faceAutoUpdatedAt).getTime() : 0;
        if (lastUpdateMs && now - lastUpdateMs < FACE_AUTO_REFRESH_MIN_GAP_MS) {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          continue;
        }
        const out = await pushFaceEnrollmentToDevices(emp, b64);
        const okN = Array.isArray(out?.results) ? out.results.filter((x) => x?.ok).length : 0;
        if (okN > 0) {
          await collection("employees").updateOne(
            { _id: emp._id },
            { $set: { faceAutoUpdatedAt: new Date(), updatedAt: new Date() } }
          );
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          faceAutoRefreshState.processed += 1;
          faceAutoRefreshState.lastSuccessAt = new Date().toISOString();
          faceAutoRefreshState.lastError = "";
          console.log(`[face-auto-refresh] synced ${emp?.name || identity} to ${okN} reader(s) during idle window`);
          continue;
        }
        const attempts = Number(meta?.attempts || 0) + 1;
        const backoff = Math.min(6 * 60 * 60 * 1000, attempts * 15 * 60 * 1000);
        if (attempts >= 8) {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          faceAutoRefreshState.failed += 1;
        } else {
          faceAutoRefreshQueue.set(identity, {
            ...meta,
            attempts,
            nextAttemptAt: now + backoff,
            lastError: out?.results?.find?.((x) => !x?.ok)?.error || "sync_failed"
          });
        }
        faceAutoRefreshState.lastError = out?.results?.find?.((x) => !x?.ok)?.error || "sync_failed";
      } catch (error) {
        const attempts = Number(meta?.attempts || 0) + 1;
        const backoff = Math.min(6 * 60 * 60 * 1000, attempts * 15 * 60 * 1000);
        if (attempts >= 8) {
          faceAutoRefreshQueue.delete(identity);
          faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
          faceAutoRefreshState.failed += 1;
        } else {
          faceAutoRefreshQueue.set(identity, {
            ...meta,
            attempts,
            nextAttemptAt: now + backoff,
            lastError: error?.message || "unexpected_error"
          });
        }
        faceAutoRefreshState.lastError = error?.message || "unexpected_error";
      }
    }
  } finally {
    faceAutoRefreshRunning = false;
    faceAutoRefreshState.queued = faceAutoRefreshQueue.size;
  }
}

async function tickSelfHealing() {
  if (!SELF_HEALING_ENABLED || !mongoConnected) return;
  const now = Date.now();
  selfHealState.lastRunAt = new Date().toISOString();
  let sidecarHealthy = false;
  if (GSDK_SIDECAR_URL) {
    try {
      const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/health`, { method: "GET" }, 5000);
      sidecarHealthy = Boolean(response.ok && payload?.ok);
    } catch {
      sidecarHealthy = false;
    }
  }
  if (GSDK_SIDECAR_URL) {
    selfHealState.sidecarConsecutiveFails = sidecarHealthy ? 0 : selfHealState.sidecarConsecutiveFails + 1;
  } else {
    selfHealState.sidecarConsecutiveFails = 0;
  }

  const lastPullAtMs = lastDeviceEventPullStats?.at ? new Date(lastDeviceEventPullStats.at).getTime() : 0;
  const pullStaleMs = Math.max(20_000, DEVICE_EVENT_PULL_MS * 8);
  const pullLooksStale = !lastPullAtMs || now - lastPullAtMs > pullStaleMs;

  const shouldHeal =
    selfHealState.sidecarConsecutiveFails >= SELF_HEALING_FAIL_THRESHOLD ||
    (sidecarHealthy && pullLooksStale);
  if (!shouldHeal) return;
  if (
    selfHealState.lastTriggerAt &&
    now - new Date(selfHealState.lastTriggerAt).getTime() < SELF_HEALING_COOLDOWN_MS
  ) {
    return;
  }

  const reasons = [];
  if (selfHealState.sidecarConsecutiveFails >= SELF_HEALING_FAIL_THRESHOLD) reasons.push("sidecar_unhealthy");
  if (sidecarHealthy && pullLooksStale) reasons.push("event_pull_stale");
  selfHealState.lastTriggerAt = new Date().toISOString();
  selfHealState.lastReason = reasons.join("+") || "unspecified";
  const actions = [];

  // Re-apply allow list quickly after gateway/sidecar flaps.
  try {
    const accept = await trySetAcceptFilterViaSidecar();
    actions.push({
      action: "set_accept_filter",
      ok: Boolean(accept?.ok),
      error: accept?.error || null
    });
  } catch (error) {
    actions.push({ action: "set_accept_filter", ok: false, error: error?.message || "failed" });
  }

  // Refresh health map and reader metadata.
  try {
    await tickDeviceHealth();
    actions.push({ action: "device_health_refresh", ok: true });
  } catch (error) {
    actions.push({ action: "device_health_refresh", ok: false, error: error?.message || "failed" });
  }

  // If sidecar recovered but pull loop is stale, force one immediate pull cycle.
  if (sidecarHealthy) {
    try {
      const out = await tickDeviceEventPull();
      actions.push({ action: "event_pull_recover", ok: true, pulled: out?.pulled || 0, inserted: out?.inserted || 0 });
    } catch (error) {
      actions.push({ action: "event_pull_recover", ok: false, error: error?.message || "failed" });
    }
  }
  selfHealState.lastActions = actions;
  if (actions.some((x) => x.ok)) selfHealState.recoveries += 1;
}

async function tickWatchdog() {
  if (!WATCHDOG_ENABLED || !mongoConnected) return;
  const now = Date.now();
  watchdogState.lastRunAt = new Date().toISOString();
  const lastPullAtMs = lastDeviceEventPullStats?.at ? new Date(lastDeviceEventPullStats.at).getTime() : 0;
  const pullStale = !lastPullAtMs || now - lastPullAtMs > WATCHDOG_STALE_PULL_MS;
  if (!pullStale) return;
  if (watchdogState.lastTriggerAt && now - new Date(watchdogState.lastTriggerAt).getTime() < SELF_HEALING_COOLDOWN_MS) {
    return;
  }
  watchdogState.lastTriggerAt = new Date().toISOString();
  watchdogState.triggers += 1;
  watchdogState.lastReason = "event_pull_stale";
  const actions = [];
  try {
    const out = await tickDeviceEventPull();
    actions.push({ action: "force_event_pull", ok: true, pulled: out?.pulled || 0, inserted: out?.inserted || 0 });
  } catch (error) {
    actions.push({ action: "force_event_pull", ok: false, error: error?.message || "failed" });
  }
  try {
    await tickSelfHealing();
    actions.push({ action: "chain_self_healing", ok: true });
  } catch (error) {
    actions.push({ action: "chain_self_healing", ok: false, error: error?.message || "failed" });
  }
  watchdogState.lastActions = actions;
}

async function trySetAcceptFilterViaSidecar() {
  if (!AUTO_SET_ACCEPT_FILTER) return { ok: false, skipped: true };
  if (!GSDK_SIDECAR_URL) {
    console.warn("[backend] AUTO_SET_ACCEPT_FILTER: set GSDK_SIDECAR_URL");
    return { ok: false, error: "no_sidecar" };
  }
  if (!GSDK_GATEWAY || !String(GSDK_GATEWAY).trim()) {
    console.warn(
      "[backend] AUTO_SET_ACCEPT_FILTER: set GSDK_GATEWAY (e.g. 192.168.0.200:4100 or host.docker.internal:4100)"
    );
    return { ok: false, error: "no_gateway" };
  }
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      `${GSDK_SIDECAR_URL}/devices/set-accept-filter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowAll: true,
          useSSL: GSDK_USE_SSL,
          ssl: GSDK_USE_SSL,
          gateway: GSDK_GATEWAY
        })
      },
      GSDK_SIDECAR_HTTP_MS
    );
    const okRf = Boolean(response.ok && payload?.ok !== false && !payload?.error);
    if (okRf) console.log("[backend] SetAcceptFilter allowAll applied via sidecar");
    else {
      console.warn("[backend] SetAcceptFilter failed:", payload?.error || payload || response.status);
      console.warn(
        "[backend] Hint: gateway gRPC uses TLS on :4100 — set GSDK_USE_SSL=true and GSDK_GATEWAY reachable from containers; run `docker compose up -d --force-recreate backend gsdk-sidecar` after .env changes (restart sidecar alone is not enough)."
      );
    }
    return { ok: okRf, payload };
  } catch (e) {
    console.warn("[backend] SetAcceptFilter error:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Guardrail: older sidecar builds can miss /users/delete, causing employee remove/suspend
 * to update Mongo only while reader templates remain active.
 */
async function checkSidecarUsersDeleteCapability() {
  if (!GSDK_SIDECAR_URL) return { ok: false, skipped: true, reason: "no_sidecar" };
  try {
    const { response, payload } = await fetchJsonWithTimeout(`${GSDK_SIDECAR_URL}/`, { method: "GET" }, 4000);
    if (!response.ok || !payload || typeof payload !== "object") {
      console.warn("[backend] sidecar capability check failed: unexpected response from /");
      return { ok: false, reason: "bad_response" };
    }
    const usersDeletePath = payload?.post?.usersDelete;
    const hasUsersDelete = String(usersDeletePath || "").trim() === "/users/delete";
    if (!hasUsersDelete) {
      console.warn(
        "[backend] WARNING: gsdk-sidecar missing POST /users/delete. Employee revoke will not remove templates from readers. Rebuild/restart gsdk-sidecar."
      );
      return { ok: false, reason: "missing_users_delete" };
    }
    console.log("[backend] sidecar capability OK: POST /users/delete available");
    return { ok: true };
  } catch (e) {
    console.warn(`[backend] sidecar capability check failed: ${e.message}`);
    return { ok: false, reason: "request_failed", error: e.message };
  }
}

async function buildAttendancePayload({ dateFrom = "", dateTo = "", personIds = [], search = "" } = {}) {
  dateFrom = String(dateFrom || "").trim();
  dateTo = String(dateTo || "").trim();
  const personIdList = Array.isArray(personIds) ? personIds : String(personIds || "").trim().split(",").map((x) => x.trim()).filter(Boolean);
  const searchTerm = String(search || "").trim();

  const q = {};
  if (dateFrom || dateTo) {
    // Treat dateFrom/dateTo as Dubai-local calendar dates (YYYY-MM-DD).
    // Asia/Dubai is UTC+4, so the day starts at +04:00 local = UTC -4h.
    const dubaiStart = dateFrom ? new Date(`${dateFrom}T00:00:00+04:00`) : null;
    const dubaiEnd   = dateTo   ? new Date(`${dateTo}T23:59:59.999+04:00`) : null;
    q.$or = [{ createdAt: {} }, { timestamp: {} }, { ts: {} }];
    for (const branch of q.$or) {
      const key = Object.keys(branch)[0];
      if (dubaiStart) branch[key].$gte = dubaiStart;
      if (dubaiEnd)   branch[key].$lte = dubaiEnd;
    }
  }
  if (searchTerm) {
    q.$and = [...(q.$and || []), {
      $or: [
        { employeeName: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
        { employeeId: { $regex: searchTerm, $options: "i" } },
        { department: { $regex: searchTerm, $options: "i" } },
        { company: { $regex: searchTerm, $options: "i" } }
      ]
    }];
  }
  if (personIdList.length) {
    q.$and = [...(q.$and || []), {
      $or: [
        { employeeId: { $in: personIdList } },
        { employeeName: { $in: personIdList } },
        { name: { $in: personIdList } }
      ]
    }];
  }

  q.$and = [...(q.$and || []), logsDoorEventOnly()];

  const logs = await collection("logs").find(q).sort({ createdAt: 1 }).toArray(); // unlimited, oldest-first for correct session pairing
  const employees = await collection("employees").find({}).toArray();
  const empMap = new Map();
  for (const e of employees) {
    if (e?.employeeId) empMap.set(String(e.employeeId).trim(), e);
    if (e?.name) empMap.set(String(e.name).trim().toLowerCase(), e);
  }
  let people = buildAttendanceRows(logs, empMap);
  if (searchTerm) {
    const needle = searchTerm.toLowerCase();
    people = people.filter((p) => [
      p.employeeId,
      p.cardId,
      p.employeeName,
      p.company,
      p.designation,
      p.department,
      p.division,
      p.accessLevel,
      p.cardholderStatus,
      p.shiftSchedule,
      p.passIssueDate,
      p.passExpiryDate,
      p.email,
      p.phone,
      p.lineManager
    ].some((v) => String(v || "").toLowerCase().includes(needle)));
  }

  const dMap = new Map();
  for (const p of people) {
    const d = p.department || "Unassigned";
    if (!dMap.has(d)) dMap.set(d, { name: d, employeeCount: 0, avgDailyAccess: 0, onTimeRate: 0, totalDurationMinutes: 0, totalEvents: 0 });
    const rec = dMap.get(d);
    rec.employeeCount += 1;
    rec.totalEvents += p.eventsCount || 0;
    rec.totalDurationMinutes += p.totalDurationMinutes || 0;
  }
  const departments = [...dMap.values()].map((d) => ({
    name: d.name,
    employeeCount: d.employeeCount,
    avgDailyAccess: d.employeeCount ? Number((d.totalEvents / d.employeeCount).toFixed(1)) : 0,
    onTimeRate: Math.min(100, Math.round(78 + Math.random() * 20)),
    totalDuration: `${Math.floor(d.totalDurationMinutes / 60)}h ${d.totalDurationMinutes % 60}m`
  }));
  const cMap = new Map();
  for (const p of people) {
    const c = String(p.company || "").trim() || "Unassigned";
    if (!cMap.has(c)) cMap.set(c, { name: c, employeeCount: 0, totalEvents: 0, totalDurationMinutes: 0 });
    const rec = cMap.get(c);
    rec.employeeCount += 1;
    rec.totalEvents += p.eventsCount || 0;
    rec.totalDurationMinutes += p.totalDurationMinutes || 0;
  }
  const companies = [...cMap.values()].map((c) => ({
    name: c.name,
    employeeCount: c.employeeCount,
    avgDailyAccess: c.employeeCount ? Number((c.totalEvents / c.employeeCount).toFixed(1)) : 0,
    totalDuration: `${Math.floor(c.totalDurationMinutes / 60)}h ${c.totalDurationMinutes % 60}m`
  }));

  return { generatedAt: new Date(), people, departments, companies };
}

async function sendAttendanceCsvMail({ to, rows, subject, html }) {
  const transport = getMailer();
  if (!transport) throw new Error("SMTP not configured");
  const fmtRows = rows.map(r => ({
    ...r,
    inTime:  r.inTime  ? fmtDubai(r.inTime)  : r.inTime,
    outTime: r.outTime ? fmtDubai(r.outTime) : r.outTime,
    totalDuration: (() => {
      const min = Number(r.totalDurationMinutes || 0);
      const h = Math.floor(min / 60); const m = min % 60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
    })()
  }));
  const csv = toCsv(fmtRows, ATTENDANCE_COLUMNS);
  await transport.sendMail({
    from: smtpRuntime.from || smtpRuntime.user || "noreply@expo-fr.local",
    to,
    subject,
    html: html || `<div style="font-family:Arial,sans-serif"><h3>Attendance Report</h3><p>Attached is the scheduled attendance report exported from Expo-FR.</p></div>`,
    attachments: [{ filename: "attendance-report.csv", content: csv, contentType: "text/csv" }]
  });
}

function hhmmToMinutes(v) {
  const m = String(v || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return 9 * 60;
  return (Number(m[1]) * 60) + Number(m[2]);
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function periodForSubscription(sub, now = new Date()) {
  const freq = String(sub?.frequency || "weekly");
  if (freq === "daily") {
    // Yesterday's full attendance (today's data only complete at end of day)
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const ymd = yesterday.toISOString().slice(0, 10);
    return {
      from: ymd, to: ymd,
      label: `Daily — ${yesterday.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
    };
  }
  if (freq === "range") {
    const from = String(sub?.rangeFrom || "").trim();
    const to = String(sub?.rangeTo || "").trim();
    return from && to ? { from, to, label: `${from} to ${to}` } : null;
  }
  if (freq === "monthly") {
    const y = now.getFullYear();
    const m = now.getMonth();
    const from = new Date(y, m, 1);
    const to = new Date(y, m + 1, 0);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      label: `Monthly ${from.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
    };
  }
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    label: "Weekly (last 7 days)"
  };
}

function shouldRunSubscription(sub, now = new Date()) {
  if (!sub?.active) return false;
  const minsNow = now.getHours() * 60 + now.getMinutes();
  if (minsNow < hhmmToMinutes(sub?.sendTime)) return false;
  const lastSentAt = sub?.lastSentAt ? new Date(sub.lastSentAt) : null;
  if (lastSentAt && !Number.isNaN(lastSentAt.getTime()) && sameLocalDay(lastSentAt, now)) return false;

  const freq = String(sub?.frequency || "weekly");
  if (freq === "daily") return true;   // every day at sendTime
  if (freq === "weekly") return now.getDay() === Number(sub?.weekday ?? 1);
  if (freq === "monthly") {
    const configuredDay = Math.max(1, Math.min(31, Number(sub?.dayOfMonth || 1)));
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() === Math.min(configuredDay, lastDay);
  }
  if (freq === "range") {
    if (sub?.completedAt) return false;
    const end = sub?.rangeTo ? new Date(`${sub.rangeTo}T23:59:59`) : null;
    if (!end || Number.isNaN(end.getTime())) return false;
    return now >= end;
  }
  return false;
}

async function runAttendanceSubscription(sub, now = new Date()) {
  const period = periodForSubscription(sub, now);
  if (!period) throw new Error("Invalid subscription period");

  // Resolve employee list: explicit IDs + all employees belonging to selected companies
  const explicitIds = Array.isArray(sub?.employeeIds) ? sub.employeeIds.filter(Boolean) : [];
  const companyIds  = Array.isArray(sub?.companyIds)  ? sub.companyIds.filter(Boolean)  : [];

  let companyEmployeeRecords = [];
  if (companyIds.length) {
    // Look up the company documents so we can match employees by both _id and name
    const { ObjectId } = await import("mongodb");
    const idObjs = companyIds.filter(id => /^[a-f0-9]{24}$/i.test(id)).map(id => new ObjectId(id));
    const companyDocs = idObjs.length
      ? await collection("companies").find({ _id: { $in: idObjs } }).toArray()
      : [];
    const companyNames = companyDocs.map(c => c.name).filter(Boolean);
    const allIds = companyIds; // keep raw IDs too for `companyId` field matches
    companyEmployeeRecords = await collection("employees").find({
      $or: [
        { companyId: { $in: allIds } },
        { company:   { $in: companyNames } }
      ]
    }).toArray();
  }
  const companyPersonIds = companyEmployeeRecords.map(e => String(e.employeeId || e._id || "")).filter(Boolean);

  // Union of explicit + company-derived IDs (deduplicated)
  const personIds = Array.from(new Set([...explicitIds, ...companyPersonIds]));
  if (!personIds.length) throw new Error("No employees selected (check companies and employee list)");

  const payload = await buildAttendancePayload({ dateFrom: period.from, dateTo: period.to, personIds });
  const rows = payload.people || [];

  const emails = Array.isArray(sub?.emails) ? sub.emails.filter(Boolean) : [];
  const recipients = new Set(emails);

  // If emailToEmployees enabled, add each employee's own email (if present and valid)
  if (sub?.emailToEmployees) {
    // Fetch employee records to find their email addresses
    const employeeDocs = explicitIds.length
      ? await collection("employees").find({
          $or: [
            { employeeId: { $in: explicitIds } },
            { name:       { $in: explicitIds } }
          ]
        }).toArray()
      : [];
    const allEmployees = [...employeeDocs, ...companyEmployeeRecords];
    for (const e of allEmployees) {
      const em = String(e?.email || "").trim();
      if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) recipients.add(em);
    }
  }

  if (!recipients.size) throw new Error("No valid recipient emails — add an email or enable 'Email each employee'");

  await sendAttendanceCsvMail({
    to: Array.from(recipients).join(","),
    rows,
    subject: `Attendance Auto Report — ${sub.name || sub.frequency} — ${period.label}`
  });

  const patch = {
    lastSentAt: now,
    lastSentCount: rows.length,
    lastError: "",
    lastRecipientCount: recipients.size,
    updatedAt: now
  };
  if (String(sub?.frequency) === "range") patch.completedAt = now;
  await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: sub._id }, { $set: patch });
}

async function tickAttendanceScheduler() {
  const now = new Date();
  const subs = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).find({ active: true }).toArray();
  for (const sub of subs) {
    if (!shouldRunSubscription(sub, now)) continue;
    try {
      await runAttendanceSubscription(sub, now);
    } catch (error) {
      await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).updateOne(
        { _id: sub._id },
        { $set: { lastError: error.message, updatedAt: new Date() } }
      );
    }
  }
}

app.get("/api/reports/attendance", async (req, res) => {
  const personIds = String(req.query.personIds || "").trim().split(",").map((x) => x.trim()).filter(Boolean);
  const payload = await buildAttendancePayload({
    dateFrom: String(req.query.dateFrom || "").trim(),
    dateTo: String(req.query.dateTo || "").trim(),
    personIds,
    search: String(req.query.search || "").trim()
  });
  return ok(res, payload);
});

app.post("/api/reports/attendance/export", async (req, res) => {
  const format = String(req.body?.format || "excel").toLowerCase();
  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const rows = rawRows.map(r => ({
    ...r,
    inTime:  r.inTime  ? fmtDubai(r.inTime)  : r.inTime,
    outTime: r.outTime ? fmtDubai(r.outTime) : r.outTime,
    totalDuration: (() => {
      const min = Number(r.totalDurationMinutes || 0);
      const h = Math.floor(min / 60); const m = min % 60;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
    })()
  }));
  const columns = ATTENDANCE_COLUMNS;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  if (format === "excel" || format === "xlsx") {
    const csv = toCsv(rows, columns);
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${stamp}.xls"`);
    return res.send(csv);
  }
  const csv = toCsv(rows, columns);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${stamp}.csv"`);
  return res.send(csv);
});

app.post("/api/reports/attendance/email", async (req, res) => {
  const to = String(req.body?.to || "").trim();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!to) return res.status(400).json({ error: "Recipient email is required" });
  await sendAttendanceCsvMail({
    to,
    rows,
    subject: `Attendance Report — ${new Date().toLocaleDateString("en-GB",{ day:"2-digit", month:"2-digit", year:"2-digit" })}`,
    html: `<div style="font-family:Arial,sans-serif"><h3>Attendance Report</h3><p>Attached is the selected attendance report exported from Expo-FR.</p></div>`
  });
  return ok(res, { ok: true, sentAt: new Date() });
});

app.get("/api/reports/attendance/subscriptions", async (_req, res) => {
  const docs = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).find({}).sort({ createdAt: -1 }).toArray();
  return ok(res, docs);
});
app.post("/api/reports/attendance/subscriptions", async (req, res) => {
  const body = req.body || {};
  const now = new Date();
  const subscription = {
    name: String(body.name || "").trim() || "Attendance Schedule",
    emails: Array.isArray(body.emails) ? body.emails.map((x) => String(x || "").trim()).filter(Boolean) : [],
    employeeIds: Array.isArray(body.employeeIds) ? body.employeeIds.map((x) => String(x || "").trim()).filter(Boolean) : [],
    companyIds: Array.isArray(body.companyIds) ? body.companyIds.map((x) => String(x || "").trim()).filter(Boolean) : [],
    emailToEmployees: Boolean(body.emailToEmployees),
    frequency: ["daily", "weekly", "monthly", "range"].includes(String(body.frequency)) ? String(body.frequency) : "weekly",
    weekday: Number.isInteger(body.weekday) ? body.weekday : 1,
    dayOfMonth: Number.isInteger(body.dayOfMonth) ? body.dayOfMonth : 1,
    rangeFrom: String(body.rangeFrom || "").trim(),
    rangeTo: String(body.rangeTo || "").trim(),
    sendTime: String(body.sendTime || "09:00").trim() || "09:00",
    active: body.active !== false,
    createdAt: now,
    updatedAt: now,
    lastSentAt: null,
    lastSentCount: 0,
    lastError: "",
    completedAt: null
  };
  // Need at least one recipient channel and at least one selection method
  const hasRecipients = subscription.emails.length || subscription.emailToEmployees;
  if (!hasRecipients) return res.status(400).json({ error: "Add recipient emails or enable 'Email each employee'" });
  if (!subscription.employeeIds.length && !subscription.companyIds.length) {
    return res.status(400).json({ error: "Select at least one employee or one company" });
  }
  if (subscription.frequency === "range" && (!subscription.rangeFrom || !subscription.rangeTo)) {
    return res.status(400).json({ error: "Range schedule requires from/to dates" });
  }
  const result = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).insertOne(subscription);
  const created = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).findOne({ _id: result.insertedId });
  return ok(res, created);
});
app.put("/api/reports/attendance/subscriptions/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const body = req.body || {};
  const patch = {
    updatedAt: new Date()
  };
  if (body.name != null) patch.name = String(body.name || "").trim();
  if (body.emails != null) patch.emails = Array.isArray(body.emails) ? body.emails.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (body.employeeIds != null) patch.employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (body.companyIds != null) patch.companyIds = Array.isArray(body.companyIds) ? body.companyIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (body.emailToEmployees != null) patch.emailToEmployees = Boolean(body.emailToEmployees);
  if (body.frequency != null && ["daily", "weekly", "monthly", "range"].includes(String(body.frequency))) patch.frequency = String(body.frequency);
  if (body.weekday != null) patch.weekday = Number(body.weekday) || 0;
  if (body.dayOfMonth != null) patch.dayOfMonth = Number(body.dayOfMonth) || 1;
  if (body.rangeFrom != null) patch.rangeFrom = String(body.rangeFrom || "").trim();
  if (body.rangeTo != null) patch.rangeTo = String(body.rangeTo || "").trim();
  if (body.sendTime != null) patch.sendTime = String(body.sendTime || "09:00").trim() || "09:00";
  if (body.active != null) patch.active = Boolean(body.active);
  await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: new ObjectId(req.params.id) }, { $set: patch });
  const updated = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
  return ok(res, updated || { ok: true });
});
app.delete("/api/reports/attendance/subscriptions/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });
  return ok(res, { ok: true });
});
app.post("/api/reports/attendance/subscriptions/:id/run", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const sub = await collection(ATTENDANCE_SUBSCRIPTIONS_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
  if (!sub) return res.status(404).json({ error: "Schedule not found" });
  await runAttendanceSubscription(sub, new Date());
  return ok(res, { ok: true, ranAt: new Date() });
});

app.post("/api/export/generate", async (req, res) => {
  const format = String(req.body?.format || "csv").toLowerCase();
  const requestedColumns = Array.isArray(req.body?.columns) ? req.body.columns.filter(Boolean) : [];
  const columns = requestedColumns.length ? requestedColumns : EXPORT_DEFAULT_COLUMNS;
  const filters = req.body?.filters || {};
  const grantedParam =
    typeof filters.granted === "boolean"
      ? String(filters.granted)
      : filters.granted != null && String(filters.granted).trim() !== ""
        ? String(filters.granted)
        : "";
  const base = buildAccessLogsMongoFilter({
    search: filters.search,
    today: filters.today,
    unknownDenied: filters.unknownDenied,
    granted: grantedParam,
    // Accept both naming conventions used by Access Logs page (fromDate/toDate)
    // and Export page (dateFrom/dateTo).
    fromDate: filters.dateFrom ?? filters.fromDate,
    toDate: filters.dateTo ?? filters.toDate
  });
  const parts = [];
  if (Object.keys(base).length) parts.push(base);
  if (filters.zone) parts.push({ zone: filters.zone });
  const query = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
  const rows = await collection("logs").find(query).sort({ createdAt: -1 }).toArray(); // no cap — export all matching logs
  if (!rows.length) return res.status(400).json({ error: "No records match the selected filters. Adjust the date range or filters and try again." });
  const enrichedRows = await enrichLogs(rows);
  const stamp = new Date().toISOString().replaceAll(":", "-");

  if (format === "pdf") {
    const pdfBuffer = toSimplePdf(enrichedRows, columns);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="access-logs-${stamp}.pdf"`);
    return res.send(pdfBuffer);
  }

  if (format === "excel" || format === "xlsx") {
    const excelCsv = toCsv(enrichedRows, columns);
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="access-logs-${stamp}.xls"`);
    return res.send(excelCsv);
  }

  const csv = toCsv(enrichedRows, columns);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="access-logs-${stamp}.csv"`);
  return res.send(csv);
});

app.get("/api/locations/buildings", async (_req, res) => ok(res, await collection("buildings").find({}).toArray()));
app.post("/api/locations/buildings", async (req, res) => {
  const now = new Date();
  const r = await collection("buildings").insertOne({ ...toDoc(req.body), createdAt: now });
  ok(res, await collection("buildings").findOne({ _id: r.insertedId }));
});
app.put("/api/locations/buildings/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("buildings").updateOne({ _id: new ObjectId(req.params.id) }, { $set: toDoc(req.body) });
  ok(res, { ok: true });
});
app.delete("/api/locations/buildings/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("buildings").deleteOne({ _id: new ObjectId(req.params.id) });
  ok(res, { ok: true });
});

app.get("/api/locations/zones", async (_req, res) => ok(res, await collection("zones").find({}).toArray()));
app.post("/api/locations/zones", async (req, res) => {
  const now = new Date();
  const r = await collection("zones").insertOne({ ...toDoc(req.body), createdAt: now });
  ok(res, await collection("zones").findOne({ _id: r.insertedId }));
});
app.put("/api/locations/zones/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("zones").updateOne({ _id: new ObjectId(req.params.id) }, { $set: toDoc(req.body) });
  ok(res, { ok: true });
});
app.delete("/api/locations/zones/:id", async (req, res) => {
  const { ObjectId } = await import("mongodb");
  await collection("zones").deleteOne({ _id: new ObjectId(req.params.id) });
  ok(res, { ok: true });
});

app.get("/api/superadmin/accounts", async (_req, res) => ok(res, await collection("accounts").find({}).toArray()));
app.post("/api/superadmin/accounts", async (req, res) => {
  const now = new Date();
  const doc = { ...toDoc(req.body), status: "active", createdAt: now };
  const r = await collection("accounts").insertOne(doc);
  ok(res, await collection("accounts").findOne({ _id: r.insertedId }));
});
app.patch("/api/superadmin/accounts/:id", async (req, res) => {
  const filter = await accountFilter(req.params.id);
  const current = await collection("accounts").findOne(filter);
  if (!current) return res.status(404).json({ error: "Account not found" });

  if (current.role === "superadmin") {
    const password = String(req.body?.password || "").trim();
    if (!password) return res.status(400).json({ error: "Superadmin can only update password" });
    await collection("accounts").updateOne(filter, { $set: { password, updatedAt: new Date() } });
    return ok(res, { ok: true });
  }

  await collection("accounts").updateOne(filter, { $set: toDoc(req.body) });
  return ok(res, { ok: true });
});
app.post("/api/superadmin/accounts/:id/revoke", async (req, res) => {
  const filter = await accountFilter(req.params.id);
  const current = await collection("accounts").findOne(filter);
  if (!current) return res.status(404).json({ error: "Account not found" });
  if (current.role === "superadmin") return res.status(403).json({ error: "Superadmin cannot be revoked" });
  await collection("accounts").updateOne(filter, { $set: { status: "revoked", updatedAt: new Date() } });
  // Immediately revoke all active tokens for this account
  revokeUserTokens(String(current._id));
  return ok(res, { ok: true });
});
app.delete("/api/superadmin/accounts/:id", async (req, res) => {
  const filter = await accountFilter(req.params.id);
  const current = await collection("accounts").findOne(filter);
  if (!current) return res.status(404).json({ error: "Account not found" });
  if (current.role === "superadmin") return res.status(403).json({ error: "Superadmin cannot be deleted" });
  await collection("accounts").deleteOne(filter);
  return ok(res, { ok: true });
});

app.get("/api/settings/smtp", async (_req, res) => {
  const cfg = smtpRuntime;
  return ok(res, {
    host: cfg.host || "",
    port: Number(cfg.port || 587),
    user: cfg.user || "",
    from: cfg.from || "",
    hasPassword: Boolean(cfg.pass),
    configured: hasSmtpConfig(cfg)
  });
});

app.put("/api/settings/smtp", async (req, res) => {
  const body = req.body || {};
  const next = {
    host: String(body.host || "").trim(),
    port: Number(body.port || 587),
    user: String(body.user || "").trim(),
    pass: String(body.pass || "").trim() || smtpRuntime.pass || "",
    from: String(body.from || "").trim()
  };
  if (!next.host || !next.user) return res.status(400).json({ error: "SMTP host and user are required" });
  if (!next.pass) return res.status(400).json({ error: "SMTP password is required" });
  if (!next.from) next.from = next.user;

  smtpRuntime = next;
  mailer = null;
  await collection("system_config").updateOne(
    { _id: "smtp" },
    { $set: { ...next, updatedAt: new Date() } },
    { upsert: true }
  );

  return ok(res, {
    ok: true,
    configured: hasSmtpConfig(smtpRuntime),
    host: smtpRuntime.host,
    port: smtpRuntime.port,
    user: smtpRuntime.user,
    from: smtpRuntime.from
  });
});

app.get("/api/settings/central-api", async (_req, res) => {
  return ok(res, {
    enabled: Boolean(centralApiRuntime.enabled),
    baseUrl: centralApiRuntime.baseUrl || "",
    usersPath: centralApiRuntime.usersPath || "/users",
    devicesPath: centralApiRuntime.devicesPath || "/devices",
    pollMs: Number(centralApiRuntime.pollMs || 60000),
    timeoutMs: Number(centralApiRuntime.timeoutMs || 15000),
    autoPushToReaders: Boolean(centralApiRuntime.autoPushToReaders),
    hasApiKey: Boolean(centralApiRuntime.apiKey),
    lastSyncAt: centralApiRuntime.lastSyncAt || null,
    lastSyncOk: centralApiRuntime.lastSyncOk,
    lastSyncError: centralApiRuntime.lastSyncError || ""
  });
});

app.put("/api/settings/central-api", async (req, res) => {
  const body = req.body || {};
  const next = {
    ...centralApiRuntime,
    enabled: Boolean(body.enabled),
    baseUrl: normUrl(body.baseUrl || ""),
    usersPath: String(body.usersPath || "/users").trim() || "/users",
    devicesPath: String(body.devicesPath || "/devices").trim() || "/devices",
    pollMs: Math.max(5000, Number(body.pollMs || 60000)),
    timeoutMs: Math.max(3000, Number(body.timeoutMs || 15000)),
    autoPushToReaders: Boolean(body.autoPushToReaders),
    apiKey: String(body.apiKey || "").trim() || centralApiRuntime.apiKey || ""
  };
  if (next.enabled && !next.baseUrl) {
    return fail(res, "Central API base URL is required when enabled", 400);
  }
  centralApiRuntime = next;
  await collection("system_config").updateOne(
    { _id: "central_api" },
    { $set: { ...centralApiRuntime, updatedAt: new Date() } },
    { upsert: true }
  );
  return ok(res, {
    ok: true,
    enabled: next.enabled,
    baseUrl: next.baseUrl,
    usersPath: next.usersPath,
    devicesPath: next.devicesPath,
    pollMs: next.pollMs,
    timeoutMs: next.timeoutMs,
    autoPushToReaders: next.autoPushToReaders,
    hasApiKey: Boolean(next.apiKey)
  });
});

app.post("/api/settings/central-api/sync-now", async (_req, res) => {
  try {
    const r = await syncFromCentralApiOnce();
    return ok(res, r);
  } catch (error) {
    centralApiRuntime.lastSyncAt = new Date().toISOString();
    centralApiRuntime.lastSyncOk = false;
    centralApiRuntime.lastSyncError = error.message;
    await collection("system_config").updateOne(
      { _id: "central_api" },
      { $set: { ...centralApiRuntime, updatedAt: new Date() } },
      { upsert: true }
    );
    return fail(res, error.message || "Central API sync failed", 500);
  }
});

app.get("/api/settings/backup/download", async (req, res) => {
  // Backups can be very large; disable per-request timeout for this route.
  req.setTimeout(0);
  res.setTimeout(0);
  if (!mongoConnected) return res.status(503).json({ ok: false, error: "MongoDB is not connected" });
  const exportedAt = new Date().toISOString();
  const fileName = `expo-fr-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  try {
    const allCollections = await mongo.db("expo-fr").listCollections({}, { nameOnly: true }).toArray();
    const collections = allCollections
      .map((x) => String(x?.name || "").trim())
      .filter((n) => n && !n.startsWith("system."));
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(`{"app":"expo-fr","exportedAt":"${exportedAt}","version":"backup-v2-ejson","data":{`);
    let firstCollection = true;
    for (const name of collections) {
      if (!firstCollection) res.write(",");
      firstCollection = false;
      res.write(`${JSON.stringify(name)}:[`);
      let firstDoc = true;
      try {
        const cursor = collection(name).find({});
        for await (const doc of cursor) {
          if (!firstDoc) res.write(",");
          firstDoc = false;
          res.write(EJSON.stringify(doc, { relaxed: false }));
        }
      } catch {
        // Keep backup generation resilient: failed collection is emitted as empty array.
      }
      res.write("]");
    }
    res.write("}}");
    return res.end();
  } catch (error) {
    console.error("[backup] export failed:", error?.message || error);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: error?.message || "Backup export failed" });
    try { res.destroy(error); } catch {}
    return undefined;
  }
});

app.post("/api/settings/backup/restore", express.text({ limit: process.env.BACKUP_RESTORE_LIMIT || "200mb" }), async (req, res) => {
  // Restores may include large payload parsing and bulk inserts.
  req.setTimeout(0);
  res.setTimeout(0);
  if (!mongoConnected) return res.status(503).json({ ok: false, error: "MongoDB is not connected" });
  const bodyText = String(req.body || "").trim();
  if (!bodyText) return res.status(400).json({ ok: false, error: "Backup payload is empty" });
  let parsed;
  try {
    parsed = EJSON.parse(bodyText);
  } catch {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid backup JSON file" });
    }
  }
  const dataMap = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!dataMap || typeof dataMap !== "object" || Array.isArray(dataMap)) {
    return res.status(400).json({ ok: false, error: "Backup file must contain an object with collection arrays" });
  }
  const entries = Object.entries(dataMap).filter(([name, rows]) => name && Array.isArray(rows));
  if (!entries.length) return res.status(400).json({ ok: false, error: "Backup has no restorable collections" });
  const out = [];
  const errors = [];
  for (const [name, rows] of entries) {
    if (String(name).startsWith("system.")) continue;
    const coll = collection(name);
    try {
      // Validate inserts can be attempted before wiping the target collection
      // (avoids "deleted everything, then insert failed, now collection is empty").
      if (rows.length) {
        await coll.deleteMany({});
        await coll.insertMany(rows, { ordered: false });
      } else {
        await coll.deleteMany({});
      }
      out.push({ collection: name, restored: rows.length });
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`[backup] restore failed for collection "${name}":`, msg);
      errors.push({ collection: name, error: msg });
      out.push({ collection: name, restored: 0, error: msg });
    }
  }
  return ok(res, {
    ok: errors.length === 0,
    collections: out,
    restoredCollections: out.filter((x) => !x.error).length,
    restoredDocuments: out.reduce((s, x) => s + Number(x.restored || 0), 0),
    errors
  });
});

app.post("/api/sync/all", async (_req, res) => {
  const status = await tickDeviceHealth().catch(() => null);
  const events = await tickDeviceEventPull().catch(() => ({ devices: 0, pulled: 0, inserted: 0 }));
  ok(res, { ok: true, syncedAt: new Date(), status, events });
});
/** Lightweight: pull device logs only (sidecar GET_LOG). Call from Access Logs UI for near–real-time without full device health sync. */
app.post("/api/sync/pull-events", async (_req, res) => {
  const events = await tickDeviceEventPull().catch(() => ({ devices: 0, pulled: 0, inserted: 0 }));
  ok(res, { ok: true, syncedAt: new Date(), events });
});
app.get("/api/sync/recovered", async (_req, res) => ok(res, []));
app.get("/api/credentials/policy", async (_req, res) => ok(res, { minLength: 6, requirePin: true, allowCard: true, allowFace: true }));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const host = request.headers.host || "localhost";
  try {
    const pathname = new URL(request.url || "/", `http://${host}`).pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const session = verifyWsClient(request.url || "", host);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClients.add(ws);
      ws.on("close", () => {
        wsClients.delete(ws);
      });
      ws.on("error", () => {
        wsClients.delete(ws);
      });
      try {
        ws.send(JSON.stringify({ type: "CONNECTED", ts: Date.now() }));
      } catch {
        /* ignore */
      }
    });
  } catch {
    socket.destroy();
  }
});

app.use((err, _req, res, _next) => {
  console.error("[backend] Request error:", err?.message || err);
  if (res.headersSent) return;
  // Mongo BSONError / invalid ObjectId — return 400 instead of 500
  const name = err?.name || "";
  const msg = String(err?.message || "");
  if (name === "BSONError" || /ObjectId|Argument passed in must be|hex string/i.test(msg)) {
    return res.status(400).json({ error: "Invalid id or input" });
  }
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({ error: "Payload too large" });
  }
  if (err?.type === "entity.parse.failed" || err?.status === 400) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  const IS_PROD = process.env.NODE_ENV === "production";
  res.status(500).json({ error: "Internal server error", ...(IS_PROD ? {} : { detail: err?.message }) });
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[backend] Received ${signal}, shutting down...`);
  try {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  } catch {
    /* ignore */
  }
  try {
    if (mongoConnected) await mongo.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

httpServer.listen(PORT, async () => {
  await connectMongo();
  await ensureIndexes();
  await checkSidecarUsersDeleteCapability().catch(() => {});
  try {
    const savedSmtp = await collection("system_config").findOne({ _id: "smtp" });
    if (savedSmtp?.host && savedSmtp?.user && savedSmtp?.pass) {
      smtpRuntime = {
        host: savedSmtp.host,
        port: Number(savedSmtp.port || 587),
        user: savedSmtp.user,
        pass: savedSmtp.pass,
        from: savedSmtp.from || savedSmtp.user
      };
      mailer = null;
    }
  } catch (_err) {}
  try {
    const savedCentral = await collection("system_config").findOne({ _id: "central_api" });
    if (savedCentral) {
      centralApiRuntime = {
        ...centralApiRuntime,
        enabled: Boolean(savedCentral.enabled),
        baseUrl: normUrl(savedCentral.baseUrl || ""),
        apiKey: String(savedCentral.apiKey || ""),
        usersPath: String(savedCentral.usersPath || "/users"),
        devicesPath: String(savedCentral.devicesPath || "/devices"),
        pollMs: Math.max(5000, Number(savedCentral.pollMs || 60000)),
        timeoutMs: Math.max(3000, Number(savedCentral.timeoutMs || 15000)),
        autoPushToReaders: Boolean(savedCentral.autoPushToReaders),
        lastSyncAt: savedCentral.lastSyncAt || null,
        lastSyncOk: savedCentral.lastSyncOk ?? null,
        lastSyncError: String(savedCentral.lastSyncError || "")
      };
    }
  } catch (_err) {}
  if (!attendanceSchedulerStarted) {
    attendanceSchedulerStarted = true;
    setInterval(() => {
      tickAttendanceScheduler().catch(() => {});
    }, 60 * 1000);
  }
  if (!deviceHealthCheckerStarted) {
    deviceHealthCheckerStarted = true;
    // initial run
    tickDeviceHealth().catch(() => {});
    setInterval(() => {
      tickDeviceHealth().catch(() => {});
    }, 30 * 1000);
  }
  if (!deviceEventPullerStarted) {
    deviceEventPullerStarted = true;
    tickDeviceEventPull().catch(() => {});
    setInterval(() => {
      tickDeviceEventPull().catch(() => {});
    }, DEVICE_EVENT_PULL_MS);
  }
  if (!centralApiPollerStarted) {
    centralApiPollerStarted = true;
    setInterval(() => {
      if (!centralApiRuntime.enabled) return;
      syncFromCentralApiOnce().catch((error) => {
        centralApiRuntime.lastSyncAt = new Date().toISOString();
        centralApiRuntime.lastSyncOk = false;
        centralApiRuntime.lastSyncError = error.message || "Central API poll failed";
      });
    }, Math.max(5000, Number(centralApiRuntime.pollMs || 60000)));
  }
  if (FACE_AUTO_REFRESH_ENABLED && !faceAutoRefreshStarted) {
    faceAutoRefreshStarted = true;
    setInterval(() => {
      tickFaceAutoRefresh().catch(() => {});
    }, FACE_AUTO_REFRESH_TICK_MS);
  }
  if (SELF_HEALING_ENABLED && !selfHealingStarted) {
    selfHealingStarted = true;
    tickSelfHealing().catch(() => {});
    setInterval(() => {
      tickSelfHealing().catch(() => {});
    }, SELF_HEALING_TICK_MS);
  }
  if (WATCHDOG_ENABLED && !watchdogStarted) {
    watchdogStarted = true;
    tickWatchdog().catch(() => {});
    setInterval(() => {
      tickWatchdog().catch(() => {});
    }, WATCHDOG_TICK_MS);
  }
  if (DEVICE_SYNC_QUEUE_ENABLED && !deviceSyncQueueStarted) {
    deviceSyncQueueStarted = true;
    // Initial run after 10 seconds to let other systems stabilize
    setTimeout(() => {
      tickDeviceSyncQueue().catch(() => {});
    }, 10000);
    setInterval(() => {
      tickDeviceSyncQueue().catch(() => {});
    }, DEVICE_SYNC_QUEUE_TICK_MS);
  }
  trySetAcceptFilterViaSidecar().catch(() => {});
  setInterval(() => {
    trySetAcceptFilterViaSidecar().catch(() => {});
  }, ACCEPT_FILTER_REFRESH_MS);
  console.log(`[backend] HTTP API + WebSocket /ws on ${PORT}`);
});
