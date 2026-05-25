import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
  createContext, useContext, Fragment
} from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, ScatterChart, Scatter, ZAxis
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════════
   SUPREMA ENTERPRISE ACS  v6.0  —  FULL PRODUCTION
   ───────────────────────────────────────────────────────────────────────
   React 18 · Vite · MongoDB 7 · Node 18 · G-SDK 1.7.2
   Ollama ARIA · Claude Vision · Docker · Nginx
   Full RBAC · Offline sync · WebSocket
═══════════════════════════════════════════════════════════════════════ */

// ── API Base ──────────────────────────────────────────────────────────
// Remote / LAN: UI is often on :5173 but API is on :4000 (Docker exposes both).
// Set VITE_API_BASE_URL at build time if you terminate TLS or use a reverse proxy.
const BASE = (() => {
  const explicit = import.meta.env.VITE_API_BASE_URL;
  if (explicit) return `${String(explicit).replace(/\/$/, "")}/api`;
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return "http://localhost:4000/api";
  const { protocol } = window.location;
  return `${protocol}//${h}:4000/api`;
})();
const WS = (() => {
  // Build WebSocket URL safely: swap protocol, use /ws instead of /api
  const wsProto = BASE.startsWith("https") ? "wss" : "ws";
  const withoutProto = BASE.replace(/^https?:\/\//, "");
  const withoutApi = withoutProto.endsWith("/api") ? withoutProto.slice(0, -4) : withoutProto;
  return `${wsProto}://${withoutApi}/ws`;
})();

// ── Auth tokens ───────────────────────────────────────────────────────
const TK    = "acs_v6_token";
const TK_EXP = "acs_v6_token_exp";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 h session
const getToken = () => {
  try {
    const exp = Number(localStorage.getItem(TK_EXP) || 0);
    if (exp && Date.now() > exp) { localStorage.removeItem(TK); localStorage.removeItem(TK_EXP); return null; }
    return localStorage.getItem(TK);
  } catch { return null; }
};
const setToken = t => {
  try {
    localStorage.setItem(TK, t);
    localStorage.setItem(TK_EXP, String(Date.now() + TOKEN_TTL_MS));
  } catch {}
};
const clearToken = () => {
  try { localStorage.removeItem(TK); localStorage.removeItem(TK_EXP); } catch {}
};

// ── Offline queue ─────────────────────────────────────────────────────
const QK = "acs_v6_queue";
const getQ  = () => { try { return JSON.parse(localStorage.getItem(QK) || "[]"); } catch { return []; } };
const setQ  = q => { try { localStorage.setItem(QK, JSON.stringify(q)); } catch {} };
const pushQ = item => setQ([...getQ(), { ...item, t: Date.now() }]);

async function flushQueue(onProgress) {
  const MAX_RETRIES = 5;
  const MAX_AGE_MS  = 48 * 60 * 60 * 1000; // 48 h
  const now = Date.now();
  const q = getQ()
    .filter(item => (item.retries || 0) < MAX_RETRIES && (now - (item.t || 0)) < MAX_AGE_MS);
  if (!q.length) { setQ([]); return 0; }
  let ok = 0; const fail = [];
  for (const item of q) {
    try {
      await apiFetch(item.path, item.opts);
      ok++;
      onProgress?.(ok, q.length);
    } catch {
      fail.push({ ...item, retries: (item.retries || 0) + 1 });
    }
  }
  setQ(fail);
  return ok;
}

// ── Core fetch ────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const tok = getToken();
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (res.status === 401) {
    if (!opts.silent401) { clearToken(); window.dispatchEvent(new Event("acs:logout")); }
    return null;
  }
  const dispo = res.headers.get("content-disposition") || "";
  const isAttachment =
    /attachment/i.test(dispo) ||
    (/filename=/i.test(dispo) && !/inline/i.test(dispo.split("filename")[0] || ""));
  if (isAttachment) {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || err.message || `HTTP ${res.status}`);
    }
    return res;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || `HTTP ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;   // raw for streams / downloads
}

async function saveDownloadResponse(res, fallbackBase = "export") {
  if (!res || typeof res.blob !== "function") throw new Error("No download file returned by server");
  const blob = await res.blob();
  const dispo = res.headers?.get?.("content-disposition") || "";
  const match = dispo.match(/filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i);
  const filename = decodeURIComponent((match?.[1] || "").trim()) || `${fallbackBase}-${Date.now()}`;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function gunzipTextFromBuffer(buf) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser does not support .json.gz restore. Please use a .json backup file.");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8").decode(ab);
}

// ── API surface ───────────────────────────────────────────────────────
const api = {
  // auth
  login:   b => apiFetch("/auth/login",  { method:"POST", body:JSON.stringify(b) }),
  me:      () => apiFetch("/auth/me"),
  logout:  () => apiFetch("/auth/logout", { method:"POST" }),

  // health
  // Cache-bust health checks so header KPIs stay live without browser refresh.
  health: () => apiFetch(`/health?_=${Date.now()}`, { silent401: true }),
  gsdkDiagnostics: () => apiFetch("/gsdk/diagnostics"),
  gsdkFaceConfig: b => apiFetch("/gsdk/face-config", { method:"POST", body:JSON.stringify(b) }),

  // employees
  employees:       p => apiFetch(`/employees?${new URLSearchParams(p)}`),
  employee:        id => apiFetch(`/employees/${id}`),
  empCreate:       b  => apiFetch("/employees",           { method:"POST", body:JSON.stringify(b) }),
  empUpdate:       (id,b) => apiFetch(`/employees/${id}`, { method:"PUT",  body:JSON.stringify(b) }),
  empDelete:       id => apiFetch(`/employees/${id}`,     { method:"DELETE" }),
  empSyncFace:     id => apiFetch(`/employees/${id}/sync-face`, { method: "POST" }),
  empLiveEnroll:   id => apiFetch(`/employees/${id}/live-enroll`, { method: "POST" }),
  empFootprint:    id => apiFetch(`/employees/${id}/footprint`),
  empBulkImport:   b  => apiFetch("/employees/bulk",      { method:"POST", body:JSON.stringify(b) }),

  // visitors
  visitors:        p  => apiFetch(`/visitors?${new URLSearchParams(p)}`),
  visitorCreate:   b  => apiFetch("/visitors",            { method:"POST", body:JSON.stringify(b) }),
  visitorUpdate:   (id,b) => apiFetch(`/visitors/${id}`, { method:"PUT",  body:JSON.stringify(b) }),
  visitorDelete:   id  => apiFetch(`/visitors/${id}`,           { method:"DELETE" }),
  visitorSuspend:  id  => apiFetch(`/visitors/${id}/suspend`,   { method:"POST" }),
  visitorCheckin:  id => apiFetch(`/visitors/${id}/checkin`,  { method:"POST" }),
  visitorCheckout: id => apiFetch(`/visitors/${id}/checkout`, { method:"POST" }),

  // ── Companies ──
  companies:       p => apiFetch(`/companies?${new URLSearchParams(p)}`),
  company:         id => apiFetch(`/companies/${id}`),
  companyCreate:   b => apiFetch("/companies",            { method:"POST", body:JSON.stringify(b) }),
  companyUpdate:   (id,b) => apiFetch(`/companies/${id}`, { method:"PUT",  body:JSON.stringify(b) }),
  companyDelete:   id => apiFetch(`/companies/${id}`,     { method:"DELETE" }),
  companyBulk:     rows => apiFetch("/companies/bulk",    { method:"POST", body:JSON.stringify({ rows }) }),

  // ── Employees bulk ──
  employeeBulk:    (rows, mode="upsert") => apiFetch("/employees/bulk", { method:"POST", body:JSON.stringify({ rows, mode }) }),
  visitorFootprint:id => apiFetch(`/visitors/${id}/footprint`),

  // devices
  devices:       () => apiFetch("/devices"),
  deviceConnect: b  => apiFetch("/devices/connect",       { method:"POST", body:JSON.stringify(b) }),
  deviceTest:    b  => apiFetch("/devices/test",          { method:"POST", body:JSON.stringify(b) }),
  deviceSync:    id => apiFetch(`/devices/${id}/sync`,    { method:"POST" }),
  deviceImageLogFilters: id => apiFetch(`/devices/${id}/image-log-filters`),
  deviceSetImageLogFilters: (id, b) =>
    apiFetch(`/devices/${id}/image-log-filters`, { method: "POST", body: JSON.stringify(b || {}) }),
  deviceUpdate:  (id,b) => apiFetch(`/devices/${id}`,     { method:"PUT",  body:JSON.stringify(b) }),
  deviceDelete:  id => apiFetch(`/devices/${id}`,         { method:"DELETE" }),

  // logs
  logs:      p  => apiFetch(`/logs?${new URLSearchParams(p)}`),
  logStats:  () => apiFetch("/logs/stats"),
  logSearch: p  => apiFetch(`/logs/search?${new URLSearchParams(p)}`),

  // enrollment & AI
  analyzePhoto:  b => apiFetch("/enrollment/analyze",   { method:"POST", body:JSON.stringify(b) }),
  enroll:        b => apiFetch("/enrollment/submit",    { method:"POST", body:JSON.stringify(b) }),
  aiAnomalyReport: () => apiFetch("/ai/anomaly-report"),
  aiBehaviorProfile:(id,type) => apiFetch(`/ai/behavior-profile/${type}/${id}`),
  aiRiskScore:   () => apiFetch("/ai/risk-score"),
  aiInsights:    () => apiFetch("/ai/insights"),
  aiPredictive:  () => apiFetch("/ai/predictive"),
  aiChatStream:  b  => fetch(`${BASE}/aria/chat`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(getToken()&&{"Authorization":`Bearer ${getToken()}`}) },
    body: JSON.stringify(b),
  }),
  aiStatus:      () => apiFetch("/aria/status"),
  aiModels:      () => apiFetch("/aria/models"),

  // alerts
  alerts:        () => apiFetch("/alerts"),
  alertAck:      id => apiFetch(`/alerts/${id}/ack`,     { method:"POST" }),
  alertResolve:  id => apiFetch(`/alerts/${id}/resolve`, { method:"POST" }),

  // reports
  reportDaily:    () => apiFetch("/reports/daily"),
  reportSecurity: () => apiFetch("/reports/security"),
  reportAttendance:(p={}) => apiFetch(`/reports/attendance?${new URLSearchParams(p)}`),
  reportAttendanceExport: b => apiFetch("/reports/attendance/export", { method:"POST", body:JSON.stringify(b) }),
  reportAttendanceEmail: b => apiFetch("/reports/attendance/email", { method:"POST", body:JSON.stringify(b) }),
  reportAttendanceSubscriptions: () => apiFetch("/reports/attendance/subscriptions"),
  reportAttendanceSubscriptionCreate: b => apiFetch("/reports/attendance/subscriptions", { method:"POST", body:JSON.stringify(b) }),
  reportAttendanceSubscriptionUpdate: (id,b) => apiFetch(`/reports/attendance/subscriptions/${id}`, { method:"PUT", body:JSON.stringify(b) }),
  reportAttendanceSubscriptionDelete: id => apiFetch(`/reports/attendance/subscriptions/${id}`, { method:"DELETE" }),
  reportAttendanceSubscriptionRunNow: id => apiFetch(`/reports/attendance/subscriptions/${id}/run`, { method:"POST" }),

  // export
  exportData: b => apiFetch("/export/generate", { method:"POST", body:JSON.stringify(b) }),
  backupDownload: () => apiFetch("/settings/backup/download"),
  backupRestore: (rawText) => apiFetch("/settings/backup/restore", {
    method:"POST",
    headers:{ "Content-Type":"text/plain" },
    body: rawText
  }),

  // locations
  buildings:      () => apiFetch("/locations/buildings"),
  buildingCreate: b  => apiFetch("/locations/buildings",       { method:"POST",   body:JSON.stringify(b) }),
  buildingUpdate: (id,b)=>apiFetch(`/locations/buildings/${id}`,{ method:"PUT",   body:JSON.stringify(b) }),
  buildingDelete: id  => apiFetch(`/locations/buildings/${id}`, { method:"DELETE" }),
  zones:          () => apiFetch("/locations/zones"),
  zoneCreate:     b  => apiFetch("/locations/zones",           { method:"POST",   body:JSON.stringify(b) }),
  zoneUpdate:     (id,b)=>apiFetch(`/locations/zones/${id}`,   { method:"PUT",    body:JSON.stringify(b) }),
  zoneDelete:     id  => apiFetch(`/locations/zones/${id}`,    { method:"DELETE" }),

  // superadmin
  adminAccounts:  () => apiFetch("/superadmin/accounts"),
  adminCreate:    b  => apiFetch("/superadmin/accounts",          { method:"POST",  body:JSON.stringify(b) }),
  adminUpdate:    (id,b) => apiFetch(`/superadmin/accounts/${id}`,{ method:"PATCH", body:JSON.stringify(b) }),
  adminRevoke:    id => apiFetch(`/superadmin/accounts/${id}/revoke`,{ method:"POST" }),
  adminDelete:    id => apiFetch(`/superadmin/accounts/${id}`,    { method:"DELETE" }),
  smtpSettings:   () => apiFetch("/settings/smtp"),
  smtpSave:       b => apiFetch("/settings/smtp", { method:"PUT", body:JSON.stringify(b) }),
  centralApiSettings: () => apiFetch("/settings/central-api"),
  centralApiSave: b => apiFetch("/settings/central-api", { method:"PUT", body:JSON.stringify(b) }),
  centralApiSyncNow: () => apiFetch("/settings/central-api/sync-now", { method:"POST" }),

  // sync
  syncAll:     () => apiFetch("/sync/all",         { method:"POST" }),
  pullEvents:  () => apiFetch("/sync/pull-events", { method:"POST" }),
  offlineLogs: () => apiFetch("/sync/recovered"),

  // credentials
  credentialsPolicy: () => apiFetch("/credentials/policy"),
};

// ── RBAC ──────────────────────────────────────────────────────────────
const ROLES = {
  superadmin: ["*"],
  admin:      ["dashboard","monitor","logs","devices","setup","models","credentials","employees","enrollment","visitors","footprints","alerts","threats","sync","reports","export","locations","ai","settings"],
  security:   ["dashboard","monitor","logs","devices","models","employees","visitors","footprints","alerts","threats","reports","ai"],
  operator:   ["dashboard","monitor","logs","employees","visitors","footprints","reports","export"],
  device_mgr: ["dashboard","devices","setup","models","credentials","sync"],
  viewer:     ["dashboard","logs","reports"],
};
const can = (role, page) => {
  const p = ROLES[role] || [];
  if (p.includes("*") || p.includes(page)) return true;
  if (page === "ai_insights" && p.includes("ai")) return true;
  return false;
};

const APP_PAGE_IDS = new Set([
  "dashboard","monitor","logs","devices","setup","models","credentials",
  "employees","enrollment","visitors","footprints","alerts","threats","sync",
  "reports","export","locations","superadmin","settings","ai","ai_insights",
]);

function parseHashPage() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.location.hash.replace(/^#\/?/, "").split(/[?&#]/)[0].trim();
    if (raw && APP_PAGE_IDS.has(raw)) return raw;
  } catch {}
  return null;
}

function hashForPage(p) {
  return `#/${p}`;
}

const normRole = (u) => String(u?.role ?? "").trim().toLowerCase();

/** Aligns with main content gate (sidebar uses superadmin bypass separately). */
function allowedPage(user, p) {
  if (!user) return false;
  const r = normRole(user);
  return can(r, p) || r === "superadmin" || p === "dashboard";
}

// ── Design tokens ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//  THEME — CSS-variable-backed. Toggle class "light-theme" on <html>.
//  Dark = SCADA industrial navy. Light = crisp professional white.
// ═══════════════════════════════════════════════════════════════════════
const ThemeCtx = createContext({ light: false, toggle: () => {} });

// All TH values reference CSS variables — toggling the class instantly repaints.
const TH = {
  bg:         "var(--th-bg)",
  surface:    "var(--th-surface)",
  card:       "var(--th-card)",
  cardHi:     "var(--th-cardHi)",
  hover:      "var(--th-hover)",
  navBg:      "var(--th-navBg)",
  border:     "var(--th-border)",
  borderB:    "var(--th-borderB)",
  borderC:    "var(--th-borderC)",
  text:       "var(--th-text)",
  muted:      "var(--th-muted)",
  faint:      "var(--th-faint)",
  textHi:     "var(--th-textHi)",
  blue:       "var(--th-blue)",
  blueHov:    "var(--th-blueHov)",
  blueDim:    "var(--th-blueDim)",
  blueGlow:   "var(--th-blueGlow)",
  green:      "var(--th-green)",
  greenDim:   "var(--th-greenDim)",
  greenGlow:  "var(--th-greenGlow)",
  amber:      "var(--th-amber)",
  amberDim:   "var(--th-amberDim)",
  amberGlow:  "var(--th-amberGlow)",
  red:        "var(--th-red)",
  redDim:     "var(--th-redDim)",
  redGlow:    "var(--th-redGlow)",
  violet:     "var(--th-violet)",
  violetDim:  "var(--th-violetDim)",
  cyan:       "var(--th-cyan)",
  cyanDim:    "var(--th-cyanDim)",
  cyanGlow:   "var(--th-cyanGlow)",
  pink:       "var(--th-pink)",
  pinkDim:    "var(--th-pinkDim)",
  grid:       "var(--th-grid)",
  gridStrong: "var(--th-gridStrong)",
  mono:       "'JetBrains Mono','Roboto Mono',monospace",
  shadow:     "var(--th-shadow)",
  shadowLg:   "var(--th-shadowLg)",
  shadowGlow: "var(--th-shadowGlow)",
  insetBevel: "var(--th-insetBevel)",
};

// ── Global CSS ─────────────────────────────────────────────────────────
const GCSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

/* ── CSS variable palettes ─────────────────────────────────────────── */
:root {
  /* Modern dark theme — deep charcoal gray with purple/violet accents (Teamify style) */
  --th-bg:#1a1a1f; --th-surface:#212128; --th-card:#25252d; --th-cardHi:#2d2d38;
  --th-hover:#343440; --th-navBg:#1e1e24;
  --th-border:#2e2e3a; --th-borderB:#3d3d4d; --th-borderC:#4a4a5c;
  --th-text:#f1f1f6; --th-muted:#a1a1aa; --th-faint:#71717a; --th-textHi:#ffffff;
  /* Purple/Violet primary accent — matches Teamify dashboard */
  --th-blue:#6366f1; --th-blueHov:#4f46e5;
  --th-blueDim:rgba(99,102,241,.15); --th-blueGlow:rgba(99,102,241,.40);
  --th-green:#22c55e; --th-greenDim:rgba(34,197,94,.15); --th-greenGlow:rgba(34,197,94,.40);
  --th-amber:#f59e0b; --th-amberDim:rgba(245,158,11,.15); --th-amberGlow:rgba(245,158,11,.40);
  --th-red:#ef4444; --th-redDim:rgba(239,68,68,.15); --th-redGlow:rgba(239,68,68,.45);
  --th-violet:#8b5cf6; --th-violetDim:rgba(139,92,246,.15); --th-violetGlow:rgba(139,92,246,.40);
  --th-cyan:#06b6d4; --th-cyanDim:rgba(6,182,212,.15); --th-cyanGlow:rgba(6,182,212,.40);
  --th-pink:#ec4899; --th-pinkDim:rgba(236,72,153,.15);
  --th-grid:rgba(255,255,255,.04); --th-gridStrong:rgba(255,255,255,.08);
  --th-shadow:0 4px 20px rgba(0,0,0,.40),0 1px 3px rgba(0,0,0,.30);
  --th-shadowLg:0 16px 48px rgba(0,0,0,.50),0 4px 16px rgba(0,0,0,.30);
  --th-shadowGlow:0 0 32px rgba(99,102,241,.30),0 8px 32px rgba(0,0,0,.40);
  --th-insetBevel:inset 0 1px 0 rgba(255,255,255,.06);
}
/* ══════════════════════════════════════════════════════════════════════
   LIGHT PROFESSIONAL THEME - Enhanced
   Modern, crisp, high-contrast design with elevated cards
══════════════════════════════════════════════════════════════════════ */
html.light-theme body{
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%);
  background-attachment: fixed;
}
html.light-theme {
  --th-bg:#f1f5f9;
  --th-surface:#ffffff;
  --th-card:#ffffff;
  --th-cardHi:#f8fafc;
  --th-hover:#f1f5f9;
  --th-navBg:#1e293b;
  /* Enhanced borders with better definition */
  --th-border:#e2e8f0;
  --th-borderB:#cbd5e1;
  --th-borderC:#94a3b8;
  /* Text — stronger contrast */
  --th-text:#334155;
  --th-muted:#64748b;
  --th-faint:#94a3b8;
  --th-textHi:#0f172a;
  /* Accent — vibrant indigo/teal */
  --th-blue:#4f46e5;
  --th-blueHov:#4338ca;
  --th-blueDim:rgba(79,70,229,.12);
  --th-blueGlow:rgba(79,70,229,.30);
  /* Status — more vibrant */
  --th-green:#10b981;
  --th-greenDim:rgba(16,185,129,.12);
  --th-greenGlow:rgba(16,185,129,.28);
  --th-amber:#f59e0b;
  --th-amberDim:rgba(245,158,11,.12);
  --th-amberGlow:rgba(245,158,11,.28);
  --th-red:#ef4444;
  --th-redDim:rgba(239,68,68,.12);
  --th-redGlow:rgba(239,68,68,.28);
  --th-violet:#7c3aed;
  --th-violetDim:rgba(124,58,237,.12);
  --th-cyan:#06b6d4;
  --th-cyanDim:rgba(6,182,212,.12);
  --th-cyanGlow:rgba(6,182,212,.25);
  --th-pink:#ec4899;
  --th-pinkDim:rgba(236,72,153,.10);
  --th-grid:rgba(148,163,184,.06);
  --th-gridStrong:rgba(148,163,184,.10);
  /* Stronger shadows for better elevation */
  --th-shadow:0 1px 3px rgba(0,0,0,.10),0 4px 16px rgba(0,0,0,.08);
  --th-shadowLg:0 4px 24px rgba(0,0,0,.12),0 2px 8px rgba(0,0,0,.08);
  --th-shadowGlow:0 0 20px rgba(79,70,229,.20),0 4px 20px rgba(0,0,0,.10);
  --th-insetBevel:inset 0 1px 0 rgba(255,255,255,.98);
  --th-mono:'JetBrains Mono','Roboto Mono',monospace;
}

/* ═══════════════════════════════════════════════════════════════════
   SIDEBAR — sleek dark navy #1e293b with indigo active highlight
═══════════════════════════════════════════════════════════════════ */
html.light-theme aside{
  background:#1e293b !important;
  border-right:1px solid #334155 !important;
  box-shadow:4px 0 24px rgba(0,0,0,.15) !important;
}
/* ALL text inside sidebar — white */
html.light-theme aside *{ color:#ecf0f1 !important; }
/* Section divider labels (OVERVIEW, DEVICES etc) */
html.light-theme aside nav > div{
  color:#64748b !important;
  opacity:1 !important;
  border-top-color:rgba(255,255,255,.06) !important;
  font-size:10px !important;
  letter-spacing:2px !important;
  font-weight:600 !important;
}
/* Nav item primary label */
html.light-theme aside button > div > div:first-child{
  color:#f1f5f9 !important;
  font-weight:600 !important;
}
/* Nav item desc subtitle */
html.light-theme aside button > div > div + div{ color:#94a3b8 !important; font-size:11px !important; }
/* Icon chips */
html.light-theme aside .icon-chip{
  background:rgba(255,255,255,.08) !important;
  border-color:rgba(255,255,255,.15) !important;
  color:#cbd5e1 !important;
  box-shadow:0 1px 2px rgba(0,0,0,.10) !important;
}
/* Inactive nav button hover */
html.light-theme aside button:hover{
  background:rgba(255,255,255,.08) !important;
}
/* ACTIVE nav item — indigo left border + indigo text */
html.light-theme aside button[style*="linear-gradient"]{
  background:rgba(79,70,229,.15) !important;
  border-left:3px solid #4f46e5 !important;
}
html.light-theme aside button[style*="linear-gradient"] *{ color:#6366f1 !important; }
html.light-theme aside button[style*="linear-gradient"] .icon-chip{
  background:rgba(79,70,229,.25) !important;
  border-color:rgba(79,70,229,.50) !important;
  color:#818cf8 !important;
}
/* Logo header — slightly darker */
html.light-theme aside > div:first-child{
  background:#0f172a !important;
  border-bottom:1px solid rgba(255,255,255,.06) !important;
}
html.light-theme aside > div:first-child *{ color:#f8fafc !important; }
/* User footer */
html.light-theme aside > div:last-child{
  background:#0f172a !important;
  border-top:1px solid rgba(255,255,255,.06) !important;
}
html.light-theme aside > div:last-child *{ color:#cbd5e1 !important; }
/* Expand/collapse toggle strip */
html.light-theme aside > div[style*="borderTop"]:not(:first-child):not(:last-child){
  background:#1e293b !important;
  border-top-color:rgba(255,255,255,.06) !important;
}
html.light-theme aside button[style*="background:none"],
html.light-theme aside button[style*="background:\"none\""]{
  color:#64748b !important;
}
/* LIVE / SETUP badges */
html.light-theme aside span[style*="background"]{ font-weight:700 !important; }

/* ═══════════════════════════════════════════════════════════════════
   TOPBAR — matching dark navy sidebar
═══════════════════════════════════════════════════════════════════ */
html.light-theme header.professional-surface{
  background:#1e293b !important;
  border-bottom:1px solid #334155 !important;
  box-shadow:0 4px 20px rgba(0,0,0,.12) !important;
}
/* All topbar text — white/light */
html.light-theme header.professional-surface *{ color:#ecf0f1 !important; }
/* ALL chips inside topbar — dark semi-transparent so white text is visible */
html.light-theme header.professional-surface div[style*="min-width"],
html.light-theme header.professional-surface div[style*="minWidth"]{
  background:rgba(15,23,42,.50) !important;
  border-color:rgba(99,102,241,.30) !important;
}
/* Devices value number */
html.light-theme header.professional-surface div[style*="min-width"] div:first-child,
html.light-theme header.professional-surface div[style*="minWidth"] div:first-child{
  color:#ffffff !important;
  text-shadow:none !important;
}
/* Devices label text */
html.light-theme header.professional-surface div[style*="min-width"] div:last-child,
html.light-theme header.professional-surface div[style*="minWidth"] div:last-child{
  color:rgba(255,255,255,.65) !important;
}
/* LINK OK / OFFLINE chip */
html.light-theme header.professional-surface div[style*="greenDim"],
html.light-theme header.professional-surface div[style*="redDim"]{
  background:rgba(0,0,0,.28) !important;
  border-color:rgba(255,255,255,.18) !important;
}
/* SYS OK chip button */
html.light-theme header.professional-surface button{
  background:rgba(0,0,0,.22) !important;
  border-color:rgba(255,255,255,.16) !important;
}
/* Theme toggle — indigo accent */
html.light-theme header.professional-surface button[style*="border-radius:8"],
html.light-theme header.professional-surface button[style*="borderRadius:8"]{
  background:rgba(79,70,229,.25) !important;
  color:#818cf8 !important;
  border-color:rgba(79,70,229,.40) !important;
}
/* Settings / Power buttons */
html.light-theme header.professional-surface button[style*="transparent"]{
  background:transparent !important;
  border-color:rgba(255,255,255,.18) !important;
}
/* All status text — inherit vivid colours (green/red/amber) */
html.light-theme header.professional-surface span{ color:inherit !important; }
/* Clock chip */
html.light-theme header.professional-surface div[style*="050d18"]{
  background:rgba(0,0,0,.35) !important;
  border-color:rgba(0,238,255,.3) !important;
}
/* Topbar h2 page name */
html.light-theme header.professional-surface h2{ color:#ffffff !important; }
/* Back button */
html.light-theme header.professional-surface button[disabled]{ opacity:.4 !important; }

/* ═══════════════════════════════════════════════════════════════════
   MAIN SHELL
═══════════════════════════════════════════════════════════════════ */
html.light-theme .app-shell{ background:#f0f2f5 !important; }
html.light-theme .app-content{ background:transparent !important; }

/* ═══════════════════════════════════════════════════════════════════
   REGULAR CARDS (scada-panel) — elevated white cards
═══════════════════════════════════════════════════════════════════ */
html.light-theme .scada-panel{
  border:1px solid #e2e8f0 !important;
  box-shadow:0 4px 6px rgba(0,0,0,.05),0 10px 20px rgba(0,0,0,.08),0 1px 0 rgba(255,255,255,.80) inset !important;
  border-radius:16px !important;
}
/* Plain Card + StatCard — white bg for all non-GlassCard panels */
html.light-theme .scada-panel:not([style*="linear-gradient(160deg, var("]){
  background:#ffffff !important;
}
/* StatCard dark inline bg → white in light theme */
html.light-theme .scada-panel[style*="rgba(14,26,48"]{
  background:#ffffff !important;
  border:1px solid #dce3ea !important;
  box-shadow:0 1px 3px rgba(0,0,0,.06),0 2px 10px rgba(0,0,0,.05) !important;
}
/* StatCard numbers keep their colour but no dark glow */
html.light-theme .scada-panel[style*="rgba(14,26,48"] [style*="textShadow"]{
  text-shadow:none !important;
}
/* Dashboard panelStyle dark bg → white */
html.light-theme .scada-panel[style*="rgba(20,36,60"]{
  background:#ffffff !important;
  border:1px solid #dce3ea !important;
}
/* Granted today inner sub-cards */
html.light-theme [style*="rgba(10,18,36"]{
  background:#f8fafc !important;
  border-color:#dce3ea !important;
}
/* GlassCard accent strip — keep visible */
html.light-theme .scada-panel > div[style*="height:3px"]{
  opacity:1 !important;
}
/* All text inside content-area cards */
html.light-theme .app-content .scada-panel *{ color:#2c3e50; }
html.light-theme .app-content .scada-panel h1,
html.light-theme .app-content .scada-panel h2,
html.light-theme .app-content .scada-panel h3{ color:#1a252f !important; }
/* KPI number values — no dark glow */
html.light-theme .app-content .scada-panel [style*="fontFamily"][style*="mono"]{
  text-shadow:none !important;
  filter:none !important;
}
/* GlassCard text on tinted bg */
html.light-theme .scada-panel[style*="linear-gradient(160deg"] *{ color:#1a252f !important; }
html.light-theme .scada-panel[style*="linear-gradient(160deg"] [style*="color:var(--th-"]{
  opacity:1 !important;
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE HEADER CONTEXT STRIP
═══════════════════════════════════════════════════════════════════ */
/* PageHeader context bar — light blue tint instead of dark cyan */
html.light-theme [style*="cyanDim"][style*="blueDim"],
html.light-theme [style*="borderLeft"][style*="cyan"]{
  background:linear-gradient(90deg,rgba(26,188,156,.06),rgba(255,255,255,0)) !important;
  border-color:#d0dce8 !important;
  border-left-color:#1abc9c !important;
}

/* ═══════════════════════════════════════════════════════════════════
   PAGE TITLE & SECTION HEADERS
═══════════════════════════════════════════════════════════════════ */
html.light-theme .app-content h1,
html.light-theme .app-content h2,
html.light-theme .app-content h3{ color:#1a252f !important; }
html.light-theme .app-content [style*="fontSize:17"][style*="fontWeight:800"]{ color:#010c1a !important; }
html.light-theme .app-content [style*="fontSize:24"][style*="fontWeight:800"]{ color:#010c1a !important; }

/* ═══════════════════════════════════════════════════════════════════
   TABLE
═══════════════════════════════════════════════════════════════════ */
html.light-theme [style*="rgba(6,14,26"]{
  background:#ffffff !important;
  border:1px solid #e2e8f0 !important;
  border-radius:12px !important;
  box-shadow:0 4px 6px rgba(0,0,0,.04),0 10px 15px rgba(0,0,0,.06) !important;
}
html.light-theme thead tr{
  background:linear-gradient(180deg,#f8fafc,#f1f5f9) !important;
  border-bottom:2px solid #e2e8f0 !important;
}
html.light-theme thead th{
  color:#64748b !important;
  text-shadow:none !important;
  font-size:11px !important;
  letter-spacing:1.4px !important;
  font-weight:700 !important;
  background:transparent !important;
}
/* First column header — indigo left accent */
html.light-theme thead th:first-child{
  border-left:3px solid #4f46e5 !important;
}
/* Zebra rows */
html.light-theme tbody tr:nth-child(odd)  { background:#ffffff !important; }
html.light-theme tbody tr:nth-child(even) { background:#f8fafc !important; }
html.light-theme tbody tr:hover{
  background:#eef2ff !important;
  box-shadow:inset 3px 0 0 #4f46e5 !important;
}
/* First column cell — indigo border placeholder */
html.light-theme tbody td:first-child{
  border-left:3px solid transparent !important;
  color:#1a252f !important;
  font-weight:600 !important;
}
html.light-theme tbody tr:hover td:first-child{
  border-left-color:#4f46e5 !important;
}
html.light-theme tbody td{ color:#2c3e50 !important; font-size:13.5px !important; }
/* Table outer border */
html.light-theme [style*="border-radius:14px"][style*="overflow"]{
  border-color:#d0dce8 !important;
  box-shadow:0 2px 12px rgba(0,0,0,.06) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   INPUTS
═══════════════════════════════════════════════════════════════════ */
html.light-theme input:not([type=checkbox]):not([type=radio]):not([type=range]),
html.light-theme select,
html.light-theme textarea{
  background:#ffffff !important;
  border-color:#dce3ea !important;
  color:#2c3e50 !important;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.04) !important;
}
html.light-theme input::placeholder,html.light-theme textarea::placeholder{ color:#95a5a6 !important; }
html.light-theme input:focus,html.light-theme select:focus,html.light-theme textarea:focus{
  border-color:#1abc9c !important;
  box-shadow:0 0 0 3px rgba(26,188,156,.15) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   CHARTS
═══════════════════════════════════════════════════════════════════ */
html.light-theme .recharts-cartesian-grid line{ stroke:rgba(44,62,80,.07) !important; }
html.light-theme .recharts-text,.recharts-tick text{ fill:#546e7a !important; }
html.light-theme .recharts-legend-item-text{ color:#2c3e50 !important; }
html.light-theme .recharts-tooltip-wrapper *{
  background:#ffffff !important;
  border-color:#dce3ea !important;
  color:#2c3e50 !important;
}

/* ═══════════════════════════════════════════════════════════════════
   SCROLLBAR
═══════════════════════════════════════════════════════════════════ */
html.light-theme ::-webkit-scrollbar-track{ background:#ecf0f1 !important; }
html.light-theme ::-webkit-scrollbar-thumb{ background:#b2bec3 !important; border-radius:6px !important; }
html.light-theme ::-webkit-scrollbar-thumb:hover{ background:#7f8c8d !important; }

/* ═══════════════════════════════════════════════════════════════════
   BUTTONS — light theme overrides for all variants
═══════════════════════════════════════════════════════════════════ */
/* secondary button — steel blue bg, dark text */
html.light-theme .app-content button[style*="cardHi"],
html.light-theme .app-content button[style*="th-card"]{
  background:linear-gradient(180deg,#e8eef5,#dce5ee) !important;
  color:#1a252f !important;
  border-color:#b0bec5 !important;
  box-shadow:0 1px 3px rgba(0,0,0,.08) !important;
}
html.light-theme .app-content button[style*="cardHi"]:hover,
html.light-theme .app-content button[style*="th-card"]:hover{
  background:linear-gradient(180deg,#d8e4ee,#c8d8e6) !important;
}
/* ghost button in content area */
html.light-theme .app-content button[style*="transparent"]{
  background:transparent !important;
  color:#546e7a !important;
  border-color:#b0bec5 !important;
}
html.light-theme .app-content button[style*="transparent"]:hover{
  background:#edf2f7 !important;
  color:#1a252f !important;
}
/* destructive button — keep red but visible */
html.light-theme .app-content button[style*="redDim"]{
  background:linear-gradient(180deg,#fde8ec,#fdd0d7) !important;
  color:#c0392b !important;
  border-color:#e57373 !important;
}
/* Primary button — keep blue, ensure text is white */
html.light-theme .app-content button[style*="blueHov"]{ color:#ffffff !important; }
/* success button */
html.light-theme .app-content button[style*="00b86a"]{ color:#ffffff !important; }

/* ═══════════════════════════════════════════════════════════════════
   SIDEBAR — LED dots / scada-led override
═══════════════════════════════════════════════════════════════════ */
/* LED dots inside sidebar keep their coloured glow */
html.light-theme aside .scada-led{ opacity:1 !important; }
/* Section bullet dots (inline ● characters) — keep coloured */
html.light-theme aside span[style*="color:"]{ color:inherit !important; }

/* ═══════════════════════════════════════════════════════════════════
   LIVE FEED — hardcoded dark colors must invert in light theme
═══════════════════════════════════════════════════════════════════ */
/* Live feed row — dark navy bg override */
html.light-theme .app-content [style*="rgba(11,22,39"]{
  background:#ffffff !important;
  border-color:#dce3ea !important;
}
/* Live feed name text hardcoded #e8f0ff → dark */
html.light-theme .app-content [style*="color:#e8f0ff"]{ color:#1a252f !important; }
/* Live feed zone text hardcoded rgba(180,200,230) → muted */
html.light-theme .app-content [style*="rgba(180,200,230"]{ color:#546e7a !important; }
/* Live feed timestamp hardcoded rgba(150,175,210) → faint */
html.light-theme .app-content [style*="rgba(150,175,210"]{ color:#78909c !important; }
/* Live feed GRANT/DENY badge hardcoded colours — keep vivid, just fix bg */
html.light-theme .app-content [style*="color:#00e887"]{ color:#1a7a4a !important; background:rgba(26,174,96,.12) !important; border-color:rgba(26,174,96,.3) !important; }
html.light-theme .app-content [style*="color:#ff4060"]{ color:#c0392b !important; background:rgba(192,57,43,.10) !important; border-color:rgba(192,57,43,.28) !important; }
/* Live feed row gradient bg in light */
html.light-theme .app-content [style*="rgba(0,232,135,.08)"],
html.light-theme .app-content [style*="rgba(255,64,96,.08)"]{ background:#fafcfe !important; border-color:#e8edf2 !important; }

/* ═══════════════════════════════════════════════════════════════════
   BADGES & STATUS PILLS
═══════════════════════════════════════════════════════════════════ */
/* Badge base — ensure text always visible */
html.light-theme .app-content [style*="greenDim"]{ background:rgba(26,174,96,.12) !important; color:#1a7a4a !important; border-color:rgba(26,174,96,.28) !important; }
html.light-theme .app-content [style*="redDim"][style*="color"]{ background:rgba(192,57,43,.10) !important; color:#a93226 !important; border-color:rgba(192,57,43,.25) !important; }
html.light-theme .app-content [style*="amberDim"]{ background:rgba(211,84,0,.10) !important; color:#a04000 !important; border-color:rgba(211,84,0,.25) !important; }
html.light-theme .app-content [style*="blueDim"][style*="color"]{ background:rgba(26,188,156,.10) !important; color:#0e7a6a !important; border-color:rgba(26,188,156,.25) !important; }

/* ═══════════════════════════════════════════════════════════════════
   SYSTEM OVERVIEW CARDS (bottom row) — dark panel bg → white
═══════════════════════════════════════════════════════════════════ */
/* panelStyle gradient bg cards */
html.light-theme .scada-panel[style*="rgba(22,38,64"]{
  background:#ffffff !important;
  border:1px solid #dce3ea !important;
  box-shadow:0 1px 6px rgba(0,0,0,.06) !important;
}
/* Progress bar track */
html.light-theme .app-content [style*="height:4px"][style*="border-radius:4px"]:not([style*="background:var"]){
  background:#e2e8f0 !important;
}
/* System overview nav button hover */
html.light-theme .app-content [style*="border-radius:8"][style*="border:1px solid"][style*="transparent"]{
  border-color:#dce3ea !important;
}
/* Navigation row button text in light */
html.light-theme .app-content [style*="fontWeight:600"][style*="color:var(--th-text)"]{ color:#2c3e50 !important; }

/* ═══════════════════════════════════════════════════════════════════
   GLASSCARD (Quick Actions) — light-mode tinted bg
═══════════════════════════════════════════════════════════════════ */
html.light-theme .scada-panel[style*="linear-gradient(160deg"]{
  border:1px solid rgba(0,0,0,.09) !important;
  box-shadow:0 1px 6px rgba(0,0,0,.07) !important;
}
html.light-theme .scada-panel[style*="linear-gradient(160deg"] *{ color:#1a252f !important; }
/* Quick action arrow → keep accent colour */
html.light-theme .scada-panel[style*="linear-gradient(160deg"] [style*="var(--th-"]:last-child{ opacity:.8 !important; }

/* ═══════════════════════════════════════════════════════════════════
   MODAL / OVERLAY
═══════════════════════════════════════════════════════════════════ */
html.light-theme [style*="rgba(0,0,0,.62)"],
html.light-theme [style*="rgba(0,0,0,.7)"]{
  background:rgba(15,25,40,.55) !important;
}
/* Modal inner card */
html.light-theme [style*="rgba(0,0,0,.62)"] .scada-panel,
html.light-theme [style*="rgba(0,0,0,.7)"] .scada-panel{
  background:#ffffff !important;
  border:1px solid #dce3ea !important;
  box-shadow:0 8px 40px rgba(0,0,0,.18) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   EMPTY STATE
═══════════════════════════════════════════════════════════════════ */
html.light-theme .app-content [style*="color:var(--th-muted)"]:not(button){ color:#546e7a !important; }
html.light-theme .app-content [style*="color:var(--th-faint)"]{ color:#78909c !important; }
html.light-theme .app-content [style*="color:var(--th-textHi)"]{ color:#1a252f !important; }
html.light-theme .app-content [style*="color:var(--th-text)"]{ color:#2c3e50 !important; }

/* ═══════════════════════════════════════════════════════════════════
   OFFLINE / SYNC BANNER
═══════════════════════════════════════════════════════════════════ */
html.light-theme [style*="amberDim"][style*="padding:8px"]{
  background:rgba(230,126,34,.12) !important;
  color:#a04000 !important;
}
html.light-theme [style*="greenDim"][style*="padding:8px"]{
  background:rgba(26,174,96,.12) !important;
  color:#1a7a4a !important;
}

/* ═══════════════════════════════════════════════════════════════════
   RECHARTS TOOLTIP — light bg fix
═══════════════════════════════════════════════════════════════════ */
html.light-theme .recharts-default-tooltip{
  background:#ffffff !important;
  border:1px solid #dce3ea !important;
  box-shadow:0 2px 12px rgba(0,0,0,.10) !important;
}
html.light-theme .recharts-default-tooltip .recharts-tooltip-label{ color:#1a252f !important; }
html.light-theme .recharts-default-tooltip .recharts-tooltip-item{ color:#2c3e50 !important; }

/* ═══════════════════════════════════════════════════════════════════
   LOGIN PAGE — Light Theme Enhancements
═══════════════════════════════════════════════════════════════════ */
/* Login page background - ensure clean light gradient */
html.light-theme .login-stage{ background:linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e8ecf4 100%) !important; }
/* Signin card - enhanced visibility */
html.light-theme .signin-card{
  background:rgba(255,255,255,.95) !important;
  border:1px solid #e2e8f0 !important;
  box-shadow:0 10px 40px rgba(0,0,0,.12),0 4px 12px rgba(0,0,0,.08) !important;
}
html.light-theme .signin-card::before{
  background:linear-gradient(120deg, rgba(99,102,241,.15), transparent 28%, transparent 72%, rgba(79,70,229,.12)) !important;
}
html.light-theme .signin-card::after{
  background:linear-gradient(90deg, transparent, rgba(99,102,241,.7), rgba(79,70,229,.8), transparent) !important;
}
/* Login page titles and text */
html.light-theme .fut-title{
  background:linear-gradient(90deg, #0f172a 0%, #334155 35%, #475569 100%) !important;
  -webkit-background-clip:text !important;
  background-clip:text !important;
}
html.light-theme .login-stage h1,
html.light-theme .login-stage h2,
html.light-theme .login-stage h3{ color:#0f172a !important; }
html.light-theme .login-stage p,
html.light-theme .login-stage span,
html.light-theme .login-stage label{ color:#334155 !important; }
html.light-theme .login-stage .ui-label{ color:#475569 !important; }
/* Input fields - override browser autofill yellow */
html.light-theme .login-stage input:-webkit-autofill,
html.light-theme .login-stage input:-webkit-autofill:hover,
html.light-theme .login-stage input:-webkit-autofill:focus{
  -webkit-box-shadow:0 0 0 30px #ffffff inset !important;
  -webkit-text-fill-color:#0f172a !important;
  transition:background-color 5000s ease-in-out 0s !important;
}
html.light-theme .login-stage input{
  background:#ffffff !important;
  border:1px solid #cbd5e1 !important;
  color:#0f172a !important;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.05),0 1px 0 rgba(255,255,255,.5) !important;
}
html.light-theme .login-stage input:focus{
  border-color:#6366f1 !important;
  box-shadow:0 0 0 3px rgba(99,102,241,.15),inset 0 1px 2px rgba(0,0,0,.05) !important;
}
html.light-theme .login-stage input::placeholder{ color:#94a3b8 !important; }
/* Login buttons - ensure visibility */
html.light-theme .login-stage button{
  color:#ffffff !important;
  font-weight:600 !important;
}
html.light-theme .login-stage button[style*="transparent"]{
  background:#f1f5f9 !important;
  color:#334155 !important;
  border:1px solid #cbd5e1 !important;
}
html.light-theme .login-stage button[style*="transparent"]:hover{
  background:#e2e8f0 !important;
  color:#0f172a !important;
}
/* Bottom action buttons container */
html.light-theme .login-stage .fut-kpi{ background:rgba(255,255,255,.8) !important; }
html.light-theme .login-stage .fut-kpi .v{ color:#0f172a !important; }
html.light-theme .login-stage .fut-kpi .l{ color:#475569 !important; }
/* Login page decorative elements - toned down for light theme */
html.light-theme .login-aurora{ opacity:.6 !important; }
html.light-theme .login-orb{ opacity:.7 !important; }
html.light-theme .login-corner-hud::before,
html.light-theme .login-corner-hud::after{ border-color:rgba(99,102,241,.35) !important; }
html.light-theme .login-corner-dot{ background:rgba(99,102,241,.5) !important; box-shadow:0 0 10px rgba(99,102,241,.35) !important; }

/* ═══════════════════════════════════════════════════════════════════
   SCADA DECORATIVE ELEMENTS — hide in light theme
═══════════════════════════════════════════════════════════════════ */
html.light-theme .scada-corner-bracket{ border-color:#6366f1 !important; opacity:.35 !important; }
html.light-theme .scada-led{ box-shadow:none !important; }

/* ═══════════════════════════════════════════════════════════════════
   GENERAL CONTENT TEXT
═══════════════════════════════════════════════════════════════════ */
html.light-theme .app-content{ color:#2c3e50; }
html.light-theme .app-content span,
html.light-theme .app-content p,
html.light-theme .app-content label,
html.light-theme .app-content div:not([class]){ color:#2c3e50; }
/* muted text */
html.light-theme .app-content [style*="color:var(--th-muted)"]{ color:#546e7a !important; }
html.light-theme .app-content [style*="color:var(--th-faint)"]{ color:#78909c !important; }

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth;-webkit-text-size-adjust:100%}
html,body,#root{height:100%}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  font-size:1rem;
  line-height:1.55;
  font-weight:400;
  background-color:var(--th-bg);
  background-image:
    /* Subtle purple/violet gradient glows like Teamify */
    radial-gradient(1400px 800px at 110% -10%, rgba(99,102,241,.10), transparent 60%),
    radial-gradient(1000px 600px at -5% 5%,  rgba(139,92,246,.08), transparent 55%),
    radial-gradient(800px 500px at 50% 105%,  rgba(236,72,153,.06), transparent 55%),
    /* Very subtle grid lines */
    linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px),
    linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
  background-size: auto, auto, auto, 32px 32px, 32px 32px, 128px 128px, 128px 128px;
  color:var(--th-text);
  min-height:100vh;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  overflow:hidden;
  letter-spacing:.15px;
  text-rendering:optimizeLegibility;
}
::selection{background:rgba(99,102,241,.35);color:#fff}
h1,h2,h3,h4{color:var(--th-textHi);font-weight:700;line-height:1.25}
p{line-height:1.6;color:var(--th-text)}
.ui-card-title{font-size:1.05rem;font-weight:700;color:var(--th-textHi);letter-spacing:-.02em;margin-bottom:.9rem}
.ui-label{font-size:.9rem;font-weight:600;color:var(--th-muted);letter-spacing:.02em}
.ui-value{font-size:.95rem;font-weight:650;color:var(--th-text)}
.ui-mono{font-family:'JetBrains Mono','Roboto Mono',monospace;font-variant-numeric:tabular-nums}
code,kbd{font-family:'JetBrains Mono',monospace;font-size:.88em;background:var(--th-blueDim);color:var(--th-cyan);padding:.12em .45em;border-radius:4px}
table{font-size:.94rem}
th{color:var(--th-muted);font-weight:700;letter-spacing:.04em;font-size:.82rem}
td{color:var(--th-text);font-size:.93rem}
/* SCADA-style top status strip — subtle scanning line at the very top of viewport */
body::before{
  content:"";
  position:fixed;
  top:0;left:0;right:0;
  height:2px;
  background:linear-gradient(90deg,
    transparent 0%,
    var(--th-cyan) 20%,
    var(--th-blue) 45%,
    var(--th-violet) 65%,
    var(--th-cyan) 85%,
    transparent 100%);
  opacity:.65;
  z-index:9999;
  pointer-events:none;
  animation:scadaTopScan 8s linear infinite;
}
@keyframes scadaTopScan{
  0%{background-position:-50% 0}
  100%{background-position:150% 0}
}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--th-surface);border-left:1px solid var(--th-border)}
::-webkit-scrollbar-thumb{
  background:linear-gradient(180deg,var(--th-borderB),var(--th-border));
  border-radius:4px;
  border:1px solid var(--th-borderC);
}
::-webkit-scrollbar-thumb:hover{
  background:linear-gradient(180deg,var(--th-borderC),var(--th-borderB));
  box-shadow:0 0 8px var(--th-cyanGlow);
}
::-webkit-scrollbar-corner{background:transparent}

/* ── SCADA Industrial UI Helpers ── */
.scada-panel{
  background:linear-gradient(160deg,var(--th-cardHi) 0%,var(--th-card) 50%,var(--th-surface) 100%);
  border:1px solid var(--th-border);
  border-radius:12px;
  box-shadow:var(--th-shadow),var(--th-insetBevel);
  position:relative;
}
.scada-panel::before{
  content:"";
  position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent 0%,var(--th-cyan) 40%,var(--th-blue) 60%,transparent 100%);
  opacity:.5;
  border-radius:12px 12px 0 0;
}
.scada-corner-bracket{position:relative}
.scada-corner-bracket::before,.scada-corner-bracket::after{
  content:"";position:absolute;width:12px;height:12px;
  border:2px solid var(--th-cyan);opacity:.45;
}
.scada-corner-bracket::before{top:-2px;left:-2px;border-right:none;border-bottom:none}
.scada-corner-bracket::after{bottom:-2px;right:-2px;border-left:none;border-top:none}
.scada-led{
  display:inline-block;width:8px;height:8px;border-radius:50%;
  box-shadow:0 0 8px currentColor, inset 0 0 2px rgba(0,0,0,.4);
  animation:scadaLedPulse 2.4s ease-in-out infinite;
}
.scada-led.alarm{animation:scadaLedAlarm .8s ease-in-out infinite}
@keyframes scadaLedPulse{
  0%,100%{opacity:1;box-shadow:0 0 8px currentColor}
  50%{opacity:.6;box-shadow:0 0 4px currentColor}
}
@keyframes scadaLedAlarm{
  0%,100%{opacity:1;box-shadow:0 0 12px currentColor, 0 0 24px currentColor}
  50%{opacity:.3;box-shadow:0 0 2px currentColor}
}
.scada-readout{
  font-family:'JetBrains Mono',monospace;
  font-variant-numeric:tabular-nums;
  letter-spacing:.6px;
  color:var(--th-cyan);
  text-shadow:0 0 6px var(--th-cyanGlow);
}
.scada-divider{
  height:1px;
  background:linear-gradient(90deg,transparent,var(--th-borderB),transparent);
  margin:8px 0;
}
.scada-stat-bg{
  background:
    linear-gradient(180deg,var(--th-cardHi) 0%,var(--th-card) 100%),
    repeating-linear-gradient(135deg,rgba(0,229,255,.02) 0 4px,transparent 4px 8px);
}
input,select,textarea,button{font-family:inherit}
button{cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--th-cyan);
  outline-offset:2px;
}
.app-shell{
  background:var(--th-bg);
}
.app-content{
  background:linear-gradient(180deg, rgba(255,255,255,.018), rgba(255,255,255,0));
}
.professional-surface{
  backdrop-filter:blur(18px);
  -webkit-backdrop-filter:blur(18px);
}
.fade-page{animation:fadePage .24s cubic-bezier(.4,0,.2,1)}
@keyframes fadePage{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.fade-in{animation:fadeIn .18s ease}
@keyframes fadeIn{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
.slide-up{animation:slideUp .22s ease}
@keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.spin{display:inline-block;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.logo-rotate-slow{animation:logoRotate 15s linear infinite}
@keyframes logoRotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.logo-float-a{animation:logoFloatA 12s ease-in-out infinite}
@keyframes logoFloatA{0%,100%{transform:translateY(0) translateX(0) rotate(0deg)}50%{transform:translateY(-18px) translateX(10px) rotate(6deg)}}
.logo-float-b{animation:logoFloatB 14s ease-in-out infinite}
@keyframes logoFloatB{0%,100%{transform:translateY(0) translateX(0) rotate(0deg)}50%{transform:translateY(16px) translateX(-8px) rotate(-7deg)}}
.pulse-dot{animation:pulseDot 2s ease-in-out infinite}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}
.ai-nav-glow{
  position:relative;
}
.ai-nav-glow::after{
  content:"";
  position:absolute;
  left:8px;
  right:8px;
  top:4px;
  bottom:4px;
  border-radius:8px;
  pointer-events:none;
  background:linear-gradient(90deg, rgba(155,108,247,.14), rgba(0,212,255,.1));
  box-shadow:0 0 14px rgba(155,108,247,.24), 0 0 24px rgba(0,212,255,.14);
  opacity:.45;
  animation:aiNavGlowPulse 2.8s ease-in-out infinite;
}
.ai-nav-icon{
  animation:aiNavIconPulse 2.8s ease-in-out infinite;
}
.icon-chip{
  width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:8px;
  border:1px solid rgba(145,174,214,.22);
  background:linear-gradient(180deg, rgba(160,198,245,.16), rgba(160,198,245,.04));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12), 0 4px 10px rgba(2,8,20,.25);
}
.icon-chip-lg{
  width:34px;height:34px;border-radius:10px;font-size:17px;
  border:1px solid rgba(145,174,214,.24);
  background:linear-gradient(180deg, rgba(160,198,245,.18), rgba(160,198,245,.06));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14), 0 6px 14px rgba(2,8,20,.28);
}
@keyframes aiNavGlowPulse{
  0%,100%{opacity:.26}
  50%{opacity:.6}
}
@keyframes aiNavIconPulse{
  0%,100%{transform:scale(1); filter:drop-shadow(0 0 0 rgba(155,108,247,0))}
  50%{transform:scale(1.08); filter:drop-shadow(0 0 8px rgba(155,108,247,.55))}
}
.fr-grid{
  background-image:
    linear-gradient(to right, rgba(77,138,240,.09) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(77,138,240,.09) 1px, transparent 1px);
  background-size:24px 24px;
}
.fr-scan-ring{
  position:absolute;inset:18% 25%;
  border:1px solid rgba(0,212,255,.34);
  border-radius:24px;
  box-shadow:0 0 34px rgba(0,212,255,.15), inset 0 0 24px rgba(77,138,240,.12);
  overflow:hidden;
}
.fr-scan-ring::before{
  content:"";
  position:absolute;left:0;right:0;top:-35%;
  height:35%;
  background:linear-gradient(180deg, rgba(0,212,255,0), rgba(0,212,255,.28), rgba(0,212,255,0));
  animation:frScan 3.4s ease-in-out infinite;
}
@keyframes frScan{
  0%{top:-35%}
  50%{top:100%}
  100%{top:-35%}
}
.fr-corners::before,.fr-corners::after{
  content:"";
  position:absolute;
  width:42px;height:42px;
  border:2px solid rgba(77,138,240,.65);
}
.fr-corners::before{top:10px;left:10px;border-right:none;border-bottom:none}
.fr-corners::after{right:10px;bottom:10px;border-left:none;border-top:none}
.logo-breathe{animation:logoRotate20 50s linear infinite}
@keyframes logoRotate20{
  from{transform:rotate(0deg)}
  to{transform:rotate(360deg)}
}
.fr-left-hud{
  position:absolute;inset:10% 13%;
  border:1px solid rgba(77,138,240,.28);
  border-radius:26px;
  box-shadow:inset 0 0 0 1px rgba(0,212,255,.08), 0 0 55px rgba(0,212,255,.08);
  pointer-events:none;
}
.fr-left-hud::before{
  content:"";
  position:absolute;inset:0;border-radius:26px;
  background:repeating-linear-gradient(0deg, rgba(77,138,240,.08) 0 1px, transparent 1px 34px);
  opacity:.45;
}
.fr-left-hud::after{
  content:"";
  position:absolute;left:0;right:0;top:-18%;
  height:22%;
  background:linear-gradient(180deg, rgba(0,212,255,0), rgba(0,212,255,.22), rgba(0,212,255,0));
  animation:frHudScan 4.6s ease-in-out infinite;
}
@keyframes frHudScan{
  0%{top:-22%}
  50%{top:100%}
  100%{top:-22%}
}
.fr-left-bg-scan{
  position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(100deg, transparent 18%, rgba(0,212,255,.05) 44%, rgba(77,138,240,.08) 52%, transparent 76%);
  transform:none;
  animation:none;
}
@keyframes leftBgScanMove{
  to{transform:translateX(120%)}
}
.fr-left-wave{
  position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(80% 40% at 50% 110%, rgba(77,138,240,.14), transparent 70%),
    radial-gradient(65% 30% at 45% -10%, rgba(0,212,255,.08), transparent 72%);
  animation:leftWavePulse 18s ease-in-out infinite;
}
.left-cinematic-vignette{
  position:absolute;
  inset:0;
  pointer-events:none;
  background:
    radial-gradient(120% 85% at 50% 52%, rgba(6,14,30,0) 48%, rgba(4,9,20,.78) 100%),
    linear-gradient(180deg, rgba(2,8,18,.56), rgba(2,8,18,.22) 38%, rgba(2,8,18,.68));
}
.left-cinematic-glow{
  position:absolute;
  inset:-10% -12%;
  pointer-events:none;
  background:
    radial-gradient(36% 30% at 48% 36%, rgba(0,212,255,.16), transparent 70%),
    radial-gradient(28% 24% at 52% 62%, rgba(77,138,240,.18), transparent 74%);
  filter:blur(10px);
  animation:leftWavePulse 24s ease-in-out infinite;
}
@keyframes leftWavePulse{
  0%,100%{opacity:.55}
  50%{opacity:.9}
}
.ai-face-wrap{
  position:relative;
  width:640px;
  height:700px;
  display:flex;
  align-items:center;
  justify-content:center;
  filter:saturate(1.08) contrast(1.05);
}
.ai-face-panel{
  animation:aiFaceSway 6.8s ease-in-out infinite;
  transform-origin:50% 50%;
}
@keyframes aiFaceSway{
  0%,100%{transform:translateX(0)}
  25%{transform:translateX(4px)}
  75%{transform:translateX(-4px)}
}
.ai-face-wrap::before{
  content:"";
  position:absolute;
  width:620px;height:620px;border-radius:50%;
  border:1px solid rgba(77,138,240,.2);
  box-shadow:0 0 70px rgba(0,212,255,.12), inset 0 0 48px rgba(77,138,240,.08);
  animation:aiOuterPulse 14s ease-in-out infinite;
}
@keyframes aiOuterPulse{
  0%,100%{opacity:.45;transform:scale(1)}
  50%{opacity:.9;transform:scale(1.03)}
}
.ai-glow-blobs{
  position:absolute;inset:0;pointer-events:none;
}
.ai-glow-blobs::before,.ai-glow-blobs::after{
  content:"";
  position:absolute;border-radius:50%;
  filter:blur(6px);
  animation:aiBlobMove 20s ease-in-out infinite;
}
.ai-glow-blobs::before{
  width:180px;height:180px;left:10%;top:18%;
  background:radial-gradient(circle, rgba(0,212,255,.26), rgba(0,212,255,.04) 62%, transparent 76%);
}
.ai-glow-blobs::after{
  width:220px;height:220px;right:10%;bottom:14%;
  background:radial-gradient(circle, rgba(77,138,240,.28), rgba(77,138,240,.05) 62%, transparent 76%);
  animation-delay:-3s;
}
@keyframes aiBlobMove{
  0%,100%{transform:translate(0,0)}
  50%{transform:translate(14px,-16px)}
}
.ai-face-rings{
  position:absolute;inset:40px;border-radius:50%;
  border:1px solid rgba(0,212,255,.42);
  box-shadow:0 0 34px rgba(0,212,255,.24), inset 0 0 28px rgba(77,138,240,.16);
  animation:faceRingSpin 48s linear infinite;
}
.ai-face-rings::before,.ai-face-rings::after{
  content:"";
  position:absolute;inset:16px;border-radius:50%;
  border:1px dashed rgba(77,138,240,.28);
}
.ai-face-rings::after{
  inset:44px;
  border-style:solid;
  border-color:rgba(0,212,255,.2);
  animation:faceRingSpinRev 36s linear infinite;
}
@keyframes faceRingSpin{to{transform:rotate(360deg)}}
@keyframes faceRingSpinRev{to{transform:rotate(-360deg)}}
.ai-orbit{
  position:absolute;inset:24px;border-radius:50%;
  border:1px dashed rgba(0,212,255,.22);
  animation:faceRingSpin 42s linear infinite;
}
.ai-orbit span{
  position:absolute;width:10px;height:10px;border-radius:50%;
  background:#7ce6ff;box-shadow:0 0 10px rgba(124,230,255,.9);
}
.ai-orbit span:nth-child(1){left:50%;top:-5px;transform:translateX(-50%)}
.ai-orbit span:nth-child(2){right:16%;top:14%}
.ai-orbit span:nth-child(3){right:-4px;top:50%;transform:translateY(-50%)}
.ai-orbit span:nth-child(4){left:14%;bottom:10%}
.ai-orbit span:nth-child(5){left:-4px;top:52%;transform:translateY(-50%)}
.ai-face-panel{
  position:relative;
  width:500px;height:590px;
  border-radius:22px;
  border:1px solid rgba(94,166,255,.46);
  background:linear-gradient(180deg, rgba(7,18,32,.86), rgba(6,14,25,.78));
  box-shadow:0 30px 72px rgba(0,0,0,.58), 0 0 56px rgba(0,212,255,.22), inset 0 1px 0 rgba(255,255,255,.09);
  overflow:hidden;
}
.ai-grid-drift{
  position:absolute;
  inset:58px 72px;
  border-radius:20px;
  pointer-events:none;
  background-image:
    linear-gradient(rgba(0,212,255,.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,212,255,.08) 1px, transparent 1px);
  background-size:24px 24px, 24px 24px;
  mask-image:radial-gradient(circle at 50% 50%, rgba(0,0,0,.95), transparent 74%);
  animation:aiGridDrift 28s linear infinite;
  opacity:.5;
}
@keyframes aiGridDrift{
  from{transform:translateY(0)}
  to{transform:translateY(24px)}
}
.ai-ambient-beam{
  position:absolute;
  left:16%;
  right:16%;
  top:18%;
  height:44%;
  border-radius:999px;
  pointer-events:none;
  background:linear-gradient(180deg, rgba(0,212,255,.13), rgba(77,138,240,.05), rgba(0,212,255,0));
  filter:blur(18px);
  animation:aiBeamFloat 22s ease-in-out infinite;
}
@keyframes aiBeamFloat{
  0%,100%{transform:translateY(-8px);opacity:.42}
  50%{transform:translateY(16px);opacity:.72}
}
.ai-energy-arcs{
  position:absolute;
  inset:20px;
  border-radius:50%;
  pointer-events:none;
}
.ai-energy-arcs::before,.ai-energy-arcs::after{
  content:"";
  position:absolute;
  inset:6px;
  border-radius:50%;
  border:1px solid transparent;
  border-top-color:rgba(0,212,255,.58);
  border-right-color:rgba(124,230,255,.36);
  filter:drop-shadow(0 0 10px rgba(0,212,255,.34));
}
.ai-energy-arcs::before{animation:faceRingSpin 30s linear infinite}
.ai-energy-arcs::after{
  inset:36px;
  border-top-color:rgba(77,138,240,.62);
  border-right-color:rgba(0,212,255,.34);
  animation:faceRingSpinRev 34s linear infinite;
}
.ai-scan-target{
  position:absolute;
  left:50%;
  top:50%;
  width:420px;
  height:420px;
  transform:translate(-50%,-52%);
  border-radius:50%;
  pointer-events:none;
  border:1px dashed rgba(124,230,255,.24);
  box-shadow:inset 0 0 28px rgba(0,212,255,.12), 0 0 18px rgba(0,212,255,.16);
  animation:aiTargetPulse 12s ease-in-out infinite;
}
@keyframes aiTargetPulse{
  0%,100%{transform:translate(-50%,-52%) scale(.97);opacity:.45}
  50%{transform:translate(-50%,-52%) scale(1.02);opacity:.82}
}
.ai-particle-field{
  position:absolute;
  inset:0;
  pointer-events:none;
}
.ai-particle-field span{
  position:absolute;
  width:4px;
  height:4px;
  border-radius:50%;
  background:rgba(124,230,255,.9);
  box-shadow:0 0 10px rgba(124,230,255,.7);
  animation:aiParticleRise 24s linear infinite;
}
.ai-particle-field span:nth-child(1){left:20%;bottom:18%;animation-delay:-2s}
.ai-particle-field span:nth-child(2){left:32%;bottom:12%;animation-delay:-8s}
.ai-particle-field span:nth-child(3){left:48%;bottom:16%;animation-delay:-5s}
.ai-particle-field span:nth-child(4){left:63%;bottom:10%;animation-delay:-11s}
.ai-particle-field span:nth-child(5){left:76%;bottom:14%;animation-delay:-15s}
@keyframes aiParticleRise{
  0%{transform:translateY(0) scale(.8);opacity:0}
  20%{opacity:.85}
  80%{opacity:.55}
  100%{transform:translateY(-460px) scale(1.2);opacity:0}
}
.ai-face-panel::before{
  content:"";
  position:absolute;left:0;right:0;top:-35%;
  height:30%;
  background:linear-gradient(180deg, rgba(0,212,255,0), rgba(0,212,255,.22), rgba(0,212,255,0));
  animation:facePanelScan 10s ease-in-out infinite;
}
.ai-face-panel::after{
  content:"";
  position:absolute;left:0;right:0;bottom:0;height:44%;
  background:linear-gradient(180deg, rgba(11,22,38,0), rgba(11,22,38,.72));
  pointer-events:none;
}
@keyframes facePanelScan{
  0%{top:-35%}
  50%{top:100%}
  100%{top:-35%}
}
.ai-face-hud{
  position:absolute;
  inset:14px;
  border-radius:16px;
  border:1px solid rgba(0,212,255,.2);
}
.ai-face-hud::before,.ai-face-hud::after{
  content:"";
  position:absolute;
  width:26px;height:26px;
  border:2px solid rgba(77,138,240,.6);
}
.ai-face-hud::before{left:-1px;top:-1px;border-right:none;border-bottom:none}
.ai-face-hud::after{right:-1px;bottom:-1px;border-left:none;border-top:none}
.ai-face-svg{
  position:absolute;
  left:50%;
  top:50%;
  transform:translate(-50%,-52%);
  width:360px;height:440px;
  opacity:.96;
  filter:brightness(1.06) saturate(1.08) drop-shadow(0 0 30px rgba(0,212,255,.26));
}
.ai-face-blink{
  position:absolute;
  left:50%;
  top:43%;
  transform:translateX(-50%);
  width:210px;
  height:18px;
  pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(124,230,255,.72), rgba(124,230,255,0) 72%);
  filter:blur(2px);
  animation:aiFaceBlink 4.6s ease-in-out infinite;
}
@keyframes aiFaceBlink{
  0%,43%,100%{opacity:.25;transform:translateX(-50%) scaleY(1)}
  45%{opacity:.95;transform:translateX(-50%) scaleY(.08)}
  47%{opacity:.4;transform:translateX(-50%) scaleY(1)}
  71%{opacity:.95;transform:translateX(-50%) scaleY(.12)}
  73%{opacity:.4;transform:translateX(-50%) scaleY(1)}
}
.ai-face-nodefield{
  position:absolute;
  left:50%;
  top:50%;
  width:320px;
  height:390px;
  transform:translate(-50%,-52%);
  pointer-events:none;
}
.ai-face-nodefield span{
  position:absolute;
  width:6px;
  height:6px;
  border-radius:50%;
  background:rgba(124,230,255,.9);
  box-shadow:0 0 12px rgba(0,212,255,.65);
  animation:aiFaceNodePulse 3.2s ease-in-out infinite;
}
.ai-face-nodefield span:nth-child(1){left:35%;top:18%}
.ai-face-nodefield span:nth-child(2){left:63%;top:20%;animation-delay:-.3s}
.ai-face-nodefield span:nth-child(3){left:50%;top:35%;animation-delay:-.8s}
.ai-face-nodefield span:nth-child(4){left:30%;top:48%;animation-delay:-1.2s}
.ai-face-nodefield span:nth-child(5){left:70%;top:48%;animation-delay:-1.6s}
.ai-face-nodefield span:nth-child(6){left:50%;top:63%;animation-delay:-2s}
.ai-face-nodefield span:nth-child(7){left:42%;top:74%;animation-delay:-2.4s}
.ai-face-nodefield span:nth-child(8){left:58%;top:74%;animation-delay:-2.8s}
@keyframes aiFaceNodePulse{
  0%,100%{opacity:.35;transform:scale(.78)}
  50%{opacity:1;transform:scale(1.28)}
}
.ai-face-scanline{
  position:absolute;
  left:50%;
  top:50%;
  width:300px;
  height:2px;
  transform:translate(-50%,-52%);
  pointer-events:none;
  background:linear-gradient(90deg, rgba(0,212,255,0), rgba(0,212,255,.95), rgba(0,212,255,0));
  box-shadow:0 0 14px rgba(0,212,255,.55);
  animation:aiFaceScanLine 6.4s ease-in-out infinite;
}
@keyframes aiFaceScanLine{
  0%{transform:translate(-50%,-160px)}
  50%{transform:translate(-50%,140px)}
  100%{transform:translate(-50%,-160px)}
}
.ai-face-dots{
  position:absolute;left:50%;bottom:24px;transform:translateX(-50%);
  display:flex;gap:8px;align-items:center;
}
.ai-face-dots span{
  width:7px;height:7px;border-radius:50%;
  background:rgba(0,212,255,.9);
  box-shadow:0 0 10px rgba(0,212,255,.7);
  animation:faceDots 3.6s ease-in-out infinite;
}
.ai-face-dots span:nth-child(2){animation-delay:.2s}
.ai-face-dots span:nth-child(3){animation-delay:.4s}
@keyframes faceDots{
  0%,100%{opacity:.28;transform:scale(.8)}
  50%{opacity:1;transform:scale(1)}
}
.ai-face-caption{
  position:absolute;
  left:50%;
  bottom:10px;
  transform:translateX(-50%);
  font-size:11px;
  color:var(--th-muted);
  letter-spacing:.5px;
  text-transform:uppercase;
}
.fr-chip{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;border:1px solid rgba(77,138,240,.38);background:rgba(10,22,39,.62);font-size:11px;color:var(--th-muted)}
.fr-chip b{color:var(--th-text);font-weight:700}
.login-stage{position:relative;isolation:isolate}
.login-aurora{
  position:absolute;inset:-20% -10%;
  background:
    radial-gradient(38% 42% at 12% 18%, rgba(0,212,255,.18), transparent 65%),
    radial-gradient(44% 40% at 88% 14%, rgba(77,138,240,.21), transparent 68%),
    radial-gradient(46% 46% at 52% 92%, rgba(155,108,247,.16), transparent 70%);
  filter:blur(16px);
  animation:none;
  pointer-events:none;
  z-index:0;
}
@keyframes loginAuroraMove{
  from{transform:translate3d(-1%, -1.5%, 0) scale(1)}
  to{transform:translate3d(1.5%, 2%, 0) scale(1.06)}
}
.login-sweep{
  position:absolute;inset:0;pointer-events:none;z-index:0;
  background:linear-gradient(115deg, transparent 20%, rgba(0,212,255,.06) 45%, rgba(77,138,240,.1) 50%, transparent 72%);
  transform:none;
  animation:none;
}
@keyframes loginSweepMove{
  to{transform:translateX(120%)}
}
.login-radar{
  position:absolute;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(circle at 24% 45%, transparent 0 88px, rgba(0,212,255,.16) 88px 90px, transparent 90px 146px, rgba(77,138,240,.11) 146px 148px, transparent 148px),
    radial-gradient(circle at 74% 50%, transparent 0 130px, rgba(77,138,240,.14) 130px 132px, transparent 132px 210px, rgba(0,212,255,.1) 210px 212px, transparent 212px);
  animation:loginRadarPulse 8.4s ease-in-out infinite;
}
@keyframes loginRadarPulse{
  0%,100%{opacity:.35;transform:scale(1)}
  50%{opacity:.62;transform:scale(1.02)}
}
.login-lines{
  position:absolute;inset:0;pointer-events:none;z-index:0;
  background:
    repeating-linear-gradient(90deg, rgba(77,138,240,.05) 0 1px, transparent 1px 80px),
    repeating-linear-gradient(0deg, rgba(77,138,240,.04) 0 1px, transparent 1px 70px);
  mask-image:radial-gradient(circle at center, rgba(0,0,0,.95), rgba(0,0,0,.2) 80%, transparent 100%);
  animation:none;
}
@keyframes loginLinesDrift{
  from{transform:translateX(0)}
  to{transform:translateX(28px)}
}
.login-particle{
  position:absolute;border-radius:999px;pointer-events:none;z-index:0;
  background:radial-gradient(circle, rgba(0,212,255,.85) 0 35%, rgba(0,212,255,.22) 55%, transparent 100%);
  box-shadow:0 0 18px rgba(0,212,255,.45);
  animation:none;
}
.login-particle.a{width:8px;height:8px;left:18%;top:28%}
.login-particle.b{width:7px;height:7px;left:61%;top:32%;animation-delay:-2.1s}
.login-particle.c{width:9px;height:9px;left:83%;top:66%;animation-delay:-4s}
.login-particle.d{width:7px;height:7px;left:38%;top:78%;animation-delay:-1.4s}
@keyframes loginParticle{
  0%,100%{transform:translateY(0) scale(1);opacity:.5}
  50%{transform:translateY(-18px) scale(1.3);opacity:1}
}
.login-orb{
  position:absolute;border-radius:50%;
  pointer-events:none;z-index:0;
  filter:blur(.4px);
  box-shadow:0 0 60px rgba(77,138,240,.18), inset 0 0 40px rgba(255,255,255,.06);
  animation:none;
}
.login-orb.a{width:280px;height:280px;left:8%;top:10%;background:radial-gradient(circle at 30% 30%, rgba(0,212,255,.28), rgba(0,212,255,.06) 58%, transparent 75%)}
.login-orb.b{width:360px;height:360px;right:7%;top:16%;background:radial-gradient(circle at 30% 30%, rgba(77,138,240,.32), rgba(77,138,240,.08) 55%, transparent 76%);animation-delay:-2.5s}
.login-orb.c{width:330px;height:330px;left:38%;bottom:-10%;background:radial-gradient(circle at 30% 30%, rgba(155,108,247,.24), rgba(155,108,247,.07) 55%, transparent 77%);animation-delay:-5.5s}
@keyframes loginOrbFloat{
  0%,100%{transform:translateY(0) translateX(0)}
  50%{transform:translateY(-24px) translateX(12px)}
}
.login-corner-hud{
  position:absolute;
  width:120px;
  height:120px;
  pointer-events:none;
  z-index:0;
  animation:loginCornerPulse 4.4s ease-in-out infinite;
}
.login-corner-hud::before,
.login-corner-hud::after{
  content:"";
  position:absolute;
  border-color:rgba(77,138,240,.55);
  filter:drop-shadow(0 0 7px rgba(0,212,255,.25));
}
.login-corner-hud::before{
  inset:0;
  border-style:solid;
  border-width:2px 2px 0 0;
}
.login-corner-hud::after{
  inset:14px;
  border-style:solid;
  border-width:1px 1px 0 0;
  opacity:.7;
}
.login-corner-hud.tl{left:20px;top:20px;}
.login-corner-hud.tr{right:20px;top:20px;transform:scaleX(-1);}
.login-corner-hud.bl{left:20px;bottom:20px;transform:scaleY(-1);}
.login-corner-hud.br{right:20px;bottom:20px;transform:scale(-1);}
@keyframes loginCornerPulse{
  0%,100%{opacity:.5;transform:translateY(0) scale(1)}
  50%{opacity:.95;transform:translateY(-2px) scale(1.03)}
}
.login-corner-dot{
  position:absolute;
  width:8px;
  height:8px;
  border-radius:50%;
  background:rgba(0,212,255,.7);
  box-shadow:0 0 10px rgba(0,212,255,.5);
  animation:loginCornerDot 3.6s ease-in-out infinite;
  z-index:0;
}
.login-corner-dot.tl{left:76px;top:76px;}
.login-corner-dot.tr{right:76px;top:76px;}
.login-corner-dot.bl{left:76px;bottom:76px;}
.login-corner-dot.br{right:76px;bottom:76px;}
@keyframes loginCornerDot{
  0%,100%{transform:scale(.8);opacity:.45}
  50%{transform:scale(1.2);opacity:1}
}
.signin-card{
  position:relative;
  backdrop-filter:blur(12px) saturate(120%);
  border:1px solid rgba(110,170,255,.45) !important;
  box-shadow:0 28px 68px rgba(10,26,54,.8), 0 0 38px rgba(77,138,240,.2), inset 0 1px 0 rgba(255,255,255,.09) !important;
  transform-style:preserve-3d;
  overflow:hidden;
}
.signin-card::before{
  content:"";
  position:absolute;inset:-1px;
  border-radius:inherit;
  background:linear-gradient(120deg, rgba(0,212,255,.18), transparent 28%, transparent 72%, rgba(77,138,240,.16));
  pointer-events:none;
}
.signin-card::after{
  content:"";
  position:absolute;left:0;right:0;top:0;height:2px;
  background:linear-gradient(90deg, transparent, rgba(0,212,255,.8), rgba(77,138,240,.85), transparent);
  pointer-events:none;
}
.signin-card-energy{
  position:absolute;
  inset:0;
  pointer-events:none;
  z-index:0;
}
.signin-card-energy::before{
  content:"";
  position:absolute;
  left:-45%;
  top:0;
  bottom:0;
  width:42%;
  background:linear-gradient(90deg, rgba(0,212,255,0), rgba(0,212,255,.24), rgba(77,138,240,.18), rgba(0,212,255,0));
  transform:skewX(-14deg);
  animation:none;
}
.signin-card-energy::after{
  content:"";
  position:absolute;
  inset:0;
  background:
    radial-gradient(120px 90px at 82% 20%, rgba(0,212,255,.16), transparent 70%),
    radial-gradient(140px 110px at 14% 88%, rgba(77,138,240,.14), transparent 70%);
  opacity:.85;
}
@keyframes signinEnergySweep{
  0%{left:-45%}
  100%{left:130%}
}
.signin-card-hud{
  position:absolute;inset:12px;border-radius:12px;pointer-events:none;
}
.signin-card-hud::before,.signin-card-hud::after{
  content:"";position:absolute;width:26px;height:26px;border:2px solid rgba(0,212,255,.55);
}
.signin-card-hud::before{left:-1px;top:-1px;border-right:none;border-bottom:none}
.signin-card-hud::after{right:-1px;bottom:-1px;border-left:none;border-top:none}
.fut-title{
  background:linear-gradient(90deg, #f4f8ff 0%, #b8d5ff 35%, #7cd7ff 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 6px 22px rgba(77,138,240,.22);
}
.fut-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}
.fut-kpi{
  border:1px solid rgba(77,138,240,.28);
  background:linear-gradient(180deg, rgba(17,29,49,.85), rgba(12,22,39,.72));
  border-radius:10px;padding:9px 10px;
}
.fut-kpi .v{font-size:13px;font-weight:800;color:var(--th-text);line-height:1.1}
.fut-kpi .l{font-size:10px;color:var(--th-muted);margin-top:2px;letter-spacing:.2px}
.signin-cta{
  position:relative;overflow:hidden;
}
.signin-cta::before{
  content:"";
  position:absolute;left:-130%;top:0;bottom:0;width:65%;
  background:linear-gradient(100deg, transparent 20%, rgba(255,255,255,.26) 50%, transparent 80%);
  animation:ctaShine 3.6s linear infinite;
}
@keyframes ctaShine{
  to{left:170%}
}
.login-pointer-glow{
  position:absolute;width:460px;height:460px;border-radius:50%;
  background:radial-gradient(circle, rgba(0,212,255,.2) 0%, rgba(77,138,240,.1) 38%, rgba(77,138,240,0) 70%);
  filter:blur(14px);
  pointer-events:none;
  transition:left .18s ease, top .18s ease;
  z-index:0;
}
.fut-strip{
  margin-top:14px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  border:1px solid rgba(77,138,240,.3);
  background:linear-gradient(90deg, rgba(14,25,42,.82), rgba(12,21,36,.75));
  border-radius:11px;
  padding:8px 12px;
}
.fut-strip .t{font-size:11px;color:var(--th-muted);letter-spacing:.2px}
.fut-bars{display:flex;align-items:flex-end;gap:3px;height:14px}
.fut-bars span{
  width:3px;border-radius:2px;
  background:linear-gradient(180deg, rgba(0,212,255,.95), rgba(77,138,240,.55));
  animation:futBars 1.2s ease-in-out infinite;
}
.fut-bars span:nth-child(1){height:5px}
.fut-bars span:nth-child(2){height:10px;animation-delay:.12s}
.fut-bars span:nth-child(3){height:14px;animation-delay:.22s}
.fut-bars span:nth-child(4){height:8px;animation-delay:.32s}
.fut-bars span:nth-child(5){height:12px;animation-delay:.42s}
@keyframes futBars{
  0%,100%{opacity:.35;transform:scaleY(.72)}
  50%{opacity:1;transform:scaleY(1)}
}
.glow-blue{box-shadow:0 0 20px var(--th-blueGlow)}
.glow-green{box-shadow:0 0 20px rgba(32,214,138,.2)}
.glow-red{box-shadow:0 0 20px var(--th-redGlow)}
.no-select{user-select:none}
`;

// ── Contexts ──────────────────────────────────────────────────────────
const AuthCtx  = createContext({});
const ToastCtx = createContext({ show: () => {} });
const useAuth  = () => useContext(AuthCtx);
const useToast = () => useContext(ToastCtx);

// ── Hooks ──────────────────────────────────────────────────────────────

function useOnline() {
  const [on, setOn] = useState(true);
  const failRef = useRef(0);
  useEffect(() => {
    let alive = true;
    let t = null;
    const check = async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        failRef.current = 2;
        if (alive) setOn(false);
        return;
      }
      let timeout = null;
      try {
        const c = new AbortController();
        timeout = setTimeout(() => c.abort(), 2500);
        const res = await fetch(`${BASE}/health`, { method: "GET", cache: "no-store", signal: c.signal });
        clearTimeout(timeout);
        if (res.ok) {
          failRef.current = 0;
          if (alive) setOn(true);
          return;
        }
        failRef.current += 1;
        if (alive && failRef.current >= 2) setOn(false);
      } catch {
        failRef.current += 1;
        if (alive && failRef.current >= 2) setOn(false);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const onStateChange = () => { check().catch(() => {}); };
    check().catch(() => {});
    t = setInterval(() => { check().catch(() => {}); }, 10000);
    window.addEventListener("focus", onStateChange);
    window.addEventListener("online", onStateChange);
    window.addEventListener("offline", onStateChange);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("focus", onStateChange);
      window.removeEventListener("online", onStateChange);
      window.removeEventListener("offline", onStateChange);
    };
  }, []);
  return on;
}

function useOfflineSync(cb) {
  const online = useOnline();
  const prevRef = useRef(online);
  const cbRef  = useRef(cb);
  useEffect(() => { cbRef.current = cb; });   // keep ref current without re-triggering sync
  useEffect(() => {
    if (!prevRef.current && online) {
      flushQueue((done, total) => {
        if (done === total) cbRef.current?.({ type:"queue", count:total });
      }).catch(() => {});
      api.syncAll().then(() => cbRef.current?.({ type:"devices" })).catch(() => {});
    }
    prevRef.current = online;
  }, [online]);   // only re-run when online status changes
  return online;
}

function useWS(handler) {
  const ws  = useRef(null);
  const tmr = useRef(null);
  const hRef= useRef(handler);
  useEffect(() => { hRef.current = handler; }, [handler]);

  useEffect(() => {
    const wsBase = WS.split("?")[0];
    function connect() {
      try {
        clearTimeout(tmr.current);
        const tok = getToken();
        if (!tok) {
          tmr.current = setTimeout(connect, 1200);
          return;
        }
        const url = `${wsBase}?token=${encodeURIComponent(tok)}`;
        const sock = new WebSocket(url);
        ws.current = sock;
        sock.onmessage = e => {
          try { hRef.current(JSON.parse(e.data)); } catch {}
        };
        sock.onclose = () => { tmr.current = setTimeout(connect, 2800); };
        sock.onerror = () => sock.close();
      } catch {
        tmr.current = setTimeout(connect, 3000);
      }
    }
    connect();
    return () => { clearTimeout(tmr.current); ws.current?.close(); };
  }, []);
}

function useFetch(fn, deps = [], init = null) {
  const [data,    setData]    = useState(init);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const run = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const r = await fn();
      if (r !== null && r !== undefined) setData(r);
      else if (r === null) setError("session_expired"); // 401 returned null — caller handles redirect
    }
    catch (e) { setError(e?.message || "Request failed"); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, loading, error, reload: run, setData };
}

// ── Formatters ────────────────────────────────────────────────────────
const safeDate = (d) => {
  if (d == null || d === "") return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
};
/** Mongo/API logs may store time as timestamp, ts, or createdAt only. */
const logEventTime = (l) => (l && (l.timestamp ?? l.ts ?? l.createdAt)) ?? null;

/** Asia/Dubai calendar day — keep in sync with backend `dubaiDayStartEnd`. */
function dubaiDayStartEndJs(now = new Date()) {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  const start = new Date(`${ymd}T00:00:00+04:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

function logEventTypeUpper(l) {
  return String(l?.eventType || "").toUpperCase();
}

/** Same semantics as Mongo `buildAccessLogsMongoFilter` granted/denied clause. */
function logRowMatchesGrantedClause(l, wantGranted) {
  const g = l?.accessGranted ?? l?.granted;
  const et = logEventTypeUpper(l);
  if (wantGranted) {
    if (g === true) return true;
    if (et === "ACCESS_GRANTED") return true;
    return false;
  }
  if (g === false) return true;
  if (et === "ACCESS_DENIED") return true;
  return false;
}

function logRowMatchesUnknownDeniedPattern(l) {
  if (!logRowMatchesGrantedClause(l, false)) return false;
  const id = String(l?.employeeId || "").trim();
  const nm = String(l?.employeeName || "").trim();
  const name = String(l?.name || "").trim();
  if (/^UNKNOWN-/i.test(id) || /^UNKNOWN-/i.test(nm) || /^UNKNOWN-/i.test(name)) return true;
  if (/^Unknown$/i.test(nm) || /^Unknown$/i.test(name)) return true;
  return false;
}

function logRowMatchesTodayDubai(l) {
  const { start, end } = dubaiDayStartEndJs();
  const t = logEventTime(l);
  if (!t) return false;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return false;
  return d >= start && d < end;
}

function logRowMatchesDubaiDateRange(l, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  const t = logEventTime(l);
  if (!t) return false;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return false;
  const parseYmdAtDubaiStart = (ymd) => {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
    const dt = new Date(`${ymd}T00:00:00+04:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const start = parseYmdAtDubaiStart(fromDate);
  const toStart = parseYmdAtDubaiStart(toDate);
  const end = toStart ? new Date(toStart.getTime() + 86400000) : null;
  if (start && d < start) return false;
  if (end && d >= end) return false;
  return true;
}

function logRowMatchesSearchLoose(l, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;
  const fields = [l?.employeeName, l?.name, l?.employeeId, l?.zone, l?.authMode].map((x) =>
    String(x ?? "").toLowerCase()
  );
  return fields.some((f) => f.includes(q));
}

/** WebSocket / poll extras merged on page 1 must match GET /api/logs query params. */
function liveLogMatchesFetchParams(l, { filter, todayOnly, unknownDeniedOnly, search, fromDate, toDate }) {
  if (String(l?.eventType || "").toUpperCase() === "ENROLLMENT") return false;
  if (search && !logRowMatchesSearchLoose(l, search)) return false;
  if (todayOnly && !logRowMatchesTodayDubai(l)) return false;
  if (!logRowMatchesDubaiDateRange(l, fromDate, toDate)) return false;
  if (unknownDeniedOnly) {
    if (!logRowMatchesUnknownDeniedPattern(l)) return false;
    if (filter === "granted") return false;
    return true;
  }
  if (filter === "all") return true;
  if (filter === "granted") return logRowMatchesGrantedClause(l, true);
  if (filter === "denied") return logRowMatchesGrantedClause(l, false);
  return true;
}

function accessLogAiInsights(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const deniedRows = safeRows.filter((l) => logRowMatchesGrantedClause(l, false));
  const deniedRate = safeRows.length ? (deniedRows.length / safeRows.length) * 100 : 0;
  const riskLevel = deniedRate >= 45 ? "high" : deniedRate >= 25 ? "medium" : "low";
  const unknownDeniedRows = deniedRows.filter((l) => logRowMatchesUnknownDeniedPattern(l));
  const zoneDeniedMap = new Map();
  const identityDeniedMap = new Map();
  for (const l of deniedRows) {
    const z = String(l?.zone || "Unassigned").trim() || "Unassigned";
    zoneDeniedMap.set(z, (zoneDeniedMap.get(z) || 0) + 1);
    const who = String(l?.employeeName || l?.name || l?.employeeId || "Unknown").trim() || "Unknown";
    identityDeniedMap.set(who, (identityDeniedMap.get(who) || 0) + 1);
  }
  const topDeniedZone = [...zoneDeniedMap.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const topDeniedIdentity = [...identityDeniedMap.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const hotWindowMs = 15 * 60 * 1000;
  const now = Date.now();
  const recentUnknownDenied = unknownDeniedRows.filter((l) => {
    const t = new Date(logEventTime(l) || 0).getTime();
    return Number.isFinite(t) && now - t <= hotWindowMs;
  }).length;
  const summary =
    riskLevel === "high"
      ? "High denial pressure detected. Prioritize device health checks and identity sync for affected zones."
      : riskLevel === "medium"
        ? "Moderate anomaly pattern. Monitor repeated denials and verify policy mappings."
        : "Access behavior looks stable for the current filter window.";
  return {
    total: safeRows.length,
    denied: deniedRows.length,
    deniedRate,
    riskLevel,
    summary,
    unknownDenied: unknownDeniedRows.length,
    recentUnknownDenied,
    topDeniedZone,
    topDeniedIdentity
  };
}

/** Merge two copies of the same access event (e.g. WS vs REST) — keep non-empty HR fields from either. */
function mergeAccessLogSnapshots(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const out = { ...a };
  const preferredKeys = new Set([
    "employeeName",
    "name",
    "department",
    "dept",
    "designation",
    "division",
    "cardId",
    "cardNo",
    "zone",
    "authMode",
    "photo",
    "jpgimage",
    "enrollmentPhoto",
    "enrolledPhoto"
  ]);
  const looksLikeNumericId = (v) => /^\d+$/.test(String(v ?? "").trim());
  const looksUnknown = (v) => /^unknown\b/i.test(String(v ?? "").trim());
  const textLen = (v) => String(v ?? "").trim().length;
  for (const k of Object.keys(b)) {
    const v = b[k];
    const o = out[k];
    const empty = o === undefined || o === null || o === "";
    if (empty && v !== undefined && v !== null && v !== "") out[k] = v;
    if (!preferredKeys.has(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    // Prefer richer identity/profile fields from enriched REST rows over raw WS snapshots.
    if (k === "employeeName" || k === "name") {
      if (looksLikeNumericId(o) && !looksLikeNumericId(v)) {
        out[k] = v;
        continue;
      }
      if (looksUnknown(o) && !looksUnknown(v)) {
        out[k] = v;
        continue;
      }
      if (textLen(v) > textLen(o || "")) {
        out[k] = v;
        continue;
      }
    }
    if ((k === "photo" || k === "jpgimage" || k === "enrollmentPhoto" || k === "enrolledPhoto") && textLen(v) > textLen(o || "")) {
      out[k] = v;
      continue;
    }
    if (empty) out[k] = v;
  }
  return out;
}
const fT   = d => {
  const t = safeDate(d);
  return t ? t.toLocaleTimeString("en-GB",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
};
const fD   = d => {
  const t = safeDate(d);
  return t ? t.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit"}) : "—";
};
const fDT  = d => {
  const t = safeDate(d);
  return t ? `${t.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit"})} ${t.toLocaleTimeString("en-GB",{hour12:false,hour:"2-digit",minute:"2-digit"})}` : "—";
};
const fDTS = d => {
  const t = safeDate(d);
  return t ? `${t.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit"})} ${t.toLocaleTimeString("en-GB",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"})}` : "—";
};
const fRel = d => {
  if (!d) return "Never";
  const s = (Date.now()-new Date(d))/1000;
  if (s < 60)    return `${~~s}s ago`;
  if (s < 3600)  return `${~~(s/60)}m ago`;
  if (s < 86400) return `${~~(s/3600)}h ago`;
  return `${~~(s/86400)}d ago`;
};
const fNum = n => n == null ? "—" : Number(n).toLocaleString();
/** Device `enrolled` is optional and is not filled from Suprema today — do not treat missing as "0 users". */
const deviceReaderUserDisplay = (d) => {
  const v = d?.enrolled;
  if (v === undefined || v === null) return "—";
  return fNum(v);
};
const formatProcUptime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
const fDur = (from, to = Date.now()) => {
  if (!from) return "—";
  const sec = Math.max(0, Math.floor((new Date(to) - new Date(from)) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/* ═══════════════════════════════════════════════════════════════════════
   PRIMITIVE COMPONENTS
═══════════════════════════════════════════════════════════════════════ */

// ── Badge ─────────────────────────────────────────────────────────────
const BC = {
  blue:   [TH.blueDim,   TH.blue],
  green:  [TH.greenDim,  TH.green],
  amber:  [TH.amberDim,  TH.amber],
  red:    [TH.redDim,    TH.red],
  violet: [TH.violetDim, TH.violet],
  cyan:   [TH.cyanDim,   TH.cyan],
  pink:   [TH.pinkDim,   TH.pink],
  gray:   ["rgba(90,127,168,.12)", TH.muted],
};
function Badge({ color = "gray", children, dot, sm }) {
  const [bg, fg] = BC[color] || BC.gray;
  // SCADA tag: sharp corners, glowing dot, uppercase mono-ish text
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:5,
      padding: sm ? "2px 8px" : "3px 10px",
      borderRadius:3,
      fontSize: sm ? 9 : 10,
      fontWeight:700,
      whiteSpace:"nowrap",
      background:bg,
      color:fg,
      letterSpacing:".8px",
      textTransform:"uppercase",
      border:`1px solid ${fg}55`,
      fontFamily:"'JetBrains Mono','Roboto Mono',monospace",
      boxShadow:`inset 0 1px 0 ${fg}11`,
    }}>
      {dot && (
        <span className="scada-led" style={{
          width:6,height:6,borderRadius:"50%",
          background:"currentColor",
          color:"currentColor",
          flexShrink:0,
          boxShadow:`0 0 6px currentColor`
        }}/>
      )}
      {children}
    </span>
  );
}

/** Non-resolved alert statuses that should appear in sidebar badge (matches ack → acknowledged). */
function alertAttentionCount(rows) {
  return (rows || []).filter((a) => {
    const s = String(a?.status || "").toLowerCase();
    return s === "open" || s === "reviewing" || s === "acknowledged";
  }).length;
}

function isAlertReviewingTab(a) {
  const s = String(a?.status || "").toLowerCase();
  return s === "reviewing" || s === "acknowledged";
}

function stBadge(s) {
  if (!s) return <Badge color="gray">—</Badge>;
  const map = {
    online:"green",connected:"green",offline:"gray",warning:"amber",active:"green",
    inactive:"gray",suspended:"red","checked-in":"green",
    "checked-out":"gray",expected:"blue",resolved:"green",
    reviewing:"amber",acknowledged:"amber",open:"red",critical:"red",high:"amber",
    medium:"blue",low:"gray",
  };
  const label = { online:"Online",connected:"Online",offline:"Offline",warning:"Warning",active:"Active",inactive:"Inactive",suspended:"Suspended","checked-in":"Checked In","checked-out":"Checked Out",expected:"Expected",resolved:"Resolved",reviewing:"Reviewing",acknowledged:"Acknowledged",open:"Open",critical:"Critical",high:"High",medium:"Medium",low:"Low" };
  const normalized = String(s).toLowerCase().replace(/_/g,"-");
  return <Badge color={map[normalized]||"gray"} dot>{label[normalized]||label[s]||String(s).charAt(0).toUpperCase()+String(s).slice(1)}</Badge>;
}

// ── Button ────────────────────────────────────────────────────────────
const BV = {
  primary:   { bg:`linear-gradient(180deg, ${TH.blue}, ${TH.blueHov})`,   fg:"#fff",       hv:`linear-gradient(180deg, ${TH.blueHov}, #006bb8)`, bd:`1px solid ${TH.blue}aa`, gl:TH.blueGlow },
  success:   { bg:`linear-gradient(180deg, ${TH.green}, #00b86a)`,         fg:"#001a0d",    hv:`linear-gradient(180deg, #00b86a, #009556)`,        bd:`1px solid ${TH.green}aa`, gl:TH.greenGlow },
  danger:    { bg:`linear-gradient(180deg, ${TH.red}, #d8334e)`,           fg:"#fff",       hv:`linear-gradient(180deg, #d8334e, #b62b41)`,        bd:`1px solid ${TH.red}aa`, gl:TH.redGlow },
  amber:     { bg:`linear-gradient(180deg, ${TH.amber}, #e69b1f)`,         fg:"#1a0e00",    hv:`linear-gradient(180deg, #e69b1f, #c4861a)`,        bd:`1px solid ${TH.amber}aa`, gl:TH.amberGlow },
  secondary: { bg:`linear-gradient(180deg, ${TH.cardHi}, ${TH.card})`,     fg:TH.cyan,      hv:`linear-gradient(180deg, ${TH.hover}, ${TH.cardHi})`, bd:`1px solid ${TH.cyan}66`, gl:TH.cyanGlow },
  ghost:     { bg:"transparent",                                            fg:TH.muted,    hv:TH.hover,                                            bd:`1px solid ${TH.border}`, gl:"transparent" },
  destructive:{ bg:`linear-gradient(180deg, ${TH.redDim}, rgba(0,0,0,.2))`, fg:"#ffd9de",   hv:TH.redDim,                                           bd:`1px solid ${TH.red}66`, gl:TH.redGlow },
};
const BSZ = { xs:{p:"3px 9px",f:11}, sm:{p:"5px 12px",f:12}, md:{p:"8px 16px",f:13}, lg:{p:"11px 22px",f:14}, xl:{p:"14px 28px",f:15} };

function Btn({ children, onClick, v="primary", sz="md", disabled, full, icon, loading:ld, style={}, type="button" }) {
  const { bg, fg, hv, bd, gl } = BV[v] || BV.primary;
  const { p, f } = BSZ[sz] || BSZ.md;
  return (
    <button type={type} onClick={onClick} disabled={disabled||ld}
      style={{
        background:bg,
        color:fg,
        border:bd,
        borderRadius:10,                                // SCADA: sharper buttons
        padding:p,
        fontSize:f,
        fontWeight:700,
        display:"inline-flex",
        alignItems:"center",
        justifyContent:"center",
        gap:6,
        transition:"all .12s cubic-bezier(.4,0,.2,1)",
        width:full?"100%":"auto",
        opacity:(disabled||ld)?.4:1,
        cursor:(disabled||ld)?"not-allowed":"pointer",
        letterSpacing:".15px",
        textTransform:"none",
        boxShadow: v!=="ghost" ? `inset 0 1px 0 rgba(255,255,255,.14), 0 8px 18px rgba(2,8,20,.22)` : "none",
        ...style
      }}
      onMouseEnter={e=>{ if(!(disabled||ld)){
        e.currentTarget.style.background = hv;
        e.currentTarget.style.boxShadow = v!=="ghost"
          ? `inset 0 1px 0 rgba(255,255,255,.16), 0 0 18px ${gl}, 0 12px 28px rgba(2,8,20,.32)`
          : `0 0 14px ${TH.cyanGlow}, inset 0 1px 0 rgba(255,255,255,.06)`;
        e.currentTarget.style.transform = "translateY(-1px)";
      }}}
      onMouseLeave={e=>{ if(!(disabled||ld)){
        e.currentTarget.style.background = bg;
        e.currentTarget.style.boxShadow = v!=="ghost"
          ? `inset 0 1px 0 rgba(255,255,255,.14), 0 8px 18px rgba(2,8,20,.22)`
          : "none";
        e.currentTarget.style.transform = "none";
      }}}
      onMouseDown={e=>{ if(!(disabled||ld)) e.currentTarget.style.transform="translateY(1px)"; }}
      onMouseUp={e=>{ if(!(disabled||ld)) e.currentTarget.style.transform="none"; }}>
      {ld
        ? <><span className="spin" style={{ fontSize:13 }}>⟳</span>{typeof children==="string"?children:null}</>
        : <>{icon&&<span style={{ fontSize:"1.1em" }}>{icon}</span>}{children}</>}
    </button>
  );
}

// ── Input ─────────────────────────────────────────────────────────────
function Input({ value, onChange, placeholder, type="text", disabled, onEnter, onKeyDown, onBlur, style={}, prefix, suffix }) {
  const focusStyle = { borderColor:TH.cyan, boxShadow:`inset 0 1px 2px rgba(0,0,0,.3), 0 0 0 2px ${TH.cyanDim}, 0 0 12px ${TH.cyanGlow}` };
  const base = { width:"100%", padding:"9px 12px", borderRadius:4, fontSize:13, background:`linear-gradient(180deg, ${TH.surface}, ${TH.card})`, border:`1px solid ${TH.border}`, color:TH.text, outline:"none", transition:"all .14s", boxShadow:"inset 0 1px 2px rgba(0,0,0,.3)", ...style };
  if (prefix || suffix) {
    return (
      <div style={{ position:"relative", display:"flex", alignItems:"center" }}>
        {prefix && <span style={{ position:"absolute",left:11,color:TH.muted,fontSize:14,pointerEvents:"none",zIndex:1 }}>{prefix}</span>}
        <input value={value??""} onChange={onChange} placeholder={placeholder} type={type} disabled={disabled}
          onKeyDown={e=>{ onKeyDown?.(e); if (e.key==="Enter") onEnter?.(); }}
          style={{ ...base, paddingLeft:prefix?34:12, paddingRight:suffix?34:12 }}
          onFocus={e=>Object.assign(e.target.style, focusStyle)}
          onBlur={e=>{ e.target.style.borderColor=TH.border; e.target.style.boxShadow="none"; onBlur?.(e); }}/>
        {suffix && <span style={{ position:"absolute",right:11,color:TH.muted,fontSize:14,pointerEvents:"none" }}>{suffix}</span>}
      </div>
    );
  }
  return (
    <input value={value??""} onChange={onChange} placeholder={placeholder} type={type} disabled={disabled}
      onKeyDown={e=>{ onKeyDown?.(e); if (e.key==="Enter") onEnter?.(); }}
      style={base}
      onFocus={e=>Object.assign(e.target.style, focusStyle)}
      onBlur={e=>{ e.target.style.borderColor=TH.border; e.target.style.boxShadow="none"; onBlur?.(e); }}/>
  );
}

// ── Textarea ──────────────────────────────────────────────────────────
function Textarea({ value, onChange, placeholder, rows=4, style={} }) {
  return (
    <textarea value={value||""} onChange={onChange} placeholder={placeholder} rows={rows}
      style={{ width:"100%",padding:"9px 12px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6,...style }}
      onFocus={e=>{ e.target.style.borderColor=TH.blue; e.target.style.boxShadow=`0 0 0 3px ${TH.blueDim}`; }}
      onBlur={e=>{ e.target.style.borderColor=TH.border; e.target.style.boxShadow="none"; }}/>
  );
}

// ── Select ────────────────────────────────────────────────────────────
function Sel({ value, onChange, options, disabled, onBlur, style={} }) {
  return (
    <select value={value??""} onChange={onChange} disabled={disabled}
      style={{ width:"100%",padding:"9px 12px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:disabled?"not-allowed":"pointer",...style }}
      onFocus={e=>{ e.target.style.borderColor=TH.blue; }}
      onBlur={e=>{ e.target.style.borderColor=TH.border; onBlur?.(e); }}>
      {(options||[]).map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
    </select>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────
function Toggle({ value, onChange, label }) {
  return (
    <label style={{ display:"flex",alignItems:"center",gap:10,cursor:"pointer" }}>
      <div onClick={()=>onChange(!value)} style={{ width:42,height:24,borderRadius:12,background:value?TH.blue:TH.border,position:"relative",transition:"background .2s",flexShrink:0 }}>
        <div style={{ position:"absolute",top:3,left:value?20:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 4px rgba(0,0,0,.3)" }}/>
      </div>
      {label&&<span style={{ fontSize:13,color:TH.text }}>{label}</span>}
    </label>
  );
}

// ── Field wrapper ─────────────────────────────────────────────────────
function Field({ label, children, hint, required, error }) {
  return (
    <div>
      {label&&<label style={{ display:"block",fontSize:11,fontWeight:error?800:600,color:error?TH.red:TH.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:".5px" }}>
        {label}{required&&<span style={{ color:TH.red,marginLeft:3 }}>*</span>}
      </label>}
      {children}
      {(hint||error)&&<p style={{ fontSize:11,color:error?TH.red:TH.muted,marginTop:4,lineHeight:1.5 }}>{error||hint}</p>}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────
function Card({ children, style={}, pad=20, glow, onClick, className="" }) {
  const hov = !!onClick;
  const bg = `linear-gradient(180deg, ${TH.cardHi} 0%, ${TH.card} 100%)`;
  return (
    <div className={className+" scada-panel"} onClick={onClick}
      style={{
        background: bg,
        border:`1px solid ${glow||TH.border}`,
        borderRadius:16,
        padding:pad,
        boxShadow: glow
          ? `0 0 28px var(--th-violetGlow), ${TH.shadow}, ${TH.insetBevel}`
          : `${TH.shadow}, ${TH.insetBevel}`,
        cursor:hov?"pointer":"default",
        transition:"transform .16s cubic-bezier(.4,0,.2,1), border-color .16s, box-shadow .16s",
        position:"relative",
        ...style
      }}
      onMouseEnter={e=>{ if(hov){
        e.currentTarget.style.borderColor=TH.violet;
        e.currentTarget.style.boxShadow=`0 0 24px ${TH.violetGlow}, ${TH.shadowLg}, ${TH.insetBevel}`;
        e.currentTarget.style.transform="translateY(-1px)";
      }}}
      onMouseLeave={e=>{ if(hov){
        e.currentTarget.style.borderColor=glow||TH.border;
        e.currentTarget.style.boxShadow=glow?`0 0 28px ${glow}30, ${TH.shadow}, ${TH.insetBevel}`:`${TH.shadow}, ${TH.insetBevel}`;
        e.currentTarget.style.transform="none";
      }}}>
      {children}
    </div>
  );
}

// ── GlassCard ─────────────────────────────────────────────────────────
// colorKey: one of "blue"|"green"|"red"|"amber"|"violet"|"cyan" — drives CSS var lookups
// Auto-inferred from color prop if not supplied explicitly
const _CK_MAP = { [TH.blue]:"blue",[TH.green]:"green",[TH.red]:"red",[TH.amber]:"amber",[TH.violet]:"violet",[TH.cyan]:"cyan",[TH.pink]:"pink",[TH.muted]:"borderB" };
function GlassCard({ children, style={}, color=TH.violet, colorKey, onClick }) {
  const ck = colorKey || _CK_MAP[color] || "violet";
  const dimVar   = `var(--th-${ck}Dim)`;
  const glowVar  = `var(--th-${ck}Glow)`;
  const colorVar = `var(--th-${ck})`;
  return (
    <div onClick={onClick}
      className="scada-panel"
      style={{
        background:`linear-gradient(160deg, ${dimVar} 0%, rgba(0,0,0,0) 60%, ${dimVar} 100%)`,
        border:`1px solid ${colorVar}44`,
        borderRadius:14,
        padding:20,
        boxShadow:`0 0 24px ${glowVar}, ${TH.shadow}, ${TH.insetBevel}`,
        cursor:onClick?"pointer":"default",
        position:"relative",
        opacity:1,
        ...style
      }}>
      {/* top accent strip */}
      <div style={{ position:"absolute", top:0, left:0, right:0, height:3,
        background:`linear-gradient(90deg, transparent, ${colorVar}, transparent)`,
        opacity:.85, borderRadius:"14px 14px 0 0" }}/>
      {children}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color=TH.violet, trend, onClick }) {
  return (
    <Card pad={16} onClick={onClick} style={{ cursor:onClick?"pointer":"default", overflow:"hidden", background:`linear-gradient(145deg, rgba(28,28,38,.95) 0%, rgba(22,22,29,.98) 100%)`, border:`1px solid rgba(139,92,246,.12)`, borderRadius:16, boxShadow:`0 8px 32px rgba(0,0,0,.50), inset 0 1px 0 rgba(255,255,255,.06)` }}>
      {/* Top color signal bar */}
      <div style={{
        position:"absolute", top:0, left:0, right:0, height:3,
        background:`linear-gradient(90deg, transparent 0%, ${color} 40%, ${color} 70%, transparent 100%)`,
        boxShadow:`0 0 16px ${color}66`
      }}/>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
        <div style={{
          width:42,height:42,borderRadius:12,
          background:`linear-gradient(135deg, ${color}20 0%, ${color}08 100%)`,
          border:`1px solid ${color}40`,
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:20,
          boxShadow:`inset 0 1px 0 rgba(255,255,255,.08), 0 4px 16px ${color}20`,
          position:"relative",flexShrink:0
        }}>
          {icon}
        </div>
        {trend!=null && (
          <div style={{ display:"flex",alignItems:"center",gap:3,padding:"4px 8px",borderRadius:20,background:trend>=0?TH.greenDim:TH.redDim,border:`1px solid ${trend>=0?TH.green:TH.red}33` }}>
            <span style={{ fontSize:11,fontWeight:700,color:trend>=0?TH.green:TH.red,fontFamily:TH.mono }}>{trend>=0?"↑":"↓"}{Math.abs(trend)}%</span>
          </div>
        )}
      </div>
      <div style={{ fontSize:28,fontWeight:800,color,fontFamily:TH.mono,fontVariantNumeric:"tabular-nums",lineHeight:1,marginBottom:8,letterSpacing:"-.5px",textShadow:`0 0 20px ${color}44` }}>
        {value??<span style={{ opacity:.3 }}>—</span>}
      </div>
      <div style={{ fontSize:12,fontWeight:600,color:TH.muted,letterSpacing:".5px",marginBottom:sub?4:0 }}>{label}</div>
      {sub && <div style={{ fontSize:11,color:TH.faint,fontWeight:500 }}>{sub}</div>}
    </Card>
  );
}

// ── Section header ────────────────────────────────────────────────────
function PageHeader({ title, sub, action, back, onBack }) {
  /* Title is already shown in the TopBar breadcrumb — PageHeader is a
     context strip: left = accent bar + optional subtitle, right = actions */
  const hasContent = sub || action || back;
  if (!hasContent) return null;
  return (
    <div style={{
      display:"flex",alignItems:"center",justifyContent:"space-between",
      marginBottom:20,gap:12,flexWrap:"wrap",
      padding:"10px 16px",
      borderRadius:10,
      background:`linear-gradient(90deg, ${TH.cyanDim}, ${TH.blueDim}, rgba(0,0,0,0))`,
      border:`1px solid ${TH.border}`,
      borderLeft:`3px solid ${TH.cyan}`,
      position:"relative",
    }}>
      <div style={{ display:"flex",gap:12,alignItems:"center",flex:1,minWidth:0 }}>
        {back && (
          <button onClick={onBack} style={{
            background:`linear-gradient(180deg, ${TH.cardHi}, ${TH.card})`,
            border:`1px solid ${TH.border}`,borderRadius:6,
            padding:"5px 10px",color:TH.muted,cursor:"pointer",
            fontSize:11,fontWeight:600,fontFamily:TH.mono,flexShrink:0
          }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor=TH.cyan; e.currentTarget.style.color=TH.cyan; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=TH.border; e.currentTarget.style.color=TH.muted; }}>
            ← {back}
          </button>
        )}
        {sub && (
          <p style={{ fontSize:13,color:TH.muted,lineHeight:1.5,fontWeight:500,margin:0 }}>{sub}</p>
        )}
      </div>
      {action && <div style={{ display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",flexShrink:0 }}>{action}</div>}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────
function Table({ headers, rows, onRow, loading, emptyIcon="📭", emptyText="No records found" }) {
  return (
    <div style={{ overflowX:"auto",borderRadius:14,border:`1px solid ${TH.border}`,overflow:"hidden",boxShadow:`0 4px 20px rgba(0,0,0,.18)` }}>
      <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13.5,minWidth:500,lineHeight:1.5 }}>
        <thead>
          <tr style={{
            background:`linear-gradient(180deg, ${TH.cardHi} 0%, ${TH.card} 100%)`,
            borderBottom:`2px solid ${TH.border}`
          }}>
            {headers.map((h,hi)=>(
              <th key={h} style={{
                padding:"13px 18px",
                textAlign:"left",
                fontSize:11,
                fontWeight:700,
                color:TH.muted,
                textTransform:"uppercase",
                letterSpacing:"1.4px",
                whiteSpace:"nowrap",
                fontFamily:TH.mono,
                borderBottom:`2px solid ${TH.border}`,
                ...(hi===0 ? { borderLeft:`3px solid ${TH.cyan}` } : {})
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={headers.length} style={{ textAlign:"center",padding:64,color:TH.muted,background:TH.surface }}>
                <span className="spin" style={{ fontSize:30,color:TH.cyan,display:"block",marginBottom:10 }}>⟳</span>
                <div style={{ fontSize:11, fontFamily:TH.mono, letterSpacing:1.5, color:TH.muted, textTransform:"uppercase" }}>Loading data...</div>
              </td>
            </tr>
          )}
          {!loading && rows.length===0 && (
            <tr><td colSpan={headers.length} style={{ background:TH.surface }}><Empty icon={emptyIcon} text={emptyText}/></td></tr>
          )}
          {!loading && rows.map((row,i)=>(
            <tr key={row.key||i} onClick={()=>onRow?.(row)} style={{
              borderBottom:`1px solid ${TH.border}`,
              cursor:onRow?"pointer":"default",
              transition:"background .12s, box-shadow .12s",
              background: i%2===0 ? TH.surface : `linear-gradient(90deg, ${TH.cardHi}, ${TH.surface})`
            }}
              onMouseEnter={e=>{
                e.currentTarget.style.background=TH.hover;
                e.currentTarget.style.boxShadow=`inset 3px 0 0 ${TH.cyan}`;
              }}
              onMouseLeave={e=>{
                e.currentTarget.style.background = i%2===0 ? TH.surface : `linear-gradient(90deg, ${TH.cardHi}, ${TH.surface})`;
                e.currentTarget.style.boxShadow="none";
              }}>
              {row.cells.map((cell,j)=>(
                <td key={j} style={{
                  padding:"11px 18px",
                  color:j===0?TH.textHi:TH.text,
                  fontWeight:j===0?600:400,
                  verticalAlign:"middle",
                  fontSize:13.5,
                  ...(j===0 ? { borderLeft:`3px solid transparent` } : {})
                }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────
function Pagination({ page, total, per, onChange }) {
  if (!per || per <= 0 || !total) return null;
  const pages = Math.ceil(total/per);
  if (pages<=1) return null;
  const s=(page-1)*per+1, e=Math.min(page*per,total);
  return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderTop:`1px solid ${TH.border}` }}>
      <span style={{ fontSize:12,color:TH.muted }}>Showing {fNum(s)}–{fNum(e)} of {fNum(total)}</span>
      <div style={{ display:"flex",gap:4 }}>
        <Btn v="ghost" sz="xs" disabled={page===1} onClick={()=>onChange(page-1)}>←</Btn>
        {Array.from({length:Math.min(5,pages)},(_,i)=>{
          const p=page<=3?i+1:page>=pages-2?pages-4+i:page-2+i;
          if(p<1||p>pages)return null;
          return <Btn key={p} v={p===page?"primary":"ghost"} sz="xs" onClick={()=>onChange(p)}>{p}</Btn>;
        })}
        <Btn v="ghost" sz="xs" disabled={page===pages} onClick={()=>onChange(page+1)}>→</Btn>
      </div>
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────
function Tabs({ items, active, onChange, style={} }) {
  return (
    <div style={{ display:"flex",gap:0,borderBottom:`1px solid ${TH.border}`,marginBottom:20,overflowX:"auto",...style }}>
      {items.map(item=>(
        <button key={item.id} onClick={()=>onChange(item.id)}
          style={{ padding:"10px 18px",fontSize:13,fontWeight:600,background:"none",border:"none",borderBottom:`2px solid ${active===item.id?TH.blue:"transparent"}`,color:active===item.id?TH.blue:TH.muted,cursor:"pointer",transition:"all .14s",display:"flex",alignItems:"center",gap:7,whiteSpace:"nowrap",flexShrink:0 }}>
          {item.icon&&<span>{item.icon}</span>}
          {item.label}
          {item.count!=null&&<Badge color={active===item.id?"blue":"gray"} sm>{item.count}</Badge>}
        </button>
      ))}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, width=660, footer, subtitle }) {
  useEffect(()=>{
    const fn=e=>{if(e.key==="Escape")onClose();};
    document.addEventListener("keydown",fn);
    return()=>document.removeEventListener("keydown",fn);
  },[onClose]);
  return (
    <div className="fade-in" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,.72)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16 }}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="professional-surface" style={{ background:`linear-gradient(180deg, ${TH.cardHi}, ${TH.surface})`,border:`1px solid ${TH.borderB}`,borderRadius:18,width:`min(${width}px,100%)`,maxHeight:"92vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 32px 96px rgba(0,0,0,.6)" }}>
        <div style={{ padding:"18px 22px",borderBottom:`1px solid ${TH.border}`,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexShrink:0 }}>
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:TH.text }}>{title}</div>
            {subtitle&&<div style={{ fontSize:12,color:TH.muted,marginTop:3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background:TH.hover,border:`1px solid ${TH.border}`,borderRadius:10,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:TH.muted,cursor:"pointer",flexShrink:0,marginLeft:16 }}>×</button>
        </div>
        <div style={{ padding:22,overflowY:"auto",flex:1 }}>{children}</div>
        {footer&&<div style={{ padding:"16px 22px",borderTop:`1px solid ${TH.border}`,flexShrink:0,background:TH.surface }}>{footer}</div>}
      </div>
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────
function Confirm({ title, message, onConfirm, onCancel, danger=true, confirmLabel="Confirm" }) {
  return (
    <Modal title={title} onClose={onCancel} width={420}
      footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={onCancel}>Cancel</Btn><Btn v={danger?"danger":"primary"} onClick={onConfirm}>{confirmLabel}</Btn></div>}>
      <p style={{ fontSize:14,color:TH.muted,lineHeight:1.75 }}>{message}</p>
    </Modal>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────
function Progress({ value, max=100, color, height=6, label }) {
  const c=color||TH.blue, pct=Math.min(100,Math.max(0,(value/max)*100));
  return (
    <div>
      {label&&<div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
        <span style={{ fontSize:11,color:TH.muted }}>{label}</span>
        <span style={{ fontSize:11,fontWeight:600,color:c,fontFamily:TH.mono }}>{~~pct}%</span>
      </div>}
      <div style={{ height,background:TH.border,borderRadius:height,overflow:"hidden" }}>
        <div style={{ height:"100%",width:`${pct}%`,background:c,borderRadius:height,transition:"width .5s cubic-bezier(.4,0,.2,1)",boxShadow:`0 0 8px ${c}50` }}/>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────
function Empty({ icon="📭", text="No data", sub, action }) {
  return (
    <div style={{ textAlign:"center",padding:"52px 20px",display:"flex",flexDirection:"column",alignItems:"center",gap:10 }}>
      <div style={{ fontSize:48,opacity:.15,filter:"grayscale(1)" }}>{icon}</div>
      <div style={{ fontSize:16,fontWeight:700,color:TH.muted }}>{text}</div>
      {sub&&<div style={{ fontSize:12,color:TH.muted,maxWidth:320,lineHeight:1.6 }}>{sub}</div>}
      {action&&<div style={{ marginTop:8 }}>{action}</div>}
    </div>
  );
}

// ── Loader ────────────────────────────────────────────────────────────
function Loader({ text="" }) {
  return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,padding:56 }}>
      <div style={{ width:36,height:36,border:`3px solid ${TH.border}`,borderTop:`3px solid ${TH.blue}`,borderRadius:"50%" }} className="spin"/>
      {text&&<span style={{ fontSize:13,color:TH.muted }}>{text}</span>}
    </div>
  );
}

// ── KV row ────────────────────────────────────────────────────────────
function KV({ label, value, color, mono, action }) {
  return (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${TH.border}` }}>
      <span className="ui-label" style={{ fontSize:14,color:TH.muted,fontWeight:600 }}>{label}</span>
      <div style={{ display:"flex",alignItems:"center",gap:8,textAlign:"right" }}>
        <span className="ui-value" style={{ fontSize:14,fontWeight:700,color:color||TH.textHi,fontFamily:mono?TH.mono:"inherit",lineHeight:1.45 }}>{value??<span style={{ opacity:.45 }}>—</span>}</span>
        {action}
      </div>
    </div>
  );
}

// ── Search bar ────────────────────────────────────────────────────────
function SearchBar({ value, onChange, placeholder="Search…", style={} }) {
  return <Input value={value} onChange={onChange} placeholder={placeholder} prefix="⌕" style={style}/>;
}

// ── Avatar ────────────────────────────────────────────────────────────
function Avatar({ name, size=36, color=TH.blue, img }) {
  const initials = (name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  if (img) return (
    <img src={img}
      style={{
        width:size,height:size,borderRadius:"50%",objectFit:"cover",
        border:`2px solid ${color}55`,
        flexShrink:0,
        boxShadow:`0 0 0 1px rgba(0,4,12,.5), 0 2px 8px rgba(0,0,0,.4), inset 0 0 0 1px ${color}22`
      }}
      alt={name}/>
  );
  return (
    <div style={{
      width:size,height:size,borderRadius:"50%",
      background:`linear-gradient(135deg, ${color}30 0%, ${color}10 100%)`,
      border:`2px solid ${color}55`,
      display:"flex",alignItems:"center",justifyContent:"center",
      fontSize:size*0.36,fontWeight:700,color,
      flexShrink:0,
      fontFamily:TH.mono,
      letterSpacing:".5px",
      boxShadow:`inset 0 1px 0 rgba(255,255,255,.08), 0 0 12px ${color}22, 0 2px 4px rgba(0,0,0,.3)`,
      textShadow:`0 0 6px ${color}66`
    }}>
      {initials}
    </div>
  );
}

// ── Toast provider ────────────────────────────────────────────────────
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((msg, type="info", dur=4500) => {
    const id = Date.now() + Math.random();
    setToasts(p=>[...p,{id,msg,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)), dur);
  },[]);
  const TC = { success:TH.green, error:TH.red, warning:TH.amber, info:TH.blue };
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div style={{ position:"fixed",bottom:22,right:22,zIndex:9999,display:"flex",flexDirection:"column",gap:9,maxWidth:380,width:"calc(100% - 44px)" }}>
        {toasts.map(t=>(
          <div key={t.id} className="slide-up"
            style={{ background:TH.surface,border:`1px solid ${TC[t.type]||TH.border}`,borderLeft:`4px solid ${TC[t.type]||TH.blue}`,borderRadius:10,padding:"12px 16px",boxShadow:TH.shadowLg,display:"flex",alignItems:"flex-start",gap:10 }}>
            <span style={{ fontSize:16,flexShrink:0 }}>{{success:"✓",error:"✗",warning:"⚠",info:"ℹ"}[t.type]||"•"}</span>
            <span style={{ fontSize:13,color:TH.text,lineHeight:1.5,flex:1 }}>{t.msg}</span>
            <button onClick={()=>setToasts(p=>p.filter(x=>x.id!==t.id))} style={{ background:"none",border:"none",color:TH.muted,cursor:"pointer",fontSize:14,padding:0,flexShrink:0 }}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Chart tooltip style ───────────────────────────────────────────────
const TT_STYLE = { background:TH.surface, border:`1px solid ${TH.border}`, borderRadius:9, fontSize:12, color:"#ffffff", boxShadow:TH.shadow };
const TT_ITEM_STYLE = { color:"#ffffff" };
const TT_LABEL_STYLE = { color:"#ffffff" };
const CHART_COLORS = [TH.blue, TH.green, TH.amber, TH.violet, TH.cyan, TH.pink, TH.red];

/* ═══════════════════════════════════════════════════════════════════════
   LOGIN
═══════════════════════════════════════════════════════════════════════ */
function LoginPage({ onLogin }) {
  const { show } = useToast();
  const [u, setU]   = useState(localStorage.getItem("expo_last_user") || "admin");
  const [p, setP]   = useState("");
  const [showPass, setShowPass] = useState(false);
  const [rememberUser, setRememberUser] = useState(!!localStorage.getItem("expo_last_user"));
  const [capsOn, setCapsOn] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [mouseFx, setMouseFx] = useState({ x: 72, y: 44 });
  const [busy, set] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const go = async e => {
    e?.preventDefault();
    if (!u.trim()) { show("Enter username", "error"); return; }
    set(true);
    try {
      const r = await api.login({ username:u.trim(), password:p });
      if (!r || !r.token) { show("Invalid username or password", "error"); return; }
      if (rememberUser) localStorage.setItem("expo_last_user", u.trim());
      else localStorage.removeItem("expo_last_user");
      setToken(r.token);
      onLogin(r.user);
    } catch (e) { show(e.message||"Login failed","error"); }
    finally { set(false); }
  };

  const companyLogo = "/company-logo.png";

  return (
    <div className="login-stage" style={{ minHeight:"100vh",display:"flex",overflow:"hidden",background:TH.bg }}
      onMouseMove={e=>{
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        const y = ((e.clientY - r.top) / r.height) * 100;
        setMouseFx({ x, y });
      }}>
      <div className="login-aurora" />
      <div className="login-pointer-glow" style={{ left:`calc(${mouseFx.x}% - 230px)`, top:`calc(${mouseFx.y}% - 230px)` }} />
      <div className="login-radar" />
      <div className="login-lines" />
      <div className="login-sweep" />
      <div className="login-particle a" />
      <div className="login-particle b" />
      <div className="login-particle c" />
      <div className="login-particle d" />
      <div className="login-orb a" />
      <div className="login-orb b" />
      <div className="login-orb c" />
      {/* Left decorative panel */}
      <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(140deg, #060f20 0%, #040b18 48%, #08162d 100%)",borderRight:`1px solid ${TH.border}`,padding:40,position:"relative",overflow:"hidden",zIndex:1 }}>
        <div className="left-cinematic-vignette" />
        <div className="left-cinematic-glow" />
        <div className="fr-grid" style={{ position:"absolute",inset:0,opacity:.26,pointerEvents:"none" }}/>
        <div className="fr-left-wave" />
        <div className="fr-left-bg-scan" />
        <div className="login-corner-hud tl" />
        <div className="login-corner-hud tr" />
        <div className="login-corner-hud bl" />
        <div className="login-corner-hud br" />
        <div className="login-corner-dot tl" />
        <div className="login-corner-dot tr" />
        <div className="login-corner-dot bl" />
        <div className="login-corner-dot br" />
        {[{s:420,o:.04,t:-120,l:-120},{s:320,o:.05,t:220,l:110},{s:220,o:.06,b:-90,r:-90}].map((c,i)=>(
          <div key={i} style={{ position:"absolute",width:c.s,height:c.s,borderRadius:"50%",border:`1px solid ${TH.blue}`,opacity:c.o,top:c.t,left:c.l,bottom:c.b,right:c.r,pointerEvents:"none" }}/>
        ))}
        <div style={{ maxWidth:560,position:"relative",zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:22,transform:"translateX(-18px)" }}>
          <div className="ai-face-wrap">
            <div className="ai-glow-blobs"/>
            <div className="ai-face-rings"/>
            <div className="ai-orbit"><span/><span/><span/><span/><span/></div>
            <div className="ai-energy-arcs"/>
            <div className="ai-grid-drift"/>
            <div className="ai-ambient-beam"/>
            <div className="ai-scan-target"/>
            <div className="ai-particle-field"><span/><span/><span/><span/><span/></div>
            <div className="ai-face-panel">
              <div className="ai-face-hud"/>
              <div className="ai-face-scanline"/>
              <img
                className="ai-face-svg"
                src="/ai-face-wireframe.png"
                alt="AI wireframe face"
                style={{ objectFit:"cover", borderRadius:14, opacity:.95 }}
              />
              <div className="ai-face-blink"/>
              <div className="ai-face-nodefield"><span/><span/><span/><span/><span/><span/><span/><span/></div>
              <div className="ai-face-dots"><span/><span/><span/></div>
              <div className="ai-face-caption">AI Face Mesh Analysis</div>
            </div>
          </div>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:10,flexWrap:"wrap",marginTop:-20 }}>
            <span className="fr-chip"><span className="pulse-dot" style={{ width:7,height:7,borderRadius:"50%",background:TH.green,display:"inline-block" }}/> <b>FR Engine:</b> Ready</span>
            <span className="fr-chip"><span style={{ color:TH.cyan }}>◈</span> <b>Liveness:</b> Enabled</span>
            <span className="fr-chip"><span style={{ color:TH.blue }}>⟟</span> <b>Mode:</b> Real-time</span>
          </div>
        </div>
        <div style={{ position:"absolute",bottom:22,left:0,right:0,textAlign:"center",fontSize:10,color:TH.muted,zIndex:1 }}>
          © Expo City Dubai. All rights reserved.
        </div>
      </div>

      {/* Right login form */}
      <div style={{ width:640,display:"flex",alignItems:"center",justifyContent:"center",padding:36,position:"relative",zIndex:1 }}>
        <div style={{ width:"100%",maxWidth:560 }}>
          <div style={{ position:"absolute",top:14,right:18,display:"inline-flex",alignItems:"center",gap:8,padding:"7px 11px",borderRadius:12,border:`1px solid ${TH.border}`,background:"rgba(10,18,34,.55)",fontSize:12,color:TH.muted }}>
            <span className="pulse-dot" style={{ width:7,height:7,borderRadius:"50%",background:TH.green,display:"inline-block" }}/>
            System time: <span style={{ color:TH.text,fontWeight:700 }}>{now.toLocaleTimeString()}</span>
          </div>
          <div style={{ display:"flex",justifyContent:"center",marginTop:-26,marginBottom:0 }}>
            <img src={companyLogo} alt="Expo City Dubai logo" className="logo-breathe" style={{ width:146,height:146,objectFit:"contain",filter:"drop-shadow(0 10px 20px rgba(0,0,0,.45)) drop-shadow(0 0 20px rgba(224,173,78,.2))" }} />
          </div>
          <div style={{ textAlign:"center",marginTop:16,marginBottom:14 }}>
            <div style={{ fontSize:20,fontWeight:900,letterSpacing:".06em",color:TH.text }}>EXPO CITY DUBAI</div>
            <div style={{ fontSize:12,color:TH.muted,letterSpacing:".12em",textTransform:"uppercase",marginTop:6 }}>Enterprise Access Control · Face Recognition</div>
          </div>
          <Card className="signin-card" pad={0} style={{ marginTop:58,marginBottom:20,overflow:"hidden",background:"linear-gradient(180deg, rgba(18,31,53,.88), rgba(14,24,41,.92))",transform:`perspective(1200px) rotateX(${(50-mouseFx.y)/65}deg) rotateY(${(mouseFx.x-50)/65}deg)` }}>
            <div className="signin-card-energy" />
            <div className="signin-card-hud" />
            <form onSubmit={go}>
              <div style={{ padding:"24px 30px 14px",borderBottom:`1px solid ${TH.border}` }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <div style={{ width:38,height:38,borderRadius:10,background:TH.blueDim,border:`1px solid ${TH.blue}55`,display:"flex",alignItems:"center",justifyContent:"center",color:TH.blue,fontSize:17 }}>🔐</div>
                  <div>
                    <div style={{ fontSize:17,fontWeight:800,color:TH.text }}>Account Login</div>
                    <div style={{ fontSize:13,color:TH.muted }}>Use your authorized credentials</div>
                  </div>
                </div>
              </div>
              <div style={{ padding:"30px 30px 0" }}>
                <Field label="Username" required>
                  <Input value={u} onChange={e=>setU(e.target.value)} placeholder="username" prefix="👤" onEnter={go}/>
                </Field>
                <div style={{ height:20 }}/>
                <Field label="Password">
                  <Input value={p} onChange={e=>setP(e.target.value)} placeholder="password" type={showPass ? "text" : "password"} prefix="🔒" onEnter={go}
                    onKeyDown={e=>setCapsOn(e.getModifierState?.("CapsLock"))}/>
                </Field>
                {capsOn && <div style={{ marginTop:8,fontSize:12,color:TH.amber }}>Caps Lock is ON</div>}
                <div style={{ marginTop:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap" }}>
                  <label style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:12,color:TH.muted }}>
                    <input type="checkbox" checked={showPass} onChange={e=>setShowPass(e.target.checked)} />
                    Show password
                  </label>
                  <label style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:12,color:TH.muted }}>
                    <input type="checkbox" checked={rememberUser} onChange={e=>setRememberUser(e.target.checked)} />
                    Remember username
                  </label>
                </div>
              </div>
              <div style={{ padding:30 }}>
                <Btn type="submit" full loading={busy} sz="lg" disabled={!u.trim() || !p} style={{ position:"relative" }}>
                  <span className="signin-cta">Sign In →</span>
                </Btn>
              </div>
            </form>
          </Card>
          <div className="fut-strip">
            <div className="t">Live biometric trust stream active</div>
            <div className="fut-bars"><span/><span/><span/><span/><span/></div>
          </div>
          <div className="fut-kpis">
            <div className="fut-kpi"><div className="v">99.98%</div><div className="l">Auth Uptime</div></div>
            <div className="fut-kpi"><div className="v">&lt; 300ms</div><div className="l">Recognition</div></div>
            <div className="fut-kpi"><div className="v">AES-256</div><div className="l">Session Security</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   NAVIGATION DEFINITION
═══════════════════════════════════════════════════════════════════════ */
const NAV = [
  { s:"Overview" },
  { id:"dashboard",    icon:"⬡",   label:"Dashboard",        desc:"Live command center" },
  { id:"monitor",      icon:"◉",   label:"FR Live Monitor",  desc:"Real-time access grid", badge:"LIVE", bc:"green" },
  { id:"logs",         icon:"≡",   label:"Access Logs",      desc:"All events",            badge:"LIVE", bc:"green" },
  { s:"Devices" },
  { id:"devices",      icon:"◫",   label:"My Devices",       desc:"Connected hardware" },
  { id:"setup",        icon:"⚙",   label:"Configure Device", desc:"Add & connect",         badge:"SETUP", bc:"blue", hl:true },
  { id:"models",       icon:"▦",   label:"Device Models",    desc:"8 supported models" },
  { id:"credentials",  icon:"🔐",  label:"Credentials",      desc:"Auth modes & cards" },
  { s:"People" },
  { id:"companies",    icon:"🏢",  label:"Companies",        desc:"Tenant organizations" },
  { id:"employees",    icon:"👥",  label:"Employees",        desc:"Staff management" },
  { id:"enrollment",   icon:"📷",  label:"Face Enrollment",  desc:"AI photo enrollment" },
  { id:"visitors",     icon:"🪪",  label:"Visitors",         desc:"Guest management" },
  { id:"footprints",   icon:"👣",  label:"Footprints",       desc:"Movement history" },
  { s:"Security" },
  { id:"alerts",       icon:"🔔",  label:"Alerts",           desc:"Notifications" },
  { id:"threats",      icon:"🛡",   label:"Threat Intel",     desc:"AI risk engine" },
  { id:"sync",         icon:"⟳",   label:"Offline Sync",     desc:"Buffer recovery" },
  { s:"AI & Analytics" },
  { id:"ai_insights",  icon:"🧠",   label:"AI Insights",      desc:"Automated analysis" },
  { id:"reports",      icon:"◪",   label:"Reports",          desc:"Charts & trends" },
  { id:"export",       icon:"⬇",   label:"Export Data",      desc:"Excel / PDF / CSV" },
  { s:"Administration" },
  { id:"locations",    icon:"📍",  label:"Locations",        desc:"Buildings & zones" },
  { id:"superadmin",   icon:"👑",  label:"Admin Accounts",   desc:"User management" },
];

/* ═══════════════════════════════════════════════════════════════════════
   SIDEBAR
═══════════════════════════════════════════════════════════════════════ */
function Sidebar({ page, onNav, user, open, onToggle, alertCount=0 }) {
  const role = String(user?.role || "").trim().toLowerCase();
  const isSuperadmin = role === "superadmin";
  const sidebarLogo = "/sidebar-logo.png";
  const bColors = { green:TH.green, blue:TH.blue, red:TH.red, amber:TH.amber };
  const logoWrap = open ? 80 : 54;
  const logoSize = open ? 68 : 44;
  const [compactHeight, setCompactHeight] = useState(() => (typeof window !== "undefined" ? window.innerHeight < 860 : false));
  useEffect(() => {
    const onResize = () => setCompactHeight(window.innerHeight < 860);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <aside className="professional-surface" style={{ width:open?312:72,height:"100vh",minHeight:0,background:`linear-gradient(180deg, rgba(8,22,38,.98) 0%, rgba(6,13,24,.98) 100%)`,display:"flex",flexDirection:"column",flexShrink:0,transition:"width .22s cubic-bezier(.4,0,.2,1)",overflowY:"hidden",overflowX:"hidden",position:"relative",zIndex:10,boxShadow:`10px 0 34px rgba(0,0,0,.34), inset -1px 0 0 ${TH.cyan}22` }}>
      {/* Logo */}
      <div style={{ position:"sticky",top:0,zIndex:3,padding:open?"12px 14px":"10px 8px",display:"flex",alignItems:"center",justifyContent:open?"flex-start":"center",gap:open?10:0,minHeight:open?68:62,flexShrink:0,background:`linear-gradient(180deg, #05101e, #0a1726)`,borderBottom:`1px solid ${TH.cyan}33`,boxShadow:`0 1px 12px ${TH.cyan}22` }}>
        <div style={{ width:logoWrap,height:logoWrap,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,background:"radial-gradient(circle at 35% 30%, rgba(255,255,255,.14), rgba(255,255,255,.02) 58%)" }}>
          <img
            src={sidebarLogo}
            alt="Expo City Dubai logo"
            onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = "/company-logo.png"; }}
            style={{ width:logoSize,height:logoSize,objectFit:"contain",filter:"none" }}
          />
        </div>
        {open&&<>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:18,fontWeight:900,color:TH.text,letterSpacing:"-.1px",lineHeight:1.2 }}>Expo City Dubai</div>
          </div>
          <button onClick={onToggle} style={{ background:"rgba(0,238,255,.10)",border:`1px solid rgba(0,238,255,.28)`,color:"rgba(255,255,255,.75)",cursor:"pointer",fontSize:15,padding:"5px 8px",borderRadius:7,flexShrink:0,lineHeight:1,fontWeight:700,transition:"all .14s" }}
            onMouseEnter={e=>{ e.currentTarget.style.background="rgba(0,238,255,.20)"; e.currentTarget.style.color="#ffffff"; }}
            onMouseLeave={e=>{ e.currentTarget.style.background="rgba(0,238,255,.10)"; e.currentTarget.style.color="rgba(255,255,255,.75)"; }}>‹</button>
        </>}
        {!open&&<button onClick={onToggle} style={{ position:"absolute",inset:0,background:"none",border:"none",cursor:"pointer" }}/>}
      </div>

      {/* Nav items */}
      <nav style={{ flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden",padding:"6px 0 8px" }}>
        {NAV.map((item,i)=>{
          if (item.s) return open
            ? <div key={i} style={{ padding:"10px 14px 6px",fontSize:10,fontWeight:700,color:TH.cyan,textTransform:"uppercase",letterSpacing:"1.6px",fontFamily:TH.mono,borderTop:i>0?`1px solid ${TH.border}`:"none",marginTop:i>0?6:0,paddingTop:i>0?10:10,opacity:.92 }}>▸ {item.s}</div>
            : <div key={i} style={{ height:2 }}/>;

          if (!can(role, item.id) && !isSuperadmin) return null;

          const on = page===item.id;
          const isAiItem = item.id==="ai" || item.id==="ai_insights";
          const bc = bColors[item.bc]||TH.blue;
          const badgeNum = item.id==="alerts"&&alertCount>0 ? alertCount : null;

          return (
            <button key={item.id} onClick={()=>onNav(item.id)} title={!open?item.label:undefined}
              className={isAiItem ? "ai-nav-glow" : undefined}
              style={{ width:"100%",display:"flex",alignItems:"center",gap:10,padding:open?"10px 14px":"9px 0",justifyContent:open?"flex-start":"center",background:on?`linear-gradient(90deg, ${TH.cyan}24 0%, ${TH.blue}16 50%, transparent 100%)`:"transparent",borderLeft:`3px solid ${on?TH.cyan:"transparent"}`,border:"none",cursor:"pointer",textAlign:"left",transition:"all .14s cubic-bezier(.4,0,.2,1)",color:on?TH.cyan:TH.muted,position:"relative",borderRadius:open?"0 12px 12px 0":0 }}
              onMouseEnter={e=>{ if(!on){e.currentTarget.style.background=`linear-gradient(90deg, ${TH.cyan}14, transparent)`;} }}
              onMouseLeave={e=>{ if(!on)e.currentTarget.style.background="transparent"; }}>
              <span className={`${isAiItem ? "ai-nav-icon " : ""}icon-chip`} style={{ fontSize:14,textAlign:"center",flexShrink:0,color:on?"#d7e9ff":TH.muted,position:"relative",zIndex:1,background:on?`linear-gradient(180deg, ${TH.cyan}40, ${TH.blue}20)`:`linear-gradient(180deg, ${TH.cardHi}, ${TH.card})`,border:on?`1px solid ${TH.cyan}aa`:`1px solid ${TH.border}`,boxShadow:on?`inset 0 1px 0 rgba(255,255,255,.18), 0 0 14px ${TH.cyanGlow}`:`inset 0 1px 0 rgba(255,255,255,.06), 0 1px 3px rgba(0,0,0,.4)` }}>{item.icon}</span>
              {open&&<>
                <div style={{ flex:1,minWidth:0,position:"relative",zIndex:1 }}>
                  <div style={{ fontSize:15,fontWeight:800,color:on?TH.cyan:TH.textHi,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2 }}>{item.label}</div>
                  {!compactHeight&&<div style={{ fontSize:13,color:"#c5d6ea",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2,marginTop:2 }}>{item.desc}</div>}
                </div>
                {badgeNum!=null&&<span style={{ fontSize:11,padding:"2px 8px",borderRadius:10,background:TH.redDim,color:TH.red,fontWeight:700,flexShrink:0 }}>{badgeNum}</span>}
                {!badgeNum&&item.badge&&<span style={{ fontSize:10,padding:"2px 7px",borderRadius:10,background:`${bc}20`,color:bc,fontWeight:700,flexShrink:0 }}>{item.badge}</span>}
              </>}
            </button>
          );
        })}
      </nav>

      {/* Expand toggle when closed */}
      {!open&&<div style={{ padding:"6px 0",borderTop:`1px solid ${TH.border}`,display:"flex",justifyContent:"center",flexShrink:0 }}>
        <button onClick={onToggle} style={{ background:"none",border:"none",color:TH.muted,cursor:"pointer",fontSize:18,padding:4 }}>›</button>
      </div>}

      {/* User (always visible, including superadmin in collapsed mode) */}
      {user&&<div
        title={`${user.name||user.username} (${user.role||"user"})`}
        style={{ padding:open?"9px 14px":"8px 0",borderTop:`1px solid ${TH.border}`,display:"flex",gap:open?10:0,alignItems:"center",justifyContent:open?"flex-start":"center",flexShrink:0,background:"linear-gradient(180deg, rgba(21,36,60,.92), rgba(18,31,52,.94))" }}>
        <Avatar name={user.name||user.username} size={open?30:28} color={TH.blue}/>
        {open
          ? <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:14,fontWeight:700,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.25 }}>{user.name||user.username}</div>
              <div style={{ fontSize:12,color:TH.blue,fontWeight:700,textTransform:"capitalize",lineHeight:1.2 }}>{user.role}</div>
            </div>
          : <span style={{ position:"absolute",bottom:5,right:8,fontSize:11,color:TH.amber,fontWeight:800 }}>👑</span>}
      </div>}
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TOPBAR
═══════════════════════════════════════════════════════════════════════ */
function TopBar({ page, user, onLogout, online, onNav, onBack, canGoBack, onThemeToggle, lightTheme }) {
  const { show } = useToast();
  const [now, setNow] = useState(new Date());
  const { data:health, reload:reloadHealth } = useFetch(()=>api.health(),[], null);

  useEffect(()=>{ const iv=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(iv); },[]);
  useEffect(() => {
    const refresh = () => { reloadHealth(); };
    const iv = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    window.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("visibilitychange", refresh);
    };
  }, [reloadHealth]);

  const label  = NAV.find(n=>n.id===page)?.label||"Dashboard";
  const devOn  = health?.devices?.online;
  const devTot = health?.devices?.total;
  const onSite = health?.onPremise;
  const sh = health?.selfHealing?.state || {};
  const wd = health?.watchdog?.state || {};
  const fa = health?.faceAutoRefreshQueue || {};
  const nowMs = Date.now();
  const parseTs = (v) => {
    const ms = Date.parse(String(v || ""));
    return Number.isFinite(ms) ? ms : 0;
  };
  const isRecent = (v, windowMs) => {
    const ts = parseTs(v);
    return ts > 0 && nowMs - ts <= windowMs;
  };
  const selfHealLevel = (() => {
    const sidecarFails = Number(sh?.sidecarConsecutiveFails || 0);
    const wdActions = Array.isArray(wd?.lastActions) ? wd.lastActions : [];
    const wdFailed = wdActions.some((a) => a?.ok === false);
    const wdTriggeredRecently = isRecent(wd?.lastTriggerAt, 5 * 60 * 1000);
    const qErr = String(fa?.lastError || "").trim();
    const queueIssueRecent = Boolean(qErr) && isRecent(fa?.lastRunAt || fa?.lastSuccessAt, 10 * 60 * 1000);
    if (sidecarFails >= 2 || (wdTriggeredRecently && wdFailed)) return "red";
    if (sidecarFails === 1 || queueIssueRecent) return "yellow";
    return "green";
  })();
  const selfHealMeta = {
    green: { label: "Self-healing OK", color: TH.green, bg: TH.greenDim },
    yellow: { label: "Self-healing warning", color: TH.amber, bg: TH.amberDim },
    red: { label: "Self-healing critical", color: TH.red, bg: TH.redDim }
  }[selfHealLevel];
  const selfHealTitle =
    `Self-healing: ${selfHealMeta.label}. ` +
    `Queue ${Number(fa?.queued || 0)} queued, ${Number(fa?.processed || 0)} processed, ${Number(fa?.failed || 0)} failed. ` +
    `Watchdog triggers: ${Number(wd?.triggers || 0)}.`;

  const doLogout = async () => {
    try { await api.logout(); } catch {}
    clearToken(); onLogout(); show("Signed out","info");
  };

  return (
    <header className="professional-surface" style={{ height:64,background:`linear-gradient(180deg, rgba(8,22,38,.92) 0%, rgba(7,17,31,.88) 100%)`,borderBottom:`1px solid ${TH.cyan}28`,display:"flex",alignItems:"center",padding:"0 24px",gap:16,flexShrink:0,boxShadow:`0 10px 28px rgba(0,0,0,.22), 0 1px 0 ${TH.cyan}11 inset`,position:"relative",zIndex:5 }}>
      <div style={{ display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0 }}>
        <Btn v="ghost" sz="sm" onClick={onBack} disabled={!canGoBack}>← Back</Btn>
        <div style={{ display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0 }}>
          <span style={{ color:TH.cyan,opacity:.45,fontSize:13,fontFamily:TH.mono,fontWeight:700,flexShrink:0 }}>//</span>
          <h2 style={{ fontSize:14,fontWeight:800,color:TH.textHi,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",letterSpacing:".3px",margin:0 }}>{label}</h2>
        </div>
      </div>

      <div style={{ display:"flex",gap:14,alignItems:"center" }}>
        {/* Live stats */}
        {[{l:"Devices",v:devOn!=null?`${devOn}/${devTot}`:"—",c:TH.green},{l:"On-Site",v:onSite??<span style={{ opacity:.4 }}>—</span>,c:TH.blue}].map(s=>(
          <div key={s.l} style={{
            display:"flex",flexDirection:"column",alignItems:"center",
            padding:"4px 12px",borderRadius:3,
            background:`linear-gradient(180deg, ${TH.cardHi}, ${TH.card})`,
            border:`1px solid ${s.c}33`,
            boxShadow:`inset 0 1px 0 rgba(255,255,255,.04), 0 0 8px ${s.c}11`,
            minWidth:62
          }}>
            <div style={{ fontSize:15,fontWeight:700,color:s.c,fontFamily:TH.mono,lineHeight:1,letterSpacing:".5px",textShadow:`0 0 6px ${s.c}66`,fontVariantNumeric:"tabular-nums" }}>{s.v}</div>
            <div style={{ fontSize:9,color:TH.muted,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",marginTop:3,fontFamily:TH.mono }}>{s.l}</div>
          </div>
        ))}

        {/* Online status */}
        <div style={{
          display:"flex",gap:7,alignItems:"center",
          padding:"5px 11px",borderRadius:3,
          background:online?`linear-gradient(180deg, ${TH.greenDim}, transparent)`:`linear-gradient(180deg, ${TH.redDim}, transparent)`,
          border:`1px solid ${online?TH.green:TH.red}55`,
          boxShadow:`inset 0 1px 0 rgba(255,255,255,.04)`
        }}>
          <span className={online?"scada-led":"scada-led alarm"} style={{
            color: online?TH.green:TH.red,
            background:online?TH.green:TH.red
          }}/>
          <span style={{ fontSize:10,fontWeight:700,color:online?TH.green:TH.red,letterSpacing:"1.2px",fontFamily:TH.mono,textTransform:"uppercase" }}>
            {online?"LINK OK":"OFFLINE"}
          </span>
        </div>

        {/* Self-healing status chip */}
        <button title={`${selfHealTitle} Click to open Settings → System Health.`}
          onClick={()=>onNav?.("settings")}
          style={{
            display:"flex",gap:7,alignItems:"center",
            padding:"5px 11px",borderRadius:3,
            background:`linear-gradient(180deg, ${selfHealMeta.bg}, transparent)`,
            border:`1px solid ${selfHealMeta.color}55`,
            cursor:"pointer",
            boxShadow:`inset 0 1px 0 rgba(255,255,255,.04)`,
            transition:"all .12s"
          }}
          onMouseEnter={e=>{ e.currentTarget.style.boxShadow=`inset 0 1px 0 rgba(255,255,255,.06), 0 0 12px ${selfHealMeta.color}44`; }}
          onMouseLeave={e=>{ e.currentTarget.style.boxShadow=`inset 0 1px 0 rgba(255,255,255,.04)`; }}>
          <span className={selfHealLevel==="red"?"scada-led alarm":"scada-led"} style={{ color:selfHealMeta.color, background:selfHealMeta.color }}/>
          <span style={{ fontSize:10,fontWeight:700,color:selfHealMeta.color,letterSpacing:"1.2px",fontFamily:TH.mono,textTransform:"uppercase" }}>
            {selfHealLevel==="green"?"SYS OK":selfHealLevel==="yellow"?"SYS WARN":"SYS ALARM"}
          </span>
        </button>

        {/* Clock */}
        <div style={{
          display:"flex",alignItems:"center",gap:8,
          padding:"5px 12px",borderRadius:3,
          background:`linear-gradient(180deg, #050d18, #0a1726)`,
          border:`1px solid ${TH.cyan}55`,
          boxShadow:`inset 0 1px 0 rgba(255,255,255,.04), inset 0 0 12px ${TH.cyan}11`,
        }}>
          <div style={{ display:"flex",flexDirection:"column",lineHeight:1 }}>
            <span style={{ fontSize:15,fontWeight:700,color:TH.cyan,fontFamily:TH.mono,letterSpacing:"1px",fontVariantNumeric:"tabular-nums",textShadow:`0 0 8px ${TH.cyanGlow}` }}>
              {now.toLocaleTimeString("en-US",{hour12:false})}
            </span>
            <span style={{ fontSize:9,color:TH.muted,fontFamily:TH.mono,letterSpacing:".8px",marginTop:2,textTransform:"uppercase" }}>
              {now.toLocaleDateString("en-GB",{ day:"2-digit", month:"short", year:"numeric" })}
            </span>
          </div>
        </div>

        {/* Theme toggle */}
        <button
          onClick={onThemeToggle}
          title={lightTheme ? "Switch to Dark theme" : "Switch to Light theme"}
          style={{
            display:"flex", alignItems:"center", gap:5,
            background: lightTheme ? "rgba(255,255,255,.15)" : "rgba(255,255,255,.07)",
            border: `1px solid ${lightTheme ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.18)"}`,
            borderRadius:8, cursor:"pointer", padding:"5px 11px",
            fontSize:12, fontWeight:700, color:"#fff",
            transition:"all .15s", letterSpacing:".3px", lineHeight:1
          }}
          onMouseEnter={e=>{ e.currentTarget.style.background="rgba(255,255,255,.22)"; }}
          onMouseLeave={e=>{ e.currentTarget.style.background=lightTheme?"rgba(255,255,255,.15)":"rgba(255,255,255,.07)"; }}
        >
          <span style={{ fontSize:15 }}>{lightTheme ? "🌙" : "☀️"}</span>
          <span>{lightTheme ? "Dark" : "Light"}</span>
        </button>
        {/* Role */}
        <Badge color="blue">{user?.role}</Badge>

        {/* Superadmin settings */}
        {user?.role==="superadmin"&&(
          <button onClick={()=>onNav?.("settings")} title="Settings"
            style={{ background:"none",border:"none",cursor:"pointer",color:TH.muted,fontSize:15,padding:"6px 11px",borderRadius:7,transition:"all .13s",fontWeight:700 }}
            onMouseEnter={e=>{ e.currentTarget.style.background=TH.blueDim; e.currentTarget.style.color=TH.blue; }}
            onMouseLeave={e=>{ e.currentTarget.style.background="none"; e.currentTarget.style.color=TH.muted; }}>
            ⚙ Settings
          </button>
        )}

        {/* Logout */}
        <button onClick={doLogout} style={{ background:"none",border:"none",cursor:"pointer",color:TH.muted,fontSize:13,padding:"5px 10px",borderRadius:7,transition:"all .13s" }}
          onMouseEnter={e=>{ e.currentTarget.style.background=TH.redDim; e.currentTarget.style.color=TH.red; }}
          onMouseLeave={e=>{ e.currentTarget.style.background="none"; e.currentTarget.style.color=TH.muted; }}>
          ⏻
        </button>
      </div>
    </header>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   OFFLINE BANNER
═══════════════════════════════════════════════════════════════════════ */
function OfflineBanner({ online, syncMsg }) {
  const [show, setShow] = useState(false);
  const [msg,  setMsg]  = useState("");
  const qCount = () => { try { return JSON.parse(localStorage.getItem(QK)||"[]").length; } catch { return 0; } };

  useEffect(()=>{
    if (!online) {
      setMsg(`⚡ Server offline — ${qCount()} queued action${qCount()!==1?"s":""} will sync when reconnected`);
      setShow(true);
    } else if (syncMsg) {
      if (syncMsg.type==="queue"&&syncMsg.count>0) setMsg(`✓ Reconnected — ${syncMsg.count} action${syncMsg.count!==1?"s":""} synced`);
      else if (syncMsg.type==="devices") setMsg("✓ Device buffers recovered");
      setShow(true);
      setTimeout(()=>setShow(false), 5000);
    } else {
      setShow(false);
    }
  },[online,syncMsg]);

  if (!show) return null;
  return (
    <div style={{ padding:"8px 22px",background:online?TH.greenDim:TH.amberDim,borderBottom:`1px solid ${online?TH.green:TH.amber}30`,display:"flex",alignItems:"center",gap:9,fontSize:13,color:online?TH.green:TH.amber,fontWeight:500,flexShrink:0 }}>
      {!online&&<span className="pulse-dot">⚡</span>}
      {msg}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════════════ */
function DashboardPage({ onNav }) {
  // Keep KPI cards live without requiring a browser refresh.
  // If you add a new dashboard card backed by API data, include its reload below.
  const DASHBOARD_REFRESH_MS = 7000;
  const { data:stats,  loading:sLoad, reload:reloadStats } = useFetch(()=>api.logStats(),   [], null);
  const { data:health, reload:reloadHealth } = useFetch(()=>api.health(),     [], null);
  const { data:insightsRaw }           = useFetch(()=>api.aiInsights(),  [], null);
  const { data:empMeta, reload:reloadEmpMeta } = useFetch(()=>api.employees({ limit:1 }), [], { total:0 });
  const { data:visMeta, reload:reloadVisMeta } = useFetch(()=>api.visitors({ limit:1 }), [], { total:0 });
  const { data:devRaw, reload:reloadDevices } = useFetch(()=>api.devices(), [], []);
  const { data:riskData, reload:reloadRisk } = useFetch(()=>api.aiRiskScore(), [], null);
  const [feed, setFeed] = useState([]);
  const [activeAuthIdx, setActiveAuthIdx] = useState(-1);
  const [activeWeekDay, setActiveWeekDay] = useState("");

  const insights = Array.isArray(insightsRaw)
    ? { items: insightsRaw, alerts: [], riskScore: null }
    : (insightsRaw || {});

  const devList = Array.isArray(devRaw) ? devRaw : [];
  const devOnline = devList.filter(d => String(d.status || "").toLowerCase() === "online").length;
  const devTotal = devList.length;
  const empTotal = Number(empMeta?.total ?? 0);
  const visTotal = Number(visMeta?.total ?? 0);
  const grantedN = Number(stats?.grantedToday ?? stats?.granted ?? 0);
  const grantedUniqueEmployeesN = Number(stats?.grantedTodayUniqueEmployees ?? 0);
  const deniedN  = Number(stats?.deniedToday ?? stats?.denied ?? 0);
  const unknownDeniedN = Number(stats?.unknownDenied ?? 0);
  const onPremN  = Number(health?.onPremise ?? stats?.onPremise ?? 0);
  const riskN    = riskData?.score != null ? Number(riskData.score) : (insights?.riskScore != null ? Number(insights.riskScore) : 0);
  const refreshDashboardCards = useCallback(() => {
    reloadStats();
    reloadHealth();
    reloadEmpMeta();
    reloadVisMeta();
    reloadDevices();
    reloadRisk();
  }, [reloadStats, reloadHealth, reloadEmpMeta, reloadVisMeta, reloadDevices, reloadRisk]);

  // initial logs + WS (JWT on /ws) + polling fallback when WS unavailable
  useEffect(()=>{ api.logs({ limit:10, sort:"desc" }).then(r=>setFeed(r?.logs||[])).catch(()=>{}); },[]);
  useEffect(() => {
    const id = setInterval(() => {
      api.logs({ limit:10, sort:"desc" }).then((r) => {
        const rows = r?.logs || [];
        if (!rows.length) return;
        setFeed((prev) => {
          const keyOf = (x) => String(x?._id || `${x?.employeeId}|${x?.timestamp}|${x?.createdAt}`);
          const known = new Set(prev.map(keyOf));
          const incoming = rows.filter((x) => !known.has(keyOf(x)));
          if (!incoming.length) return prev;
          return [...incoming, ...prev].slice(0, 50);
        });
      }).catch(()=>{});
    }, 7000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onSynced = () => {
      refreshDashboardCards();
      api.logs({ limit:10, sort:"desc" }).then(r=>setFeed(r?.logs||[])).catch(()=>{});
    };
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [refreshDashboardCards]);
  useEffect(() => {
    const id = setInterval(() => {
      refreshDashboardCards();
    }, DASHBOARD_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshDashboardCards]);
  useWS(useCallback(msg=>{
    if(msg.type==="ACCESS_EVENT") setFeed(p=>[msg.data,...p.slice(0,49)]);
  },[]));

  const hourly  = stats?.hourly  || [];
  const authPie = stats?.authModes || [];
  const weekly  = stats?.weekly  || [];
  const authTotal = authPie.reduce((s, x) => s + Number(x?.value || 0), 0);
  const weeklyPeak = Math.max(1, ...weekly.map((w) => Number(w?.count || 0)));
  const weeklyTotal = weekly.reduce((s, w) => s + Number(w?.count || 0), 0);
  const openLogsFromCard = (kind) => {
    try {
      sessionStorage.setItem("acs_logs_filter", kind);
      sessionStorage.setItem("acs_logs_today", "1");
    } catch {}
    onNav("logs");
  };
  const panelStyle = {
    background:`linear-gradient(145deg, rgba(28,28,38,.95) 0%, rgba(22,22,29,.98) 100%)`,
    border:`1px solid rgba(139,92,246,.12)`,
    borderRadius:16,
    boxShadow:`0 8px 32px rgba(0,0,0,.50), inset 0 1px 0 rgba(255,255,255,.06)`,
  };
  const titleRow = (icon, title, right) => (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,paddingBottom:12,borderBottom:`1px solid rgba(139,92,246,.12)` }}>
      <div style={{ display:"flex",alignItems:"center",gap:10 }}>
        <div style={{
          width:32,height:32,borderRadius:10,
          background:`linear-gradient(135deg, rgba(139,92,246,.20), rgba(124,58,237,.10))`,
          border:`1px solid rgba(139,92,246,.25)`,
          display:"flex",alignItems:"center",justifyContent:"center",
          fontSize:15,flexShrink:0,color:TH.violet
        }}>{icon}</div>
        <span style={{ fontSize:14,fontWeight:700,color:TH.textHi,letterSpacing:"-.2px" }}>{title}</span>
      </div>
      {right && <div style={{ display:"flex",alignItems:"center",gap:6 }}>{right}</div>}
    </div>
  );

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>

      {/* ── KPI Row ─────────────────────────────────────────────── */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10 }}>
        <StatCard icon="👥" label="Employees"    value={fNum(empTotal)}             color={TH.blue}   sub="Registered"      trend={null}               onClick={()=>onNav("employees")}/>
        <StatCard icon="🪪" label="Visitors"     value={fNum(visTotal)}             color={TH.violet} sub="Registered"      trend={null}               onClick={()=>onNav("visitors")}/>

        {/* Granted Today — compact inline version */}
        <Card pad={14} onClick={()=>openLogsFromCard("granted")} style={{ cursor:"pointer", overflow:"hidden", position:"relative" }}>
          <div style={{ position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,transparent,${TH.green},transparent)`,boxShadow:`0 0 10px ${TH.green}66` }}/>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
            <div style={{ width:36,height:36,borderRadius:9,background:`${TH.green}22`,border:`1px solid ${TH.green}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17 }}>✅</div>
            {stats?.grantedTrend!=null&&<span style={{ fontSize:10,fontWeight:700,color:stats.grantedTrend>=0?TH.green:TH.red,background:stats.grantedTrend>=0?TH.greenDim:TH.redDim,padding:"2px 6px",borderRadius:20 }}>{stats.grantedTrend>=0?"↑":"↓"}{Math.abs(stats.grantedTrend)}%</span>}
          </div>
          <div style={{ fontSize:11,fontWeight:700,color:TH.textHi,marginBottom:6,textTransform:"uppercase",letterSpacing:".8px" }}>Granted Today</div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6 }}>
            <div style={{ borderRadius:8,padding:"7px 8px",background:TH.surface,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:22,fontWeight:800,color:TH.green,fontFamily:TH.mono,lineHeight:1 }}>{fNum(grantedUniqueEmployeesN)}</div>
              <div style={{ fontSize:10,color:TH.muted,marginTop:3,fontWeight:600 }}>Employees</div>
            </div>
            <div style={{ borderRadius:8,padding:"7px 8px",background:TH.surface,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:22,fontWeight:800,color:TH.green,fontFamily:TH.mono,lineHeight:1 }}>{fNum(grantedN)}</div>
              <div style={{ fontSize:10,color:TH.muted,marginTop:3,fontWeight:600 }}>Total</div>
            </div>
          </div>
        </Card>

        <StatCard icon="🚫" label="Denied Today" value={fNum(deniedN)}              color={TH.red}    sub="Blocked"         trend={stats?.deniedTrend} onClick={()=>openLogsFromCard("denied")}/>
        <StatCard icon="📍" label="On Premises"  value={fNum(onPremN)}              color={TH.cyan}   sub="Inside"          trend={null}               onClick={()=>onNav("monitor")}/>
        <StatCard icon="◫"  label="Devices"      value={`${devOnline}/${devTotal}`} color={TH.green}  sub="Online/Total"    trend={null}               onClick={()=>onNav("devices")}/>
        <StatCard icon="🤖" label="Risk Score"   value={`${riskN}/100`}             color={riskN>=70?TH.red:riskN>=40?TH.amber:TH.green} sub="AI score" trend={null} onClick={()=>onNav("ai_insights")}/>
      </div>

      {unknownDeniedN>0&&(
        <div style={{ display:"flex",justifyContent:"flex-end" }}>
          <button onClick={()=>{ try{sessionStorage.setItem("acs_logs_filter","unknown_denied");sessionStorage.setItem("acs_logs_today","1");}catch{} onNav("logs"); }}
            style={{ border:`1px solid ${TH.red}66`,background:TH.redDim,color:"#ffdce1",borderRadius:999,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",boxShadow:`0 0 12px ${TH.redGlow}` }}>
            ⚠ Unknown Denied: {fNum(unknownDeniedN)}
          </button>
        </div>
      )}

      {/* ── Charts Row ──────────────────────────────────────────── */}
      <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr",gap:12 }}>
        <Card style={panelStyle}>
          {titleRow("📈","Access Events — Last 24h", sLoad&&<span className="spin" style={{ color:TH.muted,fontSize:13 }}>⟳</span>)}
          {hourly.length===0&&!sLoad?<Empty icon="📊" text="No data yet" sub="Connect devices to see live charts"/>:(
            <div style={{ height:160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourly} margin={{top:4,right:4,left:-22,bottom:0}}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={TH.green} stopOpacity={.25}/><stop offset="95%" stopColor={TH.green} stopOpacity={0}/></linearGradient>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={TH.red} stopOpacity={.2}/><stop offset="95%" stopColor={TH.red} stopOpacity={0}/></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                  <XAxis dataKey="hour" tick={{fill:TH.muted,fontSize:9}} interval={3}/>
                  <YAxis tick={{fill:TH.muted,fontSize:9}}/>
                  <Tooltip contentStyle={TT_STYLE} itemStyle={TT_ITEM_STYLE} labelStyle={TT_LABEL_STYLE}/>
                  <Area type="monotone" dataKey="granted" name="Granted" stroke={TH.green} strokeWidth={2} fill="url(#g1)"/>
                  <Area type="monotone" dataKey="denied"  name="Denied"  stroke={TH.red}   strokeWidth={2} fill="url(#g2)"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card style={panelStyle}>
          {titleRow("🔐","Auth Methods")}
          {authPie.length===0?<Empty icon="🔐" text="No auth data"/>:(
            <>
              <div style={{ height:140 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={authPie} cx="50%" cy="50%" innerRadius={38} outerRadius={62}
                      paddingAngle={2} cornerRadius={5} dataKey="value" stroke={TH.card} strokeWidth={2}
                      activeIndex={activeAuthIdx>=0?activeAuthIdx:undefined}
                      onMouseEnter={(_,i)=>setActiveAuthIdx(i)} onMouseLeave={()=>setActiveAuthIdx(-1)}>
                      {authPie.map((_,i)=>(<Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]} opacity={activeAuthIdx===-1||activeAuthIdx===i?.98:.38}/>))}
                    </Pie>
                    <text x="50%" y="47%" textAnchor="middle" fill={TH.muted} style={{ fontSize:10,fontWeight:600 }}>TOTAL</text>
                    <text x="50%" y="58%" textAnchor="middle" fill={TH.text} style={{ fontSize:16,fontWeight:800 }}>{`${authTotal}%`}</text>
                    <Tooltip contentStyle={TT_STYLE} formatter={(v,_,p)=>[`${v}%`,p.payload.name]} cursor={{ fill:"rgba(255,255,255,.04)" }}/>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
                {authPie.slice(0,4).map((d,i)=>(
                  <div key={d.name} style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                      <div style={{ width:7,height:7,borderRadius:"50%",background:CHART_COLORS[i%CHART_COLORS.length] }}/>
                      <span style={{ fontSize:10,color:activeAuthIdx===i?TH.text:TH.muted,fontWeight:activeAuthIdx===i?700:500 }}>{d.name}</span>
                    </div>
                    <span style={{ fontSize:11,fontWeight:700,color:activeAuthIdx===i?"#fff":TH.text,fontFamily:TH.mono }}>{d.value}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ── Bottom Row: Weekly + Live Feed + Quick Actions ───────── */}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 210px",gap:12,alignItems:"stretch" }}>

        {/* Weekly Volume */}
        <Card style={panelStyle}>
          {titleRow("📊","Weekly Volume",<span style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono }}>{fNum(weeklyTotal)} events</span>)}
          {weekly.length===0?<Empty icon="📈" text="No data"/>:(
            <div style={{ height:220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekly} margin={{top:4,right:8,left:-18,bottom:0}} barSize={20} onMouseLeave={()=>setActiveWeekDay("")}>
                  <defs>
                    <linearGradient id="weeklyBars" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TH.blue} stopOpacity={0.95}/>
                      <stop offset="100%" stopColor={TH.violet} stopOpacity={0.72}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 5" stroke={TH.grid} vertical={false}/>
                  <XAxis dataKey="day" tick={{fill:TH.muted,fontSize:10}} axisLine={false} tickLine={false}/>
                  <YAxis tick={{fill:TH.muted,fontSize:9}} axisLine={false} tickLine={false} domain={[0,Math.ceil(weeklyPeak*1.15)]}/>
                  <Tooltip contentStyle={TT_STYLE} formatter={(v)=>[`${fNum(v)} events`,"Volume"]} labelFormatter={(l)=>`Day: ${l}`} cursor={{ fill:"rgba(255,255,255,.04)" }}/>
                  <Bar dataKey="count" name="Events" fill="url(#weeklyBars)" radius={[5,5,0,0]}>
                    {weekly.map((w,i)=>(<Cell key={`wk-${w.day}-${i}`} fill="url(#weeklyBars)" opacity={!activeWeekDay||activeWeekDay===w.day?1:.38} onMouseEnter={()=>setActiveWeekDay(w.day)}/>))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {weekly.length>0&&(
            <div style={{ display:"flex",gap:5,flexWrap:"wrap",marginTop:6 }}>
              {weekly.map((w)=>(
                <span key={w.day} style={{ fontSize:10,fontFamily:TH.mono,color:activeWeekDay===w.day?"#fff":TH.muted,fontWeight:activeWeekDay===w.day?700:500,padding:"1px 5px",borderRadius:999,border:`1px solid ${activeWeekDay===w.day?TH.blue:TH.border}`,background:activeWeekDay===w.day?TH.blueDim:"transparent" }}>
                  {w.day}: {fNum(w.count||0)}
                </span>
              ))}
            </div>
          )}
        </Card>

        {/* Live Feed */}
        <Card style={panelStyle}>
          {titleRow(
            <span style={{ position:"relative",display:"inline-flex" }}>
              <span style={{ width:8,height:8,borderRadius:"50%",background:TH.green,display:"inline-block",boxShadow:`0 0 8px ${TH.green}` }}/>
              <span className="pulse-dot" style={{ position:"absolute",inset:0,borderRadius:"50%",background:TH.green,opacity:.5 }}/>
            </span>,
            "Live Feed",
            <Btn v="ghost" sz="xs" onClick={()=>onNav("logs")}>All logs →</Btn>
          )}
          {feed.length===0 ? (
            <Empty icon="⬡" text="Waiting for events…" sub="Events appear in real-time"/>
          ) : (
            <div style={{ display:"flex",flexDirection:"column",gap:4,overflowY:"hidden" }}>
              {feed.slice(0,5).map((log,i)=>{
                const ok  = log.accessGranted ?? log.granted;
                const name = log.employeeName || log.name || "Unknown";
                const zone = log.zone || log.location || "—";
                const photo = log?.photo||log?.photoUrl||log?.image||log?.imageUrl||log?.facePhoto||log?.faceImage||log?.snapshot||log?.snapshotUrl||log?.capture||log?.captureUrl||null;
                const accent    = ok ? TH.green : TH.red;
                const accentDim = ok ? TH.greenDim : TH.redDim;
                return (
                  <div key={(log._id||log.id||i)+i} style={{
                    display:"flex", alignItems:"center", gap:12,
                    padding:"10px 12px",
                    background:TH.card,
                    borderRadius:12,
                    border:`1px solid ${ok ? TH.green : TH.red}22`,
                    transition:"all .2s ease",
                    cursor:"default",
                    flexShrink:0
                  }}
                  onMouseEnter={e=>{ e.currentTarget.style.background=TH.cardHi; e.currentTarget.style.transform="translateX(2px)"; }}
                  onMouseLeave={e=>{ e.currentTarget.style.background=TH.card; e.currentTarget.style.transform="translateX(0)"; }}>
                    <Avatar name={name} size={38} color={accent} img={photo}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:TH.textHi, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{name}</div>
                      <div style={{ fontSize:11, fontWeight:400, color:TH.muted, marginTop:2, display:"flex", alignItems:"center", gap:4 }}>
                        <span style={{ color:accent, fontSize:8 }}>●</span>
                        <span>{zone}</span>
                      </div>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3, flexShrink:0 }}>
                      <div style={{ padding:"3px 10px", borderRadius:6, fontSize:10, fontWeight:700, letterSpacing:".5px", background:accentDim, color:accent }}>
                        {ok ? "GRANTED" : "DENIED"}
                      </div>
                      <span style={{ fontSize:10, color:TH.faint, fontFamily:TH.mono }}>{fT(logEventTime(log))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Quick Actions — vertical column */}
        <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,paddingBottom:10,borderBottom:`1px solid rgba(139,92,246,.15)` }}>
            <div style={{ width:4,height:18,borderRadius:2,background:`linear-gradient(180deg,${TH.violet},${TH.blue})`,boxShadow:`0 0 10px ${TH.violetGlow}` }}/>
            <span style={{ fontSize:12,fontWeight:700,color:TH.textHi,letterSpacing:".6px",textTransform:"uppercase" }}>Quick Actions</span>
          </div>
          {[
            {icon:"⚙",  label:"Configure Device", desc:"Add terminal",       page:"setup",       c:TH.blue,   ck:"blue"   },
            {icon:"📷", label:"Enroll Employee",   desc:"AI face enroll",     page:"enrollment",  c:TH.green,  ck:"green"  },
            {icon:"🔔", label:"Open Alerts",       desc:"Security alerts",    page:"alerts",      c:TH.red,    ck:"red"    },
            {icon:"👁", label:"Live Monitor",      desc:"Real-time FR grid",  page:"monitor",     c:TH.cyan,   ck:"cyan"   },
            {icon:"📋", label:"Access Logs",       desc:"Full event history",  page:"logs",        c:TH.violet, ck:"violet" },
            {icon:"🧠", label:"AI Insights",       desc:"Risk & anomalies",   page:"ai_insights", c:TH.amber,  ck:"amber"  },
          ].map(q=>(
            <GlassCard key={q.page} color={q.c} colorKey={q.ck} style={{ cursor:"pointer",padding:"9px 12px" }} onClick={()=>onNav(q.page)}>
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <div style={{ fontSize:22,lineHeight:1,filter:`drop-shadow(0 0 6px var(--th-${q.ck}Glow))`,flexShrink:0 }}>{q.icon}</div>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:12,fontWeight:800,color:TH.textHi,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{q.label}</div>
                  <div style={{ fontSize:10,color:TH.muted,marginTop:2,lineHeight:1.3 }}>{q.desc}</div>
                </div>
                <div style={{ marginLeft:"auto",fontSize:12,color:`var(--th-${q.ck})`,flexShrink:0 }}>→</div>
              </div>
            </GlassCard>
          ))}
        </div>

      </div>

      {/* ── System Overview Row ──────────────────────────────────── */}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12 }}>

        {/* Device Health */}
        <Card style={{ ...panelStyle, padding:16 }}>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
            <span style={{ fontSize:13 }}>◫</span>
            <span style={{ fontSize:12,fontWeight:800,color:TH.textHi,textTransform:"uppercase",letterSpacing:".5px" }}>Device Health</span>
            <div style={{ marginLeft:"auto",width:8,height:8,borderRadius:"50%",background:devOnline>0?TH.green:TH.red,boxShadow:`0 0 6px ${devOnline>0?TH.green:TH.red}` }}/>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {[
              { label:"Online",  val:devOnline, color:TH.green,  pct: devTotal>0?Math.round(devOnline/devTotal*100):0 },
              { label:"Offline", val:devTotal-devOnline, color:TH.red, pct: devTotal>0?Math.round((devTotal-devOnline)/devTotal*100):0 },
              { label:"Total",   val:devTotal,  color:TH.blue,   pct:100 },
            ].map(r=>(
              <div key={r.label}>
                <div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}>
                  <span style={{ fontSize:11,color:TH.muted,fontWeight:600 }}>{r.label}</span>
                  <span style={{ fontSize:11,fontWeight:700,color:r.color,fontFamily:TH.mono }}>{r.val}</span>
                </div>
                <div style={{ height:4,borderRadius:4,background:`${TH.border}`,overflow:"hidden" }}>
                  <div style={{ height:"100%",width:`${r.pct}%`,background:r.color,borderRadius:4,transition:"width .6s ease",boxShadow:`0 0 6px ${r.color}66` }}/>
                </div>
              </div>
            ))}
          </div>
          <button onClick={()=>onNav("devices")} style={{ marginTop:12,width:"100%",padding:"6px 0",fontSize:11,fontWeight:700,color:TH.blue,background:`${TH.blue}12`,border:`1px solid ${TH.blue}33`,borderRadius:7,cursor:"pointer",letterSpacing:".3px" }}>
            Manage Devices →
          </button>
        </Card>

        {/* Today's Access Summary */}
        <Card style={{ ...panelStyle, padding:16 }}>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
            <span style={{ fontSize:13 }}>📋</span>
            <span style={{ fontSize:12,fontWeight:800,color:TH.textHi,textTransform:"uppercase",letterSpacing:".5px" }}>Today's Summary</span>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
            {[
              { label:"Total Events",   val:grantedN+deniedN,  color:TH.blue   },
              { label:"Access Granted", val:grantedN,          color:TH.green  },
              { label:"Access Denied",  val:deniedN,           color:TH.red    },
              { label:"On Premises",    val:onPremN,           color:TH.cyan   },
            ].map(r=>{
              const total = Math.max(1, grantedN+deniedN);
              const pct = r.label==="Total Events" ? 100 : Math.round(r.val/total*100);
              return (
                <div key={r.label} style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <div style={{ width:7,height:7,borderRadius:"50%",background:r.color,flexShrink:0 }}/>
                  <span style={{ fontSize:11,color:TH.muted,flex:1,fontWeight:500 }}>{r.label}</span>
                  <span style={{ fontSize:12,fontWeight:700,color:r.color,fontFamily:TH.mono,minWidth:24,textAlign:"right" }}>{fNum(r.val)}</span>
                  <div style={{ width:48,height:4,borderRadius:4,background:TH.border,overflow:"hidden",flexShrink:0 }}>
                    <div style={{ height:"100%",width:`${pct}%`,background:r.color,borderRadius:4 }}/>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={()=>onNav("logs")} style={{ marginTop:12,width:"100%",padding:"6px 0",fontSize:11,fontWeight:700,color:TH.cyan,background:`${TH.cyan}12`,border:`1px solid ${TH.cyan}33`,borderRadius:7,cursor:"pointer",letterSpacing:".3px" }}>
            View All Logs →
          </button>
        </Card>

        {/* Security Posture */}
        <Card style={{ ...panelStyle, padding:16 }}>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
            <span style={{ fontSize:13 }}>🛡</span>
            <span style={{ fontSize:12,fontWeight:800,color:TH.textHi,textTransform:"uppercase",letterSpacing:".5px" }}>Security Posture</span>
          </div>
          {/* Risk meter */}
          <div style={{ textAlign:"center",marginBottom:12 }}>
            <div style={{ fontSize:32,fontWeight:800,fontFamily:TH.mono,color:riskN>=70?TH.red:riskN>=40?TH.amber:TH.green,lineHeight:1,textShadow:`0 0 16px ${riskN>=70?TH.red:riskN>=40?TH.amber:TH.green}55` }}>{riskN}</div>
            <div style={{ fontSize:10,color:TH.muted,marginTop:2,fontWeight:600,letterSpacing:".8px",textTransform:"uppercase" }}>Risk Score / 100</div>
            <div style={{ marginTop:8,height:6,borderRadius:6,background:TH.border,overflow:"hidden" }}>
              <div style={{ height:"100%",width:`${riskN}%`,borderRadius:6,transition:"width .6s",background:`linear-gradient(90deg,${TH.green},${TH.amber},${TH.red})`,clipPath:`inset(0 ${100-riskN}% 0 0 round 6px)` }}/>
            </div>
            <div style={{ display:"flex",justifyContent:"space-between",marginTop:3 }}>
              <span style={{ fontSize:9,color:TH.muted,fontFamily:TH.mono }}>LOW</span>
              <span style={{ fontSize:9,color:TH.muted,fontFamily:TH.mono }}>HIGH</span>
            </div>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
            {[
              { label:"Unknown Denied", val:unknownDeniedN, color:unknownDeniedN>0?TH.red:TH.green },
              { label:"Enrolled Staff",  val:empTotal, color:TH.blue },
            ].map(r=>(
              <div key={r.label} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",borderRadius:7,background:`${r.color}0d`,border:`1px solid ${r.color}22` }}>
                <span style={{ fontSize:11,color:TH.muted,fontWeight:500 }}>{r.label}</span>
                <span style={{ fontSize:12,fontWeight:700,color:r.color,fontFamily:TH.mono }}>{fNum(r.val)}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Navigation shortcuts */}
        <Card style={{ ...panelStyle, padding:16 }}>
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
            <span style={{ fontSize:13 }}>🧭</span>
            <span style={{ fontSize:12,fontWeight:800,color:TH.textHi,textTransform:"uppercase",letterSpacing:".5px" }}>Navigation</span>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
            {[
              { icon:"👥", label:"Employees",     page:"employees", color:TH.blue   },
              { icon:"🪪", label:"Visitors",      page:"visitors",  color:TH.violet },
              { icon:"📍", label:"Live Monitor",  page:"monitor",   color:TH.cyan   },
              { icon:"📋", label:"Access Logs",   page:"logs",      color:TH.green  },
              { icon:"🧠", label:"AI Insights",   page:"ai_insights",color:TH.amber },
              { icon:"⚠",  label:"Threat Intel",  page:"threat",    color:TH.red    },
            ].map(n=>(
              <button key={n.page} onClick={()=>onNav(n.page)}
                style={{ display:"flex",alignItems:"center",gap:9,padding:"7px 10px",borderRadius:8,background:"transparent",border:`1px solid ${TH.border}`,cursor:"pointer",width:"100%",transition:"all .12s",textAlign:"left" }}
                onMouseEnter={e=>{ e.currentTarget.style.background=`${n.color}12`; e.currentTarget.style.borderColor=`${n.color}44`; }}
                onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.borderColor=TH.border; }}>
                <span style={{ fontSize:13,flexShrink:0 }}>{n.icon}</span>
                <span style={{ fontSize:12,fontWeight:600,color:TH.text,flex:1 }}>{n.label}</span>
                <span style={{ fontSize:11,color:n.color,opacity:.7 }}>→</span>
              </button>
            ))}
          </div>
        </Card>

      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FR LIVE MONITOR
═══════════════════════════════════════════════════════════════════════ */

/** Avoid Number(null)===0 so Mongo nulls don't render as fake 0% / 0°C / 0ms. */
function accessLogNumericMetric(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * One FR Monitor tile per logical row: prefer Mongo id, else Suprema log id, else collapse bursts
 * (same person + reader + clock second) so VERIFY + IDENTIFY + WS double-deliver show as one card.
 */
function frMonitorDedupeKey(ev) {
  if (!ev || typeof ev !== "object") return `nil:${Math.random()}`;
  const mid = ev._id != null && String(ev._id).trim() !== "" ? String(ev._id) : "";
  if (mid && mid !== "undefined") return `id:${mid}`;
  const lid = Number(ev.supremaLogId ?? ev.suprema_log_id ?? 0);
  const dev = String(ev.deviceId ?? ev.deviceid ?? ev.device ?? ev.deviceName ?? "").trim();
  if (Number.isFinite(lid) && lid > 0 && dev) return `lid:${dev}:${lid}`;
  const uid =
    String(ev.employeeId ?? ev.userId ?? ev.userID ?? ev.userid ?? "").trim() ||
    String(ev.employeeName ?? ev.name ?? "").trim();
  const t = logEventTime(ev);
  let sec = 0;
  if (t) {
    const ms = new Date(t).getTime();
    if (!Number.isNaN(ms)) sec = Math.floor(ms / 1000);
  }
  const granted = ev.accessGranted ?? ev.granted ? "g" : "d";
  return `burst:${uid}:${dev}:${sec}:${granted}`;
}

function dedupeFrMonitorEvents(rows) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  arr.sort((a, b) => {
    const ta = new Date(logEventTime(a) || 0).getTime();
    const tb = new Date(logEventTime(b) || 0).getTime();
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    const k = frMonitorDedupeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function FRMonitorPage() {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sel,    setSel]    = useState(null);
  const { data:empMeta } = useFetch(()=>api.employees({ limit:100000 }), [], { employees:[] });
  const { data:visMeta } = useFetch(()=>api.visitors({ limit:100000 }), [], { visitors:[] });
  const pausedRef = useRef(false);
  useEffect(()=>{ pausedRef.current=paused; },[paused]);
  const formatDateDMY = (value = "") => {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
    if (!digits) return "";
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const isoToDMY = (iso = "") => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
  };
  const dmyToISO = (dmy = "") => {
    const m = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(String(dmy || "").trim());
    if (!m) return "";
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const fromDateIso = dmyToISO(fromDate);
  const toDateIso = dmyToISO(toDate);

  const loadRecent = useCallback(() => {
    api.logs({
      limit: 72,
      sort: "desc",
      ...(filter !== "all" && { granted: filter === "granted" }),
      ...(fromDateIso && { fromDate: fromDateIso }),
      ...(toDateIso && { toDate: toDateIso })
    })
      .then((r) => setEvents(dedupeFrMonitorEvents(r?.logs || [])))
      .catch(() => {});
  }, [filter, fromDateIso, toDateIso]);
  useEffect(()=>{ loadRecent(); }, [loadRecent]);
  useEffect(() => {
    const onSynced = () => loadRecent();
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [loadRecent]);
  useWS(
    useCallback((msg) => {
      if (msg.type !== "ACCESS_EVENT" || pausedRef.current) return;
      const row = msg.data;
      if (!row || typeof row !== "object") return;
      setEvents((p) => {
        const k = frMonitorDedupeKey(row);
        const rest = p.filter((e) => frMonitorDedupeKey(e) !== k);
        return dedupeFrMonitorEvents([row, ...rest]).slice(0, 72);
      });
    }, [])
  );

  const shown = dedupeFrMonitorEvents(events).filter((e) =>
    filter === "all" ? true : filter === "granted" ? e.accessGranted ?? e.granted : !(e.accessGranted ?? e.granted)
  );
  const ai = useMemo(() => accessLogAiInsights(shown), [shown]);
  const granted = e => e.accessGranted??e.granted;
  const name    = e => e.employeeName||e.name||e.employeeId||"Unknown";
  const rawPhoto = e => e?.photo || e?.photoUrl || e?.image || e?.imageUrl || e?.facePhoto || e?.faceImage || e?.snapshot || e?.snapshotUrl || e?.capture || e?.captureUrl || null;
  const employees = empMeta?.employees || [];
  const visitors = visMeta?.visitors || [];
  const personMetaOf = useCallback((e) => {
    const eid = String(e?.employeeId || "").trim().toLowerCase();
    const enm = String(e?.employeeName || e?.name || "").trim().toLowerCase();
    return [...employees, ...visitors].find((x) => {
      const xid = String(x?.employeeId || x?._id || "").trim().toLowerCase();
      const xnm = String(x?.name || "").trim().toLowerCase();
      return (eid && eid === xid) || (enm && enm === xnm);
    }) || null;
  }, [employees, visitors]);
  const catalogPhoto = useCallback((e) => {
    const src = personMetaOf(e);
    return e?.enrollmentPhoto || src?.photo || src?.photoUrl || src?.image || src?.imageUrl || src?.facePhoto || src?.faceImage || src?.snapshot || src?.snapshotUrl || null;
  }, [personMetaOf]);
  const generatedPhoto = useCallback((e) => {
    const ok = granted(e);
    const nm = name(e);
    const unknown = /^unknown/i.test(nm) || /^unknown/i.test(String(e?.employeeId || ""));
    const fg = unknown ? "#ffd4d9" : "#d9e8ff";
    const bg1 = unknown ? "#5d1f2b" : "#1f2e4d";
    const bg2 = unknown ? "#91293c" : "#334f83";
    const text = unknown ? "UNK" : (nm.split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase() || "FR");
    const badge = ok ? "GRANTED" : "DENIED";
    const badgeBg = ok ? "#1f7a50" : "#972f44";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='${bg1}'/><stop offset='100%' stop-color='${bg2}'/></linearGradient></defs><rect width='100%' height='100%' fill='url(#g)'/><circle cx='90' cy='70' r='32' fill='rgba(255,255,255,.12)'/><rect x='49' y='108' width='82' height='46' rx='23' fill='rgba(255,255,255,.11)'/><text x='90' y='78' text-anchor='middle' font-size='23' font-family='Inter,Arial' fill='${fg}' font-weight='700'>${text}</text><rect x='34' y='145' width='112' height='21' rx='10' fill='${badgeBg}'/><text x='90' y='160' text-anchor='middle' font-size='10' font-family='Inter,Arial' fill='#ffffff' font-weight='700'>${badge}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, []);
  const livePhotoOf = useCallback((e) => rawPhoto(e), []);
  const enrolledPhotoOf = useCallback((e) => catalogPhoto(e), [catalogPhoto]);
  const photoOf = useCallback((e) => livePhotoOf(e) || enrolledPhotoOf(e) || generatedPhoto(e), [livePhotoOf, enrolledPhotoOf, generatedPhoto]);

  // Fallback realtime refresh: keeps live monitor moving even when WS is unavailable.
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => loadRecent(), 4000);
    return () => clearInterval(id);
  }, [paused, loadRecent]);

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%" }}>
      <PageHeader title="FR Live Monitor" sub="Real-time biometric events via WebSocket"/>
      <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap" }}>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["granted","✓ Granted"],["denied","✗ Denied"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{ padding:"7px 14px",fontSize:12,fontWeight:600,background:filter===v?TH.blue:"transparent",color:filter===v?"#fff":TH.muted,border:"none",cursor:"pointer",transition:"all .12s" }}>{l}</button>
          ))}
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 46px",gap:8 }}>
          <Input
            value={fromDate}
            onChange={e=>setFromDate(formatDateDMY(e.target.value))}
            placeholder="dd/mm/yy"
            pattern="\d{2}/\d{2}/\d{2}"
            style={{ width:130 }}
            title="From date (dd/mm/yy)"
          />
          <input
            type="date"
            value={fromDateIso}
            onChange={e=>setFromDate(isoToDMY(e.target.value))}
            title="From calendar"
            style={{ width:46,padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
          />
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 46px",gap:8 }}>
          <Input
            value={toDate}
            onChange={e=>setToDate(formatDateDMY(e.target.value))}
            placeholder="dd/mm/yy"
            pattern="\d{2}/\d{2}/\d{2}"
            style={{ width:130 }}
            title="To date (dd/mm/yy)"
          />
          <input
            type="date"
            value={toDateIso}
            min={fromDateIso||undefined}
            onChange={e=>setToDate(isoToDMY(e.target.value))}
            title="To calendar"
            style={{ width:46,padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
          />
        </div>
        {(fromDate || toDate) && <Btn v="ghost" sz="sm" onClick={()=>{ setFromDate(""); setToDate(""); }}>Clear Dates</Btn>}
        <Btn v={paused?"success":"ghost"} sz="sm" onClick={()=>setPaused(p=>!p)}>{paused?"▶ Resume":"⏸ Pause"}</Btn>
        <div style={{ marginLeft:"auto",display:"flex",gap:8,alignItems:"center" }}>
          {!paused&&<><div style={{ width:8,height:8,borderRadius:"50%",background:TH.green }} className="pulse-dot"/><span style={{ fontSize:12,color:TH.green,fontWeight:700 }}>LIVE</span></>}
          {paused&&<Badge color="amber">Paused</Badge>}
          <span style={{ fontSize:12,color:TH.muted }}>{shown.length} events</span>
        </div>
      </div>

      <Card style={{ marginBottom:12 }}>
        <div style={{ display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:9 }}>
          <div>
            <div style={{ fontSize:13,fontWeight:800,color:TH.text }}>AI Live Insights</div>
            <div style={{ fontSize:12,color:TH.muted }}>{ai.summary}</div>
          </div>
          <Badge color={ai.riskLevel==="high"?"red":ai.riskLevel==="medium"?"amber":"green"} sm>
            {ai.riskLevel === "high" ? "Risk: High" : ai.riskLevel === "medium" ? "Risk: Medium" : "Risk: Low"}
          </Badge>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:8,marginBottom:9 }}>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Denied Rate</div>
            <div style={{ fontSize:18,fontWeight:800,color:ai.deniedRate>=35?TH.red:ai.deniedRate>=20?TH.amber:TH.green }}>{ai.deniedRate.toFixed(1)}%</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Unknown Denied</div>
            <div style={{ fontSize:18,fontWeight:800,color:ai.unknownDenied>0?TH.red:TH.green }}>{fNum(ai.unknownDenied)}</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Hot Zone</div>
            <div style={{ fontSize:14,fontWeight:800,color:TH.text }}>{ai.topDeniedZone?.[0] || "—"}</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Repeated Identity</div>
            <div style={{ fontSize:14,fontWeight:800,color:TH.text }}>{ai.topDeniedIdentity?.[0] || "—"}</div>
          </div>
        </div>
        <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
          <Btn v="ghost" sz="xs" onClick={()=>setFilter("denied")}>⚡ Focus Denied</Btn>
          <Btn
            v="ghost"
            sz="xs"
            onClick={()=>{
              const latestUnknownDenied = shown.find((e) => logRowMatchesUnknownDeniedPattern(e));
              if (latestUnknownDenied) setSel(latestUnknownDenied);
            }}
            disabled={!shown.some((e) => logRowMatchesUnknownDeniedPattern(e))}
          >
            🕵 Open Latest Unknown Denied
          </Btn>
          <Btn v="ghost" sz="xs" onClick={loadRecent}>⟳ Smart Refresh</Btn>
        </div>
      </Card>

      <div style={{ flex:1,overflowY:"auto" }}>
        {shown.length===0?<Empty icon="⬡" text="No events yet" sub="Events will appear when devices are connected"/>:(
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(215px,1fr))",gap:12 }}>
            {shown.map((ev,i)=>{
              const ok=granted(ev), n=name(ev);
              const meta = personMetaOf(ev);
              const passNo = ev?.employeeId || meta?.employeeId || "—";
              const cardId = ev?.cardId || meta?.cardId || meta?.cardNo || "—";
              const designation = ev?.designation || meta?.designation || "—";
              return (
                <div key={frMonitorDedupeKey(ev)} onClick={()=>setSel(ev)} className={i<4&&!paused?"fade-in":undefined}
                  style={{ background:TH.card,border:`2px solid ${ok?TH.green+"40":TH.red+"40"}`,borderRadius:13,padding:14,cursor:"pointer",position:"relative",overflow:"hidden",transition:"all .15s" }}
                  onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow=`0 10px 32px ${ok?TH.green+"20":TH.red+"20"}`; }}
                  onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="none"; }}>
                  <div style={{ position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${ok?TH.green:TH.red},${ok?TH.green+"50":TH.red+"50"})` }}/>
                  <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:10 }}>
                    <div style={{ position:"relative" }}>
                      <img src={photoOf(ev)} alt={n} style={{ width:46,height:46,borderRadius:10,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
                      <div style={{ position:"absolute",bottom:-2,right:-2,width:16,height:16,borderRadius:"50%",background:ok?TH.green:TH.red,border:`2px solid ${TH.card}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:700 }}>{ok?"✓":"✗"}</div>
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:13,fontWeight:700,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{n}</div>
                      <div style={{ fontSize:11,color:TH.muted }}>{ev.department||ev.dept||meta?.department||"—"}</div>
                      <div style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono }}>Pass: {passNo}</div>
                      <div style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono }}>Card: {cardId}</div>
                      <div style={{ fontSize:10,color:TH.muted }}>{designation}</div>
                    </div>
                  </div>
                  <div style={{ fontSize:11,color:TH.muted,marginBottom:7 }}>📍 {ev.zone||"—"}</div>
                  <div style={{ display:"flex",gap:5,flexWrap:"wrap",marginBottom:9 }}>
                    <Badge color="blue" sm>{ev.authMode||"—"}</Badge>
                    {ok?<Badge color="green" sm>Granted</Badge>:<Badge color="red" sm>Denied</Badge>}
                    {!ok && logRowMatchesUnknownDeniedPattern(ev) && <Badge color="amber" sm>AI Flag</Badge>}
                  </div>
                  <div style={{ display:"flex",justifyContent:"space-between",paddingTop:9,borderTop:`1px solid ${TH.border}`,alignItems:"center",gap:8 }}>
                    <span style={{ fontSize:10,color:TH.muted }}>
                      {ok ? "AI: normal pattern" : (logRowMatchesUnknownDeniedPattern(ev) ? "AI: unknown denied pattern" : "AI: denied event")}
                    </span>
                    <span style={{ fontSize:12,fontWeight:700,color:TH.text,fontFamily:TH.mono }}>{fT(logEventTime(ev))}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sel&&(
        <Modal title="Access Event" onClose={()=>setSel(null)} width={760}>
          {(() => {
            const meta = personMetaOf(sel) || {};
            return (
              <>
          <div style={{ display:"flex",gap:14,alignItems:"flex-start",marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${TH.border}` }}>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <div style={{ textAlign:"center" }}>
                <img src={livePhotoOf(sel) || photoOf(sel)} alt={`${name(sel)} live`} style={{ width:180,height:180,borderRadius:12,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
                <div style={{ marginTop:4,fontSize:10,color:TH.muted }}>Live Scan</div>
              </div>
              <div style={{ textAlign:"center" }}>
                <img src={enrolledPhotoOf(sel) || photoOf(sel)} alt={`${name(sel)} enrolled`} style={{ width:180,height:180,borderRadius:12,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
                <div style={{ marginTop:4,fontSize:10,color:TH.muted }}>Enrolled</div>
              </div>
            </div>
            <div>
              <div style={{ fontSize:17,fontWeight:700,color:TH.text,marginBottom:8 }}>{name(sel)}</div>
              {granted(sel)?<Badge color="green">✓ Access Granted</Badge>:<Badge color="red">✗ Access Denied</Badge>}
              <div style={{ fontSize:12,color:TH.muted,marginTop:6,fontFamily:TH.mono }}>{fDT(logEventTime(sel))}</div>
            </div>
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
            {[["Pass Number",sel.employeeId||meta.employeeId],["Card Id (CSN)",sel.cardId||meta.cardId||meta.cardNo],["Employee Name",sel.employeeName||sel.name||meta.name],["Designation",sel.designation||meta.designation],["Department",sel.department||sel.dept||meta.department],["Division",sel.division||meta.division],["Access Level",sel.accessLevel||meta.accessLevel],["Cardholder Status",sel.cardholderStatus||meta.cardholderStatus],["Shift Schedule",sel.shiftSchedule||meta.shiftSchedule],["Pass Issue Date",sel.passIssueDate||meta.passIssueDate],["Pass Expiry Date",sel.passExpiryDate||meta.passExpiryDate],["Line Manager",sel.lineManager||meta.lineManager],["Zone",sel.zone],["Device",sel.deviceName||sel.device],["Auth Mode",sel.authMode],["Direction",sel.direction],["Confidence",(() => { const n = accessLogNumericMetric(sel.confidence ?? sel.matchScore ?? sel.score); return n != null ? `${Math.round(n)}%` : "—"; })()],["Response",(() => { const n = accessLogNumericMetric(sel.processingMs ?? sel.responseMs ?? sel.latencyMs); return n != null ? `${Math.round(n)}ms` : "—"; })()],["Temperature",(() => { const n = accessLogNumericMetric(sel.temperature); return n != null ? `${Number(n).toFixed(1)}°C` : "—"; })()]].map(([k,v])=>(
              <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
                <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
                <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
              </div>
            ))}
          </div>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DEVICES
═══════════════════════════════════════════════════════════════════════ */
function DevicesPage({ onNav }) {
  const { show } = useToast();
  const { data, loading, reload } = useFetch(()=>api.devices(),[],[]);
  const [sel,    setSel]    = useState(null);
  const [edit,   setEdit]   = useState(null);
  const [search, setSearch] = useState("");
  const [tab,    setTab]    = useState("all");
  const [confirm,setConfirm]= useState(null);
  const [imgFilterBusy, setImgFilterBusy] = useState(null);

  const deviceIssue = (d = {}) => {
    const healthError = String(d?.healthError || "").trim();
    if (healthError) return healthError;
    const fwStatus = String(d?.firmwareStatus || "").trim();
    if (fwStatus && !["ok", "healthy", "up_to_date", "up-to-date", "latest"].includes(fwStatus.toLowerCase())) {
      return `Firmware: ${fwStatus}`;
    }
    const fw = String(d?.firmware || "").trim();
    if (/outdated|unsupported|mismatch|deprecated|invalid|error/i.test(fw)) {
      return `Firmware: ${fw}`;
    }
    return "";
  };
  const statusNorm = d => {
    const raw = String(d?.status || "").toLowerCase().trim();
    const isOnline = raw === "online" || raw === "connected";
    const issue = deviceIssue(d);
    if (isOnline && issue) return "warning";
    if (isOnline) return "online";
    return "offline";
  };
  const deviceList = (data || []).map(d => ({ ...d, _issue: deviceIssue(d), _statusNorm: statusNorm(d) }));
  const devs = deviceList.filter(d=>{
    const blob = `${d.name || ""}${d.ip || ""}${d.zone || ""}`.toLowerCase();
    if(search && !blob.includes(search.toLowerCase())) return false;
    if(tab==="online"&&d._statusNorm!=="online") return false;
    if(tab==="warning"&&d._statusNorm!=="warning") return false;
    if(tab==="offline"&&d._statusNorm!=="offline") return false;
    return true;
  });
  const devKey = d => d._id || d.deviceId || d.id || d.ip || d.name;

  const doSync=async id=>{
    try {
      const r = await api.deviceSync(id);
      const inserted = Number(r?.sync?.inserted || 0);
      if (r?.sidecar && !r.sidecar.ok) {
        show(`Device reachable but GSDK link failed: ${r.sidecar.error || "Unknown error"}`, "warning");
      } else {
        show(inserted > 0 ? `Sync complete (${inserted} new logs)` : "Sync complete", "success");
      }
      window.dispatchEvent(new Event("acs:sync-complete"));
      reload();
    }
    catch(e){ show(e.message,"error"); }
  };
  const doEnableScanPhotos = async (id) => {
    setImgFilterBusy(id);
    try {
      // auth-both: full BS2 event codes (0x1000–0x1A00) + legacy mainEventCode bytes (0x10–0x1A) — some firmware only honors one form.
      const r = await api.deviceSetImageLogFilters(id, { preset: "auth-both", scheduleID: 1 });
      if (r && r.ok === false) throw new Error(r.error || "SetImageFilter failed");
      show("Reader snapshot filters applied (scheduleID=1 + auth-both). Run Sync after the next scan. If BioStar Image Log still shows no JPGs, set Settings → Image Log → Image Log File Path on the BioStar PC and enable “Save unknown face” on the reader.", "success");
    } catch (e) {
      show(e.message || "Failed", "error");
    } finally {
      setImgFilterBusy(null);
    }
  };
  const doDel=async id=>{
    try { await api.deviceDelete(id); show("Device removed","success"); reload(); setConfirm(null); setSel(null); }
    catch(e){ show(e.message,"error"); }
  };
  const openEdit = d => {
    setEdit({
      _key: devKey(d),
      name: d.name || "",
      model: d.model || "",
      zone: d.zone || "",
      placement: String(d.placement || d.direction || "entry").toLowerCase() === "exit" ? "exit" : "entry",
      ip: d.ipAddr || d.ip || "",
      port: String(d.port || 51211),
      ssl: Boolean(d.ssl ?? d.sslEnabled ?? d.useSSL),
    });
  };
  const saveEdit = async () => {
    if (!edit?.ip || !edit?.name) {
      show("Name and IP are required", "error");
      return;
    }
    try {
      await api.deviceUpdate(edit._key, {
        name: edit.name,
        model: edit.model,
        zone: edit.zone,
        placement: edit.placement || "entry",
        ip: edit.ip,
        ipAddr: edit.ip,
        port: parseInt(edit.port, 10) || 51211,
        ssl: !!edit.ssl,
      });
      show("Device updated", "success");
      setEdit(null);
      reload();
    } catch (e) {
      show(e.message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="My Devices" sub={`${(data||[]).length} devices registered`}
        action={<><Btn v="ghost" sz="sm" onClick={()=>onNav("models")}>📋 Models</Btn><Btn onClick={()=>onNav("setup")} icon="⚙">Add Device</Btn></>}/>

      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:20 }}>
        {[["🟢","Online",deviceList.filter(d=>d._statusNorm==="online").length,TH.green],["🟡","Warning",deviceList.filter(d=>d._statusNorm==="warning").length,TH.amber],["🔴","Offline",deviceList.filter(d=>d._statusNorm==="offline").length,TH.red],["◫","Total",(data||[]).length,TH.blue]].map(([icon,label,val,c])=>(
          <StatCard key={label} icon={icon} label={label} value={val} color={c}/>
        ))}
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,display:"flex",gap:10,flexWrap:"wrap",alignItems:"center" }}>
          <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search device, IP, zone…" style={{ flex:1,minWidth:180 }}/>
          <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
            {["all","online","warning","offline"].map(s=>(
              <button key={s} onClick={()=>setTab(s)} style={{ padding:"7px 13px",fontSize:12,fontWeight:600,background:tab===s?TH.blue:"transparent",color:tab===s?"#fff":TH.muted,border:"none",cursor:"pointer",textTransform:"capitalize" }}>{s}</button>
            ))}
          </div>
        </div>
        <Table loading={loading} headers={["Device","Model","Zone","IP","Status","Response","Users on device","Actions"]} onRow={r=>setSel(r)}
          rows={devs.map(d=>({ key:devKey(d), d, cells:[
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <div style={{ width:9,height:9,borderRadius:"50%",background:d._statusNorm==="online"?TH.green:d._statusNorm==="warning"?TH.amber:TH.red,flexShrink:0,boxShadow:`0 0 6px ${d._statusNorm==="online"?TH.green:d._statusNorm==="warning"?TH.amber:TH.red}` }}/>
              <div>
                <div style={{ fontWeight:600 }}>{d.name}</div>
                <code style={{ fontSize:10,color:TH.muted }}>{devKey(d)}</code>
                {d._statusNorm==="warning" && d._issue && <div style={{ fontSize:10,color:TH.amber,marginTop:2,maxWidth:260,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }} title={d._issue}>⚠ {d._issue}</div>}
              </div>
            </div>,
            <span style={{ fontSize:12 }}>{d.model}</span>,
            <span style={{ fontSize:12 }}>📍 {d.zone} <span style={{ color:TH.muted }}>· {String(d.placement || "entry").toLowerCase()==="exit"?"Exit":"Entrance"}</span></span>,
            <code style={{ fontSize:12 }}>{d.ipAddr || d.ip}:{d.port||51211}</code>,
            stBadge(d._statusNorm),
            <span style={{ fontSize:12,fontWeight:700,fontFamily:TH.mono,color:!d.responseMs?"inherit":d.responseMs<200?TH.green:d.responseMs<350?TH.amber:TH.red }}>{d.responseMs?`${d.responseMs}ms`:"—"}</span>,
            <span style={{ fontSize:12 }} title="Not queried from reader by default — not the same as Face Enrollment in the app">{deviceReaderUserDisplay(d)}</span>,
            <div style={{ display:"flex",gap:5 }}>
              <Btn v="ghost" sz="xs" onClick={e=>{e.stopPropagation();doSync(devKey(d));}}>⟳</Btn>
              <Btn v="destructive" sz="xs" onClick={e=>{e.stopPropagation();setConfirm(devKey(d));}}>✕</Btn>
            </div>
          ]}))}/>
      </Card>

      {sel&&<Modal title={`Device — ${sel.d.name}`} onClose={()=>setSel(null)} footer={<div style={{ display:"flex",gap:8,flexWrap:"wrap" }}><Btn sz="sm" onClick={()=>{doSync(devKey(sel.d));setSel(null);}}>⟳ Sync</Btn><Btn v="secondary" sz="sm" loading={imgFilterBusy===devKey(sel.d)} onClick={()=>doEnableScanPhotos(devKey(sel.d))} title="Sets Suprema Event.SetImageFilter so GetImageLog returns JPGs (unknown/live scan photos)">📷 Enable scan photos</Btn><Btn v="secondary" sz="sm" onClick={()=>{openEdit(sel.d);setSel(null);}}>Edit</Btn><Btn v="destructive" sz="sm" onClick={()=>{setConfirm(devKey(sel.d));setSel(null);}}>Remove</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["ID",devKey(sel.d)],["Model",sel.d.model],["Serial",sel.d.serialNo],["Zone",sel.d.zone],["Placement",String(sel.d.placement || "entry").toLowerCase()==="exit"?"Exit":"Entrance"],["IP",sel.d.ipAddr || sel.d.ip],["Port",String(sel.d.port||51211)],["Firmware",sel.d.firmware],["Status",(sel.d._statusNorm || String(sel.d.status || "").toLowerCase() || "offline").toUpperCase()],["gRPC TLS to gateway",(sel.d.ssl ?? sel.d.sslEnabled ?? sel.d.useSSL) ? "Yes" : "No"],["Response",sel.d.responseMs?`${sel.d.responseMs}ms`:"—"],["Users on reader",deviceReaderUserDisplay(sel.d)],["Last Sync",fDT(sel.d.lastSync || sel.d.lastCheckedAt || sel.d.lastConnectedAt)],...(sel.d.healthError ? [["Health detail", String(sel.d.healthError)]] : [])].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text,fontFamily:["ID","IP","Port","Response"].includes(k)?TH.mono:"inherit" }}>{v||"—"}</div>
            </div>
          ))}
        </div>
      </Modal>}
      {edit&&<Modal title={`Edit Device — ${edit.name || edit._key}`} onClose={()=>setEdit(null)} footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" sz="sm" onClick={()=>setEdit(null)}>Cancel</Btn><Btn sz="sm" onClick={saveEdit}>Save</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
          <Field label="Device Name" required><Input value={edit.name} onChange={e=>setEdit(p=>({ ...p, name:e.target.value }))}/></Field>
          <Field label="Model"><Input value={edit.model} onChange={e=>setEdit(p=>({ ...p, model:e.target.value }))}/></Field>
          <Field label="Zone"><Input value={edit.zone} onChange={e=>setEdit(p=>({ ...p, zone:e.target.value }))}/></Field>
          <Field label="Placement">
            <Sel value={edit.placement || "entry"} onChange={e=>setEdit(p=>({ ...p, placement:e.target.value }))} options={[
              { value:"entry", label:"Entrance (inside on scan)" },
              { value:"exit", label:"Exit (outside on scan)" },
            ]}/>
          </Field>
          <Field label="IP Address" required><Input value={edit.ip} onChange={e=>setEdit(p=>({ ...p, ip:e.target.value }))}/></Field>
          <Field label="Port"><Input value={edit.port} onChange={e=>setEdit(p=>({ ...p, port:e.target.value }))}/></Field>
          <Field label="Security">
            <div style={{ display:"flex",gap:14,paddingTop:8 }}>
              <label style={{ display:"flex",gap:8,alignItems:"center",cursor:"pointer" }}>
                <input type="radio" name="editSsl" checked={!!edit.ssl} onChange={()=>setEdit(p=>({ ...p, ssl:true }))} style={{ accentColor:TH.blue }}/>
                <span style={{ fontSize:13,color:TH.text }}>SSL/TLS</span>
              </label>
              <label style={{ display:"flex",gap:8,alignItems:"center",cursor:"pointer" }}>
                <input type="radio" name="editSsl" checked={!edit.ssl} onChange={()=>setEdit(p=>({ ...p, ssl:false }))} style={{ accentColor:TH.blue }}/>
                <span style={{ fontSize:13,color:TH.text }}>No SSL</span>
              </label>
            </div>
          </Field>
        </div>
      </Modal>}

      {confirm&&<Confirm title="Remove Device" message="This device will be disconnected. Enrolled users remain in the database." onConfirm={()=>doDel(confirm)} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DEVICE SETUP WIZARD
═══════════════════════════════════════════════════════════════════════ */
function emptyDeviceWizardForm() {
  return {
    name: "",
    model: "BioStation 3",
    deviceId: "",
    ip: "",
    port: "",
    zone: "",
    placement: "entry",
    ssl: true,
    liveness: true,
    apb: true,
    doorSec: "3",
    mask: "allow",
    offlineBuf: true,
    authMode: "Face Only",
    testResult: null
  };
}

const DM = [
  {model:"BioStation 3",      code:"BS3",  face:true,card:true,pin:true,mobile:true,npu:true, ip65:true },
  {model:"BioStation A2 Plus",code:"BSA2", face:true,card:true,pin:true,mobile:false,npu:false,ip65:true},
  {model:"FaceStation F2",    code:"FSF2", face:true,card:true,pin:true,mobile:true,npu:true, ip65:true },
  {model:"BioEntry W3",       code:"BEW3", face:true,card:true,pin:true,mobile:false,npu:false,ip65:true},
  {model:"BioLite N2",        code:"BLN2", face:false,card:true,pin:true,mobile:false,npu:false,ip65:false},
  {model:"CoreStation",       code:"CS",   face:false,card:true,pin:true,mobile:false,npu:false,ip65:false},
  {model:"XPass 2",           code:"XP2",  face:false,card:true,pin:false,mobile:false,npu:false,ip65:true},
  {model:"BioStation L2",     code:"BSL2", face:false,card:true,pin:true,mobile:false,npu:false,ip65:false},
];
/** Sidecar `/devices/test` returns `devices` as an array of objects — never use String(array of objects). */
function formatDeviceTestField(_key, v) {
  if (v === undefined || v === null) return "—";
  if (Array.isArray(v)) {
    if (!v.length) return "None";
    if (typeof v[0] === "object" && v[0] !== null) {
      return v
        .map((d) => {
          const id = d.deviceid ?? d.deviceId ?? d.id ?? "?";
          const ip = d.ipaddr ?? d.ipAddr ?? d.ip ?? "";
          return ip ? `${id} @ ${ip}` : String(id);
        })
        .join(" · ");
    }
    return v.join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function DeviceSetupPage() {
  const { show } = useToast();
  const { data:zData } = useFetch(()=>api.zones(),[],[]);
  const [step,    setStep]    = useState(1);
  const [testing, setTesting] = useState(false);
  const [tested,  setTested]  = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [done,    setDone]    = useState(null);
  const [faceCfgLoading, setFaceCfgLoading] = useState(false);
  const [faceCfg, setFaceCfg] = useState(null);
  const [form,    setForm]    = useState(() => emptyDeviceWizardForm());
  const zoneOptions = useMemo(() => {
    const rows = Array.isArray(zData) ? zData : [];
    const names = rows
      .map((z) => String(z?.name || "").trim())
      .filter(Boolean)
      .map((name) => ({ value:name, label:name }));
    if (!names.length) {
      return [{ value: "", label: "No zones yet — add under Locations" }];
    }
    return [{ value: "", label: "Select a zone…" }, ...names];
  }, [zData]);
  const ff = (k,v) => setForm(p=>({...p,[k]:v}));
  const modelIdx = Math.max(0, DM.findIndex((m) => m.model === form.model));
  const setModelAt = (idx) => {
    const next = DM[(idx + DM.length) % DM.length];
    ff("model", next.model);
  };
  const STEPS = ["1. Network","2. Test","3. Settings","4. Auth","5. Confirm"];

  const runTest = async () => {
    if(!form.ip){ show("Enter IP first","error"); return; }
    setTesting(true); ff("testResult",null); setFaceCfg(null);
    try {
      const r = await api.deviceTest({
        deviceId: String(form.deviceId || "").trim() || undefined,
        ip: form.ip,
        port: parseInt(form.port, 10) || 51211,
        ssl: form.ssl,
        useSSL: form.ssl
      });
      ff("testResult",{ok:true,...r}); setTested(true);
      show("Connection successful!","success");
    } catch(e) {
      ff("testResult",{ok:false,error:e.message}); setTested(false);
    } finally { setTesting(false); }
  };

  const readFaceConfig = async () => {
    const devId = Number(String(form.deviceId || "").trim() || 0);
    if (!devId) {
      show("Enter Device ID first (gateway numeric ID).", "warning");
      return;
    }
    setFaceCfgLoading(true);
    try {
      const r = await api.gsdkFaceConfig({
        deviceId: devId,
        gateway: form.testResult?.gateway || undefined,
        useSSL: true
      });
      setFaceCfg(r);
      show("Reader face config loaded.", "success");
    } catch (e) {
      setFaceCfg({ ok: false, error: e.message });
      show(e.message || "Failed to load face config", "error");
    } finally {
      setFaceCfgLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const normalizedDeviceId = String(form.deviceId || "").trim();
      const r = await api.deviceConnect({
        deviceId: normalizedDeviceId || undefined,
        supremaDeviceId: normalizedDeviceId || undefined,
        gatewayId: normalizedDeviceId || undefined,
        name:form.name,model:form.model,ip:form.ip,port:parseInt(form.port)||51211,
        zone:form.zone,placement:form.placement,ssl:form.ssl,authMode:form.authMode,
        settings:{liveness:form.liveness,apb:form.apb,doorSec:parseInt(form.doorSec),mask:form.mask,offlineBuf:form.offlineBuf},
      });
      setDone(r);
    } catch(e){ show(e.message,"error"); }
    finally { setSaving(false); }
  };

  if (done) return (
    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:420,gap:16,textAlign:"center" }}>
      <GlassCard color={TH.green} style={{ padding:"32px 40px",textAlign:"center" }}>
        <div style={{ fontSize:52,marginBottom:12 }}>✓</div>
        <div style={{ fontSize:24,fontWeight:800,color:TH.green,marginBottom:8 }}>Device Added!</div>
        <div style={{ fontSize:14,color:TH.muted,marginBottom:20 }}>{form.name} is connected and syncing with G-SDK.</div>
        <div style={{ display:"flex",gap:10,justifyContent:"center" }}>
          <Btn v="ghost" onClick={()=>{setDone(null);setStep(1);setTested(false);setForm(emptyDeviceWizardForm());}}>Add Another</Btn>
        </div>
      </GlassCard>
    </div>
  );

  const wizardShell = {
    maxWidth: 900,
    margin: "0 auto",
  };
  const wizardCard = {
    background: "linear-gradient(180deg, rgba(20,33,54,.95), rgba(14,24,40,.95))",
    border: `1px solid ${TH.blue}35`,
    boxShadow: "0 16px 34px rgba(3,10,24,.45), inset 0 1px 0 rgba(255,255,255,.04)",
  };

  return (
    <div style={wizardShell}>
      <PageHeader title="Configure Device" sub="Step-by-step: connect any Suprema terminal to G-SDK"/>

      {/* Step bar */}
      <div style={{ display:"flex",alignItems:"flex-start",marginBottom:18,gap:0,padding:"12px 14px",border:`1px solid ${TH.border}`,borderRadius:12,background:TH.surface }}>
        {STEPS.map((s,i)=>{
          const n=i+1,dn=n<step,ac=n===step;
          return (
            <div key={s} style={{ flex:1,display:"flex",alignItems:"flex-start" }}>
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:5,flex:1 }}>
                <div style={{ width:36,height:36,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,background:dn?TH.green:ac?TH.blue:TH.card,color:dn||ac?"#fff":TH.muted,border:`2px solid ${dn?TH.green:ac?TH.blue:TH.border}`,transition:"all .25s",flexShrink:0,boxShadow:ac?`0 0 16px ${TH.blueGlow}`:"none" }}>{dn?"✓":n}</div>
                <span style={{ fontSize:10,fontWeight:ac?700:400,color:ac?TH.blue:dn?TH.green:TH.muted,whiteSpace:"nowrap",textAlign:"center" }}>{s.slice(3)}</span>
              </div>
              {i<STEPS.length-1&&<div style={{ height:2,flex:1,background:n<step?TH.green:TH.border,marginTop:17,transition:"background .3s",minWidth:8 }}/>}
            </div>
          );
        })}
      </div>

      <Card style={wizardCard}>
        {/* Step 1 */}
        {step===1&&<div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5,letterSpacing:"-.2px" }}>Network Details</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Device must be powered on and connected to your network.</p></div>
          <GlassCard color={TH.green} style={{ padding:"10px 14px" }}>
            <div style={{ fontSize:12,fontWeight:700,color:TH.green,marginBottom:7 }}>✓ Checklist before you start</div>
            {["PoE+ cable connected (green LED on device)","Ethernet to your switch","Device IP address (check device screen → Settings → Network)","TCP port 51211 open in firewall from this server to device IP"].map((s,i)=>(
              <div key={i} style={{ fontSize:12,color:TH.muted,marginBottom:4,display:"flex",gap:8 }}><span style={{ color:TH.green }}>☐</span>{s}</div>
            ))}
          </GlassCard>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
            <Field label="Device Name" required hint="e.g. Main Entrance A"><Input value={form.name} onChange={e=>ff("name",e.target.value)} placeholder="e.g. Main Entrance A" autoComplete="off"/></Field>
            <Field label="Model">
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                <Btn v="ghost" sz="xs" onClick={()=>setModelAt(modelIdx - 1)}>←</Btn>
                <Input value={form.model} readOnly style={{ textAlign:"center",fontWeight:700 }}/>
                <Btn v="ghost" sz="xs" onClick={()=>setModelAt(modelIdx + 1)}>→</Btn>
              </div>
              <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:8 }}>
                {DM.map((m) => (
                  <button
                    key={m.model}
                    type="button"
                    onClick={() => ff("model", m.model)}
                    style={{
                      border:`1px solid ${form.model===m.model?TH.blue:TH.border}`,
                      background:form.model===m.model?TH.blueDim:TH.surface,
                      color:form.model===m.model?TH.blue:TH.muted,
                      padding:"4px 8px",
                      borderRadius:999,
                      fontSize:11,
                      cursor:"pointer"
                    }}
                  >
                    {m.code}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Device ID" required hint="Suprema numeric gateway device ID (recommended for reliable matching)">
              <Input
                value={form.deviceId}
                onChange={e=>ff("deviceId", e.target.value.replace(/[^\d]/g, ""))}
                placeholder="e.g. 538231609"
                inputMode="numeric"
                autoComplete="off"
              />
            </Field>
            <Field label="IP Address" required hint="From device: Settings → Network"><Input value={form.ip} onChange={e=>ff("ip",e.target.value)} placeholder="192.168.x.x" autoComplete="off"/></Field>
            <Field label="Port" hint="51211 clear · 51212 SSL (empty = 51211)"><Input value={form.port} onChange={e=>ff("port",e.target.value)} placeholder="51211" autoComplete="off"/></Field>
            <Field label="Zone" hint="Define zones under Locations if missing">
              <Sel value={form.zone} onChange={e=>ff("zone",e.target.value)} options={zoneOptions}/>
            </Field>
            <Field label="Device Placement" hint="Used for On-Premises presence workflow">
              <Sel
                value={form.placement}
                onChange={e=>ff("placement",e.target.value)}
                options={[
                  { value:"entry", label:"Entrance (employee becomes inside)" },
                  { value:"exit", label:"Exit (employee becomes outside)" }
                ]}
              />
            </Field>
            <Field label="Security" hint="BioStation 3: typically port 51211 without TLS, or 51212 with TLS — port must match this setting"><div style={{ display:"flex",flexDirection:"column",gap:8,marginTop:6 }}>
              {[["true","SSL/TLS Encrypted"],["false","No SSL (testing)"]].map(([v,l])=>(
                <label key={v} style={{ display:"flex",gap:9,alignItems:"center",cursor:"pointer" }}>
                  <input type="radio" name="ssl" value={v} checked={String(form.ssl)===v} onChange={()=>ff("ssl",v==="true")} style={{ accentColor:TH.blue }}/>
                  <span style={{ fontSize:13,color:TH.text }}>{l}</span>
                </label>
              ))}
            </div></Field>
          </div>
          <div style={{ display:"flex",justifyContent:"flex-end" }}><Btn disabled={!form.ip||!form.name||!form.deviceId||!form.zone} onClick={()=>setStep(2)}>Continue →</Btn></div>
        </div>}

        {/* Step 2 */}
        {step===2&&<div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Test Connection</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Verify connectivity before saving.</p></div>
          <div style={{ padding:14,background:TH.surface,borderRadius:10,border:`1px solid ${TH.border}` }}>
            <div style={{ display:"flex",gap:12,alignItems:"center",marginBottom:14,flexWrap:"wrap" }}>
              <span style={{ fontSize:13,color:TH.muted }}>Target:</span>
              <code style={{ color:TH.blue }}>{form.ip}:{form.port || "51211"}</code>
              <Badge color={form.ssl?"green":"amber"}>{form.ssl?"SSL/TLS":"No SSL"}</Badge>
            </div>
            <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
              <Btn onClick={runTest} disabled={testing} icon={testing?<span className="spin">⟳</span>:"🔌"}>{testing?"Testing…":"Test Connection"}</Btn>
              <Btn
                v="secondary"
                onClick={readFaceConfig}
                disabled={faceCfgLoading || !tested}
                icon={faceCfgLoading ? <span className="spin">⟳</span> : "🧪"}
                title="Reads FaceConfig fields currently exposed by the device via G-SDK"
              >
                {faceCfgLoading ? "Reading Face Config..." : "Read Face Config"}
              </Btn>
            </div>
          </div>
          {form.testResult&&(form.testResult.ok?(
            <GlassCard color={TH.green}>
              <div style={{ fontSize:14,fontWeight:700,color:TH.green,marginBottom:10 }}>✓ Connected!</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:7 }}>
                {Object.entries(form.testResult).filter(([k])=>k!=="ok").map(([k,v])=>(
                  <div key={k} style={{ display:"flex",justifyContent:"space-between",gap:10,padding:"6px 10px",background:"rgba(0,0,0,.12)",borderRadius:7,alignItems:"flex-start" }}>
                    <span style={{ fontSize:12,color:TH.muted,textTransform:"capitalize",flexShrink:0 }}>{k}</span>
                    <span style={{ fontSize:12,fontWeight:600,color:TH.text,fontFamily:k==="devices"?TH.text:TH.mono,textAlign:"right",wordBreak:"break-word" }}>{formatDeviceTestField(k, v)}</span>
                  </div>
                ))}
              </div>
            </GlassCard>
          ):(
            <GlassCard color={TH.red}>
              <div style={{ fontSize:13,fontWeight:700,color:TH.red,marginBottom:5 }}>✗ Connection Failed</div>
              <div style={{ fontSize:12,color:TH.red,marginBottom:8 }}>{form.testResult.error}</div>
              <div style={{ fontSize:12,color:TH.muted }}>• ping {form.ip} • check device LED • open port 51211 • verify IP on device screen</div>
            </GlassCard>
          ))}
          {faceCfg && (
            <GlassCard color={faceCfg.ok ? TH.blue : TH.red}>
              <div style={{ fontSize:13,fontWeight:700,color:faceCfg.ok ? TH.blue : TH.red,marginBottom:8 }}>
                {faceCfg.ok ? "Reader Face Config (G-SDK)" : "Face Config Read Failed"}
              </div>
              {faceCfg.ok ? (
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:7 }}>
                  {Object.entries(faceCfg.config || {}).map(([k,v])=>(
                    <div key={k} style={{ display:"flex",justifyContent:"space-between",gap:10,padding:"6px 10px",background:"rgba(0,0,0,.12)",borderRadius:7 }}>
                      <span style={{ fontSize:12,color:TH.muted }}>{k}</span>
                      <span style={{ fontSize:12,fontWeight:600,color:TH.text,fontFamily:TH.mono }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize:12,color:TH.red }}>{faceCfg.error || "Unknown error"}</div>
              )}
              <div style={{ fontSize:11,color:TH.muted,marginTop:8 }}>
                These are the fields exposed remotely by your firmware. Event-photo save toggles are not present if they are missing here.
              </div>
            </GlassCard>
          )}
          <div style={{ display:"flex",justifyContent:"space-between" }}>
            <Btn v="ghost" onClick={()=>setStep(1)}>← Back</Btn>
            <Btn disabled={!tested} onClick={()=>setStep(3)}>Continue →</Btn>
          </div>
        </div>}

        {/* Step 3 */}
        {step===3&&<div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Device Settings</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Security and door behavior — change any time later.</p></div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
            <Field label="Liveness Detection" hint="Blocks fake photo attacks"><Sel value={form.liveness?"on":"off"} onChange={e=>ff("liveness",e.target.value==="on")} options={[{value:"on",label:"Enabled (Recommended)"},{value:"off",label:"Disabled"}]}/></Field>
            <Field label="Anti-Passback" hint="Prevents credential sharing"><Sel value={form.apb?"on":"off"} onChange={e=>ff("apb",e.target.value==="on")} options={[{value:"on",label:"Enabled (Recommended)"},{value:"off",label:"Disabled"}]}/></Field>
            <Field label="Door Open Duration"><Sel value={form.doorSec} onChange={e=>ff("doorSec",e.target.value)} options={["2","3","5","10"].map(v=>({value:v,label:`${v} seconds${v==="3"?" (Default)":""}` }))}/></Field>
            <Field label="Mask Handling"><Sel value={form.mask} onChange={e=>ff("mask",e.target.value)} options={[{value:"allow",label:"Allow"},{value:"block",label:"Block"},{value:"log",label:"Allow + Log"}]}/></Field>
            <Field label="Offline Buffer" hint="Store events locally when server offline"><Toggle value={form.offlineBuf} onChange={v=>ff("offlineBuf",v)} label="Auto-sync on reconnect"/></Field>
          </div>
          <div style={{ display:"flex",justifyContent:"space-between" }}>
            <Btn v="ghost" onClick={()=>setStep(2)}>← Back</Btn>
            <Btn onClick={()=>setStep(4)}>Continue →</Btn>
          </div>
        </div>}

        {/* Step 4 */}
        {step===4&&<div style={{ display:"flex",flexDirection:"column",gap:9 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Authentication Mode</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Default for this door. Override per employee after enrollment.</p></div>
          {[{id:"Face Only",icon:"👤",desc:"Fast, contactless. Best for most doors.",tier:"1FA",c:TH.blue},
            {id:"Face + Card",icon:"👤🪪",desc:"Face AND card required.",tier:"2FA",c:TH.green},
            {id:"Face + PIN",icon:"👤🔢",desc:"Face AND PIN required.",tier:"2FA",c:TH.green},
            {id:"Card Only",icon:"🪪",desc:"RFID card only.",tier:"1FA",c:TH.blue},
            {id:"Card + PIN",icon:"🪪🔢",desc:"Card AND PIN required.",tier:"2FA",c:TH.green},
            {id:"Face + Card + PIN",icon:"🔒",desc:"Maximum security.",tier:"3FA",c:TH.violet}
          ].map(m=>(
            <div key={m.id} onClick={()=>ff("authMode",m.id)}
              style={{ display:"flex",gap:14,alignItems:"center",padding:"13px 16px",background:form.authMode===m.id?TH.blueDim:TH.surface,border:`2px solid ${form.authMode===m.id?TH.blue:TH.border}`,borderRadius:11,cursor:"pointer",transition:"all .14s" }}>
              <div style={{ width:46,height:46,borderRadius:11,background:`${m.c}18`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>{m.icon}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:2 }}>{m.id}</div>
                <div style={{ fontSize:12,color:TH.muted }}>{m.desc}</div>
              </div>
              <Badge color={{blue:"blue",green:"green",violet:"violet"}[m.c===TH.blue?"blue":m.c===TH.green?"green":"violet"]||"gray"}>{m.tier}</Badge>
              {form.authMode===m.id&&<span style={{ color:TH.blue,fontSize:20,fontWeight:700 }}>✓</span>}
            </div>
          ))}
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:8 }}>
            <Btn v="ghost" onClick={()=>setStep(3)}>← Back</Btn>
            <Btn onClick={()=>setStep(5)}>Continue →</Btn>
          </div>
        </div>}

        {/* Step 5 */}
        {step===5&&<div style={{ display:"flex",flexDirection:"column",gap:12 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Review & Save</h3></div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            {[["Name",form.name],["Model",form.model],["IP",form.ip],["Port",form.port],["Zone",form.zone],["Placement",form.placement==="exit"?"Exit":"Entrance"],["SSL",form.ssl?"Yes":"No"],["Auth Mode",form.authMode],["Liveness",form.liveness?"On":"Off"],["Anti-Passback",form.apb?"On":"Off"],["Door",`${form.doorSec}s`],["Mask",form.mask],["Buffer",form.offlineBuf?"On":"Off"]].map(([k,v])=>(
              <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"8px 12px",background:TH.surface,borderRadius:8,border:`1px solid ${TH.border}` }}>
                <span style={{ fontSize:12,color:TH.muted }}>{k}</span>
                <span style={{ fontSize:12,fontWeight:700,color:TH.text }}>{v}</span>
              </div>
            ))}
          </div>
          <GlassCard color={TH.green} style={{ padding:"11px 14px" }}>
            <span style={{ fontSize:13,color:TH.green,fontWeight:600 }}>✓ Connection tested — device ready to connect</span>
          </GlassCard>
          <div style={{ display:"flex",justifyContent:"space-between" }}>
            <Btn v="ghost" onClick={()=>setStep(4)}>← Back</Btn>
            <Btn v="success" loading={saving} onClick={save} icon="✅">Save & Connect</Btn>
          </div>
        </div>}
      </Card>

      <Card style={{ marginTop:12, ...wizardCard }}>
        <div style={{ fontSize:13,fontWeight:700,color:TH.text,marginBottom:12 }}>❓ Help</div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12 }}>
          {[["Find IP","Check device screen: Settings → Network. Or router DHCP table."],["Firewall","Open TCP 51211 (or 51212 SSL) from server IP to device IP."],["SSL cert","Auto-generated in ./certs/. Replace with custom certs and restart."],["Not responding","Ping the IP. Green LED should be on. Try hold reset 5s."]].map(([q,a])=>(
            <div key={q}><div style={{ fontSize:12,fontWeight:700,color:TH.text,marginBottom:4 }}>{q}</div><div style={{ fontSize:12,color:TH.muted,lineHeight:1.6 }}>{a}</div></div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ACCESS LOGS
═══════════════════════════════════════════════════════════════════════ */
function LogsPage({ onNav }) {
  const { show } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [personType, setPersonType] = useState("all"); // "all" | "employees" | "visitors"
  const [todayOnly, setTodayOnly] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [unknownDeniedOnly, setUnknownDeniedOnly] = useState(false);
  const [page,   setPage]   = useState(1);
  const [sel,    setSel]    = useState(null);
  const [live,   setLive]   = useState([]);
  const [unknownEmpForm, setUnknownEmpForm] = useState(null);
  const [unknownVisForm, setUnknownVisForm] = useState(null);
  const PER = 100; // default page size for log table
  const formatDateDMY = (value = "") => {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
    if (!digits) return "";
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const isoToDMY = (iso = "") => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    return `${m[3]}/${m[2]}/${m[1].slice(-2)}`;
  };
  const dmyToISO = (dmy = "") => {
    const m = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(String(dmy || "").trim());
    if (!m) return "";
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const fromDateIso = dmyToISO(fromDate);
  const toDateIso = dmyToISO(toDate);

  useEffect(() => {
    try {
      const presetFilter = sessionStorage.getItem("acs_logs_filter");
      const presetToday = sessionStorage.getItem("acs_logs_today");
      if (presetFilter === "granted" || presetFilter === "denied") setFilter(presetFilter);
      if (presetFilter === "unknown_denied") setUnknownDeniedOnly(true);
      if (presetToday === "1") setTodayOnly(true);
      sessionStorage.removeItem("acs_logs_filter");
      sessionStorage.removeItem("acs_logs_today");
    } catch {}
  }, []);

  const p = { page, limit:PER, ...(filter!=="all"&&{granted:filter==="granted"}), ...(search&&{search}), ...(todayOnly&&{today:1}), ...(fromDateIso&&{fromDate:fromDateIso}), ...(toDateIso&&{toDate:toDateIso}), ...(unknownDeniedOnly&&{unknownDenied:1}) };
  const { data, loading, reload } = useFetch(()=>api.logs(p), [page,filter,search,todayOnly,fromDate,toDate,unknownDeniedOnly], {logs:[],total:0});

  const { data:stats } = useFetch(()=>api.logStats(), [], null);
  const { data:empMeta } = useFetch(()=>api.employees({ limit:100000 }), [], { employees:[] });
  const { data:visMeta } = useFetch(()=>api.visitors({ limit:100000 }), [], { visitors:[] });

  useWS(useCallback(msg=>{
    if (msg.type==="ACCESS_EVENT") setLive(prev=>[msg.data,...prev.slice(0,99)]);
  },[]));
  const logKey = useCallback((l) => String(
    l?._id ||
    `${l?.employeeId || l?.employeeName || l?.name || "unknown"}-${l?.timestamp || l?.ts || l?.createdAt || ""}-${l?.eventType || ""}`
  ), []);
  useEffect(() => {
    const onSynced = async () => {
      if (page !== 1) return;
      try {
        const fresh = await api.logs({ ...p, page:1, limit:PER });
        const rows = fresh?.logs || [];
        if (!rows.length) return;
        setLive((prev) => {
          const known = new Set([...(data?.logs || []), ...prev].map(logKey));
          const incoming = rows.filter((r) => !known.has(logKey(r)));
          if (!incoming.length) return prev;
          return [...incoming, ...prev].slice(0, 100);
        });
      } catch {}
    };
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [page, p, data?.logs, logKey]);
  const logTsMs = useCallback((l) => {
    const t = logEventTime(l);
    const d = t ? new Date(t) : null;
    const ms = d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
    return ms;
  }, []);

  useEffect(() => {
    if (page !== 1) return undefined;
    const tick = () => {
      api.pullEvents().catch(() => {});
      api
        .logs({ ...p, page: 1, limit: PER })
        .then((fresh) => {
          const rows = fresh?.logs || [];
          if (!rows.length) return;
          setLive((prev) => {
            const slot = new Map();
            for (const p of prev || []) slot.set(logKey(p), { ...p });
            for (const r of rows) {
              const k = logKey(r);
              const cur = slot.get(k);
              slot.set(k, cur ? mergeAccessLogSnapshots(cur, r) : { ...r });
            }
            return [...slot.values()]
              .sort((a, b) => logTsMs(b) - logTsMs(a))
              .slice(0, 100);
          });
        })
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => clearInterval(timer);
  }, [page, p, data?.logs, logKey]);

  /** Page 1: merge WS/poll "live" with server page — never cap live to 0 when the server returns a full page (that hid realtime rows). */
  const merged = page === 1
    ? (() => {
        const server = data?.logs || [];
        const fetchParams = { filter, todayOnly, unknownDeniedOnly, search, fromDate: fromDateIso, toDate: toDateIso };
        const fromLive = (live || []).filter((l) => liveLogMatchesFetchParams(l, fetchParams));
        const combined = [...fromLive, ...server];
        combined.sort((a, b) => logTsMs(b) - logTsMs(a));
        /**
         * Same Suprema event often appears twice (WebSocket insert snapshot vs GET /logs enriched).
         * Old logic dropped duplicates by keep-first-after-sort — the WS row could sort before the API row,
         * leaving Card/Designation/Division empty until full page refresh cleared `live`.
         */
        const deduped = [];
        const sidSlot = new Map();
        for (const l of combined) {
          const sid = Number(l?.supremaLogId || 0);
          if (sid > 0) {
            const i = sidSlot.get(sid);
            if (i !== undefined) {
              deduped[i] = mergeAccessLogSnapshots(deduped[i], l);
              continue;
            }
            sidSlot.set(sid, deduped.length);
          }
          deduped.push({ ...l });
        }
        return deduped.slice(0, PER);
      })()
    : (data?.logs || []);

  /** Same employee row as enrolled-photo lookup — fills Card/Designation/Division when API row missed enrichment after refresh. */
  const mergeLogEmployeeFields = useCallback(
    (rows) => {
      const emps = empMeta?.employees || [];
      if (!emps.length || !rows?.length) return rows;
      return rows.map((l) => {
        const eid = String(l?.employeeId ?? "").trim();
        const enm = String(l?.employeeName ?? l?.name ?? "")
          .trim()
          .toLowerCase();
        const emp = emps.find((e) => {
          const xe = String(e?.employeeId ?? "").trim();
          const xel = String(e?.name ?? "")
            .trim()
            .toLowerCase();
          if (eid && xe === eid) return true;
          if (
            eid &&
            xe &&
            !Number.isNaN(Number(eid)) &&
            !Number.isNaN(Number(xe)) &&
            Number(eid) === Number(xe)
          )
            return true;
          if (enm && xel === enm) return true;
          return false;
        });
        if (!emp) return l;
        return {
          ...l,
          cardId: l.cardId || emp.cardId || emp.cardNo || "",
          designation: l.designation || emp.designation || "",
          division: l.division || emp.division || "",
          department: l.department || l.dept || emp.department || "",
          dept: l.dept || emp.department || ""
        };
      });
    },
    [empMeta]
  );
  const rowsForTableRaw = mergeLogEmployeeFields(merged);
  const rowsForTable = useMemo(() => {
    if (personType === "all") return rowsForTableRaw;
    const empIds = new Set((empMeta?.employees || []).map(e => String(e.employeeId || "").trim().toLowerCase()).filter(Boolean));
    const empNames = new Set((empMeta?.employees || []).map(e => String(e.name || "").trim().toLowerCase()).filter(Boolean));
    const visIds = new Set((visMeta?.visitors || []).map(v => String(v.passNumber || v.employeeId || "").trim().toLowerCase()).filter(Boolean));
    const visNames = new Set((visMeta?.visitors || []).map(v => String(v.name || "").trim().toLowerCase()).filter(Boolean));
    return rowsForTableRaw.filter(l => {
      const lid = String(l?.employeeId || "").trim().toLowerCase();
      const lnm = String(l?.employeeName || l?.name || "").trim().toLowerCase();
      if (personType === "employees") return empIds.has(lid) || empNames.has(lnm);
      if (personType === "visitors")  return visIds.has(lid) || visNames.has(lnm);
      return true;
    });
  }, [rowsForTableRaw, personType, empMeta, visMeta]);
  const ai = useMemo(() => accessLogAiInsights(rowsForTable), [rowsForTable]);

  const logPhoto = l =>
    l?.photo ||
    l?.photoUrl ||
    l?.image ||
    l?.imageUrl ||
    l?.faceImage ||
    l?.facePhoto ||
    l?.snapshot ||
    l?.snapshotUrl ||
    l?.capture ||
    l?.captureUrl ||
    (l?.jpgimage ? `data:image/jpeg;base64,${l.jpgimage}` : null) ||
    null;
  const logEnrollmentPhoto = l =>
    l?.enrollmentPhoto ||
    l?.enrolledPhoto ||
    l?.profilePhoto ||
    null;
  const enrolledPhoto = useCallback((l) => {
    const eid = String(l?.employeeId || "").trim().toLowerCase();
    const enm = String(l?.employeeName || l?.name || "").trim().toLowerCase();
    const src = [...(empMeta?.employees || []), ...(visMeta?.visitors || [])].find(x => {
      const xid = String(x?.employeeId || x?._id || "").trim().toLowerCase();
      const xnm = String(x?.name || "").trim().toLowerCase();
      return (eid && eid === xid) || (enm && enm === xnm);
    });
    return logEnrollmentPhoto(l) || src?.photo || src?.photoUrl || src?.image || src?.imageUrl || src?.facePhoto || src?.faceImage || src?.snapshot || src?.snapshotUrl || null;
  }, [empMeta, visMeta]);
  const isDenied = l => !(l?.accessGranted ?? l?.granted);
const hasLivePhoto = l => Boolean(logPhoto(l));
const eventCodeHex = l => {
  const c = l?.bioStarEventCode ?? l?.eventcode ?? l?.eventCode;
  if (!c) return null;
  return '0x' + (Number(c) >>> 0).toString(16).toUpperCase();
};
  const isUnknownDenied = l => {
    if (!isDenied(l)) return false;
    const id = String(l?.employeeId || "").trim().toUpperCase();
    const nm = String(l?.employeeName || l?.name || "").trim().toUpperCase();
    return id.startsWith("UNKNOWN-") || nm.startsWith("UNKNOWN-") || nm === "UNKNOWN" || !nm;
  };
  const unknownLivePhoto = (l) => logPhoto(l) || null;
  const isUnknownLiveImageMissing = l => isUnknownDenied(l) && !unknownLivePhoto(l);
  const unknownLivePhotoMissingTitle = (l) => {
    const hx = eventCodeHex(l);
    const code = (Number(l?.bioStarEventCode ?? l?.eventcode ?? l?.eventCode ?? 0) >>> 0) & 0xffff;
    const base =
      "No JPEG arrived from the reader via GetImageLog (gateway merge). The Expo app only displays images the device stores.";
    if (code === 0x1800) {
      return `${base} Event 0x1800 = unregistered / invalid face template — many firmware builds omit snapshots until BioStar 2 enables Image Log + saving face images for authentication failure or unknown users on this reader, then click Sync.`;
    }
    if (code === 0x1400) {
      return `${base} Event 0x1400 = identify failed — enable image retention for identify-fail / unknown on the device.`;
    }
    return `${base}${hx ? ` (${hx}).` : ""}`;
  };

  const doExport = async fmt => {
    try {
      const res = await api.exportData({format:fmt,filters:{granted:filter!=="all"?filter==="granted":undefined,search,today:todayOnly?1:undefined,fromDate:fromDateIso||undefined,toDate:toDateIso||undefined,unknownDenied:unknownDeniedOnly?1:undefined}});
      await saveDownloadResponse(res, `access-logs-${fmt}`);
      show("Export downloaded","success");
    }
    catch(e){ show(e.message,"error"); }
  };
  const openUnknownAsEmployee = l => {
    const uid = String(l?.employeeId || l?.employeeName || l?.name || `UNKNOWN-${Date.now().toString(36).toUpperCase()}`).trim();
    setUnknownEmpForm({
      source: l,
      name: l?.employeeName && !String(l.employeeName).toUpperCase().startsWith("UNKNOWN-") ? l.employeeName : `Unknown ${uid.slice(-6)}`,
      employeeId: uid,
      cardId: "",
      designation: "",
      department: "Unassigned",
      division: "",
      cardholderStatus: "Active",
      shiftSchedule: "",
      passIssueDate: "",
      passExpiryDate: "",
      email: "",
      phone: "",
      lineManager: "",
      authMode: l?.authMode || "Face Only",
      accessLevel: "L1 General",
      status: "pending",
      enrolled: false,
      photo: logPhoto(l) || undefined,
      photoUrl: logPhoto(l) || undefined,
    });
  };
  const saveUnknownAsEmployee = async () => {
    try {
      const payload = { ...unknownEmpForm };
      delete payload.source;
      if (!payload.name || !payload.employeeId) {
        show("Employee Name and Pass Number are required","error");
        return;
      }
      await api.empCreate(payload);
      show("Unknown person added as Employee.","success");
      setUnknownEmpForm(null);
      setSel(null);
      onNav?.("employees");
    } catch (e) {
      show(e.message, "error");
    }
  };
  const openUnknownAsVisitor = l => {
    const uid = String(l?.employeeId || l?.employeeName || l?.name || `UNKNOWN-${Date.now().toString(36).toUpperCase()}`).trim();
    setUnknownVisForm({
      source: l,
      name: `Visitor ${uid.slice(-6)}`,
      company: "Unknown",
      email: "",
      phone: "",
      host: "",
      purpose: "Walk-in Denied Attempt",
      scheduledFrom: "",
      scheduledTo: "",
      scheduledEntry: "",
      photoUrl: logPhoto(l) || "",
      photo: logPhoto(l) || undefined,
      sourceUnknownId: uid,
    });
  };
  const saveUnknownAsVisitor = async () => {
    try {
      const payload = { ...unknownVisForm };
      delete payload.source;
      if (!payload.name) {
        show("Visitor name is required","error");
        return;
      }
      await api.visitorCreate(payload);
      show("Unknown person added as Visitor record.","success");
      setUnknownVisForm(null);
      setSel(null);
      onNav?.("visitors");
    } catch (e) {
      show(e.message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Access Logs" sub={`${fNum(data?.total||0)} total events`}
        action={<><Btn v="ghost" sz="sm" onClick={()=>doExport("excel")}>⬇ Excel</Btn><Btn v="ghost" sz="sm" onClick={()=>doExport("csv")}>⬇ CSV</Btn><Btn v="ghost" sz="xs" onClick={reload}>⟳</Btn></>}/>
      <div style={{ display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center" }}>
        <SearchBar value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Employee, pass no, card id, designation, zone…" style={{ flex:"1 1 240px" }}/>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["granted","Granted"],["denied","Denied"]].map(([v,l])=>(
            <button
              key={v}
              onClick={()=>{
                setFilter(v);
                setUnknownDeniedOnly(false);
                setPage(1);
              }}
              style={{
                padding:"7px 13px",
                fontSize:12,
                fontWeight:600,
                background:filter===v?TH.blue:"transparent",
                color:filter===v?"#fff":TH.muted,
                border:"none",
                cursor:"pointer"
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 46px",gap:8 }}>
          <Input
            value={fromDate}
            onChange={e=>{
              setFromDate(formatDateDMY(e.target.value));
              setTodayOnly(false);
              setPage(1);
            }}
            placeholder="dd/mm/yy"
            pattern="\d{2}/\d{2}/\d{2}"
            style={{ width:130 }}
            title="From date (dd/mm/yy)"
          />
          <input
            type="date"
            value={fromDateIso}
            onChange={e=>{
              setFromDate(isoToDMY(e.target.value));
              setTodayOnly(false);
              setPage(1);
            }}
            title="From calendar"
            style={{ width:46,padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
          />
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 46px",gap:8 }}>
          <Input
            value={toDate}
            onChange={e=>{
              setToDate(formatDateDMY(e.target.value));
              setTodayOnly(false);
              setPage(1);
            }}
            placeholder="dd/mm/yy"
            pattern="\d{2}/\d{2}/\d{2}"
            style={{ width:130 }}
            title="To date (dd/mm/yy)"
          />
          <input
            type="date"
            value={toDateIso}
            min={fromDateIso||undefined}
            onChange={e=>{
              setToDate(isoToDMY(e.target.value));
              setTodayOnly(false);
              setPage(1);
            }}
            title="To calendar"
            style={{ width:46,padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
          />
        </div>
        <Btn v={todayOnly?"primary":"ghost"} sz="sm" onClick={()=>{
          setTodayOnly(v => {
            const next = !v;
            if (next) {
              setFromDate("");
              setToDate("");
            }
            return next;
          });
          setPage(1);
        }}>{todayOnly?"Today Only: ON":"Today Only"}</Btn>
        {(fromDate || toDate) && (
          <Btn v="ghost" sz="sm" onClick={()=>{
            setFromDate("");
            setToDate("");
            setPage(1);
          }}>
            Clear Dates
          </Btn>
        )}
        <Btn
          v={unknownDeniedOnly?"danger":"ghost"}
          sz="sm"
          onClick={()=>{
            setUnknownDeniedOnly(v => {
              const next = !v;
              if (next) setFilter("denied");
              return next;
            });
            setPage(1);
          }}
        >
          {unknownDeniedOnly ? `Unknown Denied: ON (${fNum(stats?.unknownDenied||0)})` : `Unknown Denied (${fNum(stats?.unknownDenied||0)})`}
        </Btn>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All People"],["employees","Employees"],["visitors","Visitors"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setPersonType(v);setPage(1);}}
              style={{ padding:"7px 13px",fontSize:12,fontWeight:600,whiteSpace:"nowrap",
                background:personType===v?TH.blue:"transparent",
                color:personType===v?"#fff":TH.muted,border:"none",cursor:"pointer" }}>
              {l}
            </button>
          ))}
        </div>
        {live.length>0&&<div style={{ display:"flex",gap:5,alignItems:"center" }}><div style={{ width:7,height:7,borderRadius:"50%",background:TH.green }} className="pulse-dot"/><span style={{ fontSize:12,color:TH.green,fontWeight:600 }}>Live</span></div>}
      </div>

      <Card style={{ marginBottom:12, border:`1px solid ${TH.border}` }}>
        <div style={{ display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",alignItems:"center",marginBottom:10 }}>
          <div>
            <div style={{ fontSize:13,fontWeight:800,color:TH.text }}>AI Insights</div>
            <div style={{ fontSize:12,color:TH.muted,marginTop:2 }}>{ai.summary}</div>
          </div>
          <Badge
            color={ai.riskLevel === "high" ? "red" : ai.riskLevel === "medium" ? "amber" : "green"}
            sm
          >
            {ai.riskLevel === "high" ? "Risk: High" : ai.riskLevel === "medium" ? "Risk: Medium" : "Risk: Low"}
          </Badge>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:8,marginBottom:10 }}>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Denied Rate</div>
            <div style={{ fontSize:18,fontWeight:800,color:ai.deniedRate>=35?TH.red:ai.deniedRate>=20?TH.amber:TH.green }}>{ai.deniedRate.toFixed(1)}%</div>
            <div style={{ fontSize:11,color:TH.muted }}>{fNum(ai.denied)} denied / {fNum(ai.total)} events</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Unknown Denied</div>
            <div style={{ fontSize:18,fontWeight:800,color:ai.unknownDenied>0?TH.red:TH.green }}>{fNum(ai.unknownDenied)}</div>
            <div style={{ fontSize:11,color:TH.muted }}>{fNum(ai.recentUnknownDenied)} in last 15 min</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Hot Zone</div>
            <div style={{ fontSize:15,fontWeight:800,color:TH.text }}>{ai.topDeniedZone?.[0] || "—"}</div>
            <div style={{ fontSize:11,color:TH.muted }}>{fNum(ai.topDeniedZone?.[1] || 0)} denied events</div>
          </div>
          <div style={{ border:`1px solid ${TH.border}`,borderRadius:10,padding:"10px 11px",background:TH.surface }}>
            <div style={{ fontSize:11,color:TH.muted }}>Repeated Identity</div>
            <div style={{ fontSize:15,fontWeight:800,color:TH.text }}>{ai.topDeniedIdentity?.[0] || "—"}</div>
            <div style={{ fontSize:11,color:TH.muted }}>{fNum(ai.topDeniedIdentity?.[1] || 0)} denied attempts</div>
          </div>
        </div>
        <div style={{ display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
          <Btn
            v="ghost"
            sz="xs"
            onClick={()=>{
              setUnknownDeniedOnly(true);
              setFilter("denied");
              setPage(1);
            }}
          >
            ⚡ Focus Unknown Denied
          </Btn>
          <Btn
            v="ghost"
            sz="xs"
            disabled={!ai.topDeniedZone?.[0]}
            onClick={()=>{
              setSearch(ai.topDeniedZone?.[0] || "");
              setPage(1);
            }}
          >
            🎯 Search Hot Zone
          </Btn>
          <Btn
            v="ghost"
            sz="xs"
            disabled={!ai.topDeniedIdentity?.[0]}
            onClick={()=>{
              setSearch(ai.topDeniedIdentity?.[0] || "");
              setFilter("denied");
              setPage(1);
            }}
          >
            👤 Track Repeated Denials
          </Btn>
          <Btn
            v="ghost"
            sz="xs"
            onClick={()=>{
              setSearch("");
              setFilter("all");
              setPersonType("all");
              setTodayOnly(false);
              setUnknownDeniedOnly(false);
              setFromDate("");
              setToDate("");
              setPage(1);
            }}
          >
            Reset Smart Filters
          </Btn>
        </div>
      </Card>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Scan Time","Scan Photo","Employee","Pass No.","Card Id","Designation","Division","Zone","Auth","Direction","Result"]} onRow={r=>setSel(r.l)}
          rows={rowsForTable.map(l=>({ key:l._id||l.id,l, cells:[
            <span style={{ fontSize:12,fontFamily:TH.mono,color:TH.muted,fontWeight:600 }}>{fDTS(logEventTime(l))}</span>,
            (() => {
              const liveSrc = unknownLivePhoto(l);
              const enrolledSrc = enrolledPhoto(l);
              if (liveSrc) {
                const inferred = !logPhoto(l);
                return <img src={liveSrc} alt={l.employeeName||l.name||"photo"} title={inferred ? "Recovered live photo from nearest unknown event on same reader context." : undefined} style={{ width:72,height:80,borderRadius:9,objectFit:"cover",objectPosition:"top center",border:`1px solid ${TH.border}` }}/>;
              }
              if (isUnknownLiveImageMissing(l)) {
                return (
                  <div
                    title={unknownLivePhotoMissingTitle(l)}
                    style={{ width:72,height:80,borderRadius:9,border:`1px solid ${TH.amber}55`,background:TH.amberDim,color:TH.amber,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:800,textAlign:"center",lineHeight:1.1,padding:"4px 2px",gap:2 }}
                  >
                    <div>NO UNKNOWN</div>
                    <div>LIVE</div>
                    {eventCodeHex(l) ? <div style={{ fontSize:7,opacity:.9 }}>{eventCodeHex(l)}</div> : null}
                  </div>
                );
              }
              if (enrolledSrc) {
                return <img src={enrolledSrc} alt={l.employeeName||l.name||"photo"} title="Showing enrollment photo because live capture is unavailable for this row." style={{ width:72,height:80,borderRadius:9,objectFit:"cover",objectPosition:"top center",border:`1px solid ${TH.border}` }}/>;
              }
              return <Avatar name={l.employeeName||l.name||"?"} size={72} color={TH.muted}/>;
            })(),
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <Avatar name={l.employeeName||l.name||"?"} size={56} color={(l.accessGranted??l.granted)?TH.green:TH.red} img={enrolledPhoto(l) || logEnrollmentPhoto(l) || undefined} />
              <div><div style={{ fontWeight:700,fontSize:13,color:TH.textHi }}>{l.employeeName||l.name||"—"}</div><div style={{ fontSize:11,color:TH.muted,marginTop:2 }}>{l.department||l.dept||"—"}</div></div>
            </div>,
            <span style={{ fontSize:12,fontFamily:TH.mono,fontWeight:600 }}>{l.employeeId||"—"}</span>,
            <span style={{ fontSize:12,fontFamily:TH.mono,fontWeight:600 }}>{l.cardId||"—"}</span>,
            <span style={{ fontSize:12,fontWeight:600 }}>{l.designation||"—"}</span>,
            <span style={{ fontSize:12,fontWeight:600 }}>{l.division||"—"}</span>,
            <span style={{ fontSize:12 }}>📍 {l.zone||"—"}</span>,
            <Badge color="blue" sm>{l.authMode||"—"}</Badge>,
            (() => {
              const dir = String(l.direction || l.devicePlacement || l.placement || "").toLowerCase();
              const isOut = dir === "out" || dir === "exit";
              const isIn = dir === "in" || dir === "entry";
              const inferred = !isOut && !isIn ? ((l.accessGranted ?? l.granted) ? "in" : "out") : (isOut ? "out" : "in");
              return inferred === "out"
                ? <Badge color="amber" sm>↑ Exit</Badge>
                : <Badge color="cyan" sm>↓ Entry</Badge>;
            })(),
            (l.accessGranted??l.granted)?<Badge color="green" sm>✓</Badge>:<Badge color="red" sm>✗</Badge>,
          ]}))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>

      {sel&&<Modal title="Event Detail" onClose={()=>setSel(null)} width={760}
        footer={isUnknownDenied(sel)
          ? <div style={{ display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap" }}>
              <Btn v="ghost" onClick={()=>setSel(null)}>Close</Btn>
              <Btn v="secondary" onClick={()=>openUnknownAsVisitor(sel)} icon="🪪">Enroll as Visitor</Btn>
              <Btn v="success" onClick={()=>openUnknownAsEmployee(sel)} icon="👤">Enroll as Employee</Btn>
            </div>
          : undefined}>
        <div style={{ display:"flex",gap:14,marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${TH.border}` }}>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            <div style={{ textAlign:"center" }}>
              <img src={unknownLivePhoto(sel) || `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><rect width='100%' height='100%' fill='#1f2d4a'/><text x='90' y='95' text-anchor='middle' fill='#dbe9ff' font-size='14' font-family='Arial'>No Live Scan</text></svg>")}`} alt="live scan" style={{ width:180,height:180,borderRadius:12,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
              <div style={{ marginTop:4,fontSize:10,color:TH.muted }}>
                {(!logPhoto(sel) && unknownLivePhoto(sel)) ? "Live Scan (recovered from nearby unknown event)" : "Live Scan (scanner time)"}
              </div>
            </div>
            <div style={{ textAlign:"center" }}>
              <img src={enrolledPhoto(sel) || logEnrollmentPhoto(sel) || logPhoto(sel) || `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><rect width='100%' height='100%' fill='#1f2d4a'/><text x='90' y='95' text-anchor='middle' fill='#dbe9ff' font-size='14' font-family='Arial'>No Enrollment Photo</text></svg>")}`} alt="enrolled" style={{ width:180,height:180,borderRadius:12,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
              <div style={{ marginTop:4,fontSize:10,color:TH.muted }}>Enrollment</div>
            </div>
          </div>
          <div>
            <div style={{ fontSize:18,fontWeight:800,color:TH.text,marginBottom:8 }}>{sel.employeeName||sel.name||"Unknown"}</div>
            {(sel.accessGranted??sel.granted)?<Badge color="green">✓ Access Granted</Badge>:<Badge color="red">✗ Access Denied</Badge>}
            <div style={{ fontSize:12,color:TH.muted,marginTop:6,fontFamily:TH.mono }}>{fDT(logEventTime(sel))}</div>
          </div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["Pass Number",sel.employeeId],["Card Id (CSN)",sel.cardId],["Employee Name",sel.employeeName||sel.name],["Designation",sel.designation],["Department",sel.department||sel.dept],["Division",sel.division],["Access Level",sel.accessLevel],["Cardholder Status",sel.cardholderStatus],["Shift Schedule",sel.shiftSchedule],["Pass Issue Date",sel.passIssueDate],["Pass Expiry Date",sel.passExpiryDate],["Line Manager",sel.lineManager],["Zone",sel.zone],["Device",sel.deviceName||sel.device],["Auth Mode",sel.authMode],["Direction",sel.direction],["BioStar event",sel.bioStarEventCode!=null&&sel.bioStarEventCode!==""?`0x${(Number(sel.bioStarEventCode)>>>0).toString(16)}${sel.bioStarSubCode?` · sub 0x${(Number(sel.bioStarSubCode)>>>0).toString(16)}`:""}`:"—"],["Reader detail",sel.denialReason||"—"],["Confidence",(() => { const n = accessLogNumericMetric(sel.confidence ?? sel.matchScore ?? sel.score); return n != null ? `${Math.round(n)}%` : "—"; })()],["Response",(() => { const n = accessLogNumericMetric(sel.processingMs ?? sel.responseMs ?? sel.latencyMs); return n != null ? `${Math.round(n)}ms` : "—"; })()],["Temperature",(() => { const n = accessLogNumericMetric(sel.temperature); return n != null ? `${Number(n).toFixed(1)}°C` : "—"; })()]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
        {isUnknownDenied(sel)&&(
          <div style={{ marginTop:12,padding:"10px 12px",border:`1px solid ${TH.amber}40`,borderRadius:10,background:TH.amberDim,fontSize:12,color:TH.amber }}>
            Unknown denied event detected. You can enroll this person directly as Employee or Visitor using the actions below.
            {isUnknownLiveImageMissing(sel)
              ? ` Device source did not provide unknown live image (hasimage=false)${eventCodeHex(sel) ? ` on ${eventCodeHex(sel)}` : ""}.`
              : ""}
          </div>
        )}
      </Modal>}
      {unknownEmpForm&&<Modal title="Enroll Unknown as Employee" onClose={()=>setUnknownEmpForm(null)} width={720}
        footer={<div style={{ display:"flex",justifyContent:"flex-end",gap:8 }}><Btn v="ghost" onClick={()=>setUnknownEmpForm(null)}>Cancel</Btn><Btn onClick={saveUnknownAsEmployee}>Create Employee</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
          <Field label="Employee Name" required><Input value={unknownEmpForm.name} onChange={e=>setUnknownEmpForm(p=>({...p,name:e.target.value}))}/></Field>
          <Field label="Pass Number" required><Input value={unknownEmpForm.employeeId} onChange={e=>setUnknownEmpForm(p=>({...p,employeeId:e.target.value}))}/></Field>
          <Field label="Card Id (CSN)"><Input value={unknownEmpForm.cardId} onChange={e=>setUnknownEmpForm(p=>({...p,cardId:e.target.value}))}/></Field>
          <Field label="Designation"><Input value={unknownEmpForm.designation} onChange={e=>setUnknownEmpForm(p=>({...p,designation:e.target.value}))}/></Field>
          <Field label="Department"><Input value={unknownEmpForm.department} onChange={e=>setUnknownEmpForm(p=>({...p,department:e.target.value}))}/></Field>
          <Field label="Division"><Input value={unknownEmpForm.division} onChange={e=>setUnknownEmpForm(p=>({...p,division:e.target.value}))}/></Field>
          <Field label="Access Level"><Sel value={unknownEmpForm.accessLevel} onChange={e=>setUnknownEmpForm(p=>({...p,accessLevel:e.target.value}))} options={["L1 General","L2 Restricted","L3 Confidential","L4 Classified"].map(l=>({value:l,label:l}))}/></Field>
          <Field label="Cardholder Status"><Sel value={unknownEmpForm.cardholderStatus} onChange={e=>setUnknownEmpForm(p=>({...p,cardholderStatus:e.target.value}))} options={["Active","Inactive","Suspended","Expired"].map(s=>({value:s,label:s}))}/></Field>
          <Field label="Shift Schedule"><Input value={unknownEmpForm.shiftSchedule} onChange={e=>setUnknownEmpForm(p=>({...p,shiftSchedule:e.target.value}))}/></Field>
          <Field label="Email"><Input value={unknownEmpForm.email} onChange={e=>setUnknownEmpForm(p=>({...p,email:e.target.value}))} type="email"/></Field>
          <Field label="Phone"><Input value={unknownEmpForm.phone} onChange={e=>setUnknownEmpForm(p=>({...p,phone:e.target.value}))}/></Field>
          <Field label="Line Manager"><Input value={unknownEmpForm.lineManager} onChange={e=>setUnknownEmpForm(p=>({...p,lineManager:e.target.value}))}/></Field>
        </div>
      </Modal>}
      {unknownVisForm&&<Modal title="Enroll Unknown as Visitor" onClose={()=>setUnknownVisForm(null)} width={700}
        footer={<div style={{ display:"flex",justifyContent:"flex-end",gap:8 }}><Btn v="ghost" onClick={()=>setUnknownVisForm(null)}>Cancel</Btn><Btn onClick={saveUnknownAsVisitor}>Create Visitor</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
          <Field label="Visitor Name" required><Input value={unknownVisForm.name} onChange={e=>setUnknownVisForm(p=>({...p,name:e.target.value}))}/></Field>
          <Field label="Company"><Input value={unknownVisForm.company} onChange={e=>setUnknownVisForm(p=>({...p,company:e.target.value}))}/></Field>
          <Field label="Email"><Input value={unknownVisForm.email} onChange={e=>setUnknownVisForm(p=>({...p,email:e.target.value}))} type="email"/></Field>
          <Field label="Phone"><Input value={unknownVisForm.phone} onChange={e=>setUnknownVisForm(p=>({...p,phone:e.target.value}))}/></Field>
          <Field label="Host"><Input value={unknownVisForm.host} onChange={e=>setUnknownVisForm(p=>({...p,host:e.target.value}))}/></Field>
          <Field label="Purpose"><Sel value={unknownVisForm.purpose} onChange={e=>setUnknownVisForm(p=>({...p,purpose:e.target.value}))} options={["Meeting","Interview","Delivery","Maintenance","Audit","Demo","Inspection","Walk-in Denied Attempt"].map(x=>({value:x,label:x}))}/></Field>
          <Field label="From Date"><Input value={unknownVisForm.scheduledFrom} onChange={e=>setUnknownVisForm(p=>({...p,scheduledFrom:e.target.value}))} placeholder="dd/mm/yy"/></Field>
          <Field label="To Date"><Input value={unknownVisForm.scheduledTo} onChange={e=>setUnknownVisForm(p=>({...p,scheduledTo:e.target.value}))} placeholder="dd/mm/yy"/></Field>
        </div>
      </Modal>}
    </div>
  );
}

/** Dial codes shared by Employees + Visitors ({ value: "+971", label: "UAE (+971)" }). */
const COUNTRY_DIAL_OPTIONS = [
    { code:"+93", country:"Afghanistan" }, { code:"+355", country:"Albania" }, { code:"+213", country:"Algeria" }, { code:"+376", country:"Andorra" },
    { code:"+244", country:"Angola" }, { code:"+1-268", country:"Antigua and Barbuda" }, { code:"+54", country:"Argentina" }, { code:"+374", country:"Armenia" },
    { code:"+61", country:"Australia" }, { code:"+43", country:"Austria" }, { code:"+994", country:"Azerbaijan" }, { code:"+1-242", country:"Bahamas" },
    { code:"+973", country:"Bahrain" }, { code:"+880", country:"Bangladesh" }, { code:"+1-246", country:"Barbados" }, { code:"+375", country:"Belarus" },
    { code:"+32", country:"Belgium" }, { code:"+501", country:"Belize" }, { code:"+229", country:"Benin" }, { code:"+975", country:"Bhutan" },
    { code:"+591", country:"Bolivia" }, { code:"+387", country:"Bosnia and Herzegovina" }, { code:"+267", country:"Botswana" }, { code:"+55", country:"Brazil" },
    { code:"+673", country:"Brunei" }, { code:"+359", country:"Bulgaria" }, { code:"+226", country:"Burkina Faso" }, { code:"+257", country:"Burundi" },
    { code:"+855", country:"Cambodia" }, { code:"+237", country:"Cameroon" }, { code:"+1", country:"Canada" }, { code:"+238", country:"Cape Verde" },
    { code:"+236", country:"Central African Republic" }, { code:"+235", country:"Chad" }, { code:"+56", country:"Chile" }, { code:"+86", country:"China" },
    { code:"+57", country:"Colombia" }, { code:"+269", country:"Comoros" }, { code:"+242", country:"Congo" }, { code:"+243", country:"DR Congo" },
    { code:"+506", country:"Costa Rica" }, { code:"+385", country:"Croatia" }, { code:"+53", country:"Cuba" }, { code:"+357", country:"Cyprus" },
    { code:"+420", country:"Czech Republic" }, { code:"+45", country:"Denmark" }, { code:"+253", country:"Djibouti" }, { code:"+1-767", country:"Dominica" },
    { code:"+1-809", country:"Dominican Republic" }, { code:"+593", country:"Ecuador" }, { code:"+20", country:"Egypt" }, { code:"+503", country:"El Salvador" },
    { code:"+240", country:"Equatorial Guinea" }, { code:"+291", country:"Eritrea" }, { code:"+372", country:"Estonia" }, { code:"+251", country:"Ethiopia" },
    { code:"+679", country:"Fiji" }, { code:"+358", country:"Finland" }, { code:"+33", country:"France" }, { code:"+241", country:"Gabon" },
    { code:"+220", country:"Gambia" }, { code:"+995", country:"Georgia" }, { code:"+49", country:"Germany" }, { code:"+233", country:"Ghana" },
    { code:"+30", country:"Greece" }, { code:"+1-473", country:"Grenada" }, { code:"+502", country:"Guatemala" }, { code:"+224", country:"Guinea" },
    { code:"+245", country:"Guinea-Bissau" }, { code:"+592", country:"Guyana" }, { code:"+509", country:"Haiti" }, { code:"+504", country:"Honduras" },
    { code:"+36", country:"Hungary" }, { code:"+354", country:"Iceland" }, { code:"+91", country:"India" }, { code:"+62", country:"Indonesia" },
    { code:"+98", country:"Iran" }, { code:"+964", country:"Iraq" }, { code:"+353", country:"Ireland" }, { code:"+972", country:"Israel" },
    { code:"+39", country:"Italy" }, { code:"+225", country:"Ivory Coast" }, { code:"+1-876", country:"Jamaica" }, { code:"+81", country:"Japan" },
    { code:"+962", country:"Jordan" }, { code:"+7", country:"Kazakhstan" }, { code:"+254", country:"Kenya" }, { code:"+686", country:"Kiribati" },
    { code:"+965", country:"Kuwait" }, { code:"+996", country:"Kyrgyzstan" }, { code:"+856", country:"Laos" }, { code:"+371", country:"Latvia" },
    { code:"+961", country:"Lebanon" }, { code:"+266", country:"Lesotho" }, { code:"+231", country:"Liberia" }, { code:"+218", country:"Libya" },
    { code:"+423", country:"Liechtenstein" }, { code:"+370", country:"Lithuania" }, { code:"+352", country:"Luxembourg" }, { code:"+261", country:"Madagascar" },
    { code:"+265", country:"Malawi" }, { code:"+60", country:"Malaysia" }, { code:"+960", country:"Maldives" }, { code:"+223", country:"Mali" },
    { code:"+356", country:"Malta" }, { code:"+692", country:"Marshall Islands" }, { code:"+222", country:"Mauritania" }, { code:"+230", country:"Mauritius" },
    { code:"+52", country:"Mexico" }, { code:"+691", country:"Micronesia" }, { code:"+373", country:"Moldova" }, { code:"+377", country:"Monaco" },
    { code:"+976", country:"Mongolia" }, { code:"+382", country:"Montenegro" }, { code:"+212", country:"Morocco" }, { code:"+258", country:"Mozambique" },
    { code:"+95", country:"Myanmar" }, { code:"+264", country:"Namibia" }, { code:"+674", country:"Nauru" }, { code:"+977", country:"Nepal" },
    { code:"+31", country:"Netherlands" }, { code:"+64", country:"New Zealand" }, { code:"+505", country:"Nicaragua" }, { code:"+227", country:"Niger" },
    { code:"+234", country:"Nigeria" }, { code:"+850", country:"North Korea" }, { code:"+389", country:"North Macedonia" }, { code:"+47", country:"Norway" },
    { code:"+968", country:"Oman" }, { code:"+92", country:"Pakistan" }, { code:"+680", country:"Palau" }, { code:"+970", country:"Palestine" },
    { code:"+507", country:"Panama" }, { code:"+675", country:"Papua New Guinea" }, { code:"+595", country:"Paraguay" }, { code:"+51", country:"Peru" },
    { code:"+63", country:"Philippines" }, { code:"+48", country:"Poland" }, { code:"+351", country:"Portugal" }, { code:"+974", country:"Qatar" },
    { code:"+40", country:"Romania" }, { code:"+7", country:"Russia" }, { code:"+250", country:"Rwanda" }, { code:"+1-869", country:"Saint Kitts and Nevis" },
    { code:"+1-758", country:"Saint Lucia" }, { code:"+1-784", country:"Saint Vincent and the Grenadines" }, { code:"+685", country:"Samoa" }, { code:"+378", country:"San Marino" },
    { code:"+239", country:"Sao Tome and Principe" }, { code:"+966", country:"Saudi Arabia" }, { code:"+221", country:"Senegal" }, { code:"+381", country:"Serbia" },
    { code:"+248", country:"Seychelles" }, { code:"+232", country:"Sierra Leone" }, { code:"+65", country:"Singapore" }, { code:"+421", country:"Slovakia" },
    { code:"+386", country:"Slovenia" }, { code:"+677", country:"Solomon Islands" }, { code:"+252", country:"Somalia" }, { code:"+27", country:"South Africa" },
    { code:"+82", country:"South Korea" }, { code:"+211", country:"South Sudan" }, { code:"+34", country:"Spain" }, { code:"+94", country:"Sri Lanka" },
    { code:"+249", country:"Sudan" }, { code:"+597", country:"Suriname" }, { code:"+268", country:"Eswatini" }, { code:"+46", country:"Sweden" },
    { code:"+41", country:"Switzerland" }, { code:"+963", country:"Syria" }, { code:"+886", country:"Taiwan" }, { code:"+992", country:"Tajikistan" },
    { code:"+255", country:"Tanzania" }, { code:"+66", country:"Thailand" }, { code:"+228", country:"Togo" }, { code:"+676", country:"Tonga" },
    { code:"+1-868", country:"Trinidad and Tobago" }, { code:"+216", country:"Tunisia" }, { code:"+90", country:"Turkey" }, { code:"+993", country:"Turkmenistan" },
    { code:"+688", country:"Tuvalu" }, { code:"+256", country:"Uganda" }, { code:"+380", country:"Ukraine" }, { code:"+971", country:"UAE" },
    { code:"+44", country:"United Kingdom" }, { code:"+1", country:"United States" }, { code:"+598", country:"Uruguay" }, { code:"+998", country:"Uzbekistan" },
    { code:"+678", country:"Vanuatu" }, { code:"+58", country:"Venezuela" }, { code:"+84", country:"Vietnam" }, { code:"+967", country:"Yemen" },
    { code:"+260", country:"Zambia" }, { code:"+263", country:"Zimbabwe" }
  ].map((x) => ({ value: x.code, label: `${x.country} (${x.code})` }));

/** UAE national digits only (9 chars, paste-friendly: +971-50-186-9287, 050…, spaces). */
function extractUaeNationalDigits(value = "") {
  let d = String(value ?? "")
    .replace(/[\u200E\u200F\u202A-\u202E\uFEFF]/g, "")
    .replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  while (d.startsWith("971") && d.length > 9) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 9);
}

/** Canonical UAE mobile display: 5X-XXX-XXXX (e.g. 50-186-9287), same digits as +971-50-186-9287. */
function formatUaeMobile(value = "") {
  const digits = extractUaeNationalDigits(value);
  if (!digits) return "";
  const normalized = digits.startsWith("5") ? digits.slice(0, 9) : `5${digits.slice(0, 8)}`;
  if (normalized.length <= 2) return normalized;
  if (normalized.length <= 5) return `${normalized.slice(0, 2)}-${normalized.slice(2)}`;
  return `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5, 9)}`;
}

function isUaeMobileNationalValid(value = "") {
  return /^5\d{8}$/.test(extractUaeNationalDigits(value));
}

/* ═══════════════════════════════════════════════════════════════════════
   EMPLOYEES
═══════════════════════════════════════════════════════════════════════ */
// Pure direction helper — module-level so it never causes useMemo churn
function inferLogDirection(l) {
  const dir = String(l?.direction || "").toLowerCase();
  if (dir === "out" || dir === "exit") return "out";
  if (dir === "in"  || dir === "entry") return "in";
  const placement = String(l?.devicePlacement || l?.placement || "").toLowerCase();
  if (placement === "exit")  return "out";
  if (placement === "entry") return "in";
  return (l?.accessGranted ?? l?.granted) ? "in" : "out";
}

function EmployeesPage({ onNav, onEnroll }) {
  const { show } = useToast();

  const EMPLOYEE_TAG_OPTIONS = [
    "Al Wasl POD Access",
    "Al wasl 3 General Access",
    "Sustainability SS05 General Access"
  ];
  const formatDateDMY = (value = "") => {
    const digits = String(value).replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const isoToDMY = (iso = "") => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y.slice(-2)}`;
  };
  const dmyToISO = (dmy = "") => {
    const m = String(dmy).trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return "";
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const normalizePhone = (value = "") => {
    const digits = String(value).replace(/\D/g, "").slice(0, 12);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  };
  const emailOk = (value = "") => /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(String(value).trim());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page,   setPage]   = useState(1);
  const [attDate, setAttDate] = useState(""); // empty = today
  const [sel,    setSel]    = useState(null);
  const [add,    setAdd]    = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [del,    setDel]    = useState(null);
  const [sus,    setSus]    = useState(null);
  const [rst,    setRst]    = useState(null);
  const [syncFaceBusy, setSyncFaceBusy] = useState(false);
  const [form,   setForm]   = useState({
    employeeId:"",
    employeeTag:"Al Wasl POD Access",
    cardId:"",
    name:"",
    company:"",
    companyId:"",
    designation:"",
    department:"",
    division:"",
    accessLevel:"L1 General",
    cardholderStatus:"Active",
    shiftSchedule:"",
    passIssueDate:"",
    passExpiryDate:"",
    email:"",
    countryCode:"+971",
    phone:"",
    lineManager:"",
    lineManagerEmail:"",
    authMode:"Face Only"
  });
  const [touched, setTouched] = useState({});
  const [attemptedAdd, setAttemptedAdd] = useState(false);
  const scanStateRef = useRef({ value: "", firstTs: 0, lastTs: 0, timer: null });
  const PER = 15;
  const baseEmployeeForm = useCallback(() => ({
    employeeId:"",
    employeeTag:"Al Wasl POD Access",
    cardId:"",
    name:"",
    company:"",
    companyId:"",
    designation:"",
    department:"",
    division:"",
    accessLevel:"L1 General",
    cardholderStatus:"Active",
    shiftSchedule:"",
    passIssueDate:"",
    passExpiryDate:"",
    email:"",
    countryCode:"+971",
    phone:"",
    lineManager:"",
    lineManagerEmail:"",
    authMode:"Face Only"
  }), []);
  const markTouched = (k) => setTouched((p) => ({ ...p, [k]: true }));

  const pp = { page, limit:PER, ...(filter!=="all"&&{status:filter}), ...(search&&{search}) };
  const { data, loading, reload } = useFetch(()=>api.employees(pp),[page,filter,search],{employees:[],total:0});
  // Companies list for the Company dropdown on the Add/Edit Employee form.
  const { data: companiesData } = useFetch(()=>api.companies({ limit:1000, status:"active" }), [], { companies:[] });
  const companyOptions = useMemo(() => {
    const list = (companiesData?.companies || []).filter(c => c && c.name);
    return [{ value:"", label:"— Select company —" }, ...list.map(c => ({ value: c.name, label: c.name, _id: String(c._id || "") }))];
  }, [companiesData]);
  const { data:logsData, reload:reloadLogs } = useFetch(()=>api.logs({ limit:100000, sort:"desc" }), [], { logs:[] });
  const todayYmd = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  const selectedYmd = attDate || todayYmd;
  const { data:attendanceData, reload:reloadAttendance } = useFetch(
    () => api.reportAttendance({ dateFrom: selectedYmd, dateTo: selectedYmd }),
    [selectedYmd],
    { people: [] }
  );
  useEffect(() => {
    if (attDate) return; // only auto-refresh when viewing today
    const t = setInterval(() => { reloadLogs(); reloadAttendance(); }, 30000);
    return () => clearInterval(t);
  }, [attDate, reloadLogs, reloadAttendance]);
  const emps = data?.employees||[];
  const attendanceByEmp = useMemo(() => {
    const map = new Map();
    for (const p of (attendanceData?.people || [])) {
      const id = String(p?.employeeId || "").trim();
      const nm = String(p?.employeeName || "").trim().toLowerCase();
      const rec = {
        state: String(p?.status || "").toLowerCase() === "in" ? "in" : "out",
        ts: p?.inTime || p?.outTime || null,
        firstIn: p?.inTime || null,   // first scan of the day
        lastOut: p?.outTime || null,  // last out of the day
        lastIn: p?.inTime || null,    // backend inTime = first in (attendance report)
        inAt: p?.inTime || null,
        outAt: p?.outTime || null,
        totalMin: Number(p?.totalDurationMinutes || 0)
      };
      if (id) map.set(id, rec);
      if (nm) map.set(nm, rec);
    }
    return map;
  }, [attendanceData]);

  const presenceByEmp = useMemo(() => {
    // Filter logs to the selected date (Dubai timezone) so date picker is respected
    const allLogs = logsData?.logs || [];
    const filtered = allLogs.filter(l => {
      const ts = l?.timestamp || l?.ts || l?.createdAt;
      if (!ts) return false;
      const logYmd = new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
      return logYmd === selectedYmd;
    });
    // Sort logs oldest→newest so we process events in time order
    const sorted = [...filtered].sort((a, b) => {
      const ta = new Date(a?.timestamp || a?.ts || a?.createdAt || 0).getTime();
      const tb = new Date(b?.timestamp || b?.ts || b?.createdAt || 0).getTime();
      return ta - tb;
    });

    const map = new Map(); // key → { state, ts, firstIn, lastIn, lastOut, inAt, outAt, inStart, totalMin }

    for (const l of sorted) {
      const id  = String(l?.employeeId || "").trim();
      const nm  = String(l?.employeeName || l?.name || "").trim().toLowerCase();
      const key = id || nm;
      if (!key) continue;

      const direction = inferLogDirection(l);
      const ts = l?.timestamp || l?.ts || l?.createdAt || null;
      const tsMs = ts ? new Date(ts).getTime() : 0;

      if (!map.has(key)) {
        map.set(key, { state: "out", ts: null, firstIn: null, lastIn: null, lastOut: null, inAt: null, outAt: null, inStart: null, totalMin: 0 });
      }
      const rec = map.get(key);

      if (direction === "in") {
        rec.firstIn = rec.firstIn || ts; // first in of the day — never overwrite
        rec.lastIn  = ts;                // last in seen so far
        rec.inAt    = rec.firstIn;       // alias
        rec.inStart = tsMs;
        rec.state   = "in";
        rec.ts      = ts;
      } else {
        rec.lastOut = ts;  // always update to latest out
        rec.outAt   = ts;
        rec.state   = "out";
        rec.ts      = ts;
        if (rec.inStart && tsMs > rec.inStart) {
          rec.totalMin += Math.floor((tsMs - rec.inStart) / 60000);
          rec.inStart = null;
        }
      }
    }

    // If still "in" at query time, accumulate running minutes
    const nowMs = Date.now();
    for (const rec of map.values()) {
      if (rec.state === "in" && rec.inStart) {
        rec.totalMin += Math.floor((nowMs - rec.inStart) / 60000);
      }
    }

    return map;
  }, [logsData, selectedYmd]);
  const presenceOf = useCallback((e) => {
    const keyId = String(e?.employeeId || "").trim();
    const keyNm = String(e?.name || "").trim().toLowerCase();
    const fromAttendance = attendanceByEmp.get(keyId) || attendanceByEmp.get(keyNm);
    if (fromAttendance) return fromAttendance;
    // Only fall back to live logs when viewing today — past dates must show blank if not in attendance report
    const empty = { state:"out", ts:null, firstIn:null, lastIn:null, lastOut:null, inAt:null, outAt:null, totalMin:0 };
    if (attDate) return empty;
    return presenceByEmp.get(keyId) || presenceByEmp.get(keyNm) || empty;
  }, [presenceByEmp, attendanceByEmp, attDate]);
  const employeePhoto = (e) => e?.photo || e?.photoUrl || e?.image || e?.imageUrl || e?.facePhoto || e?.faceImage || e?.snapshot || e?.snapshotUrl || null;
  const toDate = (v) => {
    const m = String(v || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return new Date(`${yyyy}-${m[2]}-${m[1]}T00:00:00`);
  };
  const fieldErrors = useMemo(() => {
    const err = {};
    const req = [
      ["employeeId", "Pass Number is required"],
      ["employeeTag", "Employee Tag is required"],
      ["cardId", "Card Id is required"],
      ["name", "Employee Name is required"],
      ["company", "Company is required"],
      ["designation", "Designation is required"],
      ["department", "Department is required"],
      ["division", "Division is required"],
      ["accessLevel", "Sipass Access Profile is required"],
      ["cardholderStatus", "Cardholder Status is required"],
      ["shiftSchedule", "Shift Schedule is required"],
      ["email", "Email Address is required"],
      ["countryCode", "Country code is required"],
      ["phone", "Phone Number is required"],
      ["lineManager", "Line Manager is required"],
      ["lineManagerEmail", "Line Manager Email Address is required"]
    ];
    for (const [k, msg] of req) {
      if (!String(form[k] || "").trim()) err[k] = msg;
    }
    if (!/^\d{2}\/\d{2}\/(\d{2}|\d{4})$/.test(String(form.passIssueDate || "").trim()) || !dmyToISO(form.passIssueDate)) {
      err.passIssueDate = "Use format dd/mm/yy";
    }
    if (!/^\d{2}\/\d{2}\/(\d{2}|\d{4})$/.test(String(form.passExpiryDate || "").trim()) || !dmyToISO(form.passExpiryDate)) {
      err.passExpiryDate = "Use format dd/mm/yy";
    }
    if (!err.email && !emailOk(form.email)) err.email = "Enter a valid email address";
    if (!err.lineManagerEmail && !emailOk(form.lineManagerEmail)) err.lineManagerEmail = "Enter a valid email address";
    const issueDate = toDate(form.passIssueDate);
    const expiryDate = toDate(form.passExpiryDate);
    if (!err.passIssueDate && !err.passExpiryDate && issueDate && expiryDate && expiryDate <= issueDate) {
      err.passExpiryDate = "Must be later than Pass Issue Date";
    }
    return err;
  }, [form]);
  const hasFormErrors = Object.keys(fieldErrors).length > 0;
  const showFieldError = (k) => (attemptedAdd || touched[k]) ? fieldErrors[k] : "";

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(baseEmployeeForm());
    setTouched({});
    setAttemptedAdd(false);
    setAdd(true);
  }, [baseEmployeeForm]);

  const openEdit = useCallback((e) => {
    const rawPhone = String(e?.phone || "").trim();
    const m = rawPhone.match(/^(\+\d[\d-]*)(?:\s+(.+))?$/);
    const cc = m?.[1] || "+971";
    const localPhone = m?.[2] ? normalizePhone(m[2]) : normalizePhone(rawPhone.replace(/^\+\d[\d-]*/, "").trim());
    setEditingId(String(e?._id || ""));
    setForm({
      employeeId: e?.employeeId || "",
      employeeTag: e?.employeeTag || "Al Wasl POD Access",
      cardId: e?.cardId || e?.cardNo || "",
      name: e?.name || "",
      company: e?.company || "",
      companyId: String(e?.companyId || ""),
      designation: e?.designation || "",
      department: e?.department || e?.dept || "",
      division: e?.division || "",
      accessLevel: e?.accessLevel || "L1 General",
      cardholderStatus: e?.cardholderStatus || "Active",
      shiftSchedule: e?.shiftSchedule || "",
      passIssueDate: e?.passIssueDate || "",
      passExpiryDate: e?.passExpiryDate || "",
      email: e?.email || "",
      countryCode: cc,
      phone: localPhone,
      lineManager: e?.lineManager || "",
      lineManagerEmail: e?.lineManagerEmail || "",
      authMode: e?.authMode || "Face Only"
    });
    setTouched({});
    setAttemptedAdd(false);
    setAdd(true);
  }, []);

  const doAdd = async () => {
    setAttemptedAdd(true);
    if (hasFormErrors) {
      show("All fields are mandatory. Please complete every field before creating employee.", "warning");
      return;
    }
    try {
      const codeMatch = String(form.countryCode || "").match(/\+\d[\d-]*/);
      const normalizedCode = codeMatch ? codeMatch[0] : String(form.countryCode || "").trim();
      const phoneCombined = [normalizedCode || "+971", form.phone].filter(Boolean).join(" ").trim();
      // Resolve companyId from selected company name when present.
      const matchedCompany = (companiesData?.companies || []).find(c => String(c?.name || "") === String(form.company || ""));
      const companyId = matchedCompany?._id ? String(matchedCompany._id) : (form.companyId || "");
      const payload = { ...form, phone: phoneCombined, companyId };
      if (editingId) {
        await api.empUpdate(editingId, payload);
        show("Employee updated","success");
      } else {
        await api.empCreate(payload);
        show("Employee created","success");
      }
      setAdd(false);
      reload();
      setEditingId(null);
      setForm(baseEmployeeForm());
      setTouched({});
      setAttemptedAdd(false);
    }
    catch(e){ show(e.message,"error"); }
  };

  /** API `deviceRevoke` after delete or suspend — readers must get User.Delete via sidecar. */
  const toastDeviceRevoke = (dr, { doneLabel, skippedIntro } = {}) => {
    if (!dr) return;
    if (dr.skipped) {
      const hint =
        dr.reason === "no_sidecar"
          ? " API has no GSDK_SIDECAR_URL — readers were not updated."
          : dr.reason === "no_gateway"
            ? " Set GSDK_GATEWAY (gateway rpc_server :4100) — readers were not updated."
            : "";
      show(`${skippedIntro || doneLabel}.${hint}`, dr.reason === "disabled" ? "success" : "warning");
      return;
    }
    if (dr.attempted && Array.isArray(dr.results)) {
      const failed = dr.results.filter((x) => !x.ok);
      if (failed.length) {
        show(
          `${doneLabel}, but reader revoke failed (${failed.map((f) => f.error || "?").join("; ")}). Check gateway TLS and My Devices sync.`,
          "warning"
        );
      } else {
        show(`${doneLabel} — access removed on reader(s).`, "success");
      }
    }
  };
  /** API `deviceRestore` after activate/restore — readers should get face/user back via sidecar push-face. */
  const toastDeviceRestore = (dr, { doneLabel } = {}) => {
    if (!dr) return;
    if (dr.skipped) {
      const hint =
        dr.reason === "no_photo"
          ? " No stored enrollment photo found; run Face Enroll once, then Sync face to readers."
          : dr.reason === "no_sidecar"
            ? " API has no GSDK_SIDECAR_URL — readers were not updated."
            : dr.reason === "no_gateway"
              ? " Set GSDK_GATEWAY (gateway rpc_server :4100) — readers were not updated."
              : "";
      show(`${doneLabel}.${hint}`, dr.reason === "no_photo" ? "warning" : "error");
      return;
    }
    if (dr.attempted && Array.isArray(dr.results)) {
      const okN = dr.results.filter((x) => x.ok).length;
      const failed = dr.results.filter((x) => !x.ok);
      if (okN > 0 && failed.length === 0) {
        show(`${doneLabel} — restored on ${okN} reader(s).`, "success");
        return;
      }
      if (okN > 0) {
        show(`${doneLabel} — restored on ${okN} reader(s), but ${failed.length} failed. Check gateway TLS and My Devices sync.`, "warning");
        return;
      }
      show(`${doneLabel}, but reader restore failed. Check gateway/sidecar health and Sync face to readers.`, "warning");
    }
  };

  const doDel = async id => {
    try {
      const r = await api.empDelete(id);
      const dr = r?.deviceRevoke;
      if (dr) toastDeviceRevoke(dr, { doneLabel: "Removed from database", skippedIntro: "Removed from database" });
      else show("Deleted", "success");
      setDel(null);
      setSel(null);
      reload();
    } catch (e) {
      show(e.message, "error");
    }
  };

  const empIsSuspended = (e) =>
    String(e?.status || "").toLowerCase() === "suspended" ||
    String(e?.cardholderStatus || "").toLowerCase() === "suspended";
  const empIsActive = (e) =>
    String(e?.status || "").toLowerCase() === "active" &&
    String(e?.cardholderStatus || "").toLowerCase() === "active";

  const doSuspend = async id => {
    try {
      const r = await api.empUpdate(id, { status: "suspended", cardholderStatus: "Suspended" });
      if (r?.deviceRevoke != null) toastDeviceRevoke(r.deviceRevoke, { doneLabel: "Suspended", skippedIntro: "Suspended" });
      else show("Saved.", "success");
      setSus(null);
      setSel(null);
      reload();
    } catch (e) {
      show(e.message, "error");
    }
  };

  const doRestore = async id => {
    try {
      const r = await api.empUpdate(id, { status: "active", cardholderStatus: "Active" });
      if (r?.deviceRestore != null) toastDeviceRestore(r.deviceRestore, { doneLabel: "Restored to active" });
      else show("Restored to active.", "success");
      setRst(null);
      setSel(null);
      reload();
    } catch (e) {
      show(e.message, "error");
    }
  };
  const doActivate = async id => {
    try {
      const r = await api.empUpdate(id, { status: "active", cardholderStatus: "Active" });
      if (r?.deviceRestore != null) toastDeviceRestore(r.deviceRestore, { doneLabel: "Employee marked active" });
      else show("Employee marked active.", "success");
      setSel(null);
      reload();
    } catch (e) {
      show(e.message, "error");
    }
  };

  const doSyncFaceReaders = async () => {
    if (!sel?._id || syncFaceBusy) return;
    setSyncFaceBusy(true);
    try {
      const r = await api.empSyncFace(sel._id);
      const dp = r?.devicePush;
      const okN = dp?.results?.filter?.((x) => x.ok)?.length ?? 0;
      const tot = dp?.results?.length ?? 0;
      if (okN > 0) {
        show(`Face template synced to ${okN}/${tot || okN} reader(s). Test access at the terminal.`, "success");
      } else if (dp?.note) {
        show(dp.note, "warning");
      } else {
        const err = dp?.results?.find?.((x) => !x.ok)?.error;
        show(err || "No reader accepted the template — verify GSDK_GATEWAY, sidecar, and device Sync.", "warning");
      }
    } catch (e) {
      show(e.message || "Sync failed", "error");
    } finally {
      setSyncFaceBusy(false);
    }
  };

  useEffect(() => {
    if (!add) return undefined;

    const flushScan = () => {
      const st = scanStateRef.current;
      const raw = String(st.value || "").trim();
      const firstTs = st.firstTs || 0;
      const lastTs = st.lastTs || 0;
      const elapsed = firstTs && lastTs ? Math.max(0, lastTs - firstTs) : 0;
      const isLikelyScanner = raw.length >= 6 && elapsed <= Math.max(250, raw.length * 45);
      st.value = "";
      st.firstTs = 0;
      st.lastTs = 0;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      if (!raw || !isLikelyScanner) return;
      setForm((prev) => ({ ...prev, cardId: raw }));
    };

    const onKeyDown = (ev) => {
      if (!add) return;
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

      const st = scanStateRef.current;
      const now = Date.now();
      if (st.lastTs && now - st.lastTs > 120) {
        st.value = "";
        st.firstTs = 0;
      }
      st.lastTs = now;

      if (ev.key === "Enter" || ev.key === "Tab") {
        flushScan();
        return;
      }

      if (ev.key === "Backspace") {
        st.value = st.value.slice(0, -1);
      } else if (ev.key.length === 1) {
        if (!st.firstTs) st.firstTs = now;
        st.value += ev.key;
      } else {
        return;
      }

      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(flushScan, 90);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const st = scanStateRef.current;
      st.value = "";
      st.firstTs = 0;
      st.lastTs = 0;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
    };
  }, [add]);
  useEffect(() => {
    if (add) return;
    setTouched({});
    setAttemptedAdd(false);
  }, [add]);

  return (
    <div>
      <PageHeader title="Employees" sub={`${fNum(data?.total||0)} registered`}
        action={<Btn onClick={openCreate} icon="+">Add Employee</Btn>}/>
      <div style={{ display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center" }}>
        <SearchBar value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Name, pass no, card id, department, division…" style={{ flex:"1 1 200px" }}/>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["active","Active"],["enrolled","Enrolled"],["pending","Not Enrolled"],["suspended","Suspended"]].map(([v,l])=>(
            <button
              key={v}
              onClick={()=>{setFilter(v);setPage(1);}}
              style={{
                padding:"7px 11px",
                fontSize:12,
                fontWeight:600,
                background:filter===v?TH.blue:"transparent",
                color:filter===v?"#fff":TH.muted,
                border:"none",
                cursor:"pointer",
                whiteSpace:"nowrap"
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ display:"flex",gap:6,alignItems:"center" }}>
          <span style={{ fontSize:11,color:TH.muted,whiteSpace:"nowrap" }}>Attendance Date:</span>
          <input
            type="date"
            value={attDate}
            max={todayYmd}
            onChange={e=>{ setAttDate(e.target.value); }}
            style={{ background:TH.surface,border:`1px solid ${TH.border}`,borderRadius:8,padding:"5px 10px",
              fontSize:12,color:TH.text,outline:"none",fontFamily:TH.mono,cursor:"pointer" }}
          />
          {attDate && <Btn v="ghost" sz="xs" onClick={()=>setAttDate("")}>Today</Btn>}
        </div>
        <Btn v="ghost" sz="xs" onClick={()=>{reload();reloadLogs();reloadAttendance();}}>⟳ Refresh</Btn>
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Employee","Company","Designation","Department","Card","Status","Presence","Attendance","Enrolled","Last Seen","Actions"]} onRow={r=>setSel(r.e)}
          rows={emps.map(e=>({ key:e._id,e, cells:[
            <div style={{ display:"flex",gap:11,alignItems:"center",minWidth:220 }}>
              {employeePhoto(e)
                ? <img src={employeePhoto(e)} alt={e.name}
                    style={{ width:56,height:64,borderRadius:9,objectFit:"cover",objectPosition:"top center",
                      flexShrink:0,border:`2px solid ${e.enrolled?TH.green:TH.blue}66`,
                      boxShadow:`0 3px 12px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.3)` }}/>
                : <div style={{ width:56,height:64,borderRadius:9,flexShrink:0,
                    background:`linear-gradient(135deg,${e.enrolled?TH.green:TH.blue}28 0%,${e.enrolled?TH.green:TH.blue}0a 100%)`,
                    border:`2px solid ${e.enrolled?TH.green:TH.blue}55`,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:20,fontWeight:700,color:e.enrolled?TH.green:TH.blue,fontFamily:TH.mono }}>
                    {(e.name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}
                  </div>
              }
              <div style={{ minWidth:0,flex:1 }}>
                <div style={{ fontWeight:700,fontSize:13,color:TH.text,lineHeight:1.35,wordBreak:"break-word" }}>{e.name}</div>
                <code style={{ fontSize:10,color:TH.cyan,letterSpacing:".3px",display:"block",marginTop:3 }}>{e.employeeId||""}</code>
                <div style={{ fontSize:10,color:TH.muted,marginTop:1 }}>{e.cardId?`Card: ${e.cardId}`:"No card"}</div>
              </div>
            </div>,
            <span style={{ fontSize:12,color:TH.text }}>{e.company||"—"}</span>,
            e.designation||"—",
            e.department||"—",
            <div style={{ display:"flex",flexDirection:"column",gap:4,alignItems:"flex-start" }}>
              <span style={{ fontSize:11,fontFamily:TH.mono }}>{e.cardId||"—"}</span>
              <Badge color={String(e.cardholderStatus||"").toLowerCase()==="active"?"green":"gray"} sm>{e.cardholderStatus||"—"}</Badge>
            </div>,
            stBadge(e.status||"active"),
            presenceOf(e).state==="in" ? <Badge color="green" sm>In</Badge> : <Badge color="gray" sm>Out</Badge>,
            (() => {
              const pr = presenceOf(e);
              const totalMin = pr.totalMin || 0;
              const durLabel = totalMin > 0
                ? `${Math.floor(totalMin/60)}h ${totalMin%60}m`
                : pr.state==="in" && pr.firstIn
                  ? fDur(pr.firstIn)
                  : "—";
              return (
                <div style={{ display:"flex",flexDirection:"column",gap:4,minWidth:130 }}>
                  <div style={{ display:"flex",gap:5,alignItems:"center" }}>
                    <span style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono,minWidth:44 }}>1st In</span>
                    <span style={{ fontSize:11,fontWeight:600,color:pr.firstIn?TH.green:TH.muted,fontFamily:TH.mono }}>{pr.firstIn?fT(pr.firstIn):"—"}</span>
                  </div>
                  <div style={{ display:"flex",gap:5,alignItems:"center" }}>
                    <span style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono,minWidth:44 }}>Last Out</span>
                    <span style={{ fontSize:11,fontWeight:600,color:pr.lastOut?TH.amber:TH.muted,fontFamily:TH.mono }}>{pr.lastOut?fT(pr.lastOut):"—"}</span>
                  </div>
                  <div style={{ display:"flex",gap:5,alignItems:"center" }}>
                    <span style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono,minWidth:44 }}>Total</span>
                    <span style={{ fontSize:11,fontWeight:700,color:totalMin>0?TH.blue:TH.muted,fontFamily:TH.mono }}>{durLabel}</span>
                  </div>
                </div>
              );
            })(),
            e.enrolled?<Badge color="green" sm>✓</Badge>:<Badge color="gray" sm>Pending</Badge>,
            (() => { const pr=presenceOf(e); const ls=pr.ts||pr.lastOut||pr.lastIn||e.lastSeen||null; return <span style={{ fontSize:11,color:ls?TH.text:TH.muted }}>{ls?fRel(ls):"Never"}</span>; })(),
            <div onClick={(ev) => ev.stopPropagation()}>
              <select
                defaultValue=""
                onChange={(ev) => {
                  const action = ev.target.value;
                  if (!action) return;
                  if (action === "edit") openEdit(e);
                  if (action === "enroll") onEnroll?.(e);
                  if (action === "footprints") onNav("footprints");
                  if (action === "activate") doActivate(e._id);
                  if (action === "suspend") setSus(e._id);
                  if (action === "restore") setRst(e._id);
                  if (action === "delete") setDel(e._id);
                  ev.target.value = "";
                }}
                style={{ padding:"6px 8px",borderRadius:8,fontSize:12,background:TH.surface,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",minWidth:118 }}
              >
                <option value="">Actions...</option>
                <option value="edit">Edit</option>
                <option value="enroll">Face Enroll</option>
                <option value="footprints">View Footprints</option>
                {!empIsActive(e) && <option value="activate">Activate</option>}
                {!empIsSuspended(e) ? <option value="suspend">Suspend</option> : <option value="restore">Restore</option>}
                <option value="delete">Delete</option>
              </select>
            </div>
          ]}))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>

      {sel&&<Modal title={sel.name} onClose={()=>setSel(null)} footer={<div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
        <Btn sz="sm" onClick={()=>{ onEnroll?.(sel); setSel(null); }}>📷 Enroll</Btn>
        <Btn v="secondary" sz="sm" loading={syncFaceBusy} onClick={doSyncFaceReaders} title="Push stored enrollment photo to Suprema readers via gateway">
          ◈ Sync face to readers
        </Btn>
        <Btn v="secondary" sz="sm" onClick={()=>{setSel(null);onNav("footprints");}}>👣 Footprints</Btn>
        {!empIsActive(sel) && (
          <Btn v="success" sz="sm" onClick={()=>{ doActivate(sel._id); }}>✔ Activate</Btn>
        )}
        {!empIsSuspended(sel) && (
          <Btn v="amber" sz="sm" title="Remove access on all readers immediately" onClick={()=>{ setSus(sel._id); setSel(null); }}>⏸ Suspend</Btn>
        )}
        {empIsSuspended(sel) && (
          <Btn v="success" sz="sm" onClick={()=>{ setRst(sel._id); setSel(null); }}>↩ Restore</Btn>
        )}
        <Btn v="destructive" sz="sm" onClick={()=>{setDel(sel._id);setSel(null);}}>Delete</Btn>
      </div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["Pass Number",sel.employeeId||sel._id],["Card Id (CSN)",sel.cardId||sel.cardNo],["Employee Name",sel.name],["Company",sel.company],["Designation",sel.designation],["Department",sel.department],["Division",sel.division],["Access Level",sel.accessLevel],["Cardholder Status",sel.cardholderStatus],["Shift Schedule",sel.shiftSchedule],["Pass Issue Date",sel.passIssueDate],["Pass Expiry Date",sel.passExpiryDate],["Email Address",sel.email],["Phone Number",sel.phone],["Line Manager",sel.lineManager],["Auth Mode",sel.authMode],["Face Score",sel.faceScore?`${sel.faceScore}%`:"—"],["Status",sel.status],["Presence",presenceOf(sel).state==="in"?"In":"Out"],["In Time",fDT(presenceOf(sel).inAt)],["Out Time",fDT(presenceOf(sel).outAt)],["Duration",(()=>{ const pr=presenceOf(sel); const tm=pr.totalMin||0; return tm>0 ? `${Math.floor(tm/60)}h ${tm%60}m` : pr.state==="in" && pr.inAt ? fDur(pr.inAt) : "—"; })()],["Presence Updated",presenceOf(sel).ts?fRel(presenceOf(sel).ts):"—"],["Enrolled At",fD(sel.enrolledAt)],["Last Seen",fRel(sel.lastSeen)],["Created",fD(sel.createdAt)]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
      </Modal>}

      {add&&<Modal title={editingId ? "Edit Employee" : "Add Employee"} onClose={()=>{ setAdd(false); setEditingId(null); }} footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>{ setAdd(false); setEditingId(null); }}>Cancel</Btn><Btn onClick={doAdd} disabled={hasFormErrors}>{editingId ? "Save Changes" : "Create Employee"}</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="Pass Number" error={showFieldError("employeeId")}><Input value={form.employeeId} onChange={e=>setForm(p=>({...p,employeeId:e.target.value}))} onBlur={()=>markTouched("employeeId")} placeholder="PASS-00001" style={showFieldError("employeeId") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Employee Tag" error={showFieldError("employeeTag")}><Sel value={form.employeeTag} onChange={e=>setForm(p=>({...p,employeeTag:e.target.value}))} onBlur={()=>markTouched("employeeTag")} style={showFieldError("employeeTag") ? { borderColor:TH.red } : {}} options={EMPLOYEE_TAG_OPTIONS.map(t=>({ value:t, label:t }))}/></Field>
          <Field label="Card Id (CSN)" hint={!showFieldError("cardId") ? "Tap card on USB reader to auto-fill" : ""} error={showFieldError("cardId")}><Input value={form.cardId} onChange={e=>setForm(p=>({...p,cardId:e.target.value}))} onBlur={()=>markTouched("cardId")} placeholder="Card serial number" style={showFieldError("cardId") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Employee Name" required error={showFieldError("name")}><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} onBlur={()=>markTouched("name")} placeholder="Employee name" style={showFieldError("name") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Company" hint={!showFieldError("company") ? "Add companies under People → Companies" : ""} error={showFieldError("company")}>
            <Sel
              value={form.company}
              onChange={e=>{
                const name = e.target.value;
                const matched = (companiesData?.companies || []).find(c => String(c?.name || "") === name);
                setForm(p=>({ ...p, company: name, companyId: matched?._id ? String(matched._id) : "" }));
              }}
              onBlur={()=>markTouched("company")}
              style={showFieldError("company") ? { borderColor:TH.red } : {}}
              options={companyOptions}
            />
          </Field>
          <Field label="Designation" error={showFieldError("designation")}><Input value={form.designation} onChange={e=>setForm(p=>({...p,designation:e.target.value}))} onBlur={()=>markTouched("designation")} placeholder="Job title" style={showFieldError("designation") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Department" error={showFieldError("department")}><Input value={form.department} onChange={e=>setForm(p=>({...p,department:e.target.value}))} onBlur={()=>markTouched("department")} placeholder="Engineering" style={showFieldError("department") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Division" error={showFieldError("division")}><Input value={form.division} onChange={e=>setForm(p=>({...p,division:e.target.value}))} onBlur={()=>markTouched("division")} placeholder="Operations" style={showFieldError("division") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Sipass Access Profile" error={showFieldError("accessLevel")}><Sel value={form.accessLevel} onChange={e=>setForm(p=>({...p,accessLevel:e.target.value}))} onBlur={()=>markTouched("accessLevel")} style={showFieldError("accessLevel") ? { borderColor:TH.red } : {}} options={["L1 General","L2 Restricted","L3 Confidential","L4 Classified"].map(l=>({value:l,label:l}))}/></Field>
          <Field label="Cardholder Status" error={showFieldError("cardholderStatus")}><Sel value={form.cardholderStatus} onChange={e=>setForm(p=>({...p,cardholderStatus:e.target.value}))} onBlur={()=>markTouched("cardholderStatus")} style={showFieldError("cardholderStatus") ? { borderColor:TH.red } : {}} options={["Active","Inactive","Suspended","Expired"].map(s=>({value:s,label:s}))}/></Field>
          <Field label="Shift Schedule" error={showFieldError("shiftSchedule")}><Input value={form.shiftSchedule} onChange={e=>setForm(p=>({...p,shiftSchedule:e.target.value}))} onBlur={()=>markTouched("shiftSchedule")} placeholder="Day Shift" style={showFieldError("shiftSchedule") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Pass Issue Date" error={showFieldError("passIssueDate")}>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 42px",gap:8 }}>
              <Input value={form.passIssueDate} onChange={e=>setForm(p=>({...p,passIssueDate:formatDateDMY(e.target.value)}))} onBlur={()=>markTouched("passIssueDate")} placeholder="dd/mm/yy" pattern="\d{2}/\d{2}/\d{2}" style={showFieldError("passIssueDate") ? { borderColor:TH.red } : {}}/>
              <input
                type="date"
                value={dmyToISO(form.passIssueDate)}
                onChange={e=>setForm(p=>({...p,passIssueDate:isoToDMY(e.target.value)}))}
                onBlur={()=>markTouched("passIssueDate")}
                style={{ width:"100%",padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${showFieldError("passIssueDate") ? TH.red : TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
              />
            </div>
          </Field>
          <Field label="Pass Expiry Date" error={showFieldError("passExpiryDate")}>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 42px",gap:8 }}>
              <Input value={form.passExpiryDate} onChange={e=>setForm(p=>({...p,passExpiryDate:formatDateDMY(e.target.value)}))} onBlur={()=>markTouched("passExpiryDate")} placeholder="dd/mm/yy" pattern="\d{2}/\d{2}/\d{2}" style={showFieldError("passExpiryDate") ? { borderColor:TH.red } : {}}/>
              <input
                type="date"
                value={dmyToISO(form.passExpiryDate)}
                onChange={e=>setForm(p=>({...p,passExpiryDate:isoToDMY(e.target.value)}))}
                onBlur={()=>markTouched("passExpiryDate")}
                style={{ width:"100%",padding:"9px 8px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${showFieldError("passExpiryDate") ? TH.red : TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}
              />
            </div>
          </Field>
          <Field label="Email Address" error={showFieldError("email")}><Input value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} onBlur={()=>markTouched("email")} type="email" placeholder="user@company.com" style={showFieldError("email") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Phone Number" error={showFieldError("countryCode") || showFieldError("phone")}>
            <div style={{ display:"grid",gridTemplateColumns:"170px 1fr",gap:8 }}>
              <div>
                <input
                  list="country-codes"
                  value={form.countryCode}
                  onChange={e=>setForm(p=>({...p,countryCode:e.target.value}))}
                  onBlur={()=>markTouched("countryCode")}
                  placeholder="Search country/code"
                  style={{ width:"100%",padding:"9px 12px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${showFieldError("countryCode") ? TH.red : TH.border}`,color:TH.text,outline:"none" }}
                />
                <datalist id="country-codes">
                  {COUNTRY_DIAL_OPTIONS.map((c) => <option key={`${c.value}-${c.label}`} value={c.value}>{c.label}</option>)}
                </datalist>
              </div>
              <Input value={form.phone} onChange={e=>setForm(p=>({...p,phone:normalizePhone(e.target.value)}))} onBlur={()=>markTouched("phone")} placeholder="501-234-567" style={showFieldError("phone") ? { borderColor:TH.red } : {}}/>
            </div>
          </Field>
          <Field label="Line Manager" error={showFieldError("lineManager")}><Input value={form.lineManager} onChange={e=>setForm(p=>({...p,lineManager:e.target.value}))} onBlur={()=>markTouched("lineManager")} placeholder="Manager name" style={showFieldError("lineManager") ? { borderColor:TH.red } : {}}/></Field>
          <Field label="Line Manager Email Address" error={showFieldError("lineManagerEmail")}><Input value={form.lineManagerEmail} onChange={e=>setForm(p=>({...p,lineManagerEmail:e.target.value}))} onBlur={()=>markTouched("lineManagerEmail")} type="email" placeholder="manager@company.com" style={showFieldError("lineManagerEmail") ? { borderColor:TH.red } : {}}/></Field>
        </div>
      </Modal>}

      {del&&<Confirm title="Delete Employee" message="Permanently removes this employee and enrollment data, and deletes their user from all Suprema readers (when gateway/sidecar are configured)." onConfirm={()=>doDel(del)} onCancel={()=>setDel(null)}/>}
      {sus&&<Confirm title="Suspend access" message="Sets this employee to Suspended and removes their face/user from all readers immediately. They remain in the database and can be restored later." onConfirm={()=>doSuspend(sus)} onCancel={()=>setSus(null)}/>}
      {rst&&<Confirm title="Restore employee" message="Marks this employee as Active again. If they need door access, sync or re-enroll their face to readers." onConfirm={()=>doRestore(rst)} onCancel={()=>setRst(null)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FACE ENROLLMENT — Claude Vision AI
═══════════════════════════════════════════════════════════════════════ */
function EnrollmentPage({ preselectedEmployee, onNav }) {
  const { show } = useToast();
  const [step,   setStep]   = useState("select");
  const [emp,    setEmp]    = useState(null);
  const [photos, setPhotos] = useState([]);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy,   setBusy]   = useState(false);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [enrollProgress, setEnrollProgress] = useState({ pct: 0, label: "" });
  const [bulkItems, setBulkItems] = useState([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0, label: "" });
  const [bulkSheetRows, setBulkSheetRows] = useState([]);
  const [bulkSheetName, setBulkSheetName] = useState("");
  const [search, setSearch] = useState("");
  const fileRef = useRef(null);
  const bulkFileRef = useRef(null);
  const bulkSheetRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });

  const { data, loading } = useFetch(()=>api.employees({limit:10000,search}),[search],{employees:[]}); // show all employees for enrollment
  const emps = data?.employees||[];
  const employeePhoto = (e) => e?.photo || e?.photoUrl || e?.image || e?.imageUrl || e?.facePhoto || e?.faceImage || e?.snapshot || e?.snapshotUrl || null;

  const activePhoto = photos[activePhotoIdx] || null;
  const currentResult = result?.allResults?.find((r) => r._photoIdx === activePhotoIdx) || result;
  const verdictRank = (v) => ({ APPROVE: 4, CONDITIONAL: 3, REJECT: 2, FRAUD: 1 }[String(v || "").toUpperCase()] || 0);
  const scoreOf = (r) => Number(r?.qualityScore || 0) + Number(r?.livenessScore || 0) + Number(r?.depthScore || 0);
  const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const consensusFrom = (results = []) => {
    const ranked = [...results].sort((a, b) => {
      const vr = verdictRank(b.verdict) - verdictRank(a.verdict);
      if (vr !== 0) return vr;
      return scoreOf(b) - scoreOf(a);
    });
    const top = ranked.slice(0, Math.min(3, ranked.length));
    const weights = [0.5, 0.3, 0.2];
    const verdictScore = (v) => ({ APPROVE: 1, CONDITIONAL: 0.65, REJECT: 0.25, FRAUD: 0 }[String(v || "").toUpperCase()] ?? 0.2);
    let wTotal = 0;
    let passScore = 0;
    let q = 0;
    let l = 0;
    let d = 0;
    let real = 0;
    let centered = 0;
    let eyes = 0;
    let fraudVotes = 0;
    top.forEach((r, i) => {
      const w = weights[i] || 0.1;
      wTotal += w;
      passScore += verdictScore(r.verdict) * w;
      q += Number(r?.qualityScore || 0) * w;
      l += Number(r?.livenessScore || 0) * w;
      d += Number(r?.depthScore || 0) * w;
      real += (r?.isRealHuman ? 1 : 0) * w;
      centered += (r?.faceCentered ? 1 : 0) * w;
      eyes += (r?.eyesVisible ? 1 : 0) * w;
      if (String(r?.verdict || "").toUpperCase() === "FRAUD" || r?.isFakeDetected) fraudVotes += w;
    });
    const safeDiv = (n) => (wTotal ? n / wTotal : 0);
    const qualityScore = Math.round(safeDiv(q));
    const livenessScore = Math.round(safeDiv(l));
    const depthScore = Math.round(safeDiv(d));
    const passRatio = safeDiv(passScore);
    const blended = (passRatio * 100 * 0.55) + (qualityScore * 0.2) + (livenessScore * 0.15) + (depthScore * 0.1);
    const consensusConfidence = clampPct(blended - (fraudVotes >= 0.45 ? 35 : 0));
    let verdict = "APPROVE";
    let recommendation = "High confidence across top frames.";
    if (fraudVotes >= 0.45) {
      verdict = "FRAUD";
      recommendation = "Spoof/fraud indicators detected across frames.";
    } else if (passRatio >= 0.78 && qualityScore >= 78 && livenessScore >= 74 && depthScore >= 70) {
      verdict = "APPROVE";
      recommendation = "Face quality is strong and consistent across top frames.";
    } else if (passRatio >= 0.56) {
      verdict = "CONDITIONAL";
      recommendation = "Face is usable but improve lighting/angle for stronger accuracy.";
    } else {
      verdict = "REJECT";
      recommendation = "Low confidence across top frames. Retake with frontal, well-lit photos.";
    }
    const topOne = top[0] || ranked[0] || {};
    return {
      ...topOne,
      verdict,
      recommendation,
      qualityScore,
      livenessScore,
      depthScore,
      isRealHuman: safeDiv(real) >= 0.6,
      faceCentered: safeDiv(centered) >= 0.6,
      eyesVisible: safeDiv(eyes) >= 0.6,
      isFakeDetected: fraudVotes >= 0.45,
      allResults: ranked,
      analyzedPhotos: ranked.length,
      consensusTopN: top.length,
      consensusConfidence
    };
  };
  const getConfidence = (r) => {
    if (!r) return null;
    if (r?.consensusConfidence != null) return clampPct(r.consensusConfidence);
    const verdictWeight = ({ APPROVE: 1, CONDITIONAL: 0.68, REJECT: 0.3, FRAUD: 0.05 }[String(r?.verdict || "").toUpperCase()] ?? 0.4);
    const avg = (Number(r?.qualityScore || 0) + Number(r?.livenessScore || 0) + Number(r?.depthScore || 0)) / 3;
    const base = (avg * 0.7) + (verdictWeight * 30);
    return clampPct(base);
  };
  const confidencePct = getConfidence(currentResult);
  const confidenceColor = confidencePct >= 80 ? "green" : confidencePct >= 60 ? "amber" : "red";
  const getImageHash = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = 9;
        const h = 8;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve("");
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        const g = [];
        for (let i = 0; i < data.length; i += 4) {
          g.push((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114));
        }
        let bits = "";
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w - 1; x++) {
            const a = g[y * w + x];
            const b = g[y * w + x + 1];
            bits += a > b ? "1" : "0";
          }
        }
        resolve(bits);
      } catch {
        resolve("");
      }
    };
    img.onerror = () => resolve("");
    img.src = src;
  });
  const hashDistance = (a = "", b = "") => {
    if (!a || !b || a.length !== b.length) return 999;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  };
  const downloadPhoto = (photo, idx = 0) => {
    const src = photo?.enhancedSrc || photo?.src;
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    const safeName = String(emp?.name || "employee").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    a.download = `${safeName || "employee"}-photo-${idx + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const enhancePhotoLocal = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const MAX = 800;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.filter = "contrast(1.12) brightness(1.06) saturate(1.04)";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
  const makeSupremaCompatiblePhoto = (src, mode = "balanced") => new Promise((resolve, reject) => {
    if (!src) return reject(new Error("No photo source"));
    const img = new Image();
    // Enable CORS so canvas.toDataURL works on external URLs (./image/, https://, etc.)
    if (typeof src === "string" && !src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const maxByMode = mode === "safe" ? 640 : 900;
        const qualityByMode = mode === "safe" ? 0.92 : 0.9;
        const scale = Math.min(1, maxByMode / Math.max(img.width, img.height));
        canvas.width = Math.max(256, Math.round(img.width * scale));
        canvas.height = Math.max(256, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.filter = mode === "safe" ? "none" : "contrast(1.04) brightness(1.02)";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/jpeg", qualityByMode));
        } catch (taintedErr) {
          // CORS-blocked image — canvas is tainted, can't read pixels.
          // Bulk: download via fetch as blob then convert (works if server allows fetch).
          if (typeof src === "string" && !src.startsWith("data:")) {
            fetch(src, { mode: "cors", credentials: "omit" })
              .then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
              .then(blob => new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload  = () => res(fr.result);
                fr.onerror = () => rej(fr.error);
                fr.readAsDataURL(blob);
              }))
              .then(dataUrl => makeSupremaCompatiblePhoto(dataUrl, mode).then(resolve).catch(reject))
              .catch(err => reject(new Error(`Photo CORS error: ${err.message}. Host the photo from same origin or enable CORS.`)));
          } else {
            reject(taintedErr);
          }
        }
      } catch (drawErr) {
        reject(drawErr);
      }
    };
    img.onerror = () => reject(new Error(`Could not load photo from ${typeof src === "string" ? src.slice(0,80) : "source"}`));
    img.src = src;
  });
  const parseBulkEmployeeToken = (name = "") =>
    String(name || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_\-\s]+/g, " ")
      .trim()
      .toLowerCase();
  const mapBulkTokenToEmployee = (token, list = []) => {
    const t = String(token || "").trim().toLowerCase();
    if (!t) return null;
    return (
      list.find((e) => String(e?.employeeId || "").trim().toLowerCase() === t) ||
      list.find((e) => String(e?.name || "").trim().toLowerCase() === t) ||
      null
    );
  };
  const toBase64 = (buf) => {
    try {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    } catch {
      return "";
    }
  };
  const normalizeSheetPhotoDataUrl = (raw = "") => {
    const txt = String(raw || "").trim();
    if (!txt) return "";
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(txt)) return txt;
    if (/^https?:\/\//i.test(txt)) return txt;
    const stripped = txt.replace(/^base64,?/i, "").replace(/\s+/g, "");
    if (!stripped) return "";
    return `data:image/jpeg;base64,${stripped}`;
  };
  const readEmbeddedPhotosFromSheet = async (buf) => {
    try {
      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets?.[0];
      if (!ws || typeof ws.getImages !== "function") return new Map();
      const out = new Map();
      const imgs = ws.getImages();
      for (const img of imgs || []) {
        const rowNo = Number((img?.range?.tl?.nativeRow ?? img?.range?.tl?.row ?? -1)) + 1;
        if (rowNo <= 1) continue;
        const media = typeof wb.getImage === "function" ? wb.getImage(img.imageId) : null;
        const ext = String(media?.extension || "jpeg").toLowerCase();
        let b64 = "";
        if (typeof media?.base64 === "string" && media.base64) {
          b64 = media.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, "");
        } else if (media?.buffer) {
          b64 = toBase64(media.buffer);
        }
        if (!b64) continue;
        out.set(rowNo, `data:image/${ext};base64,${b64}`);
      }
      return out;
    } catch {
      return new Map();
    }
  };
  const normalizeBulkEmployeePayload = (r = {}) => {
    // Support compact format: SN | Name | Employee Number | Card Number | Image URL
    // and the original expanded format — all columns optional except Employee Number + Name.
    const employeeId = String(
      r["Employee Number"] || r.employeeId || r.passNumber || r.pass_no || r["Pass Number"] || ""
    ).trim();
    const name = String(
      r["Name"] || r.employeeName || r.name || r["Employee Name"] || ""
    ).trim();
    const cardId = String(
      r["Card Number"] || r.cardId || r.cardNumber || r.card || r["Card ID (CSN)"] || ""
    ).trim();
    const imageUrl = String(
      r["Image URL"] || r.imageUrl || r.imageURL || r.photoUrl || ""
    ).trim();
    return {
      employeeId,
      name,
      _imageUrl: imageUrl,           // kept for readBulkSheet photo resolution
      employeeTag: String(r.employeeTag || r["Employee Tag"] || "Al Wasl POD Access").trim() || "Al Wasl POD Access",
      cardId,
      company: String(r.company || r["Company"] || r["Company Name"] || "").trim(),
      designation: String(r.designation || r["Designation"] || "").trim(),
      division: String(r.division || r["Division"] || "").trim(),
      department: String(r.department || r.dept || r["Department"] || "").trim(),
      accessLevel: String(r.accessLevel || r["SIPAS Access Profile"] || r["Access Level"] || "L1 General").trim() || "L1 General",
      cardholderStatus: String(r.cardholderStatus || r.status || r["Cardholder Status"] || "Active").trim() || "Active",
      shiftSchedule: String(r.shiftSchedule || r.shift || r["Shift Schedule"] || "Day Shift").trim() || "Day Shift",
      passIssueDate: String(r.passIssueDate || r["Pass Issue Date"] || "").trim(),
      passExpiryDate: String(r.passExpiryDate || r["Pass Expiry Date"] || "").trim(),
      email: String(r.email || r["Email Address"] || "").trim(),
      phone: String(r.phone || r["Phone Number"] || "").trim(),
      lineManager: String(r.lineManager || r["Line Manager"] || "").trim(),
      lineManagerEmail: String(r.lineManagerEmail || r["Line Manager Email Address"] || "").trim()
    };
  };
  const readBulkSheet = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const XLSX = await import("xlsx");
      const wb = XLSX.read(buf, { type: "array" });
      const first = wb.SheetNames?.[0];
      if (!first) throw new Error("No sheet found");
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { defval: "" });
      const embeddedPhotos = await readEmbeddedPhotosFromSheet(buf);
      const mapped = rows.map((r, i) => {
        const rowNo = i + 2;
        const employeeDoc = normalizeBulkEmployeePayload(r);
        const employeeName = employeeDoc.name;
        const photoFile = String(r.photoFile || r.photo || r.photoName || r["Photo File"] || "").trim();
        const photoInline = normalizeSheetPhotoDataUrl(r.photoBase64 || r.photoDataUrl || "");
        const photoEmbedded = embeddedPhotos.get(rowNo) || "";
        // Image URL column: relative paths (./image/...) or https:// URLs used as src directly
        const imageUrlRaw = String(employeeDoc._imageUrl || r["Image URL"] || r.imageUrl || r.imageURL || "").trim();
        const imageUrlSrc = imageUrlRaw
          ? (imageUrlRaw.startsWith("data:") ? imageUrlRaw : imageUrlRaw)   // kept as-is; img src handles both URL and data-url
          : "";
        const photoSrc = photoInline || photoEmbedded || imageUrlSrc;
        return {
          rowNo,
          employeeId: employeeDoc.employeeId,
          employeeName,
          employeeDoc,
          photoFile: parseBulkEmployeeToken(photoFile || employeeDoc.employeeId || employeeName),
          photoSrc,
          imageUrlSrc   // raw URL kept for display in table even if not base64
        };
      }).filter((r) => r.employeeId || r.employeeName || r.photoFile || r.photoSrc);
      setBulkSheetRows(mapped);
      setBulkSheetName(file.name || "sheet");
      const sheetItems = mapped.flatMap((r) => {
        const matched = emps.find((e) =>
          (r.employeeId && String(e?.employeeId || "").trim().toLowerCase() === r.employeeId.toLowerCase()) ||
          (r.employeeName && String(e?.name || "").trim().toLowerCase() === r.employeeName.toLowerCase())
        );
        const idBase = `sheet-${r.rowNo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Determine display label for the employee in the queue row
        const snLabel = r.employeeDoc?.sn ? `SN ${r.employeeDoc.sn} · ` : "";
        const empLabel = `${snLabel}${r.employeeName || r.employeeId || `Row ${r.rowNo}`}`;
        if (r.photoSrc) {
          return [
            {
              id: idBase,
              fileName: empLabel,
              src: r.photoSrc,
              enhancedSrc: r.photoSrc,
              imageUrlSrc: r.imageUrlSrc || "",
              employeeId: matched?._id || "",
              employeeDraft: r.employeeDoc,
              allowNoPhoto: false,
              status: matched ? "ready" : r.employeeDoc?.employeeId && r.employeeDoc?.name ? "ready" : "unmapped",
              message: matched
                ? `Mapped to ${matched.name}`
                : r.employeeDoc?.employeeId && r.employeeDoc?.name
                  ? `Will create: ${r.employeeDoc.name} (${r.employeeDoc.employeeId})`
                  : "Missing Employee Number or Name in sheet row"
            }
          ];
        }
        if (r.employeeDoc?.employeeId && r.employeeDoc?.name) {
          return [
            {
              id: `${idBase}-nop`,
              fileName: `${empLabel} (no photo)`,
              src: "",
              enhancedSrc: "",
              imageUrlSrc: "",
              employeeId: matched?._id || "",
              employeeDraft: r.employeeDoc,
              allowNoPhoto: true,
              status: "ready",
              message: matched
                ? "No photo — employee record will be updated only"
                : `Will create: ${r.employeeDoc.name} (${r.employeeDoc.employeeId}) — enroll face later`
            }
          ];
        }
        return [];
      });
      if (sheetItems.length) setBulkItems((prev) => [...prev, ...sheetItems]);
      const withPhoto = mapped.filter((r) => r.photoSrc).length;
      const withoutPhoto = mapped.filter((r) => !r.photoSrc && r.employeeDoc?.employeeId && r.employeeDoc?.name).length;
      show(
        `Loaded ${mapped.length} row(s) from ${file.name}. ${withPhoto} with image data, ${withoutPhoto} employee row(s) without photo (optional).`,
        "success"
      );
    } catch (e) {
      show(e?.message || "Could not read Excel sheet", "error");
    }
  };
  const downloadBulkSampleSheet = async () => {
    try {
      const XLSX = await import("xlsx");

      // ── Sheet 1: Compact format (what you hand to site staff) ───────────
      const compactRows = [
        {
          "SN":              1,
          "Name":            "Muhammad Tariq Imran",
          "Employee Number": "EAPECD00038966",
          "Card Number":     "2112347273",
          "Image URL":       "./image/Muhammad Tariq Imran_EAPECD00038966.jpg"
        },
        {
          "SN":              2,
          "Name":            "Ali Hassan Al Wasl",
          "Employee Number": "EAPECD00038967",
          "Card Number":     "2112347274",
          "Image URL":       "./image/Ali Hassan Al Wasl_EAPECD00038967.jpg"
        },
        {
          "SN":              3,
          "Name":            "Sara Ahmed Khalifa",
          "Employee Number": "EAPECD00038968",
          "Card Number":     "2112347275",
          "Company":         "Expo City Dubai",
          "Image URL":       "https://example.com/photos/sara_ahmed.jpg"
        }
      ];
      const wsCompact = XLSX.utils.json_to_sheet(compactRows, {
        header: ["SN","Name","Employee Number","Card Number","Company","Image URL"]
      });
      // Column widths for compact sheet
      wsCompact["!cols"] = [
        { wch: 6 },   // SN
        { wch: 30 },  // Name
        { wch: 22 },  // Employee Number
        { wch: 16 },  // Card Number
        { wch: 24 },  // Company
        { wch: 58 }   // Image URL
      ];

      // ── Sheet 2: Full / expanded format (all optional fields) ───────────
      const expandedRows = [
        {
          "SN":                          1,
          "Name":                        "Muhammad Tariq Imran",
          "Employee Number":             "EAPECD00038966",
          "Card Number":                 "2112347273",
          "Image URL":                   "./image/Muhammad Tariq Imran_EAPECD00038966.jpg",
          "Employee Tag":                "Al Wasl POD Access",
          "Company":                     "Expo City Dubai",
          "Designation":                 "Senior Engineer",
          "Division":                    "Operations",
          "Department":                  "Engineering",
          "Access Level":                "L1 General",
          "Cardholder Status":           "Active",
          "Shift Schedule":              "Day Shift",
          "Pass Issue Date":             "01/05/26",
          "Pass Expiry Date":            "31/12/26",
          "Email Address":               "tariq.imran@expocitydubai.ae",
          "Phone Number":                "+971 501234567",
          "Line Manager":                "Manager Name",
          "Line Manager Email Address":  "manager@expocitydubai.ae"
        }
      ];
      const wsExpanded = XLSX.utils.json_to_sheet(expandedRows, {
        header: [
          "SN","Name","Employee Number","Card Number","Image URL",
          "Employee Tag","Company","Designation","Division","Department",
          "Access Level","Cardholder Status","Shift Schedule","Pass Issue Date","Pass Expiry Date",
          "Email Address","Phone Number","Line Manager","Line Manager Email Address"
        ]
      });
      wsExpanded["!cols"] = [
        { wch: 6 }, { wch: 30 }, { wch: 22 }, { wch: 16 }, { wch: 58 },
        { wch: 22 }, { wch: 24 }, { wch: 20 }, { wch: 18 }, { wch: 18 },
        { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
        { wch: 32 }, { wch: 18 }, { wch: 22 }, { wch: 32 }
      ];

      // ── Sheet 3: Instructions ────────────────────────────────────────────
      const instructions = XLSX.utils.aoa_to_sheet([
        ["Expo City Dubai — Bulk Enrollment Template Instructions"],
        [""],
        ["REQUIRED COLUMNS (minimum needed per row):"],
        ["  • Employee Number   — unique pass / badge number  (e.g. EAPECD00038966)"],
        ["  • Name              — full employee name"],
        [""],
        ["OPTIONAL COLUMNS (leave blank if not available):"],
        ["  • SN                — row sequence number (informational only)"],
        ["  • Card Number       — physical card CSN/serial"],
        ["  • Image URL         — path or URL to the face photo:"],
        ["      Relative path : ./image/FirstName LastName_EmployeeNumber.jpg"],
        ["      HTTPS URL     : https://your-server.com/photos/photo.jpg"],
        ["      Leave blank   — employee record is created without face enrollment"],
        [""],
        ["PHOTO RULES:"],
        ["  • JPG or PNG, minimum 180×180 px, maximum 10 MB"],
        ["  • Clear frontal face, good lighting, no sunglasses"],
        ["  • Relative paths (./image/...) work when photos folder is on the same server"],
        ["  • Alternatively embed the image directly in the Excel cell (Sheet1 rows)"],
        ["  • Or use the photoBase64 column with a base64/data-url string"],
        [""],
        ["WORKFLOW:"],
        ["  1. Fill Sheet1 (compact) or Sheet2 (expanded) with your employee data"],
        ["  2. Place face photos in ./image/ folder named:"],
        ["       FirstName LastName_EmployeeNumber.jpg"],
        ["  3. In the app: Face Enrollment → Bulk enroll (remote) → Upload Excel sheet"],
        ["  4. Review the queue — green rows have photos, grey rows are employee-only"],
        ["  5. Click Start bulk enroll"],
        ["  6. Download failed rows and fix/retry if any errors occur"]
      ]);
      instructions["!cols"] = [{ wch: 80 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsCompact,    "Bulk Enroll (Compact)");
      XLSX.utils.book_append_sheet(wb, wsExpanded,   "Bulk Enroll (Full)");
      XLSX.utils.book_append_sheet(wb, instructions, "Instructions");

      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const href = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = href;
        a.download = "bulk-enrollment-template.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(href);
      }
    } catch (e) {
      show(e?.message || "Could not download sample template", "error");
    }
  };
  const downloadFailedBulkRows = async () => {
    try {
      const failed = (bulkItems || []).filter((x) => x.status === "failed");
      if (!failed.length) {
        show("No failed rows to export.", "warning");
        return;
      }
      const XLSX = await import("xlsx");
      const rows = failed.map((row, idx) => {
        const draft = row.employeeDraft || {};
        return {
          "SN":                         idx + 1,
          "Name":                       draft.name || "",
          "Employee Number":            draft.employeeId || "",
          "Card Number":                draft.cardId || "",
          "Image URL":                  draft._imageUrl || row.imageUrlSrc || "",
          // Extended fields preserved for re-import
          "Employee Tag":               draft.employeeTag || "",
          "Company":                    draft.company || "",
          "Designation":                draft.designation || "",
          "Division":                   draft.division || "",
          "Department":                 draft.department || "",
          "Access Level":               draft.accessLevel || "",
          "Cardholder Status":          draft.cardholderStatus || "",
          "Shift Schedule":             draft.shiftSchedule || "",
          "Pass Issue Date":            draft.passIssueDate || "",
          "Pass Expiry Date":           draft.passExpiryDate || "",
          "Email Address":              draft.email || "",
          "Phone Number":               draft.phone || "",
          "Line Manager":               draft.lineManager || "",
          "Line Manager Email Address": draft.lineManagerEmail || "",
          "Error":                      row.message || "Enrollment failed"
        };
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "FailedRows");
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const href = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = href;
        a.download = "bulk-enrollment-failed-rows.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(href);
      }
      show(`Exported ${failed.length} failed row(s).`, "success");
    } catch (e) {
      show(e?.message || "Could not export failed rows", "error");
    }
  };
  const requeueFailedBulkRows = () => {
    const hasFailed = (bulkItems || []).some((x) => x.status === "failed");
    if (!hasFailed) {
      show("No failed rows to requeue.", "warning");
      return;
    }
    setBulkItems((prev) =>
      prev.map((x) =>
        x.status === "failed"
          ? {
              ...x,
              status: x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name) ? "ready" : "unmapped",
              message: x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name) ? "Requeued for retry" : "Select employee"
            }
          : x
      )
    );
    show("Failed rows requeued.", "success");
  };
  const retryFailedNow = async () => {
    const hasFailed = (bulkItems || []).some((x) => x.status === "failed");
    if (!hasFailed) {
      show("No failed rows to retry.", "warning");
      return;
    }
    setBulkItems((prev) =>
      prev.map((x) =>
        x.status === "failed"
          ? {
              ...x,
              status: x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name) ? "ready" : "unmapped",
              message: x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name) ? "Requeued for retry" : "Select employee"
            }
          : x
      )
    );
    show("Retry started for failed rows.", "info");
    setTimeout(() => {
      runBulkEnroll();
    }, 0);
  };
  const bulkFailedCount = (bulkItems || []).filter((x) => x.status === "failed").length;
  const bulkReadyRetryCount = (bulkItems || []).filter(
    (x) => x.status === "failed" && (x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name))
  ).length;

  const analyze = async () => {
    if (!photos.length || !emp) return;
    setBusy(true); setResult(null);
    try {
      const results = [];
      for (let i = 0; i < photos.length; i++) {
        const base64 = String(photos[i]?.enhancedSrc || photos[i]?.src || "").split(",")[1];
        if (!base64) continue;
        try {
          const r = await api.analyzePhoto({ base64, employeeId:emp._id, employeeName:emp.name });
          results.push({ ...r, _photoIdx: i });
        } catch {
          // Continue with remaining photos so one failure doesn't stop full analysis.
        }
      }
      if (!results.length) throw new Error("No valid photos found");
      const consensus = consensusFrom(results);
      setActivePhotoIdx(consensus._photoIdx || 0);
      setResult(consensus);
      setPan({ x: 0, y: 0 });
    } catch(e){ show(e.message,"error"); }
    finally { setBusy(false); }
  };

  const doEnroll = async () => {
    if (!activePhoto?.src) {
      show("Please upload and preview a photo first.", "warning");
      return;
    }
    const analyzed = Array.isArray(result?.allResults) ? result.allResults : (currentResult ? [currentResult] : []);
    if (!analyzed.length) {
      show("Please click Save first to validate photo(s).", "warning");
      return;
    }
    setSaving(true);
    setEnrollProgress({ pct: 8, label: "Preparing photo…" });
    try {
      const idx = Number(currentResult?._photoIdx ?? activePhotoIdx ?? 0);
      const p = photos[idx];
      const srcOriginal = p?.src || "";
      const srcEnhanced = p?.enhancedSrc || "";
      const chosenSrc = srcOriginal || srcEnhanced;
      const compatSrc = await makeSupremaCompatiblePhoto(chosenSrc, "balanced");
      setEnrollProgress({ pct: 24, label: "Converting to device-compatible JPEG…" });
      const photoBase64 = String(compatSrc).split(",")[1];
      if (!photoBase64) {
        show("Could not read photo data.", "error");
        return;
      }
      setEnrollProgress({ pct: 56, label: "Pushing to reader (attempt 1/2)…" });
      let er = await api.enroll({
        employeeId: emp._id,
        photoBase64,
        analysisResult: currentResult || analyzed[0],
        photoOnlyAccess: true
      });
      const firstPushErr = String(er?.devicePush?.results?.find?.((x) => !x.ok)?.error || "");
      const normalizeFailed =
        /BS_ERR_NORMALIZE_FACE_IMAGE|BS_ERR_NORMALIZE_FACE|Cannot normalize|Cannot extract face template/i.test(
          firstPushErr
        );
      const enhancedBase64 = String(srcEnhanced).split(",")[1];
      // Fallback: if device rejects the raw upload image for normalization, retry with enhanced JPEG.
      if (normalizeFailed && enhancedBase64 && enhancedBase64 !== photoBase64) {
        setEnrollProgress({ pct: 72, label: "Retrying with safer JPEG profile (attempt 2/2)…" });
        const safeSrc = await makeSupremaCompatiblePhoto(srcEnhanced || chosenSrc, "safe");
        er = await api.enroll({
          employeeId: emp._id,
          photoBase64: String(safeSrc).split(",")[1] || enhancedBase64,
          analysisResult: currentResult || analyzed[0],
          photoOnlyAccess: true
        });
      }
      const dp = er?.devicePush;
      let line = `${emp.name} enrolled with photo-only access — face saved.`;
      if (dp?.skipped) {
        if (dp.reason === "no_sidecar")
          line += " G-SDK sidecar not set; face was not pushed to the reader. Set GSDK_SIDECAR_URL on the API or use BioStar 2 / on-device enroll.";
        else if (dp.reason === "no_gateway")
          line +=
            " GSDK_GATEWAY is not set — API cannot reach device_gateway gRPC (e.g. 192.168.0.200:4100 or host.docker.internal:4100 in Docker). Face was not pushed to the reader.";
        else if (dp.reason === "disabled") line += " (Device push disabled on server.)";
        else if (dp.note) line += ` ${dp.note}`;
      } else if (dp?.attempted && Array.isArray(dp.results) && dp.results.length) {
        const okC = dp.results.filter((r) => r.ok).length;
        const addedC = dp.results.filter((r) => r.ok && r.readerUserAdded !== false).length;
        const faceVerifiedC = dp.results.filter((r) => r.ok && (r.faceSaved === true || r?.scanEnrollFallback?.faceSaved === true)).length;
        if (okC === dp.results.length && faceVerifiedC === dp.results.length) {
          line += ` Employee added to readers and face enrolled perfectly (${faceVerifiedC}/${dp.results.length}).`;
        } else {
          line += ` Reader template sync: ${okC}/${dp.results.length}. User added: ${addedC}/${dp.results.length}. Face verified: ${faceVerifiedC}/${dp.results.length}.`;
        }
        const hintOk = dp.results.find((r) => r.ok && r.hint)?.hint;
        const fullySuccessful = okC === dp.results.length && faceVerifiedC === dp.results.length;
        if (hintOk && !fullySuccessful) line += ` ${hintOk}`;
        const err1 = dp.results.find((r) => !r.ok)?.error;
        const explainSyncErr = (e) => {
          const s = String(e || "").trim();
          if (!s) return "";
          if (
            /BS_ERR_NORMALIZE_FACE_IMAGE|BS_ERR_NORMALIZE_FACE|Cannot normalize the unwrapped jpeg image|Cannot normalize the unwarped jpeg image|Cannot normalize the unwrapped|Cannot normalize\b/i.test(
              s
            )
          ) {
            return "Photo not suitable for device normalization - use a clearer frontal photo, or use Live enroll on device.";
          }
          if (/Cannot extract face template|EXTRACT_FACE_TEMPLATE/i.test(s)) {
            return "Device could not extract a valid face template from this photo - try another photo or use Live enroll on device.";
          }
          if (/extract returned empty template|empty template data/i.test(s)) {
            return "Reader Normalize/Extract returned no template bytes for this upload. Use a clear frontal JPEG/PNG (avoid WebP), rebuild/restart gsdk-sidecar after updating, or use Live enroll on device.";
          }
          if (/^http_error$/i.test(s) || s === "unknown") {
            return "Sidecar returned an unreadable error — rebuild/restart gsdk-sidecar (needs large JSON for photos), confirm GSDK_SIDECAR_URL, then enroll again.";
          }
          if (/413|payload too large|entity too large/i.test(s)) {
            return "Photo request too large for sidecar — update gsdk-sidecar (12mb JSON body) and retry.";
          }
          if (/^HTTP\s+50[0-9]/i.test(s) || /failed|econnrefused|fetch/i.test(s)) {
            return `${s} Check GSDK_GATEWAY, TLS, reader connected to gateway, and My Devices → Sync for supremaDeviceId.`;
          }
          return s;
        };
        if (err1) line += ` ${explainSyncErr(err1)}`;
      } else if (dp?.note) {
        line += ` ${dp.note}`;
      }
      const warn = Boolean(dp?.attempted && dp.results?.some?.((r) => !r.ok));
      setEnrollProgress({ pct: 100, label: warn ? "Finished with warnings." : "Enrollment completed." });
      show(line, warn ? "warning" : "success");
      setStep("select"); setEmp(null); setPhotos([]); setActivePhotoIdx(0); setZoom(1); setPan({ x: 0, y: 0 }); setResult(null);
    } catch(e){ show(e.message,"error"); }
    finally {
      setSaving(false);
      setTimeout(() => setEnrollProgress({ pct: 0, label: "" }), 700);
    }
  };

  const processEnrollmentFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    const remainingSlots = Math.max(0, 10 - photos.length);
    if (remainingSlots <= 0) {
      show("Maximum 10 photos allowed.", "warning");
      return;
    }
    const selected = list.slice(0, remainingSlots);
    if (list.length > remainingSlots) {
      show(`Only ${remainingSlots} more photo(s) can be added (max 10).`, "warning");
    }
    const readFile = (f) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (ev) => resolve(ev.target.result);
      r.onerror = () => reject(new Error("Failed to read photo file"));
      r.readAsDataURL(f);
    });
    const getDims = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.width, h: img.height });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = src;
    });
    try {
      const accepted = [];
      let refHash = photos[0]?.hash || "";
      if (!refHash && photos[0]?.enhancedSrc) refHash = await getImageHash(photos[0].enhancedSrc);
      let rejectedDifferentPerson = 0;
      const existingHashes = photos.map((p) => p?.hash).filter(Boolean);
      for (const f of selected) {
        if (!String(f.type || "").startsWith("image/")) continue;
        if (f.size > 10 * 1024 * 1024) continue;
        const src = await readFile(f);
        const dims = await getDims(src);
        if (dims.w < 180 || dims.h < 180) continue;
        const enhancedSrc = await enhancePhotoLocal(src);
        const hash = await getImageHash(enhancedSrc);
        if (!refHash) refHash = hash;
        // Compare against reference and all previously accepted hashes.
        // Accept if it is close to at least one known photo.
        const distances = [];
        if (refHash && hash) distances.push(hashDistance(refHash, hash));
        for (const h of existingHashes) distances.push(hashDistance(h, hash));
        for (const h of accepted.map((a) => a.hash).filter(Boolean)) distances.push(hashDistance(h, hash));
        const minDist = distances.length ? Math.min(...distances) : 0;
        if (distances.length && minDist > 34) {
          rejectedDifferentPerson++;
          continue;
        }
        accepted.push({ src, enhancedSrc, name: f.name, hash });
      }
      if (!accepted.length) {
        show("Photos are not acceptable or look like a different person.", "warning");
        return;
      }
      if (rejectedDifferentPerson > 0) {
        show(`${rejectedDifferentPerson} photo(s) were rejected because they look like a different person.`, "warning");
      }
      setPhotos((prev) => {
        const next = [...prev, ...accepted];
        setActivePhotoIdx(Math.max(0, next.length - accepted.length));
        return next;
      });
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setResult(null);
    } catch {
      show("Could not process selected photos.", "error");
    }
  };
  const onFile = async e => {
    await processEnrollmentFiles(e.target.files);
    e.target.value="";
  };
  const processBulkFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    const readFile = (f) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (ev) => resolve(ev.target.result);
      r.onerror = () => reject(new Error("Failed to read photo file"));
      r.readAsDataURL(f);
    });
    const rows = [];
    for (const f of list) {
      if (!String(f.type || "").startsWith("image/")) continue;
      if (f.size > 10 * 1024 * 1024) continue;
      try {
        const src = await readFile(f);
        const enhancedSrc = await enhancePhotoLocal(src);
        const token = parseBulkEmployeeToken(f.name);
        const sheetMatch = bulkSheetRows.find((r) => r.photoFile && r.photoFile === token);
        const matched = sheetMatch
          ? (emps.find((e) =>
              (sheetMatch.employeeId && String(e?.employeeId || "").trim().toLowerCase() === sheetMatch.employeeId.toLowerCase()) ||
              (sheetMatch.employeeName && String(e?.name || "").trim().toLowerCase() === sheetMatch.employeeName.toLowerCase())
            ) || mapBulkTokenToEmployee(token, emps))
          : mapBulkTokenToEmployee(token, emps);
        rows.push({
          id: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fileName: f.name,
          src,
          enhancedSrc,
          employeeId: matched?._id || "",
          status: matched ? "ready" : "unmapped",
          message: matched ? `Mapped to ${matched.name}${sheetMatch ? " (sheet)" : ""}` : "No auto match. Select employee manually."
        });
      } catch {}
    }
    if (!rows.length) {
      show("No valid photos selected for bulk enrollment.", "warning");
      return;
    }
    setBulkItems((prev) => [...prev, ...rows]);
  };
  const runBulkEnroll = async () => {
    const runRows = bulkItems.filter((x) => {
      if (x.status === "success") return false;
      const hasDraft = x.employeeDraft?.employeeId && x.employeeDraft?.name;
      const hasPhoto = Boolean(String(x.src || "").trim());
      const linkedEmp = Boolean(x.employeeId);
      if (x.allowNoPhoto && hasDraft && !hasPhoto) return true;
      return hasPhoto && (hasDraft || linkedEmp);
    });
    if (!runRows.length) {
      show("Add at least one row with Pass Number + Employee Name. Rows with photos will enroll; rows without photos will create/update employee only.", "warning");
      return;
    }
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: runRows.length, label: "Starting bulk enrollment…" });
    let successCount = 0;
    let failedCount = 0;

    // ── FAST PATH: bulk-upsert all rows that have no photos in a single API call ──
    // This handles thousands of rows in seconds rather than minutes.
    const noPhotoRows = runRows.filter(r => r.allowNoPhoto && !String(r.src || "").trim() && r.employeeDraft?.employeeId && r.employeeDraft?.name);
    const photoRows   = runRows.filter(r => !(r.allowNoPhoto && !String(r.src || "").trim()));
    let bulkDone = 0;

    if (noPhotoRows.length > 1) {
      setBulkProgress({ done: 0, total: runRows.length, label: `Bulk creating ${noPhotoRows.length} employees…` });
      try {
        const payload = noPhotoRows.map(r => {
          const { _imageUrl, ...clean } = normalizeBulkEmployeePayload(r.employeeDraft);
          return clean;
        });
        const res = await api.employeeBulk(payload, "upsert");
        const created = (res?.inserted || 0);
        const upd     = (res?.updated  || 0);
        const errs    = res?.errors || [];
        // Mark each as success / failed using errors list
        const errorByRow = new Map();
        for (const e of errs) errorByRow.set(e.row, e.error);
        let idx = 0;
        for (const row of noPhotoRows) {
          idx++;
          const err = errorByRow.get(idx);
          if (err) {
            failedCount++;
            setBulkItems(prev => prev.map(x => x.id===row.id ? { ...x, status:"failed", message:err } : x));
          } else {
            successCount++;
            setBulkItems(prev => prev.map(x => x.id===row.id ? { ...x, status:"success", message:"Employee created/updated (no photo)" } : x));
          }
        }
        bulkDone = noPhotoRows.length;
        setBulkProgress({ done: bulkDone, total: runRows.length, label: `Bulk created ${created}, updated ${upd}. Processing photo rows…` });
      } catch (err) {
        // Fall back to row-by-row if bulk endpoint fails
        console.error("[bulk] fast-path failed, falling back to per-row:", err);
      }
    }

    try {
      let done = bulkDone;
      for (const row of photoRows) {
        let targetEmp = emps.find((e) => e._id === row.employeeId);
        if (!targetEmp && row.employeeDraft?.employeeId) {
          targetEmp = emps.find((e) =>
            String(e?.employeeId || "").trim().toLowerCase() === String(row.employeeDraft.employeeId || "").trim().toLowerCase()
          );
        }
        if (!targetEmp && row.employeeDraft?.name) {
          targetEmp = emps.find((e) =>
            String(e?.name || "").trim().toLowerCase() === String(row.employeeDraft.name || "").trim().toLowerCase()
          );
        }
        try {
          if (!targetEmp) {
            if (!row.employeeDraft?.employeeId || !row.employeeDraft?.name) throw new Error("Missing Pass Number or Employee Name");
            const { _imageUrl, ...cleanPayload } = normalizeBulkEmployeePayload(row.employeeDraft);
            const created = await api.empCreate(cleanPayload);
            targetEmp = created;
            setBulkItems((prev) => prev.map((x) => (x.id === row.id ? { ...x, employeeId: created?._id || "", message: "Employee created from sheet" } : x)));
          }
          if (row.allowNoPhoto && !String(row.src || "").trim()) {
            successCount++;
            setBulkItems((prev) =>
              prev.map((x) =>
                x.id === row.id
                  ? { ...x, status: "success", message: "Employee saved — no photo in sheet (enroll face later)" }
                  : x
              )
            );
            done++;
            setBulkProgress({ done, total: runRows.length, label: `Processed ${done}/${runRows.length}` });
            continue;
          }
          const compatible = await makeSupremaCompatiblePhoto(row.enhancedSrc || row.src, "balanced");
          const photoBase64 = String(compatible || "").split(",")[1];
          if (!photoBase64) throw new Error("Invalid image data");
          const analysis = await api.analyzePhoto({ base64: photoBase64, employeeId: targetEmp._id, employeeName: targetEmp.name });
          let enrollResult = await api.enroll({
            employeeId: targetEmp._id,
            photoBase64,
            analysisResult: analysis,
            photoOnlyAccess: true
          });
          const firstPushErr = String(enrollResult?.devicePush?.results?.find?.((x) => !x.ok)?.error || "");
          const normalizeFailed =
            /BS_ERR_NORMALIZE_FACE_IMAGE|BS_ERR_NORMALIZE_FACE|Cannot normalize|Cannot extract face template/i.test(firstPushErr);
          if (normalizeFailed) {
            const safeSrc = await makeSupremaCompatiblePhoto(row.enhancedSrc || row.src, "safe");
            const safeBase64 = String(safeSrc || "").split(",")[1];
            if (safeBase64) {
              const safeAnalysis = await api.analyzePhoto({ base64: safeBase64, employeeId: targetEmp._id, employeeName: targetEmp.name });
              enrollResult = await api.enroll({
                employeeId: targetEmp._id,
                photoBase64: safeBase64,
                analysisResult: safeAnalysis,
                photoOnlyAccess: true
              });
            }
          }
          // Mirror doEnroll status reporting — bulk must surface the same accuracy
          // as remote photo enroll so users see whether the face actually pushed.
          const dp = enrollResult?.devicePush;
          let bulkLine = "Face saved on server.";
          let pushOk = true;
          if (dp?.skipped) {
            pushOk = false;
            if (dp.reason === "no_sidecar")        bulkLine = "Saved — G-SDK sidecar not configured, face NOT pushed to reader.";
            else if (dp.reason === "no_gateway")   bulkLine = "Saved — GSDK_GATEWAY not set, face NOT pushed to reader.";
            else if (dp.reason === "disabled")     bulkLine = "Saved — device push disabled on server.";
            else if (dp.note)                      bulkLine = `Saved — ${dp.note}`;
            else                                    bulkLine = "Saved — device push skipped.";
          } else if (dp?.attempted && Array.isArray(dp.results) && dp.results.length) {
            const okC          = dp.results.filter((r) => r.ok).length;
            const addedC       = dp.results.filter((r) => r.ok && r.readerUserAdded !== false).length;
            const faceVerifiedC = dp.results.filter((r) => r.ok && (r.faceSaved === true || r?.scanEnrollFallback?.faceSaved === true)).length;
            if (okC === dp.results.length && faceVerifiedC === dp.results.length) {
              bulkLine = `Enrolled on ${faceVerifiedC}/${dp.results.length} reader(s) ✓`;
            } else if (okC > 0) {
              pushOk = faceVerifiedC > 0;
              bulkLine = `Reader sync: ${okC}/${dp.results.length}, face verified ${faceVerifiedC}/${dp.results.length}.`;
              const firstErr = dp.results.find((r) => !r.ok)?.error;
              if (firstErr) bulkLine += ` Issue: ${String(firstErr).slice(0,80)}`;
            } else {
              pushOk = false;
              const firstErr = dp.results.find((r) => !r.ok)?.error || "Device push failed";
              bulkLine = `Server saved, reader push failed: ${String(firstErr).slice(0,100)}`;
            }
          } else if (dp?.attempted) {
            pushOk = false;
            bulkLine = "Server saved, no reader response.";
          }

          if (pushOk) {
            successCount++;
            setBulkItems((prev) =>
              prev.map((x) => (x.id === row.id ? { ...x, status: "success", message: bulkLine } : x))
            );
          } else {
            failedCount++;
            setBulkItems((prev) =>
              prev.map((x) => (x.id === row.id ? { ...x, status: "failed", message: bulkLine } : x))
            );
          }
        } catch (e) {
          failedCount++;
          setBulkItems((prev) =>
            prev.map((x) => (x.id === row.id ? { ...x, status: "failed", message: e?.message || "Enrollment failed" } : x))
          );
        }
        done++;
        setBulkProgress({ done, total: runRows.length, label: `Processed ${done}/${runRows.length}` });
      }
      show(
        `Bulk enrollment finished. Success: ${successCount}, Failed: ${failedCount}`,
        failedCount ? "warning" : "success"
      );
    } finally {
      setBulkRunning(false);
    }
  };

  const VC = {APPROVE:TH.green,CONDITIONAL:TH.amber,REJECT:TH.red,FRAUD:TH.red};
  useEffect(() => {
    if (!preselectedEmployee?._id) return;
    setEmp(preselectedEmployee);
    setStep("upload");
    setPhotos([]);
    setActivePhotoIdx(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setResult(null);
  }, [preselectedEmployee]);
  useEffect(() => {
    const onMove = (ev) => {
      if (!dragRef.current.dragging) return;
      const nx = dragRef.current.baseX + (ev.clientX - dragRef.current.startX);
      const ny = dragRef.current.baseY + (ev.clientY - dragRef.current.startY);
      setPan({ x: nx, y: ny });
    };
    const onUp = () => { dragRef.current.dragging = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (step==="select") return (
    <div>
      <PageHeader title="Face Enrollment" />
      <Card>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8,flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>Select Employee to Enroll</div>
          </div>
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            <Btn sz="sm" v="ghost" icon="📦" onClick={()=>{ setStep("bulk"); setBulkItems([]); setBulkSheetRows([]); setBulkSheetName(""); setBulkProgress({ done:0,total:0,label:"" }); }}>
              Bulk enroll (remote)
            </Btn>
            {typeof onNav === "function" && (
              <Btn sz="sm" v="secondary" icon="+" onClick={()=>onNav("employees")}>Add employee</Btn>
            )}
          </div>
        </div>
        <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search employee…" style={{ marginBottom:16 }}/>
        {loading?<Loader/>:emps.length===0?(
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <Empty icon="👥" text="No employees yet" sub="Create employees under People → Employees, then open Face Enrollment again."/>
            {typeof onNav === "function" && (
              <div style={{ marginTop:16 }}>
                <Btn onClick={()=>onNav("employees")} icon="+">Go to Employees</Btn>
              </div>
            )}
          </div>
        ):(
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10 }}>
            {emps.map(e=>(
              <div key={e._id} onClick={()=>{setEmp(e);setPhotos([]);setActivePhotoIdx(0);setZoom(1);setPan({ x: 0, y: 0 });setResult(null);setStep("upload");}}
                style={{ display:"flex",gap:10,alignItems:"center",padding:"11px 14px",background:TH.surface,borderRadius:10,border:`1px solid ${TH.border}`,cursor:"pointer",transition:"all .14s" }}
                onMouseEnter={el=>{ el.currentTarget.style.borderColor=TH.blue; el.currentTarget.style.background=TH.hover; }}
                onMouseLeave={el=>{ el.currentTarget.style.borderColor=TH.border; el.currentTarget.style.background=TH.surface; }}>
                <Avatar name={e.name} size={42} color={e.enrolled?TH.green:TH.blue} img={employeePhoto(e)}/>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:13,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.name}</div>
                  <div style={{ fontSize:11,color:TH.muted }}>{[e.designation,e.department].filter(Boolean).join(" · ")||"—"}</div>
                  {e.enrolled?<Badge color="green" sm>Enrolled</Badge>:<Badge color="gray" sm>Pending</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
  if (step==="bulk") return (
    <div>
      <PageHeader title="Face Enrollment — Bulk Remote" sub="Upload Excel sheet (SN · Name · Employee Number · Card Number · Image URL) then enroll in one click"
        back="Employee List" onBack={()=>{ setStep("select"); setBulkItems([]); setBulkSheetRows([]); setBulkSheetName(""); setBulkProgress({ done:0,total:0,label:"" }); }}/>

      {/* ── How-to banner ── */}
      <GlassCard color={TH.cyan} style={{ marginBottom:14,padding:"12px 16px" }}>
        <div style={{ display:"flex",gap:16,alignItems:"flex-start",flexWrap:"wrap" }}>
          <div style={{ flex:1,minWidth:220 }}>
            <div style={{ fontSize:13,fontWeight:700,color:TH.text,marginBottom:6 }}>Excel format (columns required)</div>
            <div style={{ display:"grid",gridTemplateColumns:"auto 1fr",gap:"2px 12px",fontSize:12,fontFamily:TH.mono }}>
              {[["SN","Row number (1, 2, 3…)"],["Name","Full employee name"],["Employee Number","Unique pass / badge ID"],["Card Number","Physical card CSN"],["Image URL","Path or URL to face photo"]].map(([col,desc])=>(
                <Fragment key={col}>
                  <span style={{ color:TH.cyan,fontWeight:700 }}>{col}</span>
                  <span style={{ color:TH.muted }}>{desc}</span>
                </Fragment>
              ))}
            </div>
          </div>
          <div style={{ flex:1,minWidth:220 }}>
            <div style={{ fontSize:12,color:TH.muted,lineHeight:1.7 }}>
              <div>📌 <b>Image URL</b> can be:</div>
              <div style={{ paddingLeft:16 }}>• Relative: <span style={{ fontFamily:TH.mono,color:TH.text }}>./image/Name_ID.jpg</span></div>
              <div style={{ paddingLeft:16 }}>• HTTPS URL: <span style={{ fontFamily:TH.mono,color:TH.text }}>https://…/photo.jpg</span></div>
              <div style={{ paddingLeft:16 }}>• Leave blank — creates employee only, enroll face later</div>
              <div style={{ marginTop:4 }}>📌 Or embed the image directly in the Excel cell</div>
            </div>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:6,alignSelf:"center" }}>
            <Btn v="secondary" sz="sm" icon="⬇" onClick={downloadBulkSampleSheet}>Download sample sheet</Btn>
            <Btn v="ghost" sz="sm" icon="📋" onClick={()=>bulkSheetRef.current?.click()} disabled={bulkRunning}>Upload Excel sheet</Btn>
          </div>
        </div>
      </GlassCard>

      <Card>
        {/* hidden inputs */}
        <input ref={bulkFileRef} type="file" accept="image/*" multiple onChange={e=>{ processBulkFiles(e.target.files); e.target.value=""; }} style={{ display:"none" }}/>
        <input ref={bulkSheetRef} type="file" accept=".xlsx,.xls,.csv" onChange={e=>{ readBulkSheet(e.target.files?.[0]); e.target.value=""; }} style={{ display:"none" }}/>

        {/* Drop zone for loose photos */}
        <div onClick={()=>!bulkRunning&&bulkFileRef.current?.click()}
          onDragOver={(e)=>{ e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e)=>{ e.preventDefault(); e.stopPropagation(); if (!bulkRunning) processBulkFiles(e.dataTransfer?.files); }}
          style={{ padding:"18px 14px",borderRadius:12,border:`2px dashed ${TH.border}`,background:TH.surface,cursor:bulkRunning?"default":"pointer",textAlign:"center",marginBottom:12 }}>
          <div style={{ fontSize:24,opacity:.18,marginBottom:4 }}>📷</div>
          <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>Drop loose photos here, or click to browse</div>
          <div style={{ fontSize:11,color:TH.muted,marginTop:3 }}>
            Files named <span style={{ fontFamily:TH.mono }}>EmployeeName_EmployeeNumber.jpg</span> auto-match to employees
          </div>
        </div>

        {/* Action toolbar */}
        <div style={{ display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center" }}>
          <Btn v="secondary" sz="sm" icon="📷" onClick={()=>bulkFileRef.current?.click()} disabled={bulkRunning}>Add photos</Btn>
          <Btn v="ghost"    sz="sm" icon="📋" onClick={()=>bulkSheetRef.current?.click()} disabled={bulkRunning}>Upload sheet</Btn>
          <div style={{ width:1,height:22,background:TH.border,margin:"0 4px" }}/>
          <Btn v="ghost" sz="sm" onClick={downloadFailedBulkRows} disabled={bulkRunning || bulkFailedCount === 0}>⬇ Failed rows</Btn>
          <Btn v="ghost" sz="sm" onClick={requeueFailedBulkRows}   disabled={bulkRunning || bulkFailedCount === 0}>↺ Requeue failed</Btn>
          <Btn v="secondary" sz="sm" onClick={retryFailedNow}       disabled={bulkRunning || bulkReadyRetryCount === 0}>⟳ Retry now</Btn>
          <Btn v="ghost" sz="sm" onClick={()=>setBulkItems([])} disabled={bulkRunning || !bulkItems.length}>✕ Clear</Btn>
          <div style={{ flex:1 }}/>
          {!!bulkProgress.total && (
            <div style={{ display:"flex",alignItems:"center",gap:8,minWidth:180 }}>
              <Progress value={bulkProgress.done} max={bulkProgress.total} height={6} color={TH.blue}/>
              <span style={{ fontSize:11,color:TH.muted,whiteSpace:"nowrap",flexShrink:0 }}>{bulkProgress.label}</span>
            </div>
          )}
          <Btn
            v="success" sz="md" icon="🚀"
            onClick={runBulkEnroll}
            loading={bulkRunning}
            disabled={!bulkItems.some((x) => (x.src || x.allowNoPhoto) && (x.employeeId || (x.employeeDraft?.employeeId && x.employeeDraft?.name)))}
          >
            Start bulk enroll
          </Btn>
        </div>

        {/* Stats strip */}
        {bulkItems.length > 0 && (
          <div style={{ display:"flex",gap:10,marginBottom:10,flexWrap:"wrap" }}>
            {[
              ["Total",    bulkItems.length,                                                         "blue"],
              ["Ready",    bulkItems.filter(x=>x.status==="ready").length,                          "cyan"],
              ["Success",  bulkItems.filter(x=>x.status==="success").length,                        "green"],
              ["Failed",   bulkFailedCount,                                                          "red"],
              ["Unmapped", bulkItems.filter(x=>x.status==="unmapped").length,                       "amber"],
              ["No photo", bulkItems.filter(x=>x.allowNoPhoto && !x.src).length,                   "gray"],
            ].map(([lbl, n, col])=>(
              <div key={lbl} style={{ display:"flex",gap:5,alignItems:"center" }}>
                <Badge color={col} sm>{lbl}: {n}</Badge>
              </div>
            ))}
          </div>
        )}

        {bulkSheetName && (
          <div style={{ fontSize:11,color:TH.muted,marginBottom:8 }}>
            📋 Sheet: <b>{bulkSheetName}</b> — {bulkSheetRows.length} rows parsed
          </div>
        )}

        {/* Queue table */}
        <Table
          headers={["#","Photo","Name","Emp Number","Card No","Image URL / Source","Status","Message","Remap"]}
          rows={bulkItems.map((row, rowIdx) => {
            const stColor = row.status === "success" ? "green" : row.status === "failed" ? "red" : row.status === "ready" ? "blue" : "amber";
            const draft = row.employeeDraft || {};
            const photoSrc = row.src || row.imageUrlSrc || "";
            const hasPhoto = Boolean(photoSrc);
            return {
              key: row.id,
              cells: [
                // SN
                <span style={{ fontSize:11,color:TH.muted,fontFamily:TH.mono }}>{rowIdx+1}</span>,
                // Photo thumbnail
                hasPhoto
                  ? <img src={photoSrc} alt="photo"
                      style={{ width:44,height:44,objectFit:"cover",borderRadius:8,border:`1px solid ${TH.border}`,display:"block" }}
                      onError={e=>{ e.target.style.display="none"; }}/>
                  : <div style={{ width:44,height:44,borderRadius:8,border:`1px dashed ${TH.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,opacity:.25 }}>📷</div>,
                // Name
                <div style={{ minWidth:130 }}>
                  <div style={{ fontSize:12,fontWeight:600,color:TH.text }}>{draft.name || row.fileName || "—"}</div>
                  {draft.designation && <div style={{ fontSize:10,color:TH.muted }}>{draft.designation}</div>}
                </div>,
                // Employee Number
                <span style={{ fontSize:11,fontFamily:TH.mono,color:TH.cyan }}>{draft.employeeId || "—"}</span>,
                // Card Number
                <span style={{ fontSize:11,fontFamily:TH.mono,color:TH.muted }}>{draft.cardId || "—"}</span>,
                // Image URL / source label
                <div style={{ maxWidth:160,overflow:"hidden" }}>
                  {row.imageUrlSrc
                    ? <span style={{ fontSize:10,fontFamily:TH.mono,color:TH.muted,wordBreak:"break-all" }} title={row.imageUrlSrc}>{row.imageUrlSrc.length>48?row.imageUrlSrc.slice(0,45)+"…":row.imageUrlSrc}</span>
                    : row.src
                      ? <Badge color="green" sm>Embedded/uploaded</Badge>
                      : <Badge color="gray" sm>No photo</Badge>
                  }
                </div>,
                // Status
                <Badge color={stColor} sm>{row.status}</Badge>,
                // Message
                <span style={{ fontSize:11,color:row.status==="failed"?TH.red:TH.muted,maxWidth:180,display:"block" }}>{row.message}</span>,
                // Remap dropdown (shown for unmapped/failed only)
                (row.status !== "success")
                  ? <Sel
                      value={row.employeeId}
                      onChange={(e)=>setBulkItems((prev)=>prev.map((x)=>x.id===row.id?{...x,employeeId:e.target.value,status:e.target.value?"ready":"unmapped",message:e.target.value?"Remapped — ready":"Select employee"}:x))}
                      options={[{ value:"", label:"— link employee —" }, ...emps.map((e)=>({ value:e._id, label:`${e.name} (${e.employeeId||e._id})` }))]}
                      style={{ minWidth:180,fontSize:11 }}
                    />
                  : <Badge color="green" sm>✓ Done</Badge>
              ]
            };
          })}
          emptyIcon="📋"
          emptyText="No rows queued yet"
          loading={false}
        />
      </Card>
    </div>
  );

  const runLiveEnroll = async () => {
    try {
      show("Stand in front of the reader camera now…", "info");
      const r = await api.empLiveEnroll(emp._id);
      const rows = Array.isArray(r?.results) ? r.results : [];
      const okRows = rows.filter((x) => x?.ok);
      const total = rows.length || okRows.length || 1;
      const addedCount = okRows.filter((x) => x?.readerUserAdded !== false).length;
      const faceVerifiedCount = okRows.filter((x) => x?.faceSaved === true).length;
      if (okRows.length > 0) {
        if (addedCount === total && faceVerifiedCount === total) {
          show(
            `Employee added to reader(s) and face enrolled perfectly on ${faceVerifiedCount}/${total} reader(s).`,
            "success"
          );
          return;
        }
        show(
          `Reader update done: user added ${addedCount}/${total}, face verified ${faceVerifiedCount}/${total}.`,
          faceVerifiedCount > 0 ? "success" : "warning"
        );
        return;
      }
      const firstErr = rows.find((x) => !x?.ok)?.error;
      show(firstErr || r?.error || "Live enroll failed", "error");
    } catch (e) {
      show(e.message || "Live enroll failed", "error");
    }
  };

  return (
    <div>
      <PageHeader title="Face Enrollment" sub={`${emp?.name} · choose remote photo or live capture`}
        back="Employee List" onBack={()=>{setStep("select");setEmp(null);setPhotos([]);setActivePhotoIdx(0);setZoom(1);setPan({ x: 0, y: 0 });setResult(null);}}
        action={<Btn sz="sm" v="ghost" icon="📦" onClick={()=>{ setStep("bulk"); setBulkItems([]); setBulkSheetRows([]); setBulkSheetName(""); setBulkProgress({ done:0,total:0,label:"" }); }}>Bulk enroll (remote)</Btn>}
      />
      <GlassCard color={TH.blue} style={{ padding:"14px 16px",marginBottom:14 }}>
        <div style={{ fontSize:13,fontWeight:800,color:TH.text,marginBottom:8 }}>Two ways to enroll Visual Face</div>
        <div style={{ marginBottom:8 }}>
          <Badge color="green" sm>Photo-only access mode enabled (Face Only)</Badge>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,alignItems:"start" }}>
          <div>
            <Badge color="cyan" sm>① Remote / off-site</Badge>
          </div>
          <div>
            <Badge color="green" sm>② Live on reader</Badge>
            <div style={{ marginTop:10 }}>
              <Btn v="primary" sz="sm" icon="📷" onClick={runLiveEnroll}>Live enroll on device</Btn>
            </div>
          </div>
        </div>
      </GlassCard>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
        {/* Upload — remote Visual Face */}
        <Card>
          <div style={{ fontSize:13,fontWeight:700,color:TH.text,marginBottom:10 }}>Remote Visual Face — upload photo</div>
          <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:18,paddingBottom:14,borderBottom:`1px solid ${TH.border}` }}>
            <Avatar name={emp?.name} size={42} color={TH.blue} img={employeePhoto(emp)}/>
            <div><div style={{ fontWeight:700,color:TH.text }}>{emp?.name}</div><div style={{ fontSize:12,color:TH.muted }}>{[emp?.designation,emp?.department].filter(Boolean).join(" · ")}{(emp?.designation||emp?.department)?" · ":""}{emp?.employeeId||emp?._id}</div></div>
          </div>

          <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFile} style={{ display:"none" }}/>
          <div onClick={()=>!busy&&fileRef.current?.click()}
            onDragOver={(e)=>{ e.preventDefault(); e.stopPropagation(); }}
            onDrop={(e)=>{ e.preventDefault(); e.stopPropagation(); if (!busy) processEnrollmentFiles(e.dataTransfer?.files); }}
            style={{ padding:"28px 16px",background:TH.surface,border:`2px dashed ${activePhoto?TH.blue:TH.border}`,borderRadius:12,textAlign:"center",cursor:busy?"default":"pointer",marginBottom:14,transition:"all .15s" }}
            onMouseEnter={e=>{ if(!busy)e.currentTarget.style.borderColor=TH.blue; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=activePhoto?TH.blue:TH.border; }}>
            {busy?(
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:10 }}>
                <div style={{ width:40,height:40,border:`3px solid ${TH.border}`,borderTop:`3px solid ${TH.blue}`,borderRadius:"50%" }} className="spin"/>
                <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>Claude Vision Analyzing…</div>
                <div style={{ fontSize:12,color:TH.muted }}>Checking: real human · liveness · quality · anti-spoof · depth</div>
              </div>
            ):activePhoto?(
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:8 }}>
                <div
                  onClick={(ev) => ev.stopPropagation()}
                  onMouseDown={(ev) => {
                    ev.stopPropagation();
                    dragRef.current.dragging = true;
                    dragRef.current.startX = ev.clientX;
                    dragRef.current.startY = ev.clientY;
                    dragRef.current.baseX = pan.x;
                    dragRef.current.baseY = pan.y;
                  }}
                  style={{ width:150,height:170,overflow:"hidden",borderRadius:10,border:`2px solid ${TH.blue}`,boxShadow:`0 4px 20px ${TH.blueGlow}`,display:"flex",alignItems:"center",justifyContent:"center",background:TH.card,cursor:"grab" }}>
                  <img src={activePhoto.src} style={{ width:120,height:140,objectFit:"cover",borderRadius:10,transform:`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,transition:"transform .12s" }}/>
                </div>
                <div style={{ fontSize:12,color:TH.muted }}>Click to change</div>
                <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                  <Btn sz="xs" v="ghost" onClick={(ev)=>{ev.stopPropagation(); setZoom(z=>Math.max(0.8, Number((z-0.1).toFixed(2))));}}>−</Btn>
                  <span style={{ fontSize:11,color:TH.muted,minWidth:42,textAlign:"center" }}>{Math.round(zoom*100)}%</span>
                  <Btn sz="xs" v="ghost" onClick={(ev)=>{ev.stopPropagation(); setZoom(z=>Math.min(3, Number((z+0.1).toFixed(2))));}}>+</Btn>
                  <Btn sz="xs" v="ghost" onClick={(ev)=>{ev.stopPropagation(); setPan({ x: 0, y: 0 });}}>Reset</Btn>
                  <Btn sz="xs" v="ghost" onClick={(ev)=>{ev.stopPropagation(); downloadPhoto(activePhoto, activePhotoIdx);}}>Download</Btn>
                </div>
                {photos.length > 1 && (
                  <div style={{ display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center" }}>
                    {photos.map((p, i) => (
                      <div key={`${p.name}-${i}`} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:4 }}>
                        <img src={p.src} onClick={(ev)=>{ev.stopPropagation(); setActivePhotoIdx(i); setZoom(1); setPan({ x: 0, y: 0 });}}
                          style={{ width:34,height:40,objectFit:"cover",borderRadius:6,cursor:"pointer",border:`1px solid ${i===activePhotoIdx?TH.blue:TH.border}` }}/>
                        <button type="button" onClick={(ev)=>{ev.stopPropagation(); downloadPhoto(p, i);}}
                          style={{ fontSize:10,color:TH.blue,background:"transparent",border:"none",cursor:"pointer",padding:0,textDecoration:"underline" }}>
                          ↓
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize:11,color:TH.muted }}>{`${photos.length}/10 photos`}</div>
                <Btn sz="xs" v="ghost" disabled={photos.length >= 10} onClick={(ev)=>{ev.stopPropagation(); if (!busy && photos.length < 10) fileRef.current?.click();}}>Add Multiple Photos</Btn>
              </div>
            ):(
              <>
                <div style={{ fontSize:40,marginBottom:10,opacity:.15 }}>📷</div>
                <div style={{ fontSize:15,fontWeight:700,color:TH.text }}>Drop or click — JPG / PNG</div>
                <div style={{ fontSize:11,color:TH.muted,marginTop:6,maxWidth:280,marginLeft:"auto",marginRight:"auto",lineHeight:1.45 }}>
                  Raw face photo is normalized on the reader path through the gateway (see Suprema Visual Face workflow).
                </div>
              </>
            )}
          </div>

          {activePhoto&&!busy&&(
            <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
              <Btn full onClick={analyze} loading={busy}>Analyze Photo (Step 1)</Btn>
              <div style={{ fontSize:11,color:TH.muted,lineHeight:1.45 }}>
                Step 2 is in AI Analysis Result: click <b>Save &amp; push Visual Face to readers</b> to enroll on Suprema devices.
              </div>
            </div>
          )}

          <Card style={{ marginTop:12,padding:12,background:TH.surface }}>
            <div style={{ fontSize:12,fontWeight:700,color:TH.amber,marginBottom:7 }}>💡 Best results</div>
            {[
              "File format: JPG or PNG",
              "Photo size: 200 KB to 5 MB (recommended)",
              "Minimum resolution: 600 x 600 px",
              "Single frontal face, centered (no side angle)",
              "Even front lighting, no heavy shadows",
              "No sunglasses/mask; both eyes visible",
              "Neutral expression, recent photo (within 12 months)"
            ].map(s=>(
              <div key={s} style={{ fontSize:11,color:TH.muted,marginBottom:4,display:"flex",gap:7 }}><span style={{ color:TH.green }}>✓</span>{s}</div>
            ))}
          </Card>
        </Card>

        {/* Analysis result */}
        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>AI Analysis Result</div>
          {!result&&!busy&&<Empty icon="🤖" text="Upload and preview photo(s)"/>}
          {currentResult&&(
            <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
              {Array.isArray(result?.allResults) && result.allResults.length > 1 && (
                <Card style={{ padding:10,background:TH.surface }}>
                  <div style={{ fontSize:12,color:TH.muted,marginBottom:8 }}>Analyzed {result.allResults.length} photos</div>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6 }}>
                    {result.allResults.map((r, idx) => (
                      <button key={`${r._photoIdx}-${idx}`} onClick={() => { setActivePhotoIdx(r._photoIdx || 0); setZoom(1); setPan({ x: 0, y: 0 }); }}
                        style={{ border:`1px solid ${(r._photoIdx===activePhotoIdx)?TH.blue:TH.border}`,background:TH.card,color:TH.text,borderRadius:8,padding:"7px 8px",textAlign:"left",cursor:"pointer" }}>
                        <div style={{ fontSize:11,fontWeight:700 }}>{`Photo ${idx + 1} · ${r.verdict || "N/A"}`}</div>
                        <div style={{ fontSize:10,color:TH.muted }}>{`Q:${r.qualityScore||0} L:${r.livenessScore||0} D:${r.depthScore||0}`}</div>
                      </button>
                    ))}
                  </div>
                </Card>
              )}
              {/* Verdict */}
              <GlassCard color={VC[currentResult.verdict]||TH.muted} style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:16,fontWeight:800,color:VC[currentResult.verdict]||TH.muted,marginBottom:5,letterSpacing:"-.2px" }}>
                  {currentResult.verdict==="APPROVE"?"✓ APPROVED — Ready to enroll":currentResult.verdict==="CONDITIONAL"?"⚠ CONDITIONAL — Enroll with caution":currentResult.verdict==="FRAUD"?"🚨 FRAUD — Fake photo detected":"✗ REJECTED — Quality too low"}
                </div>
                {confidencePct != null && (
                  <div style={{ marginBottom:8 }}>
                    <Badge color={confidenceColor} sm>{`Consensus Confidence ${confidencePct}%`}</Badge>
                  </div>
                )}
                <div style={{ fontSize:13,color:TH.muted,lineHeight:1.65 }}>{currentResult.recommendation||currentResult.message}</div>
              </GlassCard>

              {/* Score bars */}
              {["qualityScore","livenessScore","depthScore"].filter(k=>currentResult[k]!=null).map(k=>(
                <Progress key={k} value={currentResult[k]} color={currentResult[k]>=85?TH.green:currentResult[k]>=65?TH.amber:TH.red}
                  label={k==="qualityScore"?"Quality Score":k==="livenessScore"?"Liveness Score":"Depth Score"}/>
              ))}

              {/* Check grid */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                {[
                  ["Real Human",    currentResult.isRealHuman,       currentResult.isRealHuman?"Confirmed":"Failed"],
                  ["Anti-Spoof",    !currentResult.isFakeDetected,   !currentResult.isFakeDetected?"Clean":currentResult.fakeType||"FAKE"],
                  ["Liveness",      currentResult.livenessScore>=70, currentResult.livenessScore?`${currentResult.livenessScore}%`:"—"],
                  ["Face Angle",    currentResult.angleAcceptable,   currentResult.faceAngle||"—"],
                  ["Lighting",      currentResult.lighting==="good", currentResult.lighting||"—"],
                  ["Sharpness",     currentResult.blur!=="blurry",   currentResult.blur||"—"],
                  ["Eyes",          currentResult.eyesVisible,       currentResult.eyesVisible?"Visible":"Hidden"],
                  ["Face Centered", currentResult.faceCentered,      currentResult.faceCentered?"Yes":"Off-center"],
                ].map(([k,ok,v])=>(
                  <div key={k} style={{ padding:"9px 11px",background:TH.surface,borderRadius:9,border:`1px solid ${ok?TH.green+"30":TH.redDim}` }}>
                    <div style={{ fontSize:10,color:TH.muted,marginBottom:3,textTransform:"uppercase",letterSpacing:".4px" }}>{k}</div>
                    <div style={{ fontSize:13,fontWeight:700,color:ok?TH.green:TH.red }}>{v}</div>
                  </div>
                ))}
              </div>

              {(currentResult.verdict==="APPROVE"||currentResult.verdict==="CONDITIONAL") ? (
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  <Btn v="success" full loading={saving} onClick={doEnroll} icon="✅">
                    Save &amp; push Visual Face to readers
                  </Btn>
                  {saving && (
                    <Card style={{ padding:10,background:TH.surface }}>
                      <Progress value={Math.max(0, Math.min(100, Number(enrollProgress?.pct || 0)))} color={TH.blue} label="Enrollment progress"/>
                      <div style={{ fontSize:11,color:TH.muted,marginTop:6 }}>{enrollProgress?.label || "Processing…"}</div>
                    </Card>
                  )}
                  <p style={{ fontSize:11,color:TH.muted,margin:0,lineHeight:1.45 }}>
                    Saves the photo to this employee, then runs G-SDK <b>Normalize → Extract → Enroll</b> on configured readers (requires gateway + sidecar).
                  </p>
                </div>
              ) : (
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  <Btn v="amber" full loading={saving} onClick={doEnroll} icon="⚠">Save Anyway (Override AI)</Btn>
                  {saving && (
                    <Card style={{ padding:10,background:TH.surface }}>
                      <Progress value={Math.max(0, Math.min(100, Number(enrollProgress?.pct || 0)))} color={TH.blue} label="Enrollment progress"/>
                      <div style={{ fontSize:11,color:TH.muted,marginTop:6 }}>{enrollProgress?.label || "Processing…"}</div>
                    </Card>
                  )}
                  <Btn v="ghost" full onClick={()=>{setPhotos([]);setActivePhotoIdx(0);setZoom(1);setPan({ x: 0, y: 0 });setResult(null);}}>↺ Upload Different Photo</Btn>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FOOTPRINTS — Graphics-based movement history
═══════════════════════════════════════════════════════════════════════ */
function FootprintsPage() {
  const [type,     setType]    = useState("employee");
  const [search,   setSearch]  = useState("");
  const [selId,    setSelId]   = useState(null);
  const [selName,  setSelName] = useState("");
  const [view,     setView]    = useState("timeline");
  const [fpFrom,   setFpFrom]  = useState(""); // ISO yyyy-mm-dd
  const [fpTo,     setFpTo]    = useState("");   // ISO yyyy-mm-dd

  const { data:eData, loading:eLoad } = useFetch(()=>api.employees({limit:60,search,status:"active"}),[search],{employees:[]});
  const { data:vData, loading:vLoad } = useFetch(()=>api.visitors({limit:60,search}),[search],{visitors:[]});
  const list = (type==="employee"?eData?.employees:vData?.visitors)||[];
  const listLoad = type==="employee"?eLoad:vLoad;

  const { data:fp, loading:fpLoad } = useFetch(()=>{
    if(!selId) return Promise.resolve(null);
    return type==="employee"?api.empFootprint(selId):api.visitorFootprint(selId);
  },[selId,type],null);

  const trailRaw  = fp?.trail     ||[];
  const trail = useMemo(() => {
    if (!fpFrom && !fpTo) return trailRaw;
    return trailRaw.filter(ev => {
      const ts = ev.timestamp || ev.ts;
      if (!ts) return true;
      const d = new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
      if (fpFrom && d < fpFrom) return false;
      if (fpTo   && d > fpTo)   return false;
      return true;
    });
  }, [trailRaw, fpFrom, fpTo]);
  const zones    = fp?.zones     ||[];
  const hourDist = fp?.hourlyDist||[];
  const stats    = fp?.stats     ||{};
  const fpPhoto = ev => ev?.photo || ev?.photoUrl || ev?.image || ev?.imageUrl || ev?.facePhoto || ev?.faceImage || ev?.snapshot || ev?.snapshotUrl || ev?.capture || ev?.captureUrl || null;
  const personPhoto = p => p?.photo || p?.photoUrl || p?.image || p?.imageUrl || p?.facePhoto || p?.faceImage || p?.snapshot || p?.snapshotUrl || null;
  const selectedPerson = list.find(x => x?._id === selId) || null;

  return (
    <div style={{ display:"flex",height:"calc(100vh - 120px)",gap:16,overflow:"hidden" }}>
      {/* Left list */}
      <div style={{ width:235,flexShrink:0,display:"flex",flexDirection:"column",gap:10 }}>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["employee","Employees"],["visitor","Visitors"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setType(v);setSelId(null);}} style={{ flex:1,padding:"7px 0",fontSize:12,fontWeight:600,background:type===v?TH.blue:"transparent",color:type===v?"#fff":TH.muted,border:"none",cursor:"pointer" }}>{l}</button>
          ))}
        </div>
        <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"/>
        <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:5 }}>
          {listLoad?<Loader/>:list.length===0?<Empty icon="👥" text="No results"/>:list.map(item=>{
            const id=item._id, nm=item.name||"Unknown";
            const on=selId===id;
            return (
              <div key={id} onClick={()=>{setSelId(id);setSelName(nm);}}
                style={{ display:"flex",gap:9,alignItems:"center",padding:"9px 11px",background:on?TH.blueDim:TH.card,border:`1.5px solid ${on?TH.blue:TH.border}`,borderRadius:10,cursor:"pointer",transition:"all .12s" }}>
                {personPhoto(item)
                  ? <img src={personPhoto(item)} alt={nm} style={{ width:52,height:62,borderRadius:9,objectFit:"cover",objectPosition:"top center",border:`1px solid ${TH.border}`,flexShrink:0 }}/>
                  : <Avatar name={nm} size={42} color={on?TH.blue:TH.muted}/>}
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:12,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{nm}</div>
                  <div style={{ fontSize:10,color:TH.muted }}>{item.department||item.company||"—"}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right content */}
      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden" }}>
        {!selId?(
          <Card style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <Empty icon="👣" text="Select a person to see their movement trail" sub="Full timeline · Zone visits · Hourly heatmap · AI behavior analysis"/>
          </Card>
        ):(
          <>
            {/* Header */}
            <Card pad={16} style={{ marginBottom:14,flexShrink:0 }}>
              <div style={{ display:"flex",gap:12,alignItems:"center" }}>
                {personPhoto(selectedPerson)
                  ? <img src={personPhoto(selectedPerson)} alt={selName} style={{ width:64,height:76,borderRadius:10,objectFit:"cover",objectPosition:"top center",border:`1px solid ${TH.border}` }}/>
                  : <Avatar name={selName} size={64} color={TH.blue}/>}
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:17,fontWeight:800,color:TH.text,letterSpacing:"-.3px" }}>{selName}</div>
                  <div style={{ fontSize:12,color:TH.muted,marginBottom:8 }}>{fNum(stats.total||trailRaw.length)} total · {fNum(trail.length)} shown · {stats.granted||0} granted · {stats.denied||0} denied{zones[0]?` · Most visited: ${zones[0].zone}`:""}</div>
                  <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
                    <span style={{ fontSize:11,color:TH.muted,fontWeight:600 }}>From</span>
                    <input type="date" value={fpFrom} onChange={e=>{setFpFrom(e.target.value);}} title="From date"
                      style={{ padding:"5px 8px",borderRadius:7,fontSize:12,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}/>
                    <span style={{ fontSize:11,color:TH.muted,fontWeight:600 }}>To</span>
                    <input type="date" value={fpTo} onChange={e=>{setFpTo(e.target.value);}} min={fpFrom||undefined} title="To date"
                      style={{ padding:"5px 8px",borderRadius:7,fontSize:12,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:"pointer" }}/>
                    {(fpFrom||fpTo)&&<Btn v="ghost" sz="xs" onClick={()=>{setFpFrom("");setFpTo("");}}>Clear</Btn>}
                  </div>
                </div>
                <div style={{ display:"flex",gap:0,border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden",alignSelf:"flex-start" }}>
                  {[["timeline","⟳ Timeline"],["zones","📍 Zones"],["heatmap","🌡 Heatmap"],["behavior","✦ AI Profile"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setView(v)} style={{ padding:"7px 13px",fontSize:11,fontWeight:600,background:view===v?TH.blue:"transparent",color:view===v?"#fff":TH.muted,border:"none",cursor:"pointer" }}>{l}</button>
                  ))}
                </div>
              </div>
            </Card>

            {/* Stats mini row */}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14,flexShrink:0 }}>
              {[["Events",stats.total||trail.length,TH.blue],["Granted",stats.granted||0,TH.green],["Denied",stats.denied||0,TH.red],["Zones",zones.length,TH.violet]].map(([l,v,c])=>(
                <Card key={l} pad={12} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:24,fontWeight:800,color:c,fontFamily:TH.mono,lineHeight:1 }}>{v}</div>
                  <div style={{ fontSize:11,color:TH.muted,marginTop:3 }}>{l}</div>
                </Card>
              ))}
            </div>

            {fpLoad?<Loader text="Loading trail…"/>:(
              <div style={{ flex:1,overflowY:"auto" }}>
                {/* Timeline */}
                {view==="timeline"&&(
                  trail.length===0?<Empty icon="👣" text="No movement recorded"/>:(
                    <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                      {trail.map((ev,i)=>{
                        const ok=ev.accessGranted??ev.granted;
                        return (
                          <div key={(ev._id||i)+i} style={{ display:"flex",gap:12,padding:"10px 14px",background:TH.card,borderRadius:10,border:`1px solid ${TH.border}`,alignItems:"center" }}>
                            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:2,flexShrink:0 }}>
                              <div style={{ width:10,height:10,borderRadius:"50%",background:ok?TH.green:TH.red,boxShadow:`0 0 6px ${ok?TH.green:TH.red}` }}/>
                              {i<trail.length-1&&<div style={{ width:1,height:20,background:TH.border }}/>}
                            </div>
                            {fpPhoto(ev)
                              ? <img src={fpPhoto(ev)} alt={selName||"photo"} style={{ width:52,height:60,borderRadius:9,objectFit:"cover",objectPosition:"top center",border:`1px solid ${TH.border}`,flexShrink:0 }}/>
                              : <Avatar name={selName||"?"} size={48} color={ok?TH.green:TH.red}/>}
                            <div style={{ flex:1,minWidth:0 }}>
                              <div style={{ display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",marginBottom:3 }}>
                                <span style={{ fontSize:13,fontWeight:700,color:TH.text }}>📍 {ev.zone||"—"}</span>
                                {ev.direction&&<Badge color={ev.direction==="IN"?"green":"amber"} sm>{ev.direction}</Badge>}
                                <Badge color="blue" sm>{ev.authMode||"—"}</Badge>
                                {ok?<Badge color="green" sm>✓</Badge>:<Badge color="red" sm>✗</Badge>}
                              </div>
                              <div style={{ fontSize:11,color:TH.muted }}>{ev.deviceName||"—"} · {ev.processingMs?`${ev.processingMs}ms`:"—"} · {ev.confidence?`${ev.confidence}% conf`:"—"}</div>
                            </div>
                            <span style={{ fontSize:11,color:TH.muted,fontFamily:TH.mono,flexShrink:0 }}>{fDT(ev.timestamp||ev.ts)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}

                {/* Zones */}
                {view==="zones"&&(
                  zones.length===0?<Empty icon="📍" text="No zone data"/>:(
                    <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
                      {zones.map((z,i)=>(
                        <Card key={z.zone} pad={14}>
                          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                            <div style={{ display:"flex",gap:10,alignItems:"center" }}>
                              <div style={{ width:34,height:34,borderRadius:"50%",background:TH.blueDim,border:`1px solid ${TH.blue}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800,color:TH.blue }}>#{i+1}</div>
                              <div>
                                <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>📍 {z.zone}</div>
                                <div style={{ fontSize:11,color:TH.muted }}>{z.firstVisit?`First: ${fD(z.firstVisit)}`:"—"} · {z.lastVisit?`Last: ${fRel(z.lastVisit)}`:"—"}</div>
                              </div>
                            </div>
                            <div style={{ display:"flex",gap:6 }}>
                              {z.ins!=null&&<Badge color="green" sm>↓{z.ins} IN</Badge>}
                              {z.outs!=null&&<Badge color="amber" sm>↑{z.outs} OUT</Badge>}
                              <Badge color="blue" sm>{z.count||z.total||0} total</Badge>
                            </div>
                          </div>
                          <Progress value={z.count||z.total||0} max={zones[0]?.count||zones[0]?.total||1} color={TH.blue}/>
                        </Card>
                      ))}
                    </div>
                  )
                )}

                {/* Heatmap */}
                {view==="heatmap"&&(
                  <Card>
                    <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Access by Hour of Day</div>
                    {hourDist.length===0?<Empty icon="🕐" text="No hourly data"/>:(
                      <div style={{ height:280 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={hourDist} margin={{top:4,right:4,left:-20,bottom:0}} barSize={18}>
                            <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                            <XAxis dataKey="hour" tick={{fill:TH.muted,fontSize:10}} interval={3}/>
                            <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                            <Tooltip contentStyle={TT_STYLE} itemStyle={TT_ITEM_STYLE} labelStyle={TT_LABEL_STYLE}/>
                            <Bar dataKey="count" name="Events" radius={[4,4,0,0]}>
                              {hourDist.map((_,i)=>{
                                const max=Math.max(...hourDist.map(d=>d.count||0))||1;
                                const pct=(hourDist[i]?.count||0)/max;
                                return <Cell key={i} fill={TH.blue} opacity={0.3+0.7*pct}/>;
                              })}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                    {stats.peakHour!=null&&(
                      <GlassCard color={TH.blue} style={{ marginTop:12,padding:"9px 14px" }}>
                        <span style={{ fontSize:12,color:TH.blue,fontWeight:600 }}>Peak hour: {String(stats.peakHour).padStart(2,"0")}:00 — {stats.peakCount||0} events</span>
                      </GlassCard>
                    )}
                  </Card>
                )}

                {/* AI Behavior Profile */}
                {view==="behavior"&&(
                  <AIBehaviorProfile empId={selId} type={type} name={selName}/>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ALERTS
═══════════════════════════════════════════════════════════════════════ */
function AlertsPage() {
  const { show } = useToast();
  const [filter, setFilter] = useState("open");
  const { data, loading, reload } = useFetch(()=>api.alerts(),[],[]);
  const alerts = data||[];

  const syncSidebarAlerts = () => window.dispatchEvent(new Event("acs:alerts-updated"));
  const ack     = async id=>{ try{await api.alertAck(id);show("Acknowledged","success");await reload();syncSidebarAlerts();}catch(e){show(e.message,"error");} };
  const resolve = async id=>{ try{await api.alertResolve(id);show("Resolved","success");await reload();syncSidebarAlerts();}catch(e){show(e.message,"error");} };

  const shown =
    filter==="all" ? alerts
    : filter==="reviewing" ? alerts.filter(isAlertReviewingTab)
    : alerts.filter(a=>a.status===filter);
  const sColor= s=>({critical:TH.red,high:TH.amber,medium:TH.blue,low:TH.muted})[s]||TH.muted;

  return (
    <div>
      <PageHeader title="Security Alerts" action={<Btn v="ghost" sz="sm" onClick={async()=>{await reload();syncSidebarAlerts();}}>⟳ Refresh</Btn>}/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="🚨" label="Critical" value={alerts.filter(a=>a.severity==="critical"&&a.status!=="resolved").length} color={TH.red}/>
        <StatCard icon="⚠"  label="High"    value={alerts.filter(a=>a.severity==="high"&&a.status!=="resolved").length}     color={TH.amber}/>
        <StatCard icon="🔓" label="Open"    value={alerts.filter(a=>a.status==="open").length}                               color={TH.blue}/>
        <StatCard icon="✅" label="Resolved"value={alerts.filter(a=>a.status==="resolved").length}                          color={TH.green}/>
      </div>
      <Tabs active={filter} onChange={setFilter} items={[{id:"all",label:"All",count:alerts.length},{id:"open",label:"Open",count:alerts.filter(a=>a.status==="open").length},{id:"reviewing",label:"Reviewing",count:alerts.filter(isAlertReviewingTab).length},{id:"resolved",label:"Resolved",count:alerts.filter(a=>a.status==="resolved").length}]}/>
      {loading?<Loader/>:shown.length===0?<Empty icon="✅" text="No alerts in this category"/>:(
        <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
          {shown.map(a=>(
            <Card key={a._id||a.id} pad={0} style={{ overflow:"hidden" }}>
              <div style={{ display:"flex" }}>
                <div style={{ width:4,background:sColor(a.severity),flexShrink:0 }}/>
                <div style={{ flex:1,padding:"13px 16px",display:"flex",gap:12,alignItems:"flex-start" }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",marginBottom:6 }}>
                      <Badge color={{critical:"red",high:"amber",medium:"blue",low:"gray"}[a.severity]||"gray"}>{a.severity}</Badge>
                      {stBadge(a.status)}
                      <span style={{ fontSize:14,fontWeight:700,color:TH.text }}>{a.type}</span>
                    </div>
                    <div style={{ fontSize:13,color:TH.muted,lineHeight:1.65,marginBottom:5 }}>{a.message}</div>
                    <div style={{ display:"flex",gap:12,fontSize:11,color:TH.muted,flexWrap:"wrap" }}>
                      {a.zone&&<span>📍 {a.zone}</span>}
                      {a.device&&<span>◫ {a.device}</span>}
                      <span>🕐 {fRel(a.createdAt||a.ts)}</span>
                    </div>
                  </div>
                  <div style={{ display:"flex",gap:6,flexShrink:0 }}>
                    {String(a.status||"").toLowerCase()==="open"&&<Btn v="amber" sz="xs" onClick={()=>ack(a._id||a.id)}>Ack</Btn>}
                    {a.status!=="resolved"&&<Btn v="success" sz="xs" onClick={()=>resolve(a._id||a.id)}>Resolve</Btn>}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AIBehaviorProfile({ empId, type, name }) {
  const { show } = useToast();
  const { data, loading, error } = useFetch(()=>api.aiBehaviorProfile(empId,type),[empId,type],null);

  if (loading) return <Loader text="AI analyzing behavior profile…"/>;
  if (error) return <Empty icon="✦" text="AI analysis unavailable" sub={error}/>;
  if (!data) return <Empty icon="✦" text="No behavior data" sub="Need more access events to generate profile"/>;

  const riskColor = data.riskScore>=70?TH.red:data.riskScore>=40?TH.amber:TH.green;

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
      <GlassCard color={TH.violet} style={{ padding:"16px 18px" }}>
        <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
          <div style={{ fontSize:28 }}>✦</div>
          <div>
            <div style={{ fontSize:14,fontWeight:700,color:TH.violet,marginBottom:5 }}>AI Behavior Profile — {name}</div>
            <div style={{ fontSize:13,color:TH.muted,lineHeight:1.7 }}>{data.summary}</div>
          </div>
        </div>
      </GlassCard>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        <Card pad={14}>
          <div style={{ fontSize:12,fontWeight:700,color:TH.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10 }}>Behavior Risk Score</div>
          <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:12 }}>
            <div style={{ width:56,height:56,borderRadius:"50%",background:`${riskColor}15`,border:`2px solid ${riskColor}30`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
              <div style={{ fontSize:18,fontWeight:800,color:riskColor,fontFamily:TH.mono,lineHeight:1 }}>{data.riskScore}</div>
              <div style={{ fontSize:8,color:TH.muted }}>/ 100</div>
            </div>
            <div>
              <Badge color={data.riskScore>=70?"red":data.riskScore>=40?"amber":"green"}>{data.riskScore>=70?"HIGH RISK":data.riskScore>=40?"MEDIUM":"LOW RISK"}</Badge>
              <div style={{ fontSize:11,color:TH.muted,marginTop:4 }}>{data.riskReason||"Normal behavior"}</div>
            </div>
          </div>
        </Card>
        <Card pad={14}>
          <div style={{ fontSize:12,fontWeight:700,color:TH.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10 }}>Behavioral Patterns</div>
          {(data.patterns||[]).map((p,i)=>(
            <div key={i} style={{ display:"flex",gap:8,alignItems:"flex-start",marginBottom:8 }}>
              <span style={{ color:p.anomaly?TH.amber:TH.green,flexShrink:0 }}>{p.anomaly?"⚠":"✓"}</span>
              <span style={{ fontSize:12,color:TH.muted,lineHeight:1.5 }}>{p.description}</span>
            </div>
          ))}
        </Card>
      </div>

      {data.anomalies?.length>0&&(
        <Card pad={14}>
          <div style={{ fontSize:12,fontWeight:700,color:TH.amber,marginBottom:10 }}>⚠ Detected Anomalies</div>
          {data.anomalies.map((a,i)=>(
            <div key={i} style={{ padding:"8px 10px",background:TH.amberDim,borderRadius:8,border:`1px solid ${TH.amber}20`,marginBottom:6 }}>
              <div style={{ fontSize:13,fontWeight:600,color:TH.amber,marginBottom:2 }}>{a.type}</div>
              <div style={{ fontSize:12,color:TH.muted }}>{a.description}</div>
            </div>
          ))}
        </Card>
      )}

      {data.recommendations?.length>0&&(
        <Card pad={14}>
          <div style={{ fontSize:12,fontWeight:700,color:TH.blue,marginBottom:10 }}>✦ AI Recommendations</div>
          {data.recommendations.map((r,i)=>(
            <div key={i} style={{ display:"flex",gap:8,marginBottom:6 }}>
              <span style={{ color:TH.blue,flexShrink:0 }}>→</span>
              <span style={{ fontSize:12,color:TH.muted,lineHeight:1.5 }}>{r}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   VISITORS
═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   COMPANIES — Tenant / Organization Management (supports 100+ companies)
═══════════════════════════════════════════════════════════════════════ */
function CompaniesPage() {
  const { show } = useToast();
  const [search, setSearch]   = useState("");
  const [status, setStatus]   = useState("all");
  const [page,   setPage]     = useState(1);
  const [add,    setAdd]      = useState(false);
  const [editing,setEditing]  = useState(null);
  const [del,    setDel]      = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkRef = useRef(null);
  const PER = 25;

  const [form, setForm] = useState({
    name:"", code:"", contactName:"", contactEmail:"", contactPhone:"",
    address:"", status:"active", notes:""
  });

  const pp = useMemo(() => {
    const p = { page, limit:PER };
    if (search.trim()) p.q = search.trim();
    if (status !== "all") p.status = status;
    return p;
  }, [page, search, status]);

  const { data, loading, reload } = useFetch(()=>api.companies(pp), [page, search, status], { companies:[], total:0 });
  const companies = data?.companies || [];

  const resetForm = () => setForm({ name:"", code:"", contactName:"", contactEmail:"", contactPhone:"", address:"", status:"active", notes:"" });

  const openAdd = () => { resetForm(); setEditing(null); setAdd(true); };
  const openEdit = (c) => {
    setForm({
      name: c.name || "", code: c.code || "",
      contactName: c.contactName || "", contactEmail: c.contactEmail || "",
      contactPhone: c.contactPhone || "", address: c.address || "",
      status: c.status || "active", notes: c.notes || ""
    });
    setEditing(c);
    setAdd(true);
  };

  const save = async () => {
    if (!form.name.trim()) { show("Company name is required", "error"); return; }
    try {
      if (editing) {
        await api.companyUpdate(editing._id, form);
        show("Company updated", "success");
      } else {
        await api.companyCreate(form);
        show("Company added", "success");
      }
      setAdd(false);
      setEditing(null);
      reload();
    } catch (e) { show(e?.message || "Save failed", "error"); }
  };

  const remove = async () => {
    if (!del) return;
    try {
      await api.companyDelete(del._id);
      show("Company deleted", "success");
      setDel(null);
      reload();
    } catch (e) { show(e?.message || "Delete failed", "error"); }
  };

  const downloadSample = async () => {
    try {
      const XLSX = await import("xlsx");
      const rows = [
        { "Company Name":"Expo City Authority", "Code":"ECA", "Contact Name":"Ahmed Al Mansouri", "Contact Email":"ahmed@expocity.ae", "Contact Phone":"+971501234567", "Address":"Expo City Dubai, UAE", "Status":"active", "Notes":"Anchor tenant" },
        { "Company Name":"DP World",              "Code":"DPW", "Contact Name":"Fatima Hassan",     "Contact Email":"fatima@dpworld.com", "Contact Phone":"+971502234567", "Address":"Jebel Ali, Dubai",     "Status":"active", "Notes":"" }
      ];
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{ wch:30 },{ wch:10 },{ wch:24 },{ wch:30 },{ wch:18 },{ wch:36 },{ wch:10 },{ wch:30 }];
      const note = XLSX.utils.aoa_to_sheet([
        ["Companies Bulk Import Template"], [""],
        ["REQUIRED:"], ["  • Company Name — unique name"], [""],
        ["OPTIONAL:"],
        ["  • Code — short identifier (e.g. ECA, DPW)"],
        ["  • Contact Name / Email / Phone"],
        ["  • Address"],
        ["  • Status — active | inactive | suspended  (default: active)"],
        ["  • Notes — free text"], [""],
        ["BEHAVIOR: Duplicates by name are updated (upsert)."]
      ]);
      note["!cols"] = [{ wch:80 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws,   "Companies");
      XLSX.utils.book_append_sheet(wb, note, "Instructions");
      const out = XLSX.write(wb, { type:"array", bookType:"xlsx" });
      const blob = new Blob([out], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const href = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = href; a.download = "companies-template.xlsx";
        document.body.appendChild(a); a.click(); a.remove();
      } finally { URL.revokeObjectURL(href); }
    } catch (e) { show(e?.message || "Download failed", "error"); }
  };

  const handleBulkFile = async (file) => {
    if (!file) return;
    setBulkBusy(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type:"array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { defval:"" });
      const rows = raw.map(r => ({
        name:         String(r["Company Name"] || r.name || "").trim(),
        code:         String(r["Code"] || r.code || "").trim(),
        contactName:  String(r["Contact Name"]  || r.contactName  || "").trim(),
        contactEmail: String(r["Contact Email"] || r.contactEmail || "").trim(),
        contactPhone: String(r["Contact Phone"] || r.contactPhone || "").trim(),
        address:      String(r["Address"] || r.address || "").trim(),
        status:       String(r["Status"]  || r.status  || "active").toLowerCase().trim() || "active",
        notes:        String(r["Notes"]   || r.notes   || "").trim()
      })).filter(r => r.name);
      if (!rows.length) { show("No valid rows found in sheet", "error"); return; }
      const res = await api.companyBulk(rows);
      const msg = `Imported ${rows.length} rows · Created: ${res?.inserted||0} · Updated: ${res?.updated||0}${res?.errors?.length?` · Errors: ${res.errors.length}`:""}`;
      show(msg, res?.errors?.length ? "warning" : "success");
      reload();
    } catch (e) { show(e?.message || "Bulk import failed", "error"); }
    finally { setBulkBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Companies" sub={`${fNum(data?.total||0)} organizations registered`}
        action={
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            <input ref={bulkRef} type="file" accept=".xlsx,.xls,.csv" style={{ display:"none" }}
              onChange={e=>{ handleBulkFile(e.target.files?.[0]); e.target.value=""; }}/>
            <Btn v="ghost" sz="sm" onClick={downloadSample}>⬇ Sample</Btn>
            <Btn v="secondary" sz="sm" loading={bulkBusy} onClick={()=>bulkRef.current?.click()}>📋 Bulk Import</Btn>
            <Btn icon="+" onClick={openAdd}>Add Company</Btn>
          </div>
        }/>

      {/* Stats */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="🏢" label="Total"     value={data?.total||0}                                       color={TH.blue}/>
        <StatCard icon="✅" label="Active"    value={companies.filter(c=>c.status==="active").length}     color={TH.green}/>
        <StatCard icon="⏸"  label="Inactive"  value={companies.filter(c=>c.status==="inactive").length}   color={TH.muted}/>
        <StatCard icon="🚫" label="Suspended" value={companies.filter(c=>c.status==="suspended").length}  color={TH.red}/>
      </div>

      {/* Filters */}
      <div style={{ display:"flex",gap:8,marginBottom:16,flexWrap:"wrap" }}>
        <SearchBar value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}
          placeholder="Search by name, code, contact…" style={{ width:280 }}/>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["active","Active"],["inactive","Inactive"],["suspended","Suspended"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setStatus(v);setPage(1);}}
              style={{ padding:"7px 13px",fontSize:12,fontWeight:600,background:status===v?TH.blue:"transparent",color:status===v?"#fff":TH.muted,border:"none",cursor:"pointer" }}>{l}</button>
          ))}
        </div>
        <Btn v="ghost" sz="xs" onClick={reload}>⟳</Btn>
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading}
          headers={["#","Company","Code","Contact","Email","Phone","Status","Employees","Actions"]}
          rows={companies.map((c, idx)=>({
            key:c._id, c,
            cells:[
              <span style={{ fontSize:11,color:TH.muted,fontFamily:TH.mono }}>{(page-1)*PER + idx + 1}</span>,
              <div>
                <div style={{ fontWeight:700,color:TH.text }}>{c.name}</div>
                {c.address && <div style={{ fontSize:11,color:TH.muted,marginTop:2 }}>{c.address}</div>}
              </div>,
              <span style={{ fontSize:11,fontFamily:TH.mono,color:TH.cyan }}>{c.code||"—"}</span>,
              c.contactName || "—",
              c.contactEmail ? <span style={{ fontSize:12,color:TH.text }}>{c.contactEmail}</span> : "—",
              c.contactPhone ? <span style={{ fontSize:12,fontFamily:TH.mono }}>{c.contactPhone}</span> : "—",
              stBadge(c.status||"active"),
              <Badge color="blue" sm>{fNum(c.employeeCount||0)}</Badge>,
              <div style={{ display:"flex",gap:5 }} onClick={e=>e.stopPropagation()}>
                <Btn v="ghost" sz="xs" onClick={()=>openEdit(c)}>Edit</Btn>
                <Btn v="destructive" sz="xs" onClick={()=>setDel(c)}>Delete</Btn>
              </div>
            ]
          }))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>

      {/* Add / Edit modal */}
      {add && (
        <Modal title={editing?"Edit Company":"Add Company"} onClose={()=>{setAdd(false);setEditing(null);}} width={620}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
            <Btn v="ghost" onClick={()=>{setAdd(false);setEditing(null);}}>Cancel</Btn>
            <Btn onClick={save}>{editing?"Save Changes":"Create Company"}</Btn>
          </div>}>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
            <Field label="Company Name" required>
              <Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full company name"/>
            </Field>
            <Field label="Code" hint="Short identifier (3–6 chars)">
              <Input value={form.code} onChange={e=>setForm(p=>({...p,code:e.target.value.toUpperCase()}))} placeholder="e.g. ECA"/>
            </Field>
            <Field label="Contact Name">
              <Input value={form.contactName} onChange={e=>setForm(p=>({...p,contactName:e.target.value}))} placeholder="Primary contact"/>
            </Field>
            <Field label="Contact Email">
              <Input value={form.contactEmail} onChange={e=>setForm(p=>({...p,contactEmail:e.target.value}))} type="email" placeholder="contact@company.com"/>
            </Field>
            <Field label="Contact Phone">
              <Input value={form.contactPhone} onChange={e=>setForm(p=>({...p,contactPhone:e.target.value}))} placeholder="+971 50 123 4567"/>
            </Field>
            <Field label="Status">
              <Sel value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))}
                options={[{value:"active",label:"Active"},{value:"inactive",label:"Inactive"},{value:"suspended",label:"Suspended"}]}/>
            </Field>
            <Field label="Address" style={{ gridColumn:"1/-1" }}>
              <Input value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))} placeholder="Building, district, city"/>
            </Field>
            <Field label="Notes" style={{ gridColumn:"1/-1" }}>
              <Textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="Additional info"/>
            </Field>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {del && (
        <Modal title="Delete Company?" onClose={()=>setDel(null)} width={460}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
            <Btn v="ghost" onClick={()=>setDel(null)}>Cancel</Btn>
            <Btn v="danger" onClick={remove}>Delete</Btn>
          </div>}>
          <p style={{ color:TH.text }}>
            Are you sure you want to delete <b>{del.name}</b>?
          </p>
          {del.employeeCount > 0 && (
            <p style={{ color:TH.amber, marginTop:10, fontSize:13 }}>
              ⚠ {del.employeeCount} employee(s) are linked to this company. Reassign them first or the delete will fail.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

function VisitorsPage({ onNav, onEnroll }) {
  const { show } = useToast();
  const [filter, setFilter] = useState("all");
  const [page,   setPage]   = useState(1);
  const [add,    setAdd]    = useState(false);
  const [search, setSearch] = useState("");
  const [sel,    setSel]    = useState(null);
  const [fp,     setFp]     = useState([]);
  const [fpLoading, setFpLoading] = useState(false);
  const [form,   setForm]   = useState({
    visitorName:"",
    company:"",
    visitorEmail:"",
    passNumber:"",
    employeePhotoUrl:"",
    employeePhotoFileName:"",
    employeePhotoData:"",
    visitingDepartment:"",
    employeeTag:"",
    visitorMobileCountryCode:"+971",
    visitorMobile:"",
    startDate:"",
    endDate:"",
    visitTime:"",
    visitingLocation:"",
    visitingPersonName:"",
    visitingPersonEmail:"",
    purpose:"Meeting",
    visitorPhotoUrl:"",
    visitorPhotoFileName:"",
    visitorPhotoData:""
  });
  const [touched, setTouched] = useState({});
  const [attemptedAdd, setAttemptedAdd] = useState(false);
  const markTouched = (k) => setTouched((p) => ({ ...p, [k]: true }));
  const emailOk = (value = "") => /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(String(value).trim());
  const formatDateDMY = (value = "") => {
    const digits = String(value).replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const isoToDMY = (iso = "") => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y.slice(-2)}`;
  };
  const dmyToISO = (dmy = "") => {
    const m = String(dmy).trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return "";
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const dateOk = (v) => Boolean(dmyToISO(v));
  const timeOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "").trim());
  const toDate = (v) => {
    const m = String(v || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return new Date(`${yyyy}-${m[2]}-${m[1]}T00:00:00`);
  };
  const formatVisitorNational = (cc, raw) =>
    cc === "+971" ? formatUaeMobile(raw) : String(raw || "").replace(/\D/g, "").slice(0, 15);
  const visitorMobileOk = (cc, national) => {
    const n = String(national || "").trim();
    if (!n) return false;
    if (cc === "+971") return isUaeMobileNationalValid(n);
    const d = n.replace(/\D/g, "");
    return d.length >= 7 && d.length <= 15;
  };
  const onPhotoPick = (keyData, keyName) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      show("Please select an image file", "warning");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      show("Photo size must be under 10MB", "warning");
      return;
    }
    try {
      const src = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ""));
        r.onerror = () => reject(new Error("Failed to read image"));
        r.readAsDataURL(file);
      });
      setForm((p) => ({ ...p, [keyData]: src, [keyName]: file.name }));
      markTouched(keyData);
    } catch (err) {
      show(err.message, "error");
    } finally {
      e.target.value = "";
    }
  };
  const PER = 15;

  const pp = { page, limit:PER, ...(filter!=="all"&&{status:filter}) };
  const { data, loading, reload } = useFetch(()=>api.visitors(pp),[page,filter],{visitors:[],total:0});
  const { data:eData } = useFetch(()=>api.employees({limit:60}),[],{employees:[]});
  const normVs = s => ({ checked_in:"checked-in", checked_out:"checked-out", pending:"expected", checkedin:"checked-in", checkedout:"checked-out", suspended:"suspended" }[String(s||"").toLowerCase()] || s || "expected");
  const visitors = (data?.visitors||[]).map(v=>({ ...v, status:normVs(v.status) }));
  const visitorPhoto = v => v?.photo || v?.photoUrl || v?.image || v?.imageUrl || null;
  const pickTs = (...vals) => vals.find(Boolean) || null;
  const checkInAt = v => pickTs(v?.checkInAt, v?.checkedInAt, v?.inAt, v?.entryAt, v?.checkinAt);
  const checkOutAt = v => pickTs(v?.checkOutAt, v?.checkedOutAt, v?.outAt, v?.exitAt, v?.checkoutAt);
  const visitorDur = v => {
    const iat = checkInAt(v);
    if (!iat) return "—";
    const oat = checkOutAt(v);
    if (v.status === "checked-in" || !oat) return fDur(iat);
    return fDur(iat, oat);
  };
  const shown = visitors.filter(v => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [v.name, v.company, v.host, v.purpose, v.email, v.phone].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
  const emps     = eData?.employees||[];
  const fieldErrors = useMemo(() => {
    const err = {};
    const req = [
      ["visitorName", "Visitor Name is required"],
      ["company", "Company is required"],
      ["visitorEmail", "Visitor Email is required"],
      ["passNumber", "Pass Number is required"],
      ["visitingDepartment", "Visiting Department is required"],
      ["employeeTag", "Employee Tag is required"],
      ["visitorMobile", "Visitor Mobile Number is required"],
      ["startDate", "Start Date is required"],
      ["endDate", "End Date is required"],
      ["visitTime", "Visiting Time is required"],
      ["visitingLocation", "Visiting Location is required"],
      ["visitingPersonName", "Visiting Person Name is required"],
      ["visitingPersonEmail", "Visiting Person Email ID is required"],
      ["purpose", "Purpose is required"],
    ];
    for (const [k, msg] of req) {
      if (!String(form[k] || "").trim()) err[k] = msg;
    }
    if (!err.visitorEmail && !emailOk(form.visitorEmail)) err.visitorEmail = "Enter a valid email address";
    if (!err.visitingPersonEmail && !emailOk(form.visitingPersonEmail)) err.visitingPersonEmail = "Enter a valid email address";
    if (!String(form.visitorPhotoData || "").trim()) err.visitorPhotoData = "Visitor Photo is required";
    if (!err.visitorMobile && !visitorMobileOk(form.visitorMobileCountryCode, form.visitorMobile)) {
      err.visitorMobile =
        form.visitorMobileCountryCode === "+971"
          ? "UAE mobile: 9 digits starting with 5 (e.g. +971-50-186-9287 or 50-186-9287)"
          : "Enter 7–15 digits (national number, no country code)";
    }
    if (!err.startDate && !dateOk(form.startDate)) err.startDate = "Use format dd/mm/yy";
    if (!err.endDate && !dateOk(form.endDate)) err.endDate = "Use format dd/mm/yy";
    if (!err.visitTime && !timeOk(form.visitTime)) err.visitTime = "Use HH:MM (24h)";
    const from = toDate(form.startDate);
    const to = toDate(form.endDate);
    if (!err.startDate && !err.endDate && from && to && to < from) {
      err.endDate = "End Date cannot be earlier than Start Date";
    }
    return err;
  }, [form]);
  const hasFormErrors = Object.keys(fieldErrors).length > 0;
  const showFieldError = (k) => (attemptedAdd || touched[k]) ? fieldErrors[k] : "";

  const [kioskTab, setKioskTab] = useState("list"); // "list" | "kiosk"
  const [kioskSearch, setKioskSearch] = useState("");
  const [kioskBusy, setKioskBusy] = useState(null); // id being processed
  const [kioskConfirm, setKioskConfirm] = useState(null); // { visitor, action:"in"|"out" }
  const [kioskDone, setKioskDone] = useState(null); // { visitor, action, ts }
  const [editV, setEditV] = useState(null); // visitor being edited
  const [editForm, setEditForm] = useState({});
  const [editBusy, setEditBusy] = useState(false);
  const [delConfirm, setDelConfirm] = useState(null); // visitor to delete
  const [delBusy, setDelBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(null); // id of visitor with suspend in progress

  const openEdit = (v) => {
    setEditV(v);
    setEditForm({
      name: v.name || "",
      company: v.company || "",
      email: v.email || "",
      phone: v.phone || "",
      host: v.host || "",
      hostEmail: v.hostEmail || "",
      purpose: v.purpose || "",
      passNumber: v.passNumber || "",
      visitingDepartment: v.visitingDepartment || v.department || "",
      visitingLocation: v.visitingLocation || v.division || "",
      scheduledFrom: v.scheduledFrom || v.scheduledEntry || "",
      scheduledTo: v.scheduledTo || "",
      visitTime: v.visitTime || "",
    });
  };
  const doEdit = async () => {
    if (!editV) return;
    setEditBusy(true);
    try {
      await api.visitorUpdate(editV._id, editForm);
      show("Visitor updated", "success");
      setEditV(null);
      reload();
    } catch(e) { show(e.message, "error"); }
    finally { setEditBusy(false); }
  };
  const doDelete = async () => {
    if (!delConfirm) return;
    setDelBusy(true);
    try {
      await api.visitorDelete(delConfirm._id);
      show("Visitor deleted", "success");
      setDelConfirm(null);
      if (sel?._id === delConfirm._id) setSel(null);
      reload();
    } catch(e) { show(e.message, "error"); }
    finally { setDelBusy(false); }
  };
  const doSuspend = async (v) => {
    setActionBusy(v._id);
    try {
      const res = await api.visitorSuspend(v._id);
      const newSt = res?.status || "suspended";
      show(newSt === "suspended" ? "Visitor suspended" : "Visitor unsuspended", "success");
      reload();
    } catch(e) { show(e.message, "error"); }
    finally { setActionBusy(null); }
  };

  const VALID_TAGS = ["Al Wasl POD Access","Al wasl 3 General Access","Sustainability SS05 General Access"];
  const [enrollV, setEnrollV] = useState(null); // visitor to enroll
  const [enrollTag, setEnrollTag] = useState(VALID_TAGS[0]);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const openEnrollModal = (v) => { setEnrollV(v); setEnrollTag(VALID_TAGS[0]); };
  const doEnrollFace = async () => {
    if (!enrollV) return;
    setEnrollBusy(true);
    try {
      const empId = enrollV.passNumber || "";
      // Check if an employee record already exists for this visitor to avoid duplicate key error
      let enrollEmp = null;
      const params = new URLSearchParams();
      if (empId) params.set("employeeId", empId);
      if (enrollV._id) params.set("sourceVisitorId", String(enrollV._id));
      const lookupRes = await apiFetch(`/employees/lookup?${params.toString()}`).catch(() => null);
      if (lookupRes?.employee?._id) enrollEmp = lookupRes.employee;
      if (!enrollEmp) {
        enrollEmp = await api.empCreate({
          employeeId: empId || `VIS-${Date.now()}`,
          employeeTag: enrollTag,
          cardId: "",
          name: enrollV.name,
          company: enrollV.company || "",
          designation: "Visitor",
          department: enrollV.visitingDepartment || "",
          division: enrollV.visitingLocation || "",
          accessLevel: "Visitor Access",
          cardholderStatus: "Active",
          shiftSchedule: "Visitor",
          passIssueDate: enrollV.scheduledFrom || enrollV.scheduledEntry || "",
          passExpiryDate: enrollV.scheduledTo || "",
          email: enrollV.email || "",
          phone: enrollV.phone || "",
          lineManager: enrollV.host || "",
          lineManagerEmail: enrollV.hostEmail || "",
          authMode: "Face Only",
          status: "active",
          enrolled: false,
          photo: enrollV.photo || enrollV.photoUrl || enrollV.visitorPhotoData || "",
          photoUrl: enrollV.photo || enrollV.photoUrl || enrollV.visitorPhotoData || "",
          sourceVisitorId: String(enrollV._id || "")
        });
        show("Visitor registered as employee. Opening Face Enrollment...", "success");
      } else {
        show("Opening Face Enrollment for existing record...", "success");
      }
      setEnrollV(null);
      if (enrollEmp?._id) {
        onEnroll?.(enrollEmp);
      } else {
        show("Could not open enrollment — please enroll from the Employees page.", "warning");
      }
    } catch(e) { show(e.message, "error"); }
    finally { setEnrollBusy(false); }
  };

  const checkin  = async id=>{ try{await api.visitorCheckin(id);show("Checked in","success");reload();}catch(e){show(e.message,"error");} };
  const checkout = async id=>{ try{await api.visitorCheckout(id);show("Checked out","success");reload();}catch(e){show(e.message,"error");} };

  const kioskAction = async (visitor, action) => {
    setKioskBusy(visitor._id);
    try {
      if (action === "in") {
        await api.visitorCheckin(visitor._id);
      } else {
        await api.visitorCheckout(visitor._id);
      }
      const ts = new Date();
      setKioskDone({ visitor, action, ts });
      setKioskConfirm(null);
      reload();
      // Auto-clear success banner after 4s
      setTimeout(() => setKioskDone(d => d?.visitor?._id === visitor._id ? null : d), 4000);
    } catch(e) {
      show(e.message, "error");
    } finally {
      setKioskBusy(null);
    }
  };
  const doAdd = async (enrollAfter = false) => {
    setAttemptedAdd(true);
    if (hasFormErrors) {
      show("Please fix highlighted fields before registering visitor.", "warning");
      return;
    }
    try{
      const payload = {
        name: form.visitorName,
        company: form.company,
        email: form.visitorEmail,
        phone: `${form.visitorMobileCountryCode} ${form.visitorMobile}`.trim(),
        host: form.visitingPersonName,
        hostEmail: form.visitingPersonEmail,
        purpose: form.purpose,
        passNumber: form.passNumber,
        employeePhotoUrl: form.employeePhotoData || "",
        employeePhotoData: form.employeePhotoData || "",
        visitingDepartment: form.visitingDepartment,
        employeeTag: form.employeeTag,
        visitingLocation: form.visitingLocation,
        scheduledFrom: form.startDate,
        scheduledTo: form.endDate,
        visitTime: form.visitTime,
        scheduledEntry: form.startDate,
        photoUrl: form.visitorPhotoData || "",
        photo: form.visitorPhotoData || "",
        visitorPhotoUrl: form.visitorPhotoData || "",
        visitorPhotoData: form.visitorPhotoData || "",
        employeePhotoFileName: form.employeePhotoFileName || "",
        visitorPhotoFileName: form.visitorPhotoFileName || ""
      };
      const created = await api.visitorCreate(payload);
      if (enrollAfter) {
        const enrollEmp = await api.empCreate({
          employeeId: form.passNumber,
          employeeTag: form.employeeTag,
          cardId: "",
          name: form.visitorName,
          designation: "Visitor",
          department: form.visitingDepartment,
          division: form.visitingLocation,
          accessLevel: "Visitor Access",
          cardholderStatus: "Active",
          shiftSchedule: "Visitor",
          passIssueDate: form.startDate,
          passExpiryDate: form.endDate,
          email: form.visitorEmail,
          phone: `${form.visitorMobileCountryCode} ${form.visitorMobile}`.trim(),
          lineManager: form.visitingPersonName,
          lineManagerEmail: form.visitingPersonEmail,
          authMode: "Face Only",
          status: "active",
          enrolled: false,
          photo: form.visitorPhotoData || "",
          photoUrl: form.visitorPhotoData || "",
          sourceVisitorId: created?._id || ""
        });
        show("Visitor registered. Opening Face Enrollment...", "success");
        setAdd(false);
        setTouched({});
        setAttemptedAdd(false);
        reload();
        if (enrollEmp?._id) {
          onEnroll?.(enrollEmp);
          return;
        }
      }
      const diskMsg = created?.qrLocalStorage?.relativeDir
        ? ` QR saved on server: data/visitor-qr-codes/${created.qrLocalStorage.relativeDir}/ (qr.png + contact.json).`
        : "";
      const mailMsg = created?.email?.emailSent
        ? " Email sent."
        : " Email optional — SMTP not configured or skipped.";
      show(`Visitor registered.${diskMsg}${mailMsg}`,"success");
      setAdd(false);
      setTouched({});
      setAttemptedAdd(false);
      reload();
    }catch(e){show(e.message,"error");}
  };
  useEffect(() => {
    if (add) return;
    setTouched({});
    setAttemptedAdd(false);
  }, [add]);
  const openFp = async v => {
    setSel(v);
    setFp([]);
    setFpLoading(true);
    try {
      const rows = await api.visitorFootprint(v._id);
      setFp(Array.isArray(rows) ? rows : []);
    } catch {
      setFp([]);
    } finally {
      setFpLoading(false);
    }
  };

  // Kiosk filtered visitors
  const kioskVisitors = visitors.filter(v => {
    const q = kioskSearch.trim().toLowerCase();
    if (!q) return v.status === "expected" || v.status === "checked-in";
    return [v.name, v.company, v.host, v.purpose, v.email, v.phone, v.passNumber]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });

  return (
    <div>
      <PageHeader title="Visitors" sub={`${fNum(data?.total||0)} total`}
        action={
          <div style={{ display:"flex",gap:8,alignItems:"center" }}>
            <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
              {[["list","📋 List"],["kiosk","🖥 Kiosk"]].map(([v,l])=>(
                <button key={v} onClick={()=>setKioskTab(v)}
                  style={{ padding:"7px 14px",fontSize:12,fontWeight:700,background:kioskTab===v?TH.blue:"transparent",color:kioskTab===v?"#fff":TH.muted,border:"none",cursor:"pointer",whiteSpace:"nowrap" }}>
                  {l}
                </button>
              ))}
            </div>
            <Btn onClick={()=>setAdd(true)} icon="+">Register Visitor</Btn>
          </div>
        }/>

      {/* Stat cards always visible */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="🕐" label="Expected"    value={visitors.filter(v=>v.status==="expected").length}    color={TH.blue}/>
        <StatCard icon="✅" label="Checked In"  value={visitors.filter(v=>v.status==="checked-in").length}  color={TH.green}/>
        <StatCard icon="🚶" label="Checked Out" value={visitors.filter(v=>v.status==="checked-out").length} color={TH.muted}/>
        <StatCard icon="👥" label="Total"       value={data?.total||0}                                       color={TH.violet}/>
      </div>

      {/* ══════════ KIOSK VIEW ══════════ */}
      {kioskTab === "kiosk" && (
        <div>
          {/* Success/done banner */}
          {kioskDone && (
            <div className="fade-in" style={{ marginBottom:16,padding:"18px 22px",borderRadius:14,
              background:kioskDone.action==="in"?"rgba(32,214,138,.12)":"rgba(255,107,120,.10)",
              border:`2px solid ${kioskDone.action==="in"?TH.green:TH.red}`,
              display:"flex",alignItems:"center",gap:16 }}>
              <span style={{ fontSize:42 }}>{kioskDone.action==="in"?"✅":"🚪"}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:20,fontWeight:800,color:kioskDone.action==="in"?TH.green:TH.red }}>
                  {kioskDone.action==="in" ? "Checked In Successfully" : "Checked Out Successfully"}
                </div>
                <div style={{ fontSize:15,color:TH.text,marginTop:4 }}>
                  <b>{kioskDone.visitor?.name}</b>
                  {kioskDone.visitor?.company ? ` · ${kioskDone.visitor.company}` : ""}
                  <span style={{ marginLeft:12,fontSize:13,color:TH.muted,fontFamily:"monospace" }}>
                    {fDT(kioskDone.ts)}
                  </span>
                </div>
              </div>
              <button onClick={()=>setKioskDone(null)}
                style={{ background:"none",border:"none",color:TH.muted,fontSize:22,cursor:"pointer" }}>×</button>
            </div>
          )}

          {/* Kiosk search bar */}
          <Card style={{ marginBottom:14,padding:"14px 16px" }}>
            <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap" }}>
              <div style={{ flex:1,minWidth:220 }}>
                <SearchBar value={kioskSearch} onChange={e=>setKioskSearch(e.target.value)}
                  placeholder="Search by name, company, host, pass number…"/>
              </div>
              <Btn v="ghost" sz="sm" onClick={()=>{reload();setKioskSearch("");}}>⟳ Refresh</Btn>
              <span style={{ fontSize:12,color:TH.muted }}>
                {kioskSearch ? "Search results" : "Expected + checked-in"} · {kioskVisitors.length} visitor(s)
              </span>
            </div>
          </Card>

          {/* Visitor cards */}
          {loading ? <Loader text="Loading visitors…"/> : kioskVisitors.length === 0 ? (
            <Empty icon="🕐" text="No visitors to show"
              sub={kioskSearch ? "No visitors match your search" : "No expected or checked-in visitors right now"}/>
          ) : (
            <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14 }}>
              {kioskVisitors.map(v => {
                const isIn  = v.status === "checked-in";
                const isOut = v.status === "checked-out";
                const busy  = kioskBusy === v._id;
                const accentColor = isIn ? TH.green : isOut ? TH.muted : TH.blue;
                return (
                  <div key={v._id} style={{
                    background:TH.card,
                    border:`2px solid ${isIn?TH.green+"55":isOut?TH.border:TH.blue+"44"}`,
                    borderRadius:16,padding:18,boxShadow:TH.shadow,
                    display:"flex",flexDirection:"column",gap:12
                  }}>
                    {/* Photo + name */}
                    <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
                      {visitorPhoto(v)
                        ? <img src={visitorPhoto(v)} alt={v.name}
                            style={{ width:64,height:64,borderRadius:12,objectFit:"cover",
                              border:`2px solid ${accentColor}55`,flexShrink:0 }}/>
                        : <Avatar name={v.name||"?"} size={64} color={accentColor}/>
                      }
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontSize:16,fontWeight:800,color:TH.text,
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                          {v.name}
                        </div>
                        {v.company && <div style={{ fontSize:12,color:TH.muted,marginTop:2 }}>{v.company}</div>}
                        <div style={{ marginTop:6 }}>{stBadge(v.status)}</div>
                      </div>
                    </div>

                    {/* Details */}
                    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 10px",fontSize:12 }}>
                      {v.host && (
                        <div style={{ gridColumn:"1/-1" }}>
                          <span style={{ color:TH.muted }}>Visiting: </span>
                          <span style={{ color:TH.text,fontWeight:600 }}>{v.host}</span>
                        </div>
                      )}
                      {v.purpose && (
                        <div>
                          <span style={{ color:TH.muted }}>Purpose: </span>
                          <span style={{ color:TH.text }}>{v.purpose}</span>
                        </div>
                      )}
                      {checkInAt(v) && (
                        <div>
                          <span style={{ color:TH.muted }}>In: </span>
                          <span style={{ color:TH.green,fontFamily:"monospace" }}>{fT(checkInAt(v))}</span>
                        </div>
                      )}
                      {checkOutAt(v) && (
                        <div>
                          <span style={{ color:TH.muted }}>Out: </span>
                          <span style={{ color:TH.amber,fontFamily:"monospace" }}>{fT(checkOutAt(v))}</span>
                        </div>
                      )}
                      {(checkInAt(v) || isIn) && (
                        <div>
                          <span style={{ color:TH.muted }}>Duration: </span>
                          <span style={{ color:TH.blue,fontFamily:"monospace",fontWeight:700 }}>{visitorDur(v)}</span>
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div style={{ display:"flex",gap:8,marginTop:4 }}>
                      {v.status === "expected" && (
                        <Btn full v="success" sz="lg" loading={busy}
                          onClick={()=>setKioskConfirm({ visitor:v, action:"in" })}>
                          ✅ Check In
                        </Btn>
                      )}
                      {v.status === "checked-in" && (
                        <>
                          <Btn full v="danger" sz="lg" loading={busy}
                            onClick={()=>setKioskConfirm({ visitor:v, action:"out" })}>
                            🚪 Check Out
                          </Btn>
                          <Btn v="ghost" sz="lg" onClick={()=>openFp(v)} title="View footprint">👣</Btn>
                        </>
                      )}
                      {v.status === "checked-out" && (
                        <div style={{ width:"100%",textAlign:"center",fontSize:13,color:TH.muted,
                          padding:"10px 0",borderTop:`1px solid ${TH.border}` }}>
                          Visit complete · {visitorDur(v)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Confirmation modal */}
          {kioskConfirm && (
            <div className="fade-in" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,.75)",
              backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",
              zIndex:1000,padding:20 }}>
              <div style={{ background:TH.surface,
                border:`2px solid ${kioskConfirm.action==="in"?TH.green:TH.red}`,
                borderRadius:20,padding:36,maxWidth:480,width:"100%",textAlign:"center",
                boxShadow:"0 32px 96px rgba(0,0,0,.7)" }}>
                <div style={{ fontSize:64,marginBottom:12 }}>
                  {kioskConfirm.action==="in" ? "✅" : "🚪"}
                </div>
                {visitorPhoto(kioskConfirm.visitor) && (
                  <img src={visitorPhoto(kioskConfirm.visitor)} alt={kioskConfirm.visitor.name}
                    style={{ width:90,height:90,borderRadius:"50%",objectFit:"cover",
                      border:`3px solid ${kioskConfirm.action==="in"?TH.green:TH.red}`,
                      display:"block",margin:"0 auto 14px" }}/>
                )}
                <div style={{ fontSize:22,fontWeight:900,color:TH.text,marginBottom:8 }}>
                  {kioskConfirm.action==="in" ? "Confirm Check-In" : "Confirm Check-Out"}
                </div>
                <div style={{ fontSize:17,color:TH.text,marginBottom:4 }}>
                  <b>{kioskConfirm.visitor.name}</b>
                </div>
                {kioskConfirm.visitor.company && (
                  <div style={{ fontSize:14,color:TH.muted,marginBottom:4 }}>{kioskConfirm.visitor.company}</div>
                )}
                {kioskConfirm.visitor.host && (
                  <div style={{ fontSize:14,color:TH.muted,marginBottom:16 }}>
                    Visiting: <b>{kioskConfirm.visitor.host}</b>
                  </div>
                )}
                <div style={{ display:"flex",gap:12,marginTop:24,justifyContent:"center" }}>
                  <Btn v="ghost" sz="xl" disabled={kioskBusy===kioskConfirm.visitor._id}
                    onClick={()=>setKioskConfirm(null)}>
                    Cancel
                  </Btn>
                  <Btn v={kioskConfirm.action==="in"?"success":"danger"} sz="xl"
                    loading={kioskBusy===kioskConfirm.visitor._id}
                    onClick={()=>kioskAction(kioskConfirm.visitor, kioskConfirm.action)}>
                    {kioskConfirm.action==="in" ? "✅ Confirm Check-In" : "🚪 Confirm Check-Out"}
                  </Btn>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════ LIST VIEW ══════════ */}
      {kioskTab === "list" && (
        <div>
          <div style={{ display:"flex",gap:8,marginBottom:16,flexWrap:"wrap" }}>
            <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search visitor…" style={{ width:220 }}/>
            <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
              {[["all","All"],["expected","Expected"],["checked-in","In"],["checked-out","Out"]].map(([fv,l])=>(
                <button key={fv} onClick={()=>{setFilter(fv);setPage(1);}}
                  style={{ padding:"7px 13px",fontSize:12,fontWeight:600,background:filter===fv?TH.blue:"transparent",color:filter===fv?"#fff":TH.muted,border:"none",cursor:"pointer" }}>{l}</button>
              ))}
            </div>
            <Btn v="ghost" sz="xs" onClick={reload}>⟳</Btn>
          </div>
          <Card pad={0} style={{ overflow:"hidden" }}>
            <Table loading={loading} headers={["Photo","Visitor","Company","Host","Purpose","Status","Scheduled","Check-in","Check-out","Duration","Actions"]}
              onRow={r=>openFp(r.v)}
              rows={shown.map(vis=>({ key:vis._id, v:vis, cells:[
                visitorPhoto(vis)
                  ? <img src={visitorPhoto(vis)} alt={vis.name||"visitor"} style={{ width:56,height:56,borderRadius:8,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
                  : <Avatar name={vis.name||"?"} size={30} color={TH.blue}/>,
                <div style={{ fontWeight:600 }}>{vis.name}</div>,
                vis.company||"—", vis.host||"—", vis.purpose||"—",
                stBadge(vis.status),
                <span style={{ fontSize:12,fontFamily:TH.mono }}>
                  {vis.scheduledFrom || vis.scheduledTo
                    ? `${vis.scheduledFrom||"—"}${vis.scheduledTo?` to ${vis.scheduledTo}`:""}`
                    : (vis.scheduledEntry || "—")}
                </span>,
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{checkInAt(vis)?fT(checkInAt(vis)):"—"}</span>,
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{checkOutAt(vis)?fT(checkOutAt(vis)):"—"}</span>,
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{visitorDur(vis)}</span>,
                <div style={{ display:"flex",gap:5,flexWrap:"wrap" }} onClick={e=>e.stopPropagation()}>
                  {vis.status==="expected" && (
                    <Btn v="success" sz="sm"
                      onClick={e=>{e.stopPropagation();setKioskConfirm({visitor:vis,action:"in"});setKioskTab("kiosk");}}>
                      ✅ In
                    </Btn>
                  )}
                  {vis.status==="checked-in" && (
                    <Btn v="danger" sz="sm"
                      onClick={e=>{e.stopPropagation();setKioskConfirm({visitor:vis,action:"out"});setKioskTab("kiosk");}}>
                      🚪 Out
                    </Btn>
                  )}
                  <Btn v="ghost" sz="sm" title="Edit visitor"
                    onClick={e=>{e.stopPropagation();openEdit(vis);}}>✏️</Btn>
                  <Btn v="ghost" sz="sm" title={vis.status==="suspended"?"Unsuspend":"Suspend"}
                    loading={actionBusy===vis._id}
                    onClick={e=>{e.stopPropagation();doSuspend(vis);}}>
                    {vis.status==="suspended"?"▶ Unsuspend":"⏸ Suspend"}
                  </Btn>
                  <Btn v="danger" sz="sm" title="Delete visitor"
                    onClick={e=>{e.stopPropagation();setDelConfirm(vis);}}>🗑</Btn>
                  <Btn v="ghost" sz="sm" title="Enroll face for access"
                    onClick={e=>{e.stopPropagation();openEnrollModal(vis);}}>📷 Enroll</Btn>
                </div>
              ]}))}
            />
            <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
          </Card>
        </div>
      )}

      {/* Footprint modal */}
      {sel&&<Modal title={`Visitor — ${sel.name||"Visitor"}`} onClose={()=>setSel(null)} width={640}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:14 }}>
          {[["Company",sel.company],["Host",sel.host],["Purpose",sel.purpose],["Scheduled From",sel.scheduledFrom||sel.scheduledEntry],["Scheduled To",sel.scheduledTo],["Status",sel.status],["Check-in",checkInAt(sel)?fDT(checkInAt(sel)):"—"],["Check-out",checkOutAt(sel)?fDT(checkOutAt(sel)):"—"],["Duration",visitorDur(sel)],["Email",sel.email],["Phone",sel.phone]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex",gap:8,marginBottom:14 }}>
          {sel.status==="expected"&&<Btn v="success" sz="sm" loading={kioskBusy===sel._id} onClick={()=>kioskAction(sel,"in")}>✅ Check In</Btn>}
          {sel.status==="checked-in"&&<Btn v="danger" sz="sm" loading={kioskBusy===sel._id} onClick={()=>kioskAction(sel,"out")}>🚪 Check Out</Btn>}
        </div>
        {fpLoading ? <Loader text="Loading footprint..."/> : fp.length===0 ? (
          <Empty icon="👣" text="No footprint records yet" sub="Entries will appear after visitor movements are recorded"/>
        ) : (
          <Card pad={0} style={{ overflow:"hidden" }}>
            <Table headers={["Photo","Time","Zone","Device","Direction","Event"]}
              rows={fp.map((x,i)=>({ key:x._id||i, cells:[
                (x?.photo || x?.photoUrl || x?.image || x?.imageUrl || x?.facePhoto || x?.faceImage || x?.snapshot || x?.snapshotUrl || x?.capture || x?.captureUrl)
                  ? <img src={x.photo || x.photoUrl || x.image || x.imageUrl || x.facePhoto || x.faceImage || x.snapshot || x.snapshotUrl || x.capture || x.captureUrl} alt={sel.name||"visitor"} style={{ width:28,height:28,borderRadius:7,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
                  : <Avatar name={sel.name||"?"} size={26} color={TH.blue}/>,
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{fDT(x.timestamp||x.ts||x.createdAt)}</span>,
                x.zone||"—",
                x.device||x.deviceName||"—",
                x.direction||"—",
                x.event||x.type||"Movement"
              ]}))}/>
          </Card>
        )}
      </Modal>}
      {/* ── Enroll Face Access Modal ── */}
      {enrollV&&<Modal title="Enroll Face Access" onClose={()=>setEnrollV(null)} width={480}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setEnrollV(null)}>Cancel</Btn>
          <Btn loading={enrollBusy} onClick={doEnrollFace}>📷 Continue to Face Enrollment</Btn>
        </div>}>
        <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
          <div style={{ display:"flex",gap:14,alignItems:"center",padding:"14px 16px",background:TH.surface,borderRadius:12,border:`1px solid ${TH.border}` }}>
            {(enrollV.photo||enrollV.photoUrl)
              ? <img src={enrollV.photo||enrollV.photoUrl} alt={enrollV.name} style={{ width:64,height:64,borderRadius:10,objectFit:"cover",border:`2px solid ${TH.blue}55`,flexShrink:0 }}/>
              : <Avatar name={enrollV.name||"?"} size={64} color={TH.blue}/>
            }
            <div>
              <div style={{ fontWeight:700,fontSize:16,color:TH.text }}>{enrollV.name}</div>
              {enrollV.company&&<div style={{ fontSize:13,color:TH.muted }}>{enrollV.company}</div>}
              {enrollV.passNumber&&<div style={{ fontSize:12,color:TH.muted,marginTop:2 }}>Pass: {enrollV.passNumber}</div>}
            </div>
          </div>
          <div style={{ padding:"12px 14px",background:"rgba(59,130,246,.08)",borderRadius:10,border:`1px solid rgba(59,130,246,.2)`,fontSize:13,color:TH.muted,lineHeight:1.6 }}>
            This will create an <b style={{ color:TH.text }}>employee record</b> for this visitor and open the Face Enrollment page. Select which <b style={{ color:TH.text }}>access zone</b> they should be granted.
          </div>
          <Field label="Access Zone / Employee Tag" required>
            <Sel value={enrollTag} onChange={e=>setEnrollTag(e.target.value)}
              options={VALID_TAGS.map(t=>({ value:t, label:t }))}/>
          </Field>
        </div>
      </Modal>}

      {/* ── Edit Visitor Modal ── */}
      {editV&&<Modal title={`Edit Visitor — ${editV.name||""}`} onClose={()=>setEditV(null)} width={700}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setEditV(null)}>Cancel</Btn>
          <Btn loading={editBusy} onClick={doEdit}>Save Changes</Btn>
        </div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="Visitor Name" required><Input value={editForm.name||""} onChange={e=>setEditForm(p=>({...p,name:e.target.value}))} placeholder="Full name"/></Field>
          <Field label="Company"><Input value={editForm.company||""} onChange={e=>setEditForm(p=>({...p,company:e.target.value}))} placeholder="Company"/></Field>
          <Field label="Email"><Input value={editForm.email||""} onChange={e=>setEditForm(p=>({...p,email:e.target.value}))} type="email" placeholder="visitor@company.com"/></Field>
          <Field label="Phone"><Input value={editForm.phone||""} onChange={e=>setEditForm(p=>({...p,phone:e.target.value}))} placeholder="+971 50-000-0000"/></Field>
          <Field label="Host (Visiting Person)"><Input value={editForm.host||""} onChange={e=>setEditForm(p=>({...p,host:e.target.value}))} placeholder="Host name"/></Field>
          <Field label="Host Email"><Input value={editForm.hostEmail||""} onChange={e=>setEditForm(p=>({...p,hostEmail:e.target.value}))} type="email" placeholder="host@company.com"/></Field>
          <Field label="Pass Number"><Input value={editForm.passNumber||""} onChange={e=>setEditForm(p=>({...p,passNumber:e.target.value}))} placeholder="PASS-00001"/></Field>
          <Field label="Purpose">
            <Sel value={editForm.purpose||""} onChange={e=>setEditForm(p=>({...p,purpose:e.target.value}))}
              options={["Meeting","Interview","Delivery","Maintenance","Tour","Other"]}/>
          </Field>
          <Field label="Visiting Department"><Input value={editForm.visitingDepartment||""} onChange={e=>setEditForm(p=>({...p,visitingDepartment:e.target.value}))} placeholder="Department"/></Field>
          <Field label="Visiting Location"><Input value={editForm.visitingLocation||""} onChange={e=>setEditForm(p=>({...p,visitingLocation:e.target.value}))} placeholder="Location"/></Field>
          <Field label="Start Date"><Input value={editForm.scheduledFrom||""} onChange={e=>setEditForm(p=>({...p,scheduledFrom:e.target.value}))} placeholder="dd/mm/yy"/></Field>
          <Field label="End Date"><Input value={editForm.scheduledTo||""} onChange={e=>setEditForm(p=>({...p,scheduledTo:e.target.value}))} placeholder="dd/mm/yy"/></Field>
          <Field label="Visit Time" style={{ gridColumn:"1/-1" }}><Input value={editForm.visitTime||""} onChange={e=>setEditForm(p=>({...p,visitTime:e.target.value}))} placeholder="HH:MM"/></Field>
        </div>
      </Modal>}

      {/* ── Delete Confirm Modal ── */}
      {delConfirm&&<Modal title="Delete Visitor" onClose={()=>setDelConfirm(null)} width={420}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setDelConfirm(null)}>Cancel</Btn>
          <Btn v="danger" loading={delBusy} onClick={doDelete}>Yes, Delete</Btn>
        </div>}>
        <div style={{ padding:"8px 0" }}>
          <p style={{ color:TH.text,marginBottom:12,fontSize:15 }}>Permanently delete this visitor?</p>
          <div style={{ background:TH.surface,borderRadius:10,padding:"12px 16px",border:`1px solid ${TH.border}` }}>
            <div style={{ fontWeight:700,fontSize:16,color:TH.text }}>{delConfirm.name}</div>
            {delConfirm.company&&<div style={{ fontSize:13,color:TH.muted,marginTop:2 }}>{delConfirm.company}</div>}
            {delConfirm.purpose&&<div style={{ fontSize:12,color:TH.muted,marginTop:2 }}>Purpose: {delConfirm.purpose}</div>}
          </div>
          <p style={{ color:TH.red,fontSize:13,marginTop:12 }}>⚠ This action cannot be undone.</p>
        </div>
      </Modal>}

      {add&&<Modal title="Register Visitor" onClose={()=>setAdd(false)} width={780}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap",alignItems:"center" }}>
          <Btn v="ghost" onClick={()=>setAdd(false)}>Cancel</Btn>
          <Btn v="secondary" onClick={()=>doAdd(true)}>Register + Enroll Face</Btn>
          <Btn onClick={()=>doAdd(false)}>Register</Btn>
        </div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="Visitor Name" required error={showFieldError("visitorName")}><Input value={form.visitorName} onChange={e=>setForm(p=>({...p,visitorName:e.target.value}))} onBlur={()=>markTouched("visitorName")} placeholder="Visitor full name" style={showFieldError("visitorName")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Company" error={showFieldError("company")}><Input value={form.company} onChange={e=>setForm(p=>({...p,company:e.target.value}))} onBlur={()=>markTouched("company")} placeholder="Company" style={showFieldError("company")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Pass Number" error={showFieldError("passNumber")}><Input value={form.passNumber} onChange={e=>setForm(p=>({...p,passNumber:e.target.value}))} onBlur={()=>markTouched("passNumber")} placeholder="PASS-00001" style={showFieldError("passNumber")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Employee Tag" error={showFieldError("employeeTag")}><Input value={form.employeeTag} onChange={e=>setForm(p=>({...p,employeeTag:e.target.value}))} onBlur={()=>markTouched("employeeTag")} placeholder="Employee tag" style={showFieldError("employeeTag")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visiting Department" error={showFieldError("visitingDepartment")}><Input value={form.visitingDepartment} onChange={e=>setForm(p=>({...p,visitingDepartment:e.target.value}))} onBlur={()=>markTouched("visitingDepartment")} placeholder="Department" style={showFieldError("visitingDepartment")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visiting Location" error={showFieldError("visitingLocation")}><Input value={form.visitingLocation} onChange={e=>setForm(p=>({...p,visitingLocation:e.target.value}))} onBlur={()=>markTouched("visitingLocation")} placeholder="Location" style={showFieldError("visitingLocation")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visiting Person Name" error={showFieldError("visitingPersonName")}><Input value={form.visitingPersonName} onChange={e=>setForm(p=>({...p,visitingPersonName:e.target.value}))} onBlur={()=>markTouched("visitingPersonName")} placeholder="Employee name to visit" style={showFieldError("visitingPersonName")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visiting Person Email" error={showFieldError("visitingPersonEmail")}><Input value={form.visitingPersonEmail} onChange={e=>setForm(p=>({...p,visitingPersonEmail:e.target.value}))} onBlur={()=>markTouched("visitingPersonEmail")} type="email" placeholder="person@company.com" style={showFieldError("visitingPersonEmail")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visitor Email" error={showFieldError("visitorEmail")}><Input value={form.visitorEmail} onChange={e=>setForm(p=>({...p,visitorEmail:e.target.value}))} onBlur={()=>markTouched("visitorEmail")} type="email" placeholder="visitor@company.com" style={showFieldError("visitorEmail")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visitor Mobile" error={showFieldError("visitorMobile")}>
            <div style={{ display:"grid",gridTemplateColumns:"minmax(148px,44%) 1fr",gap:8 }}>
              <Sel value={form.visitorMobileCountryCode}
                onChange={e=>{ const cc=e.target.value; setForm(p=>({...p,visitorMobileCountryCode:cc,visitorMobile:cc==="+971"?formatUaeMobile(p.visitorMobile):String(p.visitorMobile||"").replace(/\D/g,"").slice(0,15)})); }}
                onBlur={()=>markTouched("visitorMobileCountryCode")}
                style={{ fontSize:12,...(showFieldError("visitorMobile")?{borderColor:TH.red}:{}) }}
                options={COUNTRY_DIAL_OPTIONS}/>
              <Input value={form.visitorMobile}
                onChange={e=>{ const raw=form.visitorMobileCountryCode==="+971"?formatUaeMobile(e.target.value):String(e.target.value||"").replace(/[^0-9]/g,"").slice(0,15); setForm(p=>({...p,visitorMobile:raw})); }}
                onBlur={()=>markTouched("visitorMobile")}
                placeholder={form.visitorMobileCountryCode==="+971"?"50-186-9287":"National number"}
                style={showFieldError("visitorMobile")?{borderColor:TH.red}:{}}/>
            </div>
          </Field>
          <Field label="Start Date" error={showFieldError("startDate")}><Input value={form.startDate} onChange={e=>setForm(p=>({...p,startDate:formatDateDMY(e.target.value)}))} onBlur={()=>markTouched("startDate")} placeholder="dd/mm/yy" style={showFieldError("startDate")?{borderColor:TH.red}:{}}/></Field>
          <Field label="End Date" error={showFieldError("endDate")}><Input value={form.endDate} onChange={e=>setForm(p=>({...p,endDate:formatDateDMY(e.target.value)}))} onBlur={()=>markTouched("endDate")} placeholder="dd/mm/yy" style={showFieldError("endDate")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Visiting Time" error={showFieldError("visitTime")}><Input value={form.visitTime} onChange={e=>setForm(p=>({...p,visitTime:e.target.value}))} onBlur={()=>markTouched("visitTime")} placeholder="HH:MM" style={showFieldError("visitTime")?{borderColor:TH.red}:{}}/></Field>
          <Field label="Purpose" error={showFieldError("purpose")}>
            <Sel value={form.purpose} onChange={e=>setForm(p=>({...p,purpose:e.target.value}))}
              options={["Meeting","Interview","Delivery","Maintenance","Tour","Other"]}/>
          </Field>
          <Field label="Visitor Photo" error={showFieldError("visitorPhotoData")} style={{ gridColumn:"1/-1" }}>
            <div style={{ display:"flex",gap:10,alignItems:"center" }}>
              {form.visitorPhotoData && <img src={form.visitorPhotoData} alt="visitor" style={{ width:56,height:56,borderRadius:8,objectFit:"cover",border:`1px solid ${TH.border}` }}/>}
              <label style={{ cursor:"pointer" }}>
                <input type="file" accept="image/*" onChange={onPhotoPick("visitorPhotoData","visitorPhotoFileName")} style={{ display:"none" }}/>
                <Btn v="ghost" sz="sm" style={{ pointerEvents:"none" }}>📷 {form.visitorPhotoData?"Change Photo":"Upload Photo"}</Btn>
              </label>
              {form.visitorPhotoFileName && <span style={{ fontSize:11,color:TH.muted }}>{form.visitorPhotoFileName}</span>}
            </div>
          </Field>
        </div>
      </Modal>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   OFFLINE SYNC
═══════════════════════════════════════════════════════════════════════ */
function SyncPage() {
  const { show } = useToast();
  const [syncing, setSyncing] = useState(null);
  const [all,     setAll]     = useState(false);
  const { data, loading, reload } = useFetch(()=>api.devices(),[],[]);
  const { data:recovered } = useFetch(()=>api.offlineLogs(),[],[]);
  const devs = (data||[]).map(d=>({...d,buffered:d.bufferedEvents||0,recovered:d.recoveredToday||0}));
  const totBuf = devs.reduce((s,d)=>s+(d.buffered||0),0);

  const doOne = async id=>{
    setSyncing(id);
    try{
      const r = await api.deviceSync(id);
      const inserted = Number(r?.sync?.inserted || 0);
      if (r?.sidecar && !r.sidecar.ok) {
        show(`Device reachable but GSDK link failed: ${r.sidecar.error || "Unknown error"}`, "warning");
      } else {
        show(inserted > 0 ? `Sync done (${inserted} logs)` : "Sync done","success");
      }
      window.dispatchEvent(new Event("acs:sync-complete"));
      reload();
    }
    catch(e){show(e.message,"error");}
    finally{setSyncing(null);}
  };
  const doAll = async()=>{
    setAll(true);
    try{await api.syncAll();show("All synced","success");reload();}
    catch(e){show(e.message,"error");}
    finally{setAll(false);}
  };

  return (
    <div>
      <PageHeader title="Offline Sync" sub="Device buffer recovery — auto-syncs when server comes back online"
        action={<Btn loading={all} disabled={!totBuf} onClick={doAll} icon="⟳">Sync All Now</Btn>}/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="⟳"  label="Total Buffered"  value={fNum(totBuf)}                                          color={totBuf>0?TH.amber:TH.green}/>
        <StatCard icon="🔴" label="Offline Devices"  value={devs.filter(d=>d.status==="offline").length}          color={TH.red}/>
        <StatCard icon="✅" label="Recovered Today"  value={fNum(recovered?.length||0)}                           color={TH.green}/>
        <StatCard icon="◫"  label="Fully Synced"     value={devs.filter(d=>d.status==="online"&&!d.buffered).length} color={TH.blue}/>
      </div>
      {totBuf>0&&<GlassCard color={TH.amber} style={{ marginBottom:16,padding:"11px 16px" }}>
        <span style={{ fontSize:13,color:TH.amber,fontWeight:600 }}>⚠ {fNum(totBuf)} events buffered on devices — sync to recover them</span>
      </GlassCard>}
      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Device","Zone","Status","Buffered","Recovered","Last Sync","Actions"]}
          rows={devs.map(d=>({ key:d._id,cells:[
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <div style={{ width:9,height:9,borderRadius:"50%",background:d.status==="online"?TH.green:d.status==="warning"?TH.amber:TH.red,boxShadow:`0 0 6px ${d.status==="online"?TH.green:TH.red}` }}/>
              <div><div style={{ fontWeight:600 }}>{d.name}</div><code style={{ fontSize:10,color:TH.muted }}>{d._id}</code></div>
            </div>,
            <span style={{ fontSize:12 }}>📍 {d.zone}</span>,
            stBadge(d.status),
            d.buffered>0?<span style={{ fontSize:13,fontWeight:800,color:d.buffered>100?TH.red:d.buffered>30?TH.amber:TH.green,fontFamily:TH.mono }}>{fNum(d.buffered)}</span>:<Badge color="green" sm>Clear</Badge>,
            <span style={{ fontSize:12,fontFamily:TH.mono,color:TH.green }}>{fNum(d.recovered||0)}</span>,
            <span style={{ fontSize:11,color:TH.muted }}>{fRel(d.lastSync)}</span>,
            d.buffered>0&&syncing!==d._id?<Btn v="amber" sz="xs" onClick={()=>doOne(d._id)}>Sync</Btn>:syncing===d._id?<span style={{ fontSize:11,color:TH.blue,display:"flex",gap:4,alignItems:"center" }}><span className="spin">⟳</span>Syncing</span>:<Badge color="green" sm>✓</Badge>
          ]}))}/>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   CREDENTIALS
═══════════════════════════════════════════════════════════════════════ */
const AUTH_MODES = [
  {hex:"0x00",label:"Face Only",       tier:1,icon:"👤",  desc:"Face recognition only. Fast, contactless.",                  devs:["BS3","FSF2","BSA2"]},
  {hex:"0x01",label:"Card Only",       tier:1,icon:"🪪",  desc:"Any RFID card.",                                              devs:["BS3","BEW3","BLN2","XP2","BSL2"]},
  {hex:"0x02",label:"PIN Only",        tier:1,icon:"🔢",  desc:"4–8 digit PIN keypad.",                                       devs:["BS3","BLN2","BSL2"]},
  {hex:"0x30",label:"Mobile BLE/NFC",  tier:1,icon:"📱",  desc:"Suprema mobile app.",                                         devs:["BS3","FSF2"]},
  {hex:"0x10",label:"Face + Card",     tier:2,icon:"👤🪪", desc:"Face AND card. 2-factor.",                                   devs:["BS3","FSF2"]},
  {hex:"0x11",label:"Face + PIN",      tier:2,icon:"👤🔢", desc:"Face AND PIN. 2-factor.",                                    devs:["BS3","FSF2","BSA2"]},
  {hex:"0x12",label:"Card + PIN",      tier:2,icon:"🪪🔢", desc:"Card AND PIN. 2-factor.",                                    devs:["BS3","BLN2","BSL2"]},
  {hex:"0x20",label:"Face+Card+PIN",   tier:3,icon:"🔒",  desc:"All three factors. Maximum security.",                        devs:["BS3","FSF2"]},
  {hex:"0xFF",label:"Bypass",          tier:0,icon:"⚡",  desc:"No authentication. Fire exits only.",                         devs:["BS3","BEW3"]},
];
const CARD_TYPES = [
  {name:"EM4100",         freq:"125kHz",  prot:"EM",         range:"~80mm", devs:["BS3","BSA2","FSF2","BEW3","BLN2","XP2"]},
  {name:"MIFARE Classic", freq:"13.56MHz",prot:"ISO 14443A", range:"~100mm",devs:["BS3","BSA2","FSF2","BEW3","BLN2","XP2","BSL2"]},
  {name:"MIFARE Plus",    freq:"13.56MHz",prot:"ISO 14443A", range:"~100mm",devs:["BS3","BSA2","FSF2","BEW3","BSL2"]},
  {name:"DESFire EV2",    freq:"13.56MHz",prot:"ISO 14443A", range:"~80mm", devs:["BS3","FSF2","BEW3"]},
  {name:"DESFire EV3",    freq:"13.56MHz",prot:"ISO 14443A", range:"~80mm", devs:["BS3","FSF2"]},
  {name:"iCLASS",         freq:"13.56MHz",prot:"ISO 15693",  range:"~100mm",devs:["BS3","BSA2","FSF2","BEW3"]},
  {name:"HID SEOS",       freq:"13.56MHz",prot:"HID",        range:"~100mm",devs:["BS3","FSF2"]},
  {name:"HID Prox",       freq:"125kHz",  prot:"HID",        range:"~80mm", devs:["BS3","BSA2","FSF2","BEW3","BLN2","XP2"]},
  {name:"FeliCa",         freq:"13.56MHz",prot:"ISO 18092",  range:"~80mm", devs:["BS3","FSF2"]},
  {name:"Mobile BLE",     freq:"2.4GHz",  prot:"BLE",        range:"~10m",  devs:["BS3","FSF2"]},
];

function CredentialsPage() {
  const [tab, setTab] = useState("modes");
  const tc = n => ([TH.muted,TH.blue,TH.green,TH.violet])[n]||TH.muted;
  return (
    <div>
      <PageHeader title="Credentials & Auth Modes" sub="All supported authentication methods and card protocols for G-SDK 1.7.2"/>
      <Tabs active={tab} onChange={setTab} items={[{id:"modes",label:"Auth Modes",icon:"🔐",count:AUTH_MODES.length},{id:"cards",label:"Card Types",icon:"🪪",count:CARD_TYPES.length}]}/>
      {tab==="modes"&&(
        <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
          {[3,2,1,0].map(tier=>{
            const modes=AUTH_MODES.filter(m=>m.tier===tier);
            if(!modes.length)return null;
            const TL=["Bypass","Single Factor","2-Factor (2FA)","3-Factor (3FA)"][tier];
            return (
              <div key={tier}>
                <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:10 }}>
                  <div style={{ height:1,flex:1,background:TH.border }}/>
                  <Badge color={{3:"violet",2:"green",1:"blue",0:"gray"}[tier]}>{TL}</Badge>
                  <div style={{ height:1,flex:1,background:TH.border }}/>
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10 }}>
                  {modes.map(m=>(
                    <Card key={m.hex} pad={16}>
                      <div style={{ display:"flex",gap:12,alignItems:"flex-start",marginBottom:10 }}>
                        <div className="icon-chip-lg" style={{ background:`linear-gradient(180deg, ${tc(tier)}32, ${tc(tier)}14)`,border:`1px solid ${tc(tier)}66`,boxShadow:`inset 0 1px 0 rgba(255,255,255,.14), 0 8px 16px ${tc(tier)}30`,flexShrink:0 }}>{m.icon}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:3 }}>{m.label}</div>
                          <div style={{ fontSize:12,color:TH.muted,lineHeight:1.5 }}>{m.desc}</div>
                        </div>
                        <code style={{ fontSize:11,color:TH.blue,flexShrink:0 }}>{m.hex}</code>
                      </div>
                      <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>{m.devs.map(d=><Badge key={d} color="gray" sm>{d}</Badge>)}</div>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab==="cards"&&(
        <Card pad={0} style={{ overflow:"hidden" }}>
          <Table headers={["Card Type","Frequency","Protocol","Range","Compatible"]}
            rows={CARD_TYPES.map(c=>({ cells:[
              <span style={{ fontWeight:600 }}>{c.name}</span>,
              <Badge color="cyan" sm>{c.freq}</Badge>,
              <span style={{ fontSize:12,color:TH.muted }}>{c.prot}</span>,
              <code style={{ fontSize:12 }}>{c.range}</code>,
              <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>{c.devs.map(d=><Badge key={d} color="gray" sm>{d}</Badge>)}</div>
            ]}))}/>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DEVICE MODELS
═══════════════════════════════════════════════════════════════════════ */
function DeviceModelsPage({ onNav }) {
  const [sel, setSel] = useState(null);
  const chk = v => <span style={{ color:v?TH.green:TH.red,fontWeight:700 }}>{v?"✓":"✗"}</span>;
  return (
    <div>
      <PageHeader title="Supported Device Models" sub="All 8 Suprema terminals compatible with G-SDK 1.7.2"
        action={<Btn onClick={()=>onNav("setup")} icon="⚙">Configure a Device</Btn>}/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:14,marginBottom:24 }}>
        {DM.map(m=>(
          <Card key={m.code} onClick={()=>setSel(m)} style={{ cursor:"pointer" }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
              <div>
                <div style={{ fontSize:15,fontWeight:800,color:TH.text,marginBottom:3,letterSpacing:"-.2px" }}>{m.model}</div>
                <code style={{ fontSize:11,color:TH.muted }}>{m.code}</code>
              </div>
              {m.npu?<Badge color="violet">NPU</Badge>:m.face?<Badge color="blue">Face</Badge>:<Badge color="gray">Card/PIN</Badge>}
            </div>
            <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>
              {m.face&&<Badge color="blue" sm>Face</Badge>}
              {m.card&&<Badge color="cyan" sm>Card</Badge>}
              {m.pin&&<Badge color="amber" sm>PIN</Badge>}
              {m.mobile&&<Badge color="green" sm>Mobile</Badge>}
              {m.ip65&&<Badge color="gray" sm>IP65</Badge>}
            </div>
          </Card>
        ))}
      </div>
      <Card pad={0} style={{ overflow:"hidden" }}>
        <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Feature Comparison</div>
        <Table headers={["Model","Face","Card","PIN","Mobile","NPU","IP65","G-SDK"]}
          rows={DM.map(m=>({ cells:[
            <div><div style={{ fontWeight:600 }}>{m.model}</div><code style={{ fontSize:10 }}>{m.code}</code></div>,
            chk(m.face),chk(m.card),chk(m.pin),chk(m.mobile),chk(m.npu),chk(m.ip65),
            <Badge color="green" sm>✓ Supported</Badge>
          ]}))}/>
      </Card>
      {sel&&<Modal title={sel.model} onClose={()=>setSel(null)} width={480} footer={<Btn full onClick={()=>{setSel(null);onNav("setup");}}>Configure This Device →</Btn>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["Code",sel.code],["Face",sel.face?"Yes":"No"],["Card",sel.card?"Yes":"No"],["PIN",sel.pin?"Yes":"No"],["Mobile",sel.mobile?"Yes":"No"],["NPU",sel.npu?"Yes — on-chip AI":"No"],["IP65",sel.ip65?"Yes — outdoor":"Indoor only"],["G-SDK","✓ v1.7.2"],["Default Port","51211"],["SSL Port","51212"]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v}</div>
            </div>
          ))}
        </div>
      </Modal>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   EXPORT DATA
═══════════════════════════════════════════════════════════════════════ */
function ExportPage() {
  const { show } = useToast();
  const { data:zData } = useFetch(()=>api.zones(),[],[]);
  const [cols,     setCols]     = useState(["timestamp","employeeName","zone","authMode","accessGranted","confidence","processingMs","temperature"]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [filter,   setFilter]   = useState("all");
  const [zone,     setZone]     = useState("all");
  const [exporting,setEx]       = useState(null);
  const formatDateDMY = (value = "") => {
    const digits = String(value).replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const dmyToISO = (dmy = "") => {
    const m = String(dmy).trim().match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return "";
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return "";
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const isoToDMY = (iso = "") => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return "";
    const [y, mm, dd] = iso.split("-");
    return `${dd}/${mm}/${y.slice(-2)}`;
  };
  const ALL_COLS = ["timestamp","employeeName","employeeId","company","department","zone","building","device","authMode","accessGranted","confidence","processingMs","temperature","direction","date"];
  const zoneOptions = useMemo(() => {
    const rows = Array.isArray(zData) ? zData : [];
    return [{ value:"all", label:"All Zones" }, ...rows
      .map((z) => String(z?.name || "").trim())
      .filter(Boolean)
      .map((name) => ({ value:name, label:name }))];
  }, [zData]);
  const setRangeDays = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - Math.max(0, days - 1));
    const iso = (d) => d.toISOString().slice(0, 10);
    setDateFrom(isoToDMY(iso(start)));
    setDateTo(isoToDMY(iso(end)));
  };

  const doExport = async fmt => {
    if (!cols.length) { show("Select at least one column","warning"); return; }
    setEx(fmt);
    try {
      const res = await api.exportData({
        format:fmt,
        columns:cols,
        filters:{
          dateFrom: dmyToISO(dateFrom) || undefined,
          dateTo: dmyToISO(dateTo) || undefined,
          granted:filter!=="all"?filter==="granted":undefined,
          zone:zone!=="all"?zone:undefined
        }
      });
      await saveDownloadResponse(res, `export-${fmt}`);
      show(`${fmt.toUpperCase()} downloaded`,"success");
    } catch(e) { show(e.message,"error"); }
    finally { setEx(null); }
  };

  return (
    <div>
      <PageHeader title="Export Data" sub="Download access logs in Excel, CSV, or PDF"/>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 320px", gap:16 }}>
        {/* Filters + Columns */}
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <Card>
            <div style={{ fontSize:14, fontWeight:700, color:TH.text, marginBottom:14 }}>Filters</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <Field label="From Date (dd/mm/yy)">
                <Input value={dateFrom} onChange={e=>setDateFrom(formatDateDMY(e.target.value))} placeholder="dd/mm/yy"/>
              </Field>
              <Field label="To Date (dd/mm/yy)">
                <Input value={dateTo} onChange={e=>setDateTo(formatDateDMY(e.target.value))} placeholder="dd/mm/yy"/>
              </Field>
              <Field label="Access Result">
                <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
                  {[["all","All"],["granted","Granted"],["denied","Denied"]].map(([v,l])=>(
                    <button
                      key={v}
                      onClick={()=>setFilter(v)}
                      style={{
                        padding:"7px 13px",
                        fontSize:12,
                        fontWeight:600,
                        background:filter===v?TH.blue:"transparent",
                        color:filter===v?"#fff":TH.muted,
                        border:"none",
                        cursor:"pointer"
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Zone">
                <div style={{ display:"flex",gap:6,flexWrap:"wrap",maxHeight:88,overflow:"auto",padding:2 }}>
                  {zoneOptions.map((z) => (
                    <button
                      key={z.value}
                      onClick={()=>setZone(z.value)}
                      style={{
                        padding:"5px 10px",
                        borderRadius:999,
                        fontSize:12,
                        fontWeight:600,
                        border:`1px solid ${zone===z.value?TH.blue:TH.border}`,
                        background:zone===z.value?TH.blueDim:TH.surface,
                        color:zone===z.value?TH.blue:TH.muted,
                        cursor:"pointer"
                      }}
                    >
                      {z.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginTop:10 }}>
              <Btn v="ghost" sz="xs" onClick={()=>setRangeDays(1)}>Today</Btn>
              <Btn v="ghost" sz="xs" onClick={()=>setRangeDays(7)}>Last 7 Days</Btn>
              <Btn v="ghost" sz="xs" onClick={()=>setRangeDays(30)}>Last 30 Days</Btn>
              <Btn v="ghost" sz="xs" onClick={()=>{setDateFrom("");setDateTo("");}}>Clear Dates</Btn>
            </div>
          </Card>
          <Card>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <span style={{ fontSize:14, fontWeight:700, color:TH.text }}>Columns ({cols.length} selected)</span>
              <div style={{ display:"flex", gap:7 }}>
                <Btn v="ghost" sz="xs" onClick={()=>setCols(ALL_COLS)}>Select All</Btn>
                <Btn v="ghost" sz="xs" onClick={()=>setCols([])}>Clear</Btn>
              </div>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
              {ALL_COLS.map(c=>(
                <button key={c} onClick={()=>setCols(p=>p.includes(c)?p.filter(x=>x!==c):[...p,c])}
                  style={{ padding:"5px 12px", borderRadius:20, fontSize:12, fontWeight:600, border:`1.5px solid ${cols.includes(c)?TH.blue:TH.border}`, background:cols.includes(c)?TH.blueDim:TH.surface, color:cols.includes(c)?TH.blue:TH.muted, cursor:"pointer", transition:"all .12s" }}>
                  {cols.includes(c)?"✓ ":""}{c}
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* Format buttons */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {[
            { fmt:"excel", icon:"📊", title:"Excel (.xlsx)", desc:"Spreadsheet with formatting, auto-widths, and column headers.", note:"Best for analysis, filtering, pivot tables", color:TH.green },
            { fmt:"csv",   icon:"📋", title:"CSV (.csv)",    desc:"Plain text, unlimited rows, compatible with any system.",       note:"Best for database import and automation",  color:TH.blue  },
            { fmt:"pdf",   icon:"📄", title:"PDF Report",    desc:"Formatted printable report with page numbers.",                 note:"Best for printing and official reports",    color:TH.red   },
          ].map(f=>(
            <GlassCard key={f.fmt} color={f.color} style={{ padding:"16px" }}>
              <div style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:14 }}>
                <div className="icon-chip-lg" style={{ background:`linear-gradient(180deg, ${f.color}34, ${f.color}16)`, border:`1px solid ${f.color}66`, boxShadow:`inset 0 1px 0 rgba(255,255,255,.14), 0 8px 16px ${f.color}30`, fontSize:18, flexShrink:0 }}>{f.icon}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:TH.text, marginBottom:3 }}>{f.title}</div>
                  <div style={{ fontSize:12, color:TH.muted, marginBottom:3 }}>{f.desc}</div>
                  <div style={{ fontSize:11, color:f.color, fontWeight:500 }}>{f.note}</div>
                </div>
              </div>
              <Btn full v="secondary" loading={exporting===f.fmt} disabled={!cols.length||!!exporting} onClick={()=>doExport(f.fmt)} style={{ borderColor:`${f.color}50`, color:f.color }}>
                ⬇ Download {f.title}
              </Btn>
            </GlassCard>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   THREAT INTEL
═══════════════════════════════════════════════════════════════════════ */
function ThreatIntelPage({ onNav }) {
  const [tab, setTab] = useState("overview");
  const { data, loading } = useFetch(()=>api.reportSecurity(),[],null);
  const riskScore = data?.riskScore||0;
  const riskColor = riskScore>=70?TH.red:riskScore>=40?TH.amber:TH.green;
  const threats   = data?.threats||[];
  const riskTrend = data?.riskTrend||[];

  const HOTSPOT_TYPE = "Denied Access Hotspot";
  const DETECTORS = [
    {icon:"👥",label:"Credential Sharing",    desc:"Same credential in 2+ zones <2min"},
    {icon:"🚶",label:"Tailgating Detection",   desc:"Two events <3s at same door"},
    {icon:"🔢",label:"Brute Force PIN",         desc:"5+ failed PINs in 10 min"},
    {icon:"🕐",label:"Off-Hours Access",       desc:"Events 01:00–05:00 AM"},
    {icon:"❓",label:"Unknown Credential",     desc:"Unregistered card presented"},
    {icon:"📷",label:"Fake Photo Enrollment",  desc:"Claude Vision anti-spoof AI"},
    {icon:"↩",label:"Anti-Passback",           desc:"Exit before entry in zone"},
    {icon:"🚪",label:"Door Held Open",         desc:"Door open >30 seconds"},
    {icon:"🌡",label:"Temperature Screening",  desc:"High temperature detection"},
    {icon:"🔒",label:"Forced Entry",            desc:"Relay trigger without auth event"},
  ];

  return (
    <div>
      <PageHeader title="Threat Intelligence" sub="AI-powered security risk engine with real-time anomaly detection"/>
      <Tabs active={tab} onChange={setTab} items={[
        {id:"overview",  label:"Overview",   icon:"🛡"},
        {id:"threats",   label:"Threats",    icon:"⚠", count:threats.filter(t=>t.status!=="resolved").length},
        {id:"trend",     label:"Risk Trend", icon:"📈"},
        {id:"detectors", label:"Detectors",  icon:"◉", count:DETECTORS.length},
      ]}/>

      {/* Overview */}
      {tab==="overview"&&(
        loading?<Loader/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
            <div style={{ display:"grid",gridTemplateColumns:"180px 1fr",gap:16 }}>
              {/* Gauge */}
              <Card style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,padding:20 }}>
                <div style={{ fontSize:11,fontWeight:700,color:TH.muted,textTransform:"uppercase",letterSpacing:".7px" }}>Risk Score</div>
                <div style={{ position:"relative",width:130,height:130 }}>
                  <svg width={130} height={130} style={{ transform:"rotate(-90deg)" }}>
                    <circle cx={65} cy={65} r={54} fill="none" stroke={TH.border} strokeWidth={10}/>
                    <circle cx={65} cy={65} r={54} fill="none" stroke={riskColor} strokeWidth={10}
                      strokeDasharray={`${2*Math.PI*54*riskScore/100} ${2*Math.PI*54*(1-riskScore/100)}`}
                      strokeLinecap="round"
                      style={{ filter:`drop-shadow(0 0 12px ${riskColor})`, transition:"stroke-dasharray .7s cubic-bezier(.4,0,.2,1)" }}/>
                  </svg>
                  <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
                    <div style={{ fontSize:32,fontWeight:900,color:riskColor,fontFamily:TH.mono,lineHeight:1 }}>{riskScore}</div>
                    <div style={{ fontSize:9,color:TH.muted }}>/100</div>
                  </div>
                </div>
                <Badge color={riskScore>=70?"red":riskScore>=40?"amber":"green"}>
                  {riskScore>=70?"HIGH RISK":riskScore>=40?"MEDIUM":"LOW RISK"}
                </Badge>
              </Card>

              {/* Stats grid */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
                <StatCard icon="🚨" label="Critical"    value={data?.critical||0}      color={TH.red}/>
                <StatCard icon="⚠"  label="High Risk"   value={data?.high||0}          color={TH.amber}/>
                <StatCard icon="🛡"  label="Detectors"   value={DETECTORS.length}       color={TH.blue}/>
                <StatCard icon="✅" label="Resolved"    value={data?.resolvedMonth||0}  color={TH.green}/>
              </div>
            </div>

            {/* AI Summary */}
            {data?.aiSummary&&(
              <GlassCard color={TH.violet} style={{ padding:"16px 18px" }}>
                <div style={{ display:"flex",gap:10,alignItems:"flex-start" }}>
                  <span style={{ fontSize:22,flexShrink:0 }}>✦</span>
                  <div>
                    <div style={{ fontSize:13,fontWeight:700,color:TH.violet,marginBottom:5 }}>ARIA AI Security Analysis</div>
                    <div style={{ fontSize:13,color:TH.muted,lineHeight:1.75 }}>{data.aiSummary}</div>
                    <div style={{ fontSize:11,color:TH.muted,lineHeight:1.55,marginTop:10,opacity:.88 }}>
                      Totals here mix Security Alerts with log-derived hotspots; the sidebar Alerts badge only counts open items in the Alerts inbox.
                    </div>
                  </div>
                </div>
              </GlassCard>
            )}
          </div>
        )
      )}

      {/* Active threats */}
      {tab==="threats"&&(
        loading?<Loader/>:threats.length===0?(
          <Empty icon="🛡" text="No threats detected" sub="All access patterns appear normal. Keep monitoring."/>
        ):(
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            {threats.map((t,i)=>{
              const sc=({HIGH:TH.red,MEDIUM:TH.amber,LOW:TH.blue})[t.risk]||TH.muted;
              return (
                <Card key={i} pad={0} style={{ overflow:"hidden" }}>
                  <div style={{ display:"flex" }}>
                    <div style={{ width:4,background:sc,flexShrink:0 }}/>
                    <div style={{ flex:1,padding:"13px 16px",display:"flex",gap:12,alignItems:"flex-start" }}>
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",marginBottom:6 }}>
                          <Badge color={{HIGH:"red",MEDIUM:"amber",LOW:"blue"}[t.risk]||"gray"}>{t.risk}</Badge>
                          {stBadge(t.status||"open")}
                          <span style={{ fontSize:14,fontWeight:700,color:TH.text }}>{t.type}</span>
                          {t.count&&<Badge color="gray" sm>{t.count} events</Badge>}
                        </div>
                        <div style={{ fontSize:13,color:TH.muted,lineHeight:1.65,marginBottom:5 }}>{t.detail||t.description}</div>
                        {t.affectedZone&&<span style={{ fontSize:11,color:TH.muted }}>📍 {t.affectedZone}</span>}
                      </div>
                      <Btn v="ghost" sz="xs" onClick={()=>{
                        if (!onNav) return;
                        if (String(t.type) === HOTSPOT_TYPE) {
                          try { sessionStorage.setItem("acs_logs_filter", "denied"); } catch {}
                          onNav("logs");
                        } else {
                          onNav("alerts");
                        }
                      }}>Investigate</Btn>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* Risk trend chart */}
      {tab==="trend"&&(
        riskTrend.length===0?(
          <Empty icon="📈" text="No trend data yet" sub="Needs 7+ days of access events to compute risk trend"/>
        ):(
          <Card>
            <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Risk Score — Last 14 Days</div>
            <div style={{ height:300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={riskTrend} margin={{top:4,right:4,left:-20,bottom:0}}>
                  <defs>
                    <linearGradient id="riskGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={TH.amber} stopOpacity={.28}/>
                      <stop offset="95%" stopColor={TH.amber} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                  <XAxis dataKey="date" tick={{fill:TH.muted,fontSize:10}}/>
                  <YAxis domain={[0,100]} tick={{fill:TH.muted,fontSize:10}}/>
                  <Tooltip contentStyle={TT_STYLE} itemStyle={TT_ITEM_STYLE} labelStyle={TT_LABEL_STYLE}/>
                  <Area type="monotone" dataKey="score" name="Risk Score" stroke={TH.amber} strokeWidth={2.5} fill="url(#riskGrad)"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )
      )}

      {/* Detection rules */}
      {tab==="detectors"&&(
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12 }}>
          {DETECTORS.map((d,i)=>(
            <Card key={i} pad={14}>
              <div style={{ display:"flex",gap:10,alignItems:"center" }}>
                <div className="icon-chip-lg" style={{ width:40,height:40,borderRadius:10,background:`linear-gradient(180deg, ${TH.blue}30, ${TH.blue}12)`,border:`1px solid ${TH.blue}55`,boxShadow:`inset 0 1px 0 rgba(255,255,255,.14), 0 8px 16px ${TH.blueGlow}`,fontSize:16,flexShrink:0 }}>{d.icon}</div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:13,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{d.label}</div>
                  <div style={{ fontSize:11,color:TH.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{d.desc}</div>
                </div>
                <Badge color="green" sm>ON</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   AI — ARIA Chat
═══════════════════════════════════════════════════════════════════════ */
function AIPage() {
  const { show } = useToast();
  const [msgs,    setMsgs]  = useState([]);
  const [input,   setInput] = useState("");
  const [busy,    setBusy]  = useState(false);
  const [model,   setModel] = useState("llama3.2");
  const { data:status } = useFetch(()=>api.aiStatus(),[],null);
  const msgWrapRef = useRef(null);
  const endRef = useRef(null);
  const modelOptions = (Array.isArray(status?.models) && status.models.length > 0
    ? status.models
    : ["llama3.2", "mistral", "codellama", "llama3.1"]).map(m => ({ value: m, label: m }));

  useEffect(() => {
    if (!msgWrapRef.current || msgs.length === 0) return;
    msgWrapRef.current.scrollTo({ top: msgWrapRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    const userMsg  = { role:"user",      content:q, ts:Date.now() };
    const assistMsg= { role:"assistant", content:"", loading:true, ts:Date.now() };
    setMsgs(p=>[...p, userMsg, assistMsg]);
    setInput("");
    setBusy(true);

    try {
      const history = [...msgs, userMsg].map(m=>({ role:m.role, content:m.content }));
      const res = await api.aiChatStream({ messages:history, model, context:"suprema_acs" });

      if (!res.ok) {
        const e = await res.json().catch(()=>({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }

      const ct = res.headers.get("content-type")||"";
      let full = "";

      if (ct.includes("text/event-stream")) {
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value).split("\n").filter(l=>l.startsWith("data:"));
          for (const line of lines) {
            const d = line.slice(5).trim();
            if (d==="[DONE]") continue;
            try {
              const p = JSON.parse(d);
              full += p.content || p.text || p.response || "";
            } catch {}
          }
          setMsgs(p=>{ const a=[...p]; a[a.length-1]={ ...a[a.length-1], content:full, loading:false }; return a; });
        }
      } else {
        const d = await res.json();
        full = d.response || d.content || d.message || "No response received";
        setMsgs(p=>{ const a=[...p]; a[a.length-1]={ ...a[a.length-1], content:full, loading:false }; return a; });
      }
    } catch(err) {
      setMsgs(p=>{ const a=[...p]; a[a.length-1]={ ...a[a.length-1], content:`⚠ ${err.message}`, loading:false }; return a; });
      show("AI request failed. Is Ollama running?","error");
    } finally { setBusy(false); }
  };

  const QUICK = [
    "Run anomaly detection on today's logs",
    "Which employees have the most denied access?",
    "Summarize last night's access events",
    "Find unusual access time patterns",
    "Which devices have high response times?",
    "Who accessed the server room this week?",
    "Generate a security compliance report",
    "Check for anti-passback violations",
    "List employees not enrolled in 30+ days",
    "What zones have the highest denial rate?",
    "Identify tailgating events in the last hour",
    "Give me a risk assessment summary",
  ];

  const renderContent = text => {
    if (!text) return <span style={{ color:TH.muted }}>▋</span>;
    return text.split("\n").map((line, i) => {
      const html = line
        .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${TH.blue};font-weight:700">$1</strong>`)
        .replace(/`([^`]+)`/g, `<code style="font-family:${TH.mono};background:${TH.blueDim};padding:1px 6px;border-radius:4px;font-size:.88em;color:${TH.blue}">$1</code>`)
        .replace(/^### (.+)/, `<span style="font-size:1.05em;font-weight:700;color:${TH.text}">$1</span>`)
        .replace(/^## (.+)/,  `<span style="font-size:1.1em;font-weight:800;color:${TH.text}">$1</span>`)
        .replace(/^- (.+)/,   `<span>• $1</span>`);
      return <div key={i} dangerouslySetInnerHTML={{ __html: html||"&nbsp;" }} style={{ lineHeight:1.78, marginBottom:1 }}/>;
    });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <PageHeader title="ARIA AI Assistant"/>

      {/* Status bar */}
      <Card pad={12} style={{ marginBottom:14, flexShrink:0 }}>
        <div style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap" }}>
          <div style={{ display:"flex", gap:7, alignItems:"center" }}>
            <div style={{ width:9, height:9, borderRadius:"50%", background:status?.online?TH.green:TH.red, boxShadow:`0 0 8px ${status?.online?TH.green:TH.red}` }} className="pulse-dot"/>
            <span style={{ fontSize:13, fontWeight:600, color:status?.online?TH.green:TH.red }}>
              {status?.online?"Ollama Online":"Ollama Offline"}
            </span>
          </div>
          {status?.online && (
            <Sel value={model} onChange={e=>setModel(e.target.value)} style={{ width:190 }}
              options={modelOptions}/>
          )}
          {!status?.online && (
            <span style={{ fontSize:12, color:TH.muted }}>
              Start: <code>ollama serve</code> · Pull: <code>ollama pull llama3.2</code>
            </span>
          )}
          {msgs.length>0&&<Btn v="ghost" sz="xs" style={{ marginLeft:"auto" }} onClick={()=>setMsgs([])}>Clear Chat</Btn>}
        </div>
      </Card>

      {/* Messages area */}
      <div ref={msgWrapRef} style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:14, marginBottom:14 }}>
        {msgs.length===0 ? (
          <div>
            <div style={{ textAlign:"center", padding:"24px 0 28px" }}>
              <div style={{ fontSize:44, marginBottom:10, opacity:.12 }}>◈</div>
              <div style={{ fontSize:18, fontWeight:800, color:TH.text, letterSpacing:"-.4px" }}>ARIA — Access & Risk Intelligence</div>
              <div style={{ fontSize:13, color:TH.muted, marginTop:6 }}>Powered by Ollama · Connected to live ACS data</div>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
              {QUICK.map(q=>(
                <button key={q} onClick={()=>setInput(q)}
                  style={{ padding:"6px 13px", background:TH.card, border:`1px solid ${TH.border}`, borderRadius:20, fontSize:12, color:TH.muted, cursor:"pointer", transition:"all .13s" }}
                  onMouseEnter={e=>{ e.currentTarget.style.borderColor=TH.blue; e.currentTarget.style.color=TH.blue; e.currentTarget.style.background=TH.blueDim; }}
                  onMouseLeave={e=>{ e.currentTarget.style.borderColor=TH.border; e.currentTarget.style.color=TH.muted; e.currentTarget.style.background=TH.card; }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : msgs.map((m,i)=>(
          <div key={i} className="fade-in" style={{ display:"flex", gap:10, alignItems:"flex-start", flexDirection:m.role==="user"?"row-reverse":"row" }}>
            <div style={{ width:34, height:34, borderRadius:"50%", background:m.role==="user"?TH.blueDim:TH.violetDim, border:`1px solid ${m.role==="user"?TH.blue:TH.violet}30`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0 }}>
              {m.role==="user"?"👤":"◈"}
            </div>
            <div style={{ maxWidth:"80%", background:m.role==="user"?TH.blueDim:TH.card, border:`1px solid ${m.role==="user"?`${TH.blue}25`:TH.border}`, borderRadius:m.role==="user"?"14px 3px 14px 14px":"3px 14px 14px 14px", padding:"12px 16px", fontSize:13, color:TH.text, lineHeight:1.7 }}>
              {m.loading ? (
                <span style={{ color:TH.muted, display:"flex", gap:6, alignItems:"center" }}>
                  <span className="spin" style={{ fontSize:13, color:TH.violet }}>⟳</span>
                  <span>ARIA is thinking…</span>
                </span>
              ) : renderContent(m.content)}
            </div>
          </div>
        ))}
        <div ref={endRef}/>
      </div>

      {/* Input */}
      <div style={{ display:"flex", gap:9, flexShrink:0 }}>
        <Input value={input} onChange={e=>setInput(e.target.value)}
          placeholder={status?.online?"Ask about logs, devices, employees, threats, anomalies…":"Start Ollama to use ARIA AI"}
          onEnter={send} disabled={busy||!status?.online} style={{ flex:1 }}/>
        <Btn onClick={send} disabled={busy||!input.trim()||!status?.online} loading={busy} icon={busy?undefined:"▶"}>
          {busy?"":"Send"}
        </Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   AI INSIGHTS
═══════════════════════════════════════════════════════════════════════ */
function AIInsightsPage() {
  const [tab, setTab] = useState("insights");
  const { data:insights,   loading:iLoad, reload } = useFetch(()=>api.aiInsights(),[],null);
  const { data:anomalies,  loading:aLoad, reload:reloadAnomalies } = useFetch(()=>api.aiAnomalyReport(),[],null);
  const { data:predictive, loading:pLoad, reload:reloadPredictive } = useFetch(()=>api.aiPredictive(),[],null);
  useEffect(() => {
    const iv = setInterval(() => {
      reload();
      reloadAnomalies();
      reloadPredictive();
    }, 15 * 60 * 1000);
    return () => clearInterval(iv);
  }, [reload, reloadAnomalies, reloadPredictive]);

  return (
    <div>
      <PageHeader title="AI Insights" sub="Automated analysis from ARIA — refreshed every 15 minutes"
        action={<Btn v="ghost" sz="sm" onClick={reload}>⟳ Refresh</Btn>}/>
      <Tabs active={tab} onChange={setTab} items={[
        {id:"insights",   label:"✦ Insights",  count:insights?.items?.length},
        {id:"anomalies",  label:"⚠ Anomalies", count:anomalies?.items?.length},
        {id:"predictive", label:"🔮 Predictive"},
      ]}/>

      {tab==="insights"&&(
        iLoad?<Loader text="ARIA is analyzing your data…"/>:
        !insights?.items?.length?<Empty icon="✦" text="No insights yet" sub="ARIA needs more access events to generate meaningful insights. Come back after more devices are connected."/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
            {insights.items.map((item,i)=>{
              const c = ({info:TH.blue,warning:TH.amber,critical:TH.red,success:TH.green})[item.severity]||TH.blue;
              return (
                <GlassCard key={i} color={c} style={{ padding:"14px 16px" }}>
                  <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
                    <span style={{ fontSize:22,flexShrink:0 }}>{item.icon||"✦"}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:5 }}>{item.title}</div>
                      <div style={{ fontSize:13,color:TH.muted,lineHeight:1.7 }}>{item.message}</div>
                      {item.action&&<div style={{ marginTop:8 }}><Btn v="ghost" sz="xs">{item.action}</Btn></div>}
                    </div>
                    <Badge color={{info:"blue",warning:"amber",critical:"red",success:"green"}[item.severity]||"blue"} sm>{item.severity}</Badge>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )
      )}

      {tab==="anomalies"&&(
        aLoad?<Loader text="Scanning for anomalies…"/>:
        !anomalies?.items?.length?<Empty icon="✅" text="No anomalies detected" sub="All access patterns appear normal"/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            {anomalies.items.map((a,i)=>(
              <Card key={i} pad={16}>
                <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
                  <div style={{ width:44,height:44,borderRadius:11,background:`${({high:TH.red,medium:TH.amber,low:TH.blue})[a.severity]||TH.blue}15`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>⚠</div>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:5 }}>
                      <Badge color={{high:"red",medium:"amber",low:"blue"}[a.severity]||"blue"}>{a.severity}</Badge>
                      <span style={{ fontSize:14,fontWeight:700,color:TH.text }}>{a.type}</span>
                      {a.affectedEntity&&<code style={{ fontSize:11 }}>{a.affectedEntity}</code>}
                    </div>
                    <div style={{ fontSize:13,color:TH.muted,lineHeight:1.65,marginBottom:6 }}>{a.description}</div>
                    {a.evidence?.length>0&&(
                      <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
                        {a.evidence.map((ev,j)=><Badge key={j} color="gray" sm>{ev}</Badge>)}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize:11,color:TH.muted,flexShrink:0 }}>{fRel(a.detectedAt)}</span>
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {tab==="predictive"&&(
        pLoad?<Loader text="Computing predictions…"/>:
        !predictive?<Empty icon="🔮" text="Insufficient data" sub="ARIA needs 7+ days of access events to generate predictions"/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <GlassCard color={TH.violet} style={{ padding:"16px 18px" }}>
              <div style={{ fontSize:13,fontWeight:700,color:TH.violet,marginBottom:7 }}>🔮 ARIA Predictive Analysis</div>
              <div style={{ fontSize:13,color:TH.muted,lineHeight:1.75 }}>{predictive.summary}</div>
            </GlassCard>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
              {(predictive.predictions||[]).map((p,i)=>(
                <Card key={i} pad={14}>
                  <div style={{ fontSize:11,fontWeight:700,color:TH.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8 }}>{p.category}</div>
                  <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:5 }}>{p.prediction}</div>
                  <div style={{ fontSize:12,color:TH.muted,marginBottom:10,lineHeight:1.6 }}>{p.reasoning}</div>
                  <Progress value={p.confidence||0} color={p.confidence>=80?TH.green:p.confidence>=60?TH.amber:TH.red} height={4} label={`Confidence: ${p.confidence||0}%`}/>
                </Card>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   REPORTS
═══════════════════════════════════════════════════════════════════════ */

/* Compact company multi-select used inside the Reports schedule form */
function CompanyPickerForSchedule({ selectedIds = [], onChange }) {
  const [search, setSearch] = useState("");
  const { data } = useFetch(()=>api.companies({ limit:200, status:"active" }), [], { companies:[] });
  const companies = data?.companies || [];
  const filtered = companies.filter(c => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (c.name||"").toLowerCase().includes(s) || (c.code||"").toLowerCase().includes(s);
  });
  const toggle = (id) => {
    const set = new Set(selectedIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    onChange?.(Array.from(set));
  };
  return (
    <Field label="Companies (optional)" hint="Select one or more companies to include all their employees automatically">
      <div style={{ marginBottom:6 }}>
        <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search companies…" style={{ fontSize:12 }}/>
      </div>
      <div style={{
        maxHeight:140, overflowY:"auto",
        border:`1px solid ${TH.border}`, borderRadius:6,
        background:TH.surface, padding:6
      }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:"center", padding:18, fontSize:12, color:TH.muted }}>
            {companies.length===0 ? "No companies registered yet — add some under People → Companies" : "No companies match"}
          </div>
        ) : (
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {filtered.map(c => {
              const id = String(c._id);
              const on = selectedIds.includes(id);
              return (
                <button key={id} type="button" onClick={()=>toggle(id)}
                  style={{
                    padding:"5px 10px",
                    fontSize:11, fontWeight:600,
                    borderRadius:4,
                    border:`1px solid ${on?TH.cyan:TH.border}`,
                    background:on?`linear-gradient(180deg, ${TH.cyanDim}, transparent)`:TH.card,
                    color:on?TH.cyan:TH.text,
                    cursor:"pointer",
                    transition:"all .12s"
                  }}>
                  {on ? "✓ " : ""}{c.name}{c.code?` (${c.code})`:""}
                  {c.employeeCount > 0 && (
                    <span style={{ marginLeft:6, fontSize:10, color:TH.muted }}>· {c.employeeCount} emp</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selectedIds.length > 0 && (
        <div style={{ fontSize:11, color:TH.cyan, marginTop:6 }}>
          {selectedIds.length} compan{selectedIds.length===1?"y":"ies"} selected
        </div>
      )}
    </Field>
  );
}

function ReportsPage() {
  const { show } = useToast();
  const [tab, setTab] = useState("overview");
  const [attFrom, setAttFrom] = useState("");
  const [attTo, setAttTo] = useState("");
  const [attSearch, setAttSearch] = useState("");
  const [attSearchMode, setAttSearchMode] = useState("name");
  const [attView, setAttView] = useState("person");
  const [attQuickRange, setAttQuickRange] = useState("custom");
  const [attSelectedIds, setAttSelectedIds] = useState([]);
  const [attSuggestIdx, setAttSuggestIdx] = useState(-1);
  const [selectedPeople, setSelectedPeople] = useState([]);
  const [schedEmpSearch, setSchedEmpSearch] = useState("");
  const [schedEmployeeIds, setSchedEmployeeIds] = useState([]);
  const [schedSuggestIdx, setSchedSuggestIdx] = useState(-1);
  const [schedForm, setSchedForm] = useState({
    name: "",
    emails: "",
    frequency: "weekly",
    weekday: "1",
    dayOfMonth: "1",
    rangeFrom: "",
    rangeTo: "",
    sendTime: "09:00",
    emailToEmployees: false,
    companyIds: [],          // NEW: select by company
  });
  const [schedCompanyIds, setSchedCompanyIds] = useState([]);  // controlled UI state
  const formatDateDMY = (value = "") => {
    const digits = String(value).replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(-2)}`;
  };
  const toDMY = (iso = "") => {
    const s = String(iso || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y.slice(-2)}`;
  };
  const toIsoDate = (v) => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (!m) return "";
    const dd = m[1];
    const mm = m[2];
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yy}-${mm}-${dd}`;
  };
  const { data:daily,    loading:dLoad } = useFetch(()=>api.reportDaily(),    [], null);
  const { data:security, loading:sLoad } = useFetch(()=>api.reportSecurity(), [], null);
  const { data:attend, loading:aLoad, reload:reloadAttend } = useFetch(()=>api.reportAttendance({
    dateFrom:toIsoDate(attFrom)||undefined,
    dateTo:toIsoDate(attTo)||undefined,
    search:attSearch||undefined,
    personIds: attSelectedIds.length ? attSelectedIds.join(",") : undefined
  }),[attFrom,attTo,attSearch,attSelectedIds.join(",")], null);
  const { data:subsData, reload:reloadSubs } = useFetch(()=>api.reportAttendanceSubscriptions(),[],[]);
  const { data:empData } = useFetch(()=>api.employees({ limit:100000 }),[],{ employees:[] });
  const schedules = Array.isArray(subsData) ? subsData : [];
  const schedEmployees = empData?.employees || [];
  const attEmpSuggestions = schedEmployees.filter((e) => {
    const q = attSearch.trim().toLowerCase();
    if (!q) return false;
    if (attSearchMode === "person") return String(e.employeeId || "").toLowerCase().includes(q);
    if (attSearchMode === "company") return String(e.company || "").toLowerCase().includes(q);
    if (attSearchMode === "department") return String(e.department || "").toLowerCase().includes(q);
    return String(e.name || "").toLowerCase().includes(q);
  }).slice(0, 10);
  useEffect(() => {
    setAttSuggestIdx(attEmpSuggestions.length ? 0 : -1);
  }, [attSearch, attSearchMode, attEmpSuggestions.length]);
  const addAttendanceFilterEmployee = useCallback((emp) => {
    const id = String(emp?.employeeId || "").trim();
    if (!id) return;
    setAttSelectedIds((prev)=>prev.includes(id)?prev:[...prev,id]);
    setAttSearch("");
    setAttSuggestIdx(-1);
  }, []);
  const schedEmployeeOptions = schedEmployees.filter((e) => {
    if (!schedEmpSearch.trim()) return true;
    const q = schedEmpSearch.toLowerCase();
    return [e.name, e.employeeId, e.department, e.designation].filter(Boolean).join(" ").toLowerCase().includes(q);
  }).slice(0, 12);
  useEffect(() => {
    setSchedSuggestIdx(schedEmployeeOptions.length ? 0 : -1);
  }, [schedEmpSearch, schedEmployeeOptions.length]);
  const addSchedEmployee = useCallback((emp) => {
    const id = String(emp?.employeeId || "").trim();
    if (!id) return;
    setSchedEmployeeIds((prev) => prev.includes(id) ? prev : [...prev, id]);
    setSchedEmpSearch("");
    setSchedSuggestIdx(-1);
  }, []);
  const attPeople = attend?.people || [];
  const selectedRows = attPeople.filter(p => selectedPeople.includes(p.personKey));
  const attDepartments = attend?.departments || [];
  const attCompanies = attend?.companies || [];
  const toggleSelected = (key) => setSelectedPeople(prev => prev.includes(key) ? prev.filter(x => x!==key) : [...prev, key]);
  const toggleSelectAll = () => setSelectedPeople(prev => (prev.length === attPeople.length ? [] : attPeople.map(p=>p.personKey)));
  const setQuickRange = (mode) => {
    const now = new Date();
    const toIso = (d) => d.toISOString().slice(0, 10);
    let from = "";
    let to = "";
    if (mode === "today") {
      from = toIso(now);
      to = toIso(now);
    } else if (mode === "week") {
      const start = new Date(now);
      start.setDate(now.getDate() - 6);
      from = toIso(start);
      to = toIso(now);
    } else if (mode === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      from = toIso(start);
      to = toIso(end);
    }
    setAttQuickRange(mode);
    if (mode === "custom") return;
    setAttFrom(from);
    setAttTo(to);
  };
  const doAttendanceExport = async (format) => {
    try {
      const rows = selectedRows.length ? selectedRows : attPeople;
      const res = await api.reportAttendanceExport({ format, rows });
      await saveDownloadResponse(res, `attendance-${format}`);
    } catch (e) {}
  };
  const doAttendanceEmail = async () => {
    const to = window.prompt("Recipient email for attendance report:");
    if (!to) return;
    try {
      const rows = selectedRows.length ? selectedRows : attPeople;
      await api.reportAttendanceEmail({ to, rows });
      window.alert("Attendance report emailed successfully.");
    } catch (e) {
      window.alert(e.message || "Failed to send attendance email.");
    }
  };
  const createAttendanceSchedule = async () => {
    try {
      const fallbackFromTable = [...new Set(selectedRows.map((r) => String(r.employeeId || "").trim()).filter(Boolean))];
      const employeeIds = [...new Set([...(schedEmployeeIds || []), ...fallbackFromTable])];
      if (!employeeIds.length && !schedCompanyIds.length) {
        show("Select at least one employee or one company","error");
        return;
      }
      const emails = String(schedForm.emails || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!emails.length && !schedForm.emailToEmployees) {
        show("Add at least one recipient email — or enable 'Email each employee'","error");
        return;
      }
      if (emails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
        show("One or more recipient emails are invalid","error");
        return;
      }
      if (schedForm.frequency === "monthly") {
        const dom = Number(schedForm.dayOfMonth || 1);
        if (Number.isNaN(dom) || dom < 1 || dom > 31) {
          show("Day of month must be between 1 and 31","error");
          return;
        }
      }
      if (schedForm.frequency === "range") {
        const fromIso = toIsoDate(schedForm.rangeFrom);
        const toIso = toIsoDate(schedForm.rangeTo);
        if (!fromIso || !toIso) {
          show("Range schedule requires valid from/to dates","error");
          return;
        }
        if (new Date(fromIso) > new Date(toIso)) {
          show("From date cannot be later than To date","error");
          return;
        }
      }
      const payload = {
        name: schedForm.name || `Attendance ${schedForm.frequency}`,
        emails,
        employeeIds,
        companyIds: schedCompanyIds,
        emailToEmployees: !!schedForm.emailToEmployees,
        frequency: schedForm.frequency,
        weekday: Number(schedForm.weekday || 1),
        dayOfMonth: Number(schedForm.dayOfMonth || 1),
        rangeFrom: toIsoDate(schedForm.rangeFrom),
        rangeTo: toIsoDate(schedForm.rangeTo),
        sendTime: schedForm.sendTime || "09:00",
        active: true
      };
      await api.reportAttendanceSubscriptionCreate(payload);
      show("Auto-attendance schedule created","success");
      setSchedForm({
        name: "",
        emails: "",
        frequency: "weekly",
        weekday: "1",
        dayOfMonth: "1",
        rangeFrom: "",
        rangeTo: "",
        sendTime: "09:00",
        emailToEmployees: false,
        companyIds: []
      });
      setSchedCompanyIds([]);
      setSchedEmployeeIds([]);
      setSchedEmpSearch("");
      reloadSubs();
    } catch (e) {
      show(e.message || "Failed to create schedule", "error");
    }
  };
  const setScheduleActive = async (s, active) => {
    try {
      await api.reportAttendanceSubscriptionUpdate(s._id, { active });
      show(active ? "Schedule enabled" : "Schedule paused", "success");
      reloadSubs();
    } catch (e) {
      show(e.message || "Failed to update schedule", "error");
    }
  };
  const runScheduleNow = async (s) => {
    try {
      await api.reportAttendanceSubscriptionRunNow(s._id);
      show("Scheduled report sent", "success");
      reloadSubs();
    } catch (e) {
      show(e.message || "Failed to send schedule", "error");
    }
  };
  const deleteSchedule = async (s) => {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
    try {
      await api.reportAttendanceSubscriptionDelete(s._id);
      show("Schedule deleted", "success");
      reloadSubs();
    } catch (e) {
      show(e.message || "Failed to delete schedule", "error");
    }
  };

  return (
    <div>
      <PageHeader title="Reports & Analytics"/>
      <Tabs active={tab} onChange={setTab} items={[{id:"overview",label:"Overview"},{id:"security",label:"Security"},{id:"attendance",label:"Attendance"}]}/>

      {tab==="overview"&&(
        dLoad?<Loader/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:16 }}>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12 }}>
              <StatCard icon="✅" label="Granted (30d)"  value={fNum(daily?.grantedMonth)}  color={TH.green}/>
              <StatCard icon="🚫" label="Denied (30d)"   value={fNum(daily?.deniedMonth)}   color={TH.red}/>
              <StatCard icon="⚠"  label="Alerts (30d)"  value={fNum(daily?.alertsMonth)}   color={TH.amber}/>
              <StatCard icon="👥" label="Unique Staff"   value={fNum(daily?.uniqueStaff)}   color={TH.blue}/>
            </div>
            {daily?.dailyTrend?.length>0&&(
              <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr",gap:16 }}>
                <Card>
                  <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Daily Trend — Last 14 Days</div>
                  <div style={{ height:210 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={daily.dailyTrend} margin={{top:4,right:4,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                        <XAxis dataKey="date" tick={{fill:TH.muted,fontSize:10}}/>
                        <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                        <Tooltip contentStyle={TT_STYLE} itemStyle={TT_ITEM_STYLE} labelStyle={TT_LABEL_STYLE}/>
                        <Line type="monotone" dataKey="granted" name="Granted" stroke={TH.green} strokeWidth={2} dot={false}/>
                        <Line type="monotone" dataKey="denied"  name="Denied"  stroke={TH.red}   strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                {daily?.byZone?.length>0&&(
                  <Card>
                    <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Top Zones</div>
                    <div style={{ height:210 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={daily.byZone.slice(0,7)} layout="vertical" margin={{top:0,right:8,left:0,bottom:0}}>
                          <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                          <XAxis type="number" tick={{fill:TH.muted,fontSize:10}}/>
                          <YAxis type="category" dataKey="zone" tick={{fill:TH.muted,fontSize:10}} width={84}/>
                          <Tooltip contentStyle={TT_STYLE} itemStyle={TT_ITEM_STYLE} labelStyle={TT_LABEL_STYLE}/>
                          <Bar dataKey="count" fill={TH.blue} radius={[0,4,4,0]}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </Card>
                )}
              </div>
            )}
            {(!daily?.dailyTrend?.length)&&!dLoad&&<Empty icon="📊" text="No report data yet" sub="Connect devices and access events will appear here"/>}
          </div>
        )
      )}

      {tab==="security"&&(
        sLoad?<Loader/>:!security?<Empty icon="🛡" text="No security data"/>:(
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12 }}>
              <StatCard icon="🚨" label="Critical"     value={security.critical||0}    color={TH.red}/>
              <StatCard icon="⚠"  label="High Risk"   value={security.high||0}         color={TH.amber}/>
              <StatCard icon="🛡"  label="Fake Blocks" value={security.fakeBlocked||0}  color={TH.green}/>
              <StatCard icon="↩"  label="APB"         value={security.apb||0}          color={TH.violet}/>
            </div>
            {security.incidents?.length>0&&(
              <Card pad={0} style={{ overflow:"hidden" }}>
                <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Security Incidents</div>
                <Table headers={["Type","Count","Severity","Last Seen"]}
                  rows={(security.incidents||[]).map(inc=>({ cells:[
                    <span style={{ fontWeight:600 }}>{inc.type}</span>,
                    <Badge color="blue" sm>{inc.count}</Badge>,
                    <Badge color={{critical:"red",high:"amber",medium:"blue",low:"gray"}[inc.severity]||"gray"} sm>{inc.severity}</Badge>,
                    <span style={{ fontSize:12,color:TH.muted }}>{fRel(inc.lastOccurrence)}</span>
                  ]}))}/>
              </Card>
            )}
          </div>
        )
      )}

      {tab==="attendance"&&(
          <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
            <Card>
              <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
                <Input value={toDMY(attFrom)} onChange={e=>{setAttFrom(formatDateDMY(e.target.value));setAttQuickRange("custom");}} placeholder="dd/mm/yy" style={{ width:170 }}/>
                <Input value={toDMY(attTo)} onChange={e=>{setAttTo(formatDateDMY(e.target.value));setAttQuickRange("custom");}} placeholder="dd/mm/yy" style={{ width:170 }}/>
                <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
                  {[["custom","Custom"],["today","Today"],["week","This Week"],["month","This Month"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setQuickRange(v)} style={{ padding:"7px 10px",fontSize:12,fontWeight:600,background:attQuickRange===v?TH.blue:"transparent",color:attQuickRange===v?"#fff":TH.muted,border:"none",cursor:"pointer",whiteSpace:"nowrap" }}>{l}</button>
                  ))}
                </div>
                <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
                  {[["person","Pass Number"],["name","Name"],["company","Company"],["department","Department"]].map(([v,l])=>(
                    <button key={v} onClick={()=>setAttSearchMode(v)} style={{ padding:"7px 10px",fontSize:12,fontWeight:600,background:attSearchMode===v?TH.blue:"transparent",color:attSearchMode===v?"#fff":TH.muted,border:"none",cursor:"pointer",whiteSpace:"nowrap" }}>{l}</button>
                  ))}
                </div>
                <div style={{ position:"relative",width:320 }}>
                  <Input
                    value={attSearch}
                    onChange={e=>setAttSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (!attEmpSuggestions.length) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAttSuggestIdx((p) => (p + 1) % attEmpSuggestions.length);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAttSuggestIdx((p) => (p <= 0 ? attEmpSuggestions.length - 1 : p - 1));
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        const pick = attEmpSuggestions[attSuggestIdx >= 0 ? attSuggestIdx : 0];
                        if (pick) addAttendanceFilterEmployee(pick);
                      } else if (e.key === "Escape") {
                        setAttSearch("");
                        setAttSuggestIdx(-1);
                      }
                    }}
                    placeholder={attSearchMode==="person"?"Type pass number…":attSearchMode==="company"?"Type company…":attSearchMode==="department"?"Type department…":"Type employee name…"}
                    style={{ width:"100%" }}
                  />
                  {attEmpSuggestions.length>0&&(
                    <div style={{ position:"absolute",top:"calc(100% + 4px)",left:0,right:0,zIndex:20,background:TH.surface,border:`1px solid ${TH.border}`,borderRadius:8,maxHeight:180,overflowY:"auto" }}>
                      {attEmpSuggestions.map((e, idx)=>(
                        <button key={e._id||e.employeeId} onClick={()=>{
                          addAttendanceFilterEmployee(e);
                        }} style={{ width:"100%",textAlign:"left",padding:"8px 10px",background:idx===attSuggestIdx?TH.blueDim:"transparent",border:"none",borderBottom:`1px solid ${TH.border}`,color:TH.text }}>
                          <span style={{ fontSize:12,fontWeight:600 }}>{e.name||"—"}</span> <span style={{ fontSize:11,color:TH.muted,fontFamily:TH.mono }}>({e.employeeId||"—"})</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Btn v="ghost" sz="xs" onClick={reloadAttend}>⟳</Btn>
                <div style={{ marginLeft:"auto",display:"flex",gap:7,flexWrap:"wrap" }}>
                  <Btn v="ghost" sz="sm" onClick={()=>doAttendanceExport("excel")}>⬇ Excel {selectedRows.length?`(${selectedRows.length})`:""}</Btn>
                  <Btn v="ghost" sz="sm" onClick={()=>doAttendanceExport("csv")}>⬇ CSV {selectedRows.length?`(${selectedRows.length})`:""}</Btn>
                  <Btn v="secondary" sz="sm" onClick={doAttendanceEmail}>✉ Email Attendance</Btn>
                </div>
              </div>
              {attSelectedIds.length>0&&(
                <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:8 }}>
                  {attSelectedIds.map((id)=>{
                    const e = schedEmployees.find((x)=>String(x.employeeId||"").trim()===id);
                    return <button key={id} onClick={()=>setAttSelectedIds((prev)=>prev.filter((x)=>x!==id))} style={{ border:`1px solid ${TH.blue}55`,background:TH.blueDim,color:TH.blue,borderRadius:999,padding:"2px 8px",fontSize:11 }}>{e?.name||id} ×</button>;
                  })}
                  <Btn sz="xs" v="ghost" onClick={()=>setAttSelectedIds([])}>Clear</Btn>
                </div>
              )}
            </Card>
            <Card>
              <Tabs
                active={attView}
                onChange={setAttView}
                items={[
                  { id:"person", label:"Attendance by Person", count:attPeople.length },
                  { id:"department", label:"Attendance by Department", count:attDepartments.length },
                  { id:"company", label:"Attendance by Company", count:attCompanies.length }
                ]}
              />
            </Card>
            <Card>
              <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:10 }}>Attendance Auto Email</div>
              <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:10 }}>
                <Field label="Schedule Name"><Input value={schedForm.name} onChange={e=>setSchedForm(p=>({...p,name:e.target.value}))} placeholder="Weekly Security Team"/></Field>
                <Field label="Recipients (comma separated)" hint="e.g. sec@company.com, hr@company.com"><Input value={schedForm.emails} onChange={e=>setSchedForm(p=>({...p,emails:e.target.value}))} placeholder="email1@company.com, email2@company.com"/></Field>
                <Field label="Frequency">
                  <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
                    {[["daily","Daily"],["weekly","Weekly"],["monthly","Monthly"],["range","Date Range"]].map(([v,l])=>(
                      <button key={v} onClick={()=>setSchedForm(p=>({...p,frequency:v}))} style={{ padding:"7px 10px",fontSize:12,fontWeight:600,background:schedForm.frequency===v?TH.blue:"transparent",color:schedForm.frequency===v?"#fff":TH.muted,border:"none",cursor:"pointer",whiteSpace:"nowrap" }}>{l}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Send Time"><Input type="time" value={schedForm.sendTime} onChange={e=>setSchedForm(p=>({...p,sendTime:e.target.value}))}/></Field>
                {schedForm.frequency==="weekly"&&<Field label="Weekday">
                  <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                    {[["0","Sunday"],["1","Monday"],["2","Tuesday"],["3","Wednesday"],["4","Thursday"],["5","Friday"],["6","Saturday"]].map(([v,l])=>(
                      <button key={v} onClick={()=>setSchedForm(p=>({...p,weekday:v}))} style={{ padding:"5px 9px",borderRadius:999,border:`1px solid ${schedForm.weekday===v?TH.blue:TH.border}`,background:schedForm.weekday===v?TH.blueDim:TH.surface,color:schedForm.weekday===v?TH.blue:TH.muted,fontSize:11,fontWeight:600,cursor:"pointer" }}>{l}</button>
                    ))}
                  </div>
                </Field>}
                {schedForm.frequency==="monthly"&&<Field label="Day of Month"><Input value={schedForm.dayOfMonth} onChange={e=>setSchedForm(p=>({...p,dayOfMonth:e.target.value}))} placeholder="1-31"/></Field>}
                {schedForm.frequency==="range"&&<Field label="From Date"><Input value={schedForm.rangeFrom} onChange={e=>setSchedForm(p=>({...p,rangeFrom:e.target.value}))} placeholder="dd/mm/yyyy"/></Field>}
                {schedForm.frequency==="range"&&<Field label="To Date"><Input value={schedForm.rangeTo} onChange={e=>setSchedForm(p=>({...p,rangeTo:e.target.value}))} placeholder="dd/mm/yyyy"/></Field>}
              </div>

              {/* Company-wise selection + email-each-employee */}
              <CompanyPickerForSchedule
                selectedIds={schedCompanyIds}
                onChange={setSchedCompanyIds}
              />
              <div style={{
                marginBottom:12, padding:"10px 12px",
                background:`linear-gradient(180deg, ${TH.cyanDim}, transparent)`,
                border:`1px solid ${TH.cyan}33`, borderRadius:6
              }}>
                <label style={{ display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer" }}>
                  <input
                    type="checkbox"
                    checked={!!schedForm.emailToEmployees}
                    onChange={e=>setSchedForm(p=>({...p,emailToEmployees:e.target.checked}))}
                    style={{ marginTop:2, accentColor:TH.cyan, width:16, height:16 }}
                  />
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:TH.text }}>📧 Also email each employee directly</div>
                    <div style={{ fontSize:11, color:TH.muted, marginTop:2 }}>
                      Each employee with a valid email address on file receives the attendance report at <b>{schedForm.sendTime}</b>.
                      Useful for weekly self-service reports.
                    </div>
                  </div>
                </label>
              </div>

              <div style={{ marginBottom:10 }}>
                <Field label="Select Employees by Name" hint="Search and add specific employees for this schedule">
                  <Input
                    value={schedEmpSearch}
                    onChange={e=>setSchedEmpSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (!schedEmployeeOptions.length) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSchedSuggestIdx((p) => (p + 1) % schedEmployeeOptions.length);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSchedSuggestIdx((p) => (p <= 0 ? schedEmployeeOptions.length - 1 : p - 1));
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        const pick = schedEmployeeOptions[schedSuggestIdx >= 0 ? schedSuggestIdx : 0];
                        if (pick) addSchedEmployee(pick);
                      } else if (e.key === "Escape") {
                        setSchedEmpSearch("");
                        setSchedSuggestIdx(-1);
                      }
                    }}
                    placeholder="Search by name / pass number / department"
                  />
                </Field>
                {schedEmpSearch.trim() && (
                  <div style={{ maxHeight:160, overflowY:"auto", border:`1px solid ${TH.border}`, borderRadius:8, background:TH.surface }}>
                    {schedEmployeeOptions.length===0 ? <div style={{ padding:10,fontSize:12,color:TH.muted }}>No employee match found</div> : schedEmployeeOptions.map((e, idx)=> {
                      const id = String(e.employeeId || "").trim();
                      const selected = schedEmployeeIds.includes(id);
                      return (
                        <button key={id||e._id} onClick={() => {
                          if (!id) return;
                          if (selected) setSchedEmployeeIds((prev) => prev.filter((x) => x!==id));
                          else addSchedEmployee(e);
                        }}
                          style={{ width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",background:selected||idx===schedSuggestIdx?TH.blueDim:"transparent",border:"none",borderBottom:`1px solid ${TH.border}`,color:TH.text,textAlign:"left" }}>
                          <span style={{ fontSize:12 }}>{e.name} <span style={{ color:TH.muted,fontFamily:TH.mono }}>({id||"—"})</span></span>
                          {selected && <Badge color="green" sm>Added</Badge>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {schedEmployeeIds.length>0 && (
                  <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:8 }}>
                    {schedEmployeeIds.map((id) => {
                      const e = schedEmployees.find((x) => String(x.employeeId||"").trim()===id);
                      return <button key={id} onClick={() => setSchedEmployeeIds((prev)=>prev.filter((x)=>x!==id))}
                        style={{ border:`1px solid ${TH.blue}55`,background:TH.blueDim,color:TH.blue,borderRadius:999,padding:"2px 8px",fontSize:11 }}>
                        {e?.name || id} ×
                      </button>;
                    })}
                  </div>
                )}
              </div>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                <div style={{ fontSize:12,color:TH.muted }}>
                  Selected employees for this schedule: <b>{[...new Set([...(schedEmployeeIds||[]), ...selectedRows.map((r)=>String(r.employeeId||"").trim()).filter(Boolean)])].length}</b>
                </div>
                <Btn onClick={createAttendanceSchedule}>Save Auto Schedule</Btn>
              </div>
              <div style={{ marginTop:12 }}>
                {schedules.length===0 ? <div style={{ fontSize:12,color:TH.muted }}>No schedules configured yet.</div> : (
                  <Table headers={["Name","Frequency","Send","Recipients","Selection","Last Sent","Status","Actions"]}
                    rows={schedules.map((s)=>({ key:s._id, cells:[
                      <div>
                        <div style={{ fontWeight:600 }}>{s.name||"—"}</div>
                        {s.emailToEmployees && <Badge color="cyan" sm>📧 Each Employee</Badge>}
                      </div>,
                      <div style={{ fontSize:12, textTransform:"capitalize" }}>
                        <div>{s.frequency||"—"}</div>
                        <div style={{ fontSize:10, color:TH.muted, fontFamily:TH.mono }}>
                          {s.frequency==="weekly" && `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][Number(s.weekday||1)]||""}`}
                          {s.frequency==="monthly" && `Day ${s.dayOfMonth||1}`}
                          {s.frequency==="range" && `${s.rangeFrom} → ${s.rangeTo}`}
                        </div>
                      </div>,
                      <span style={{ fontSize:12,fontFamily:TH.mono,color:TH.cyan }}>{s.sendTime||"—"}</span>,
                      <div style={{ fontSize:12 }}>
                        {(s.emails||[]).slice(0,2).join(", ")||(s.emailToEmployees?"(each employee)":"—")}
                        {(s.emails||[]).length>2 && <span style={{ color:TH.muted }}> +{(s.emails||[]).length-2}</span>}
                      </div>,
                      <div style={{ display:"flex",gap:4,flexDirection:"column" }}>
                        {(s.employeeIds||[]).length>0 && <Badge color="blue" sm>{(s.employeeIds||[]).length} emp</Badge>}
                        {(s.companyIds||[]).length>0 && <Badge color="violet" sm>{(s.companyIds||[]).length} co.</Badge>}
                      </div>,
                      <span style={{ fontSize:11,fontFamily:TH.mono }}>
                        {s.lastSentAt
                          ? <span>{fDT(s.lastSentAt)}{s.lastSentCount?` · ${s.lastSentCount} rows`:""}</span>
                          : "Never"}
                        {s.lastError && <div style={{ color:TH.red, fontSize:10, marginTop:2 }}>⚠ {String(s.lastError).slice(0,60)}</div>}
                      </span>,
                      s.active ? <Badge color="green" sm>Active</Badge> : <Badge color="gray" sm>Paused</Badge>,
                      <div style={{ display:"flex",gap:6 }}>
                        <Btn sz="xs" v="ghost" onClick={()=>runScheduleNow(s)}>Run now</Btn>
                        <Btn sz="xs" v="secondary" onClick={()=>setScheduleActive(s,!s.active)}>{s.active?"Pause":"Enable"}</Btn>
                        <Btn sz="xs" v="destructive" onClick={()=>deleteSchedule(s)}>Delete</Btn>
                      </div>
                    ]}))}/>
                )}
              </div>
            </Card>

            {attView==="person"&&<Card pad={0} style={{ overflow:"hidden" }}>
              <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Attendance by Person</div>
              <Table loading={aLoad} headers={["", "Photo", "Pass Number", "Card Id", "Name", "Company", "Designation", "Department", "Division", "Cardholder Status", "Status", "In Time", "Out Time", "Duration", "Events"]}
                rows={attPeople.map(p=>({ cells:[
                  <input type="checkbox" checked={selectedPeople.includes(p.personKey)} onChange={()=>toggleSelected(p.personKey)} />,
                  p.photo ? <img src={p.photo} alt={p.employeeName} style={{ width:30,height:30,borderRadius:8,objectFit:"cover",border:`1px solid ${TH.border}` }}/> : <Avatar name={p.employeeName||"?"} size={28} color={p.status==="in"?TH.green:TH.muted}/>,
                  <span style={{ fontSize:12,fontFamily:TH.mono }}>{p.employeeId||"—"}</span>,
                  <span style={{ fontSize:12,fontFamily:TH.mono }}>{p.cardId||"—"}</span>,
                  <span style={{ fontWeight:600 }}>{p.employeeName||"—"}</span>,
                  p.company||"—",
                  p.designation||"—",
                  p.department||"—",
                  p.division||"—",
                  <Badge color={String(p.cardholderStatus||"").toLowerCase()==="active"?"green":"gray"} sm>{p.cardholderStatus||"—"}</Badge>,
                  p.status==="in" ? <Badge color="green" sm>In</Badge> : <Badge color="gray" sm>Out</Badge>,
                  <span style={{ fontSize:12,fontFamily:TH.mono }}>{fDT(p.inTime)}</span>,
                  <span style={{ fontSize:12,fontFamily:TH.mono }}>{fDT(p.outTime)}</span>,
                  <span style={{ fontSize:12,fontFamily:TH.mono }}>{p.totalDuration||"—"}</span>,
                  <Badge color="blue" sm>{p.eventsCount||0}</Badge>
                ]}))}/>
              <div style={{ padding:"8px 16px",borderTop:`1px solid ${TH.border}`,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <button onClick={toggleSelectAll} style={{ background:"none",border:"none",color:TH.blue,cursor:"pointer",fontSize:12 }}>{selectedPeople.length===attPeople.length?"Unselect all":"Select all"}</button>
                <span style={{ fontSize:12,color:TH.muted }}>{selectedPeople.length} selected</span>
              </div>
            </Card>}

            {attView==="department"&&<Card pad={0} style={{ overflow:"hidden" }}>
              <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Attendance by Department</div>
              <Table loading={aLoad} headers={["Department","Employees","Avg Daily","On-Time Rate","Total Duration"]}
                rows={attDepartments.map(d=>({ cells:[
                  d.name, fNum(d.employeeCount),
                  <span style={{ fontFamily:TH.mono }}>{d.avgDailyAccess||0}/day</span>,
                  <div style={{ minWidth:90 }}><Progress value={d.onTimeRate||0} color={d.onTimeRate>=90?TH.green:d.onTimeRate>=75?TH.amber:TH.red} height={4} label={`${d.onTimeRate||0}%`}/></div>,
                  <span style={{ fontFamily:TH.mono }}>{d.totalDuration||"—"}</span>
                ]}))}/>
            </Card>}
            {attView==="company"&&<Card pad={0} style={{ overflow:"hidden" }}>
              <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Attendance by Company</div>
              <Table loading={aLoad} headers={["Company","Employees","Avg Daily","Total Duration"]}
                rows={attCompanies.map(c=>({ cells:[
                  c.name || "—",
                  fNum(c.employeeCount || 0),
                  <span style={{ fontFamily:TH.mono }}>{c.avgDailyAccess||0}/day</span>,
                  <span style={{ fontFamily:TH.mono }}>{c.totalDuration||"—"}</span>
                ]}))}/>
            </Card>}
          </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   LOCATIONS & BUILDINGS
═══════════════════════════════════════════════════════════════════════ */
function LocationsPage() {
  const { show } = useToast();
  const [tab, setTab] = useState("buildings");
  const { data:bData, loading:bLoad, reload:bReload } = useFetch(()=>api.buildings(),[],[]);
  const { data:zData, loading:zLoad, reload:zReload }  = useFetch(()=>api.zones(),[],[]);
  const { data:dData, loading:dLoad } = useFetch(()=>api.devices(),[],[]);
  const buildings = bData||[]; const zones = zData||[];
  const devices = dData||[];
  const idEq = (a, b) => String(a || "").trim() === String(b || "").trim();
  const norm = (v) => String(v || "").trim().toLowerCase();

  const [showB, setShowB] = useState(false);
  const [showZ, setShowZ] = useState(false);
  const [editB, setEditB] = useState(null);
  const [editZ, setEditZ] = useState(null);
  const [selZone, setSelZone] = useState(null);
  const [bForm, setBForm] = useState({ name:"", address:"", floors:"1" });
  const [zForm, setZForm] = useState({ name:"", building:"", floor:"G", type:"entry" });
  const [confirm, setConfirm] = useState(null);

  const saveB = async () => {
    try {
      editB ? await api.buildingUpdate(editB._id, bForm) : await api.buildingCreate(bForm);
      show(editB?"Updated":"Created","success"); setShowB(false); bReload();
    } catch(e){ show(e.message,"error"); }
  };
  const saveZ = async () => {
    try {
      editZ ? await api.zoneUpdate(editZ._id, zForm) : await api.zoneCreate(zForm);
      show(editZ?"Updated":"Created","success"); setShowZ(false); zReload();
    } catch(e){ show(e.message,"error"); }
  };
  const delB = async id => {
    try { await api.buildingDelete(id); show("Deleted","success"); bReload(); zReload(); }
    catch(e){ show(e.message,"error"); }
    finally { setConfirm(null); }
  };
  const delZ = async id => {
    try { await api.zoneDelete(id); show("Deleted","success"); zReload(); }
    catch(e){ show(e.message,"error"); }
    finally { setConfirm(null); }
  };

  const TYPE_C = { entry:"green", general:"blue", restricted:"red" };
  const zoneDevices = useCallback((z) => devices.filter((d) => {
    const zoneName = norm(d.zone || d.zoneName || d.zoneLabel || d.zone_title);
    const zoneId = String(d.zoneId || d.zone_id || d.zoneRef || "").trim();
    return zoneName === norm(z?.name) || idEq(zoneId, z?._id);
  }), [devices]);
  // Canonical source of truth: compute zone/building device counts from actual devices list.
  // Do not trust persisted `zone.devices` since it can be stale after restore/migration.
  const zoneDeviceCountById = useMemo(() => {
    const m = new Map();
    for (const z of zones) m.set(String(z?._id || ""), zoneDevices(z).length);
    return m;
  }, [zones, zoneDevices]);
  const buildingDeviceCount = useCallback((b) => {
    const bz = zones.filter((z) => idEq(z.building, b?._id) || idEq(z.buildingId, b?._id));
    return bz.reduce((sum, z) => sum + Number(zoneDeviceCountById.get(String(z?._id || "")) || 0), 0);
  }, [zones, zoneDeviceCountById]);

  return (
    <div>
      <PageHeader title="Locations & Buildings"
        action={
          tab==="buildings"
            ? <Btn onClick={()=>{setEditB(null);setBForm({name:"",address:"",floors:"1"});setShowB(true);}} icon="+">Add Building</Btn>
            : <Btn onClick={()=>{setEditZ(null);setZForm({name:"",building:buildings[0]?._id||"",floor:"G",type:"entry"});setShowZ(true);}} icon="+">Add Zone</Btn>
        }/>
      <Tabs active={tab} onChange={setTab} items={[{id:"buildings",label:"🏢 Buildings",count:buildings.length},{id:"zones",label:"📍 Zones",count:zones.length}]}/>

      {tab==="buildings"&&(
        bLoad?<Loader/>:buildings.length===0?(
          <Empty icon="🏢" text="No buildings yet" sub="Add your first building to organize access zones"
            action={<Btn onClick={()=>{setEditB(null);setBForm({name:"",address:"",floors:"1"});setShowB(true);}}>Add First Building</Btn>}/>
        ):(
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14 }}>
            {buildings.map(b=>{
              const bz = zones.filter(z=>idEq(z.building, b._id)||idEq(z.buildingId, b._id));
              return (
                <Card key={b._id}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14 }}>
                    <div style={{ display:"flex",gap:11,alignItems:"center" }}>
                      <div style={{ width:44,height:44,borderRadius:11,background:TH.blueDim,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22 }}>🏢</div>
                      <div>
                        <div style={{ fontSize:15,fontWeight:800,color:TH.text,letterSpacing:"-.2px" }}>{b.name}</div>
                        <code style={{ fontSize:10,color:TH.muted }}>{b._id}</code>
                      </div>
                    </div>
                    {stBadge(b.status||"active")}
                  </div>
                  {b.address&&<div style={{ fontSize:12,color:TH.muted,marginBottom:14 }}>📍 {b.address}</div>}
                  <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14 }}>
                    {[["Floors",b.floors||"—"],["Zones",bz.length],["Devices",buildingDeviceCount(b)]].map(([k,v])=>(
                      <div key={k} style={{ textAlign:"center",padding:"8px 4px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
                        <div style={{ fontSize:18,fontWeight:800,color:TH.blue,fontFamily:TH.mono }}>{v}</div>
                        <div style={{ fontSize:10,color:TH.muted,textTransform:"uppercase" }}>{k}</div>
                      </div>
                    ))}
                  </div>
                  {bz.length>0&&(
                    <div style={{ display:"flex",flexWrap:"wrap",gap:5,marginBottom:14 }}>
                      {bz.map(z=><Badge key={z._id} color={TYPE_C[z.type]||"gray"} sm>📍 {z.name}</Badge>)}
                    </div>
                  )}
                  <div style={{ display:"flex",gap:8,paddingTop:12,borderTop:`1px solid ${TH.border}` }}>
                    <Btn v="secondary" sz="sm" full onClick={()=>{setEditB(b);setBForm({name:b.name,address:b.address||"",floors:String(b.floors||1)});setShowB(true);}}>✏ Edit</Btn>
                    <Btn v="destructive" sz="sm" onClick={()=>setConfirm({kind:"building",id:b._id,name:b.name})}>✕</Btn>
                  </div>
                </Card>
              );
            })}
            <div onClick={()=>{setEditB(null);setBForm({name:"",address:"",floors:"1"});setShowB(true);}}
              style={{ border:`2px dashed ${TH.border}`,borderRadius:14,padding:20,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:9,cursor:"pointer",minHeight:180,transition:"all .14s" }}
              onMouseEnter={e=>{ e.currentTarget.style.borderColor=TH.blue; e.currentTarget.style.background=TH.blueDim; }}
              onMouseLeave={e=>{ e.currentTarget.style.borderColor=TH.border; e.currentTarget.style.background="transparent"; }}>
              <div style={{ fontSize:30,opacity:.2 }}>🏢</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.muted }}>Add Building</div>
            </div>
          </div>
        )
      )}

      {tab==="zones"&&(
        zLoad?<Loader/>:zones.length===0?(
          <Empty icon="📍" text="No zones yet" sub="Add buildings first, then add zones to each building"/>
        ):(
          <div style={{ display:"flex",flexDirection:"column",gap:18 }}>
            {[...buildings.map(b => {
              const bz = zones.filter(z=>idEq(z.building, b._id)||idEq(z.buildingId, b._id));
              return { key: String(b._id), title: b.name, zones: bz };
            }).filter(g => g.zones.length),
            ...(() => {
              const assigned = new Set(buildings.map(b => String(b._id)));
              const orphan = zones.filter(z => {
                const zid = String(z.building || z.buildingId || "");
                return !zid || !assigned.has(zid);
              });
              return orphan.length ? [{ key: "__unassigned__", title: "Unassigned Zones", zones: orphan }] : [];
            })()
            ].map(g=>(
              <div key={g.key}>
                <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:9,display:"flex",alignItems:"center",gap:8 }}>
                  🏢 {g.title}<span style={{ fontSize:12,color:TH.muted,fontWeight:400 }}>· {g.zones.length} zone{g.zones.length!==1?"s":""}</span>
                </div>
                <Card pad={0} style={{ overflow:"hidden" }}>
                  <Table headers={["Zone","Floor","Type","Devices","Status","Actions"]}
                    onRow={row => setSelZone(row.z)}
                    rows={g.zones.map(z=>({ cells:[
                      <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                        <span style={{ fontSize:15 }}>📍</span>
                        <div><div style={{ fontWeight:600 }}>{z.name}</div><code style={{ fontSize:10,color:TH.muted }}>{z._id}</code></div>
                      </div>,
                      <Badge color="gray" sm>Floor {z.floor||"G"}</Badge>,
                      <Badge color={TYPE_C[z.type]||"gray"} sm>{z.type}</Badge>,
                      <span style={{ fontSize:12,fontFamily:TH.mono }}>{zoneDeviceCountById.get(String(z?._id || "")) || 0}</span>,
                      stBadge(z.status||"active"),
                      <div style={{ display:"flex",gap:5 }}>
                        <Btn v="secondary" sz="xs" onClick={e=>{e.stopPropagation();setSelZone(z);}}>View Devices</Btn>
                        <Btn v="ghost" sz="xs" onClick={e=>{e.stopPropagation();setEditZ(z);setZForm({name:z.name,building:z.building||z.buildingId||"",floor:z.floor||"G",type:z.type||"entry"});setShowZ(true);}}>✏</Btn>
                        <Btn v="destructive" sz="xs" onClick={e=>{e.stopPropagation();setConfirm({kind:"zone",id:z._id,name:z.name});}}>✕</Btn>
                      </div>
                    ], z}))}/>
                </Card>
              </div>
            ))}
          </div>
        )
      )}

      {/* Building modal */}
      {showB&&(
        <Modal title={editB?"Edit Building":"Add Building"} onClose={()=>setShowB(false)} width={480}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setShowB(false)}>Cancel</Btn><Btn onClick={saveB} disabled={!bForm.name}>{editB?"Save Changes":"Add Building"}</Btn></div>}>
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <Field label="Building Name" required><Input value={bForm.name} onChange={e=>setBForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Headquarters"/></Field>
            <Field label="Full Address"><Input value={bForm.address} onChange={e=>setBForm(p=>({...p,address:e.target.value}))} placeholder="123 Main St, City, State 00000"/></Field>
            <Field label="Number of Floors"><Input value={bForm.floors} onChange={e=>setBForm(p=>({...p,floors:e.target.value}))} type="number" placeholder="1" style={{ maxWidth:120 }}/></Field>
          </div>
        </Modal>
      )}

      {/* Zone modal */}
      {showZ&&(
        <Modal title={editZ?"Edit Zone":"Add Zone"} onClose={()=>setShowZ(false)} width={480}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setShowZ(false)}>Cancel</Btn><Btn onClick={saveZ} disabled={!zForm.name||!zForm.building}>{editZ?"Save Changes":"Add Zone"}</Btn></div>}>
          <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
            <Field label="Building" required>
              <Sel value={zForm.building} onChange={e=>setZForm(p=>({...p,building:e.target.value}))} options={[{value:"",label:"Select building…"},...buildings.map(b=>({value:b._id,label:b.name}))]}/>
            </Field>
            <Field label="Zone Name" required hint="e.g. Main Entrance, Server Room, Lab A"><Input value={zForm.name} onChange={e=>setZForm(p=>({...p,name:e.target.value}))} placeholder="Zone name"/></Field>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
              <Field label="Floor" hint="G=Ground, B1=Basement, 1–99"><Input value={zForm.floor} onChange={e=>setZForm(p=>({...p,floor:e.target.value}))} placeholder="G" style={{ maxWidth:100 }}/></Field>
              <Field label="Zone Type">
                <Sel value={zForm.type} onChange={e=>setZForm(p=>({...p,type:e.target.value}))} options={[{value:"entry",label:"Entry — public"},{value:"general",label:"General — staff"},{value:"restricted",label:"Restricted — high security"}]}/>
              </Field>
            </div>
          </div>
        </Modal>
      )}

      {selZone&&(
        <Modal title={`Zone Devices — ${selZone.name}`} onClose={()=>setSelZone(null)} width={720}>
          {dLoad ? <Loader/> : (
            zoneDevices(selZone).length===0 ? (
              <Empty icon="◫" text="No devices installed in this zone" sub="Assign a device to this zone from Device Setup or My Devices"/>
            ) : (
              <Card pad={0} style={{ overflow:"hidden" }}>
                <Table headers={["Device","Model","IP","Status","Users"]}
                  rows={zoneDevices(selZone).map(d=>({ key:d._id||d.deviceId||d.id||d.ip||d.name, cells:[
                    <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                      <span style={{ fontSize:14 }}>◫</span>
                      <div>
                        <div style={{ fontWeight:600 }}>{d.name||"Unnamed Device"}</div>
                        <code style={{ fontSize:10,color:TH.muted }}>{d._id||d.deviceId||d.id||"—"}</code>
                      </div>
                    </div>,
                    d.model||"—",
                    <code style={{ fontSize:12 }}>{d.ipAddr||d.ip||"—"}:{d.port||51211}</code>,
                    stBadge(d.status||"offline"),
                    <span style={{ fontSize:12,fontFamily:TH.mono }} title="Not queried from reader">{deviceReaderUserDisplay(d)}</span>
                  ]}))}
                  emptyIcon="◫"
                  emptyText="No devices installed in this zone"/>
              </Card>
            )
          )}
        </Modal>
      )}

      {confirm&&<Confirm title={`Delete ${confirm.kind}`}
        message={`Delete "${confirm.name}"?${confirm.kind==="building"?" All zones in this building will also be deleted.":""}`}
        onConfirm={()=>confirm.kind==="building"?delB(confirm.id):delZ(confirm.id)} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPER ADMIN
═══════════════════════════════════════════════════════════════════════ */
function SuperAdminPage() {
  const { show } = useToast();
  const { data, loading, reload } = useFetch(()=>api.adminAccounts(),[],[]);
  const [showCreate, setShowCreate] = useState(false);
  const [editAcc,     setEditAcc]    = useState(null);
  const [renew,      setRenew]      = useState(null);
  const [confirm,    setConfirm]    = useState(null);
  const [form, setForm] = useState({ name:"", username:"", password:"", email:"", role:"operator", expires:"" });
  const [editForm, setEditForm] = useState({ name:"", email:"", role:"operator", status:"active", expires:"", password:"" });
  const accounts = data||[];
  const isSuper = a => (a?.role || "").toLowerCase() === "superadmin";

  const daysLeft = exp => { if(!exp)return null; return Math.floor((new Date(exp)-Date.now())/86400000); };
  const rc = r => ({ admin:"amber", superadmin:"red", security:"cyan", operator:"blue", device_mgr:"violet", viewer:"gray" })[r]||"gray";

  const doCreate = async () => {
    try { await api.adminCreate(form); show("Account created","success"); setShowCreate(false); reload(); }
    catch(e){ show(e.message,"error"); }
  };
  const doRevoke = async id => {
    try { await api.adminRevoke(id); show("Access revoked","success"); reload(); }
    catch(e){ show(e.message,"error"); }
    finally { setConfirm(null); }
  };
  const doDelete = async id => {
    try { await api.adminDelete(id); show("Account deleted","success"); reload(); }
    catch(e){ show(e.message,"error"); }
    finally { setConfirm(null); }
  };
  const doRenew = async (id, days) => {
    try { await api.adminUpdate(id,{renewDays:days}); show(`Renewed +${days} days`,"success"); reload(); setRenew(null); }
    catch(e){ show(e.message,"error"); }
  };
  const startEdit = a => {
    setEditAcc(a);
    setEditForm({
      name: a.name || "",
      email: a.email || "",
      role: a.role || "operator",
      status: a.status || "active",
      expires: a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0,10) : "",
      password: ""
    });
  };
  const doEdit = async () => {
    if (!editAcc) return;
    try {
      const accountId = editAcc._id || editAcc.username;
      if (isSuper(editAcc)) {
        if (!editForm.password.trim()) { show("Enter new password for superadmin","warning"); return; }
        await api.adminUpdate(accountId, { password: editForm.password });
      } else {
        await api.adminUpdate(accountId, {
          name: editForm.name,
          email: editForm.email,
          role: editForm.role,
          status: editForm.status,
          expiresAt: editForm.expires || null
        });
      }
      show("Account updated","success");
      setEditAcc(null);
      reload();
    } catch (e) { show(e.message,"error"); }
  };

  const expiring = accounts.filter(a=>{ const d=daysLeft(a.expiresAt); return d!=null&&d>0&&d<=30; });

  return (
    <div>
      <PageHeader title="Admin Account Management" sub="Create and manage portal user accounts with expiry control"
        action={<Btn onClick={()=>setShowCreate(true)} icon="+">Create Account</Btn>}/>

      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="👥" label="Total"       value={accounts.length}                                       color={TH.blue}/>
        <StatCard icon="✅" label="Active"      value={accounts.filter(a=>a.status==="active").length}        color={TH.green}/>
        <StatCard icon="⚠"  label="Expiring"   value={expiring.length}                                       color={TH.amber}/>
        <StatCard icon="🔴" label="Expired"    value={accounts.filter(a=>{const d=daysLeft(a.expiresAt);return d!=null&&d<0;}).length} color={TH.red}/>
      </div>

      {expiring.length>0&&(
        <GlassCard color={TH.amber} style={{ marginBottom:16,padding:"11px 16px" }}>
          <span style={{ fontSize:13,color:TH.amber,fontWeight:600 }}>
            ⚠ Expiring soon: {expiring.map(a=>`${a.name||a.username} (${daysLeft(a.expiresAt)}d)`).join(" · ")}
          </span>
        </GlassCard>
      )}

      {loading?<Loader/>:(
        <Card pad={0} style={{ overflow:"hidden" }}>
          <Table headers={["Account","Role","Status","Expires","Days Left","Actions"]}
            rows={accounts.map(a=>{
              const days = daysLeft(a.expiresAt);
              return ({ cells:[
                <div>
                  <div style={{ fontWeight:600 }}>{a.name||a.username}</div>
                  <code style={{ fontSize:10,color:TH.muted }}>{a.username}</code>
                </div>,
                <Badge color={rc(a.role)}>{a.role?.replace("_"," ")}</Badge>,
                stBadge(a.status||"active"),
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{a.expiresAt?fD(a.expiresAt):"Never"}</span>,
                days===null?<Badge color="gray" sm>No Expiry</Badge>:days<0?<Badge color="red" sm>Expired</Badge>:days<=30?<Badge color="amber" sm>{days}d</Badge>:<Badge color="green" sm>{days}d</Badge>,
                <div style={{ display:"flex",gap:4 }}>
                  <Btn v="ghost" sz="xs" onClick={()=>setRenew(a)}>Renew</Btn>
                  <Btn v="ghost" sz="xs" onClick={()=>startEdit(a)}>Edit</Btn>
                  {!isSuper(a) && <Btn v="destructive" sz="xs" onClick={()=>setConfirm({type:"revoke",id:a._id||a.username,name:a.username})}>Revoke</Btn>}
                  {!isSuper(a) && <Btn v="destructive" sz="xs" onClick={()=>setConfirm({type:"delete",id:a._id||a.username,name:a.username})}>✕</Btn>}
                </div>
              ]});
            })}/>
        </Card>
      )}

      {showCreate&&(
        <Modal title="Create Admin Account" onClose={()=>setShowCreate(false)}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setShowCreate(false)}>Cancel</Btn><Btn onClick={doCreate} disabled={!form.name||!form.username||!form.password}>Create Account</Btn></div>}>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
            <Field label="Full Name" required><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full name"/></Field>
            <Field label="Username" required><Input value={form.username} onChange={e=>setForm(p=>({...p,username:e.target.value}))} placeholder="username"/></Field>
            <Field label="Password" required><Input value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))} type="password" placeholder="Min 8 characters"/></Field>
            <Field label="Email"><Input value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} type="email" placeholder="user@company.com"/></Field>
            <Field label="Role" required><Sel value={form.role} onChange={e=>setForm(p=>({...p,role:e.target.value}))} options={["admin","security","operator","device_mgr","viewer"].map(r=>({value:r,label:r.replace("_"," ")}))}/></Field>
            <Field label="Account Expiry" hint="Leave blank for no expiry"><Input value={form.expires} onChange={e=>setForm(p=>({...p,expires:e.target.value}))} type="date"/></Field>
          </div>
        </Modal>
      )}

      {editAcc&&(
        <Modal title={`Edit Account — ${editAcc.username}`} onClose={()=>setEditAcc(null)}
          footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setEditAcc(null)}>Cancel</Btn><Btn onClick={doEdit}>Save Changes</Btn></div>}>
          {isSuper(editAcc) ? (
            <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
              <GlassCard color={TH.amber} style={{ padding:"10px 12px" }}>
                <div style={{ fontSize:12,color:TH.amber,fontWeight:600 }}>Superadmin account is protected. Only password can be changed.</div>
              </GlassCard>
              <Field label="Username"><Input value={editAcc.username||""} disabled/></Field>
              <Field label="New Password" required><Input value={editForm.password} onChange={e=>setEditForm(p=>({...p,password:e.target.value}))} type="password" placeholder="Enter new password"/></Field>
            </div>
          ) : (
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
              <Field label="Full Name"><Input value={editForm.name} onChange={e=>setEditForm(p=>({...p,name:e.target.value}))} placeholder="Full name"/></Field>
              <Field label="Email"><Input value={editForm.email} onChange={e=>setEditForm(p=>({...p,email:e.target.value}))} type="email" placeholder="user@company.com"/></Field>
              <Field label="Role"><Sel value={editForm.role} onChange={e=>setEditForm(p=>({...p,role:e.target.value}))} options={["superadmin","admin","security","operator","device_mgr","viewer"].map(r=>({value:r,label:r.replace("_"," ")}))}/></Field>
              <Field label="Status"><Sel value={editForm.status} onChange={e=>setEditForm(p=>({...p,status:e.target.value}))} options={["active","revoked","suspended"].map(s=>({value:s,label:s}))}/></Field>
              <Field label="Expiry Date" hint="Leave blank for no expiry"><Input value={editForm.expires} onChange={e=>setEditForm(p=>({...p,expires:e.target.value}))} type="date"/></Field>
              <Field label="Username"><Input value={editAcc.username||""} disabled/></Field>
            </div>
          )}
        </Modal>
      )}

      {renew&&(
        <Modal title={`Renew Access — ${renew.name||renew.username}`} onClose={()=>setRenew(null)} width={440}
          footer={<Btn v="ghost" full onClick={()=>setRenew(null)}>Cancel</Btn>}>
          <p style={{ fontSize:13,color:TH.muted,marginBottom:16 }}>Select renewal period:</p>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:9 }}>
            {[30,60,90,180,365,"Custom"].map(d=>(
              <button key={d} onClick={()=>typeof d==="number"&&doRenew(renew._id,d)}
                style={{ padding:"13px 8px",background:TH.surface,border:`1px solid ${TH.border}`,borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:700,color:TH.text,transition:"all .13s" }}
                onMouseEnter={e=>{ e.currentTarget.style.borderColor=TH.blue; e.currentTarget.style.background=TH.blueDim; e.currentTarget.style.color=TH.blue; }}
                onMouseLeave={e=>{ e.currentTarget.style.borderColor=TH.border; e.currentTarget.style.background=TH.surface; e.currentTarget.style.color=TH.text; }}>
                {d==="Custom"?d:`+${d}d`}
              </button>
            ))}
          </div>
          <div style={{ marginTop:14 }}>
            <Field label="Or specific date"><Input type="date"/></Field>
          </div>
        </Modal>
      )}

      {confirm&&<Confirm
        title={confirm.type==="delete"?"Delete Account":"Revoke Access"}
        message={confirm.type==="delete"
          ? `Delete account "${confirm.name}" permanently? This cannot be undone.`
          : `Revoke portal access for "${confirm.name}"? They will be immediately signed out.`}
        onConfirm={()=>confirm.type==="delete"?doDelete(confirm.id):doRevoke(confirm.id)}
        onCancel={()=>setConfirm(null)}
      />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════════════════════════ */
function SettingsPage() {
  const { show } = useToast();
  const { data:health } = useFetch(()=>api.health(),[],null);
  const { data:smtp, reload:reloadSmtp } = useFetch(()=>api.smtpSettings(),[],null);
  const { data:centralApi, reload:reloadCentralApi } = useFetch(()=>api.centralApiSettings(),[],null);
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [smtpForm, setSmtpForm] = useState({ host:"", port:587, user:"", pass:"", from:"" });
  const [centralOpen, setCentralOpen] = useState(false);
  const [centralBusy, setCentralBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupPreview, setBackupPreview] = useState(null);
  const backupFileRef = useRef(null);
  const [centralForm, setCentralForm] = useState({
    enabled:false, baseUrl:"", apiKey:"", usersPath:"/users", devicesPath:"/devices", pollMs:60000, timeoutMs:15000, autoPushToReaders:true
  });
  const qLen = () => { try { return JSON.parse(localStorage.getItem(QK)||"[]").length; } catch { return 0; } };
  const mongoHost = (health?.config?.mongodbUri || "").replace(/^mongodb:\/\//, "").split("/")[0] || "localhost:27017";
  const ollamaHost = (health?.config?.ollamaHost || "").replace(/^https?:\/\//, "") || "localhost:11434";
  const gsdkUp = health?.services?.gsdk === "up";
  const mongoUp = health?.services?.mongodb === "up";
  const ollamaUp = health?.services?.ollama === "up";
  const smtpConfigured = Boolean(smtp?.configured);
  const centralEnabled = Boolean(centralApi?.enabled);
  const selfHeal = health?.selfHealing || {};
  const selfHealState = selfHeal?.state || {};
  const watchdog = health?.watchdog || {};
  const watchdogState = watchdog?.state || {};
  const queueState = health?.faceAutoRefreshQueue || {};

  useEffect(() => {
    if (!smtp) return;
    setSmtpForm({
      host: smtp.host || "",
      port: Number(smtp.port || 587),
      user: smtp.user || "",
      pass: "",
      from: smtp.from || ""
    });
  }, [smtp]);

  useEffect(() => {
    if (!centralApi) return;
    setCentralForm({
      enabled: Boolean(centralApi.enabled),
      baseUrl: centralApi.baseUrl || "",
      apiKey: "",
      usersPath: centralApi.usersPath || "/users",
      devicesPath: centralApi.devicesPath || "/devices",
      pollMs: Number(centralApi.pollMs || 60000),
      timeoutMs: Number(centralApi.timeoutMs || 15000),
      autoPushToReaders: Boolean(centralApi.autoPushToReaders)
    });
  }, [centralApi]);

  const saveSmtp = async () => {
    try {
      await api.smtpSave({
        host: smtpForm.host,
        port: Number(smtpForm.port || 587),
        user: smtpForm.user,
        pass: smtpForm.pass,
        from: smtpForm.from
      });
      show("SMTP settings saved","success");
      setSmtpOpen(false);
      reloadSmtp();
    } catch (e) {
      show(e.message, "error");
    }
  };

  const saveCentralApi = async () => {
    try {
      setCentralBusy(true);
      await api.centralApiSave({
        enabled: centralForm.enabled,
        baseUrl: centralForm.baseUrl,
        apiKey: centralForm.apiKey,
        usersPath: centralForm.usersPath,
        devicesPath: centralForm.devicesPath,
        pollMs: Number(centralForm.pollMs || 60000),
        timeoutMs: Number(centralForm.timeoutMs || 15000),
        autoPushToReaders: centralForm.autoPushToReaders
      });
      show("Central API settings saved","success");
      setCentralOpen(false);
      reloadCentralApi();
    } catch (e) {
      show(e.message, "error");
    } finally {
      setCentralBusy(false);
    }
  };

  const syncCentralNow = async () => {
    try {
      setCentralBusy(true);
      const r = await api.centralApiSyncNow();
      show(`Central sync complete (${r.usersUpserted||0} users, ${r.devicesUpserted||0} devices)`, "success");
      reloadCentralApi();
    } catch (e) {
      show(e.message, "error");
    } finally {
      setCentralBusy(false);
    }
  };

  const restoreBackupFile = async (file) => {
    if (!file) return;
    try {
      const lowerName = String(file?.name || "").toLowerCase();
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const isGzip = lowerName.endsWith(".gz") || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
      const raw = isGzip ? await gunzipTextFromBuffer(buffer) : new TextDecoder("utf-8").decode(buffer);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(isGzip ? "Invalid .json.gz backup file" : "Invalid backup JSON file");
      }
      const dataMap = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
      if (!dataMap || typeof dataMap !== "object" || Array.isArray(dataMap)) {
        throw new Error("Backup file must contain an object with collection arrays");
      }
      const collections = Object.entries(dataMap)
        .filter(([name, rows]) => name && Array.isArray(rows))
        .map(([name, rows]) => ({ name, count: rows.length }))
        .sort((a, b) => b.count - a.count);
      if (!collections.length) throw new Error("Backup has no restorable collections");
      setBackupPreview({
        raw,
        fileName: file.name || "backup.json",
        app: String(parsed?.app || ""),
        version: String(parsed?.version || ""),
        exportedAt: String(parsed?.exportedAt || ""),
        collections,
        totalDocs: collections.reduce((sum, x) => sum + Number(x.count || 0), 0)
      });
    } catch (e) {
      show(e.message || "Backup restore failed", "error");
      if (backupFileRef.current) backupFileRef.current.value = "";
    }
  };
  const backupImpactColor = (count = 0) => {
    const n = Number(count || 0);
    if (n >= 100000) return "red";
    if (n >= 10000) return "amber";
    return "green";
  };
  const backupImpactLabel = (count = 0) => {
    const n = Number(count || 0);
    if (n >= 100000) return "Very large";
    if (n >= 10000) return "Large";
    return "Small";
  };
  const confirmBackupRestore = async () => {
    if (!backupPreview?.raw) return;
    try {
      setBackupBusy(true);
      const r = await api.backupRestore(backupPreview.raw);
      show(`Backup restored: ${r.restoredDocuments || 0} records across ${r.restoredCollections || 0} collections`, "success");
      setBackupPreview(null);
      window.location.reload();
    } catch (e) {
      show(e.message || "Backup restore failed", "error");
    } finally {
      setBackupBusy(false);
      if (backupFileRef.current) backupFileRef.current.value = "";
    }
  };

  return (
    <div>
      <PageHeader title="Settings" sub="System configuration and service connections"/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16 }}>
        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>G-SDK Gateway</div>
          <KV label="Host"      value={health?.config?.gsdkGateway||"Not set"} mono/>
          <KV label="Port"      value={health?.config?.gsdkDevicePort||"51211"} mono/>
          <KV label="Mode"      value={health?.config?.gsdkUseSsl?"SSL":"Insecure"} color={health?.config?.gsdkUseSsl?TH.amber:TH.green}/>
          <KV label="Version"   value="1.7.2" mono/>
          <KV label="Status"    value={gsdkUp?"Connected":"Disconnected"} color={gsdkUp?TH.green:TH.red}/>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>MongoDB</div>
          <KV label="Host"      value={mongoHost} mono/>
          <KV label="Database"  value="expo-fr" mono/>
          <KV label="Status"    value={mongoUp?"Connected":"Disconnected"} color={mongoUp?TH.green:TH.red}/>
          <KV label="Employees" value={fNum(health?.counts?.employees ?? 0)} mono/>
          <KV label="Visitors" value={fNum(health?.counts?.visitors ?? 0)} mono/>
          <KV label="Log Records" value={fNum(health?.counts?.logs ?? 0)} mono/>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Ollama / ARIA AI</div>
          <KV label="Host"          value={ollamaHost} mono/>
          <KV label="Active Model"  value={health?.ollama?.model||"llama3.2"} mono/>
          <KV label="Status"        value={ollamaUp?"Online":"Offline"} color={ollamaUp?TH.green:TH.red}/>
          {!ollamaUp && (
            <div style={{ fontSize:13,color:TH.muted,marginTop:8,lineHeight:1.55 }}>
              {(ollamaHost.includes("localhost") || ollamaHost.startsWith("127.0.0.1")) && (
                <>If the API runs in Docker, set Ollama to <code style={{ fontSize:11 }}>http://ollama:11434</code> (localhost here is the API container, not Ollama). </>
              )}
              {health?.errors?.ollama ? `(${health.errors.ollama})` : ""}
            </div>
          )}
          <KV label="Claude Vision" value="Active (Enrollment AI)" color={TH.green}/>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Offline Sync</div>
          <KV label="Queue Size"     value={`${qLen()} actions`} mono/>
          <KV label="Auto-Sync"      value="On reconnect" color={TH.green}/>
          <KV label="Device Buffer"  value="Auto-recover" color={TH.green}/>
          <KV label="WebSocket"      value="Auto-reconnect 3s" color={TH.blue}/>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>API process</div>
          <KV label="Hostname" value={health?.serverRuntime?.hostname ?? "—"} mono/>
          <KV label="Platform" value={health?.serverRuntime?.platform ?? "—"} mono/>
          <KV label="Node.js" value={health?.serverRuntime?.nodeVersion ?? "—"} mono/>
          <KV label="Uptime" value={health?.serverRuntime?.uptimeSec != null ? formatProcUptime(health.serverRuntime.uptimeSec) : "—"} mono/>
          <KV label="Memory (used/total)" value={health?.serverRuntime?.memory ?? "—"} mono/>
          <KV
            label="Visitor QR folder"
            value={
              health?.config?.visitorQrStorageEnabled === false
                ? "disabled"
                : (health?.config?.visitorQrStorageDir || "data/visitor-qr-codes").replace(/^https?:\/\//, "")
            }
            mono
          />
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>System Health</div>
          <KV label="Self-healing" value={selfHeal?.enabled ? "Enabled" : "Disabled"} color={selfHeal?.enabled ? TH.green : TH.red}/>
          <KV label="Self-heal recoveries" value={fNum(selfHealState?.recoveries ?? 0)} mono/>
          <KV label="Self-heal reason" value={selfHealState?.lastReason || "—"} mono/>
          <KV label="Watchdog" value={watchdog?.enabled ? "Enabled" : "Disabled"} color={watchdog?.enabled ? TH.green : TH.red}/>
          <KV label="Watchdog triggers" value={fNum(watchdogState?.triggers ?? 0)} mono/>
          <KV label="Face queue" value={`${fNum(queueState?.queued ?? 0)} queued · ${fNum(queueState?.processed ?? 0)} done · ${fNum(queueState?.failed ?? 0)} failed`} mono/>
          <div style={{ marginTop:10,paddingTop:10,borderTop:`1px solid ${TH.border}` }}>
            <div style={{ fontSize:11,color:TH.muted,marginBottom:4 }}>Last recovery actions</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
              {[...(watchdogState?.lastActions||[]), ...(selfHealState?.lastActions||[])].slice(0,6).map((a,i)=>(
                <Badge key={`${a?.action||"act"}-${i}`} color={a?.ok ? "green" : "red"} sm>{`${a?.action||"action"}:${a?.ok?"ok":"fail"}`}</Badge>
              ))}
              {(!watchdogState?.lastActions?.length && !selfHealState?.lastActions?.length) && <Badge color="gray" sm>no recent actions</Badge>}
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>RBAC Permissions</div>
          {Object.entries(ROLES).map(([role,perms])=>(
            <div key={role} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${TH.border}` }}>
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                <Badge color={{admin:"amber",superadmin:"red",security:"cyan",operator:"blue",device_mgr:"violet",viewer:"gray"}[role]||"gray"} sm>{role.replace("_"," ")}</Badge>
              </div>
              <span style={{ fontSize:11,color:TH.muted }}>{perms.includes("*")?"All pages":`${perms.length} pages`}</span>
            </div>
          ))}
        </Card>

        <Card>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>Central API Interface</div>
            <div style={{ display:"flex",gap:8 }}>
              <Btn sz="xs" v="secondary" onClick={syncCentralNow} loading={centralBusy}>Sync now</Btn>
              <Btn sz="xs" onClick={()=>setCentralOpen(true)}>{centralEnabled ? "Edit" : "Setup"}</Btn>
            </div>
          </div>
          <KV label="Mode" value="Hybrid (Pull + Push + Reader Events)" color={TH.blue}/>
          <KV label="Status" value={centralEnabled ? "Enabled" : "Disabled"} color={centralEnabled ? TH.green : TH.amber}/>
          <KV label="Base URL" value={centralApi?.baseUrl || "Not set"} mono/>
          <KV label="Users Path" value={centralApi?.usersPath || "/users"} mono/>
          <KV label="Devices Path" value={centralApi?.devicesPath || "/devices"} mono/>
          <KV label="Poll Interval" value={`${Math.round(Number(centralApi?.pollMs || 60000) / 1000)}s`} mono/>
          <KV label="Last Sync" value={centralApi?.lastSyncAt ? fDT(centralApi.lastSyncAt) : "Never"} mono/>
          <KV
            label="Last Result"
            value={centralApi?.lastSyncOk===null ? "Not run" : centralApi?.lastSyncOk ? "Success" : (centralApi?.lastSyncError || "Failed")}
            color={centralApi?.lastSyncOk ? TH.green : (centralApi?.lastSyncOk===false ? TH.red : TH.muted)}
          />
        </Card>

        <Card>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>SMTP / Email</div>
            <Btn sz="xs" onClick={()=>setSmtpOpen(true)}>{smtpConfigured ? "Edit" : "Setup"}</Btn>
          </div>
          <KV label="Status" value={smtpConfigured ? "Configured" : "Not configured"} color={smtpConfigured ? TH.green : TH.amber}/>
          <KV label="Host" value={smtp?.host || "Not set"} mono/>
          <KV label="Port" value={smtp?.port || 587} mono/>
          <KV label="User" value={smtp?.user || "Not set"} mono/>
          <KV label="From" value={smtp?.from || "Not set"} mono/>
        </Card>

        <Card>
          <div style={{ fontSize:16,fontWeight:800,color:TH.textHi,marginBottom:14 }}>Data Management</div>
          <div style={{ display:"flex",gap:10,flexWrap:"wrap" }}>
            <Btn v="secondary" sz="sm" onClick={async()=>{
              try {
                const res = await api.backupDownload();
                await saveDownloadResponse(res, "expo-fr-backup");
                show("Backup downloaded", "success");
              } catch (e) {
                show(e.message, "error");
              }
            }}>⬇ Backup Data</Btn>
            <Btn v="secondary" sz="sm" loading={backupBusy} onClick={() => backupFileRef.current?.click()}>⬆ Upload Restore Backup</Btn>
            <input
              ref={backupFileRef}
              type="file"
              accept=".json,.gz,.json.gz,application/json,application/gzip"
              style={{ display:"none" }}
              onChange={(e)=>restoreBackupFile(e.target.files?.[0] || null)}
            />
            <Btn v="destructive" sz="sm" onClick={async()=>{
              if(!confirm("Delete ALL logs from database AND Suprema device permanently?")) return;
              try {
                const r = await apiFetch("/logs/all", {method:"DELETE"});
                await apiFetch("/devices/logs/all", {method:"DELETE"}).catch(()=>{});
                show(`Deleted ${r.deleted} logs from DB + device cleared`, "success");
              } catch(e) { show(e.message,"error"); }
            }}>🗑 Clear All Logs</Btn>
            <Btn v="destructive" sz="sm" onClick={async()=>{
              if(!confirm("Delete ALL enrolled users from Suprema device?")) return;
              try {
                const r = await apiFetch("/devices/users/all", {method:"DELETE"});
                const ok = r.results?.filter(x=>x.ok).length || 0;
                show(`Deleted users from ${ok} device(s)`, "success");
              } catch(e) { show(e.message,"error"); }
            }}>🗑 Clear Device Users</Btn>
          </div>
        </Card>
      </div>

      {backupPreview && <Modal
        title="Preview Backup Restore"
        subtitle="Confirm what will be replaced before restore"
        width={720}
        onClose={()=>{ if (!backupBusy) setBackupPreview(null); }}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setBackupPreview(null)} disabled={backupBusy}>Cancel</Btn>
          <Btn v="destructive" onClick={confirmBackupRestore} loading={backupBusy}>
            Restore Now (Replace Existing Data)
          </Btn>
        </div>}
      >
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
          <KV label="File" value={backupPreview.fileName} mono/>
          <KV label="App" value={backupPreview.app || "—"} mono/>
          <KV label="Version" value={backupPreview.version || "—"} mono/>
          <KV label="Exported" value={backupPreview.exportedAt ? fDT(backupPreview.exportedAt) : "—"} mono/>
          <KV label="Collections" value={fNum(backupPreview.collections.length)} mono/>
          <KV label="Total Records" value={fNum(backupPreview.totalDocs)} mono/>
        </div>
        <div style={{ fontSize:12,color:TH.amber,marginBottom:8 }}>
          Warning: restore will delete current records in these collections and replace them from this backup.
        </div>
        <div style={{ maxHeight:280,overflow:"auto",border:`1px solid ${TH.border}`,borderRadius:10,background:TH.surface }}>
          {backupPreview.collections.map((c) => (
            <div key={c.name} style={{ display:"flex",justifyContent:"space-between",padding:"8px 10px",borderBottom:`1px solid ${TH.border}` }}>
              <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                <span style={{ fontSize:12,fontFamily:TH.mono,color:TH.text }}>{c.name}</span>
                <Badge color={backupImpactColor(c.count)} sm>{backupImpactLabel(c.count)}</Badge>
              </div>
              <Badge color={backupImpactColor(c.count)} sm>{fNum(c.count)} rows</Badge>
            </div>
          ))}
        </div>
      </Modal>}

      {smtpOpen && <Modal
        title="SMTP Configuration"
        subtitle="Visitor QR emails will be sent using this account"
        width={560}
        onClose={()=>setSmtpOpen(false)}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setSmtpOpen(false)}>Cancel</Btn>
          <Btn onClick={saveSmtp} disabled={!smtpForm.host || !smtpForm.user || (!smtpForm.pass && !smtp?.hasPassword)}>Save SMTP</Btn>
        </div>}
      >
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="SMTP Host" required><Input value={smtpForm.host} onChange={e=>setSmtpForm(p=>({...p,host:e.target.value}))} placeholder="smtp.gmail.com"/></Field>
          <Field label="SMTP Port" required><Input type="number" value={smtpForm.port} onChange={e=>setSmtpForm(p=>({...p,port:e.target.value}))} placeholder="587"/></Field>
          <Field label="SMTP User" required><Input value={smtpForm.user} onChange={e=>setSmtpForm(p=>({...p,user:e.target.value}))} placeholder="user@domain.com"/></Field>
          <Field label="From Email"><Input value={smtpForm.from} onChange={e=>setSmtpForm(p=>({...p,from:e.target.value}))} placeholder="noreply@domain.com"/></Field>
          <div style={{ gridColumn:"1 / -1" }}>
            <Field label="SMTP Password / App Password" required>
              <Input type="password" value={smtpForm.pass} onChange={e=>setSmtpForm(p=>({...p,pass:e.target.value}))} placeholder={smtp?.hasPassword ? "Leave blank to keep existing password" : "Enter password"} />
            </Field>
          </div>
        </div>
      </Modal>}

      {centralOpen && <Modal
        title="Central API Interface"
        subtitle="Pull central updates, then push users/cards to readers while readers push live events to this app"
        width={640}
        onClose={()=>setCentralOpen(false)}
        footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
          <Btn v="ghost" onClick={()=>setCentralOpen(false)}>Cancel</Btn>
          <Btn onClick={saveCentralApi} loading={centralBusy} disabled={centralForm.enabled && !centralForm.baseUrl}>Save Interface</Btn>
        </div>}
      >
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <div style={{ gridColumn:"1 / -1" }}>
            <label style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:TH.text }}>
              <input type="checkbox" checked={centralForm.enabled} onChange={e=>setCentralForm(p=>({ ...p, enabled:e.target.checked }))} />
              Enable central API synchronization
            </label>
          </div>
          <Field label="Central API Base URL" required>
            <Input value={centralForm.baseUrl} onChange={e=>setCentralForm(p=>({ ...p, baseUrl:e.target.value }))} placeholder="https://central.example.com/api"/>
          </Field>
          <Field label="API Key / Bearer token">
            <Input type="password" value={centralForm.apiKey} onChange={e=>setCentralForm(p=>({ ...p, apiKey:e.target.value }))} placeholder={centralApi?.hasApiKey ? "Leave blank to keep existing key" : "Enter token"}/>
          </Field>
          <Field label="Users Path"><Input value={centralForm.usersPath} onChange={e=>setCentralForm(p=>({ ...p, usersPath:e.target.value }))} placeholder="/users"/></Field>
          <Field label="Devices Path"><Input value={centralForm.devicesPath} onChange={e=>setCentralForm(p=>({ ...p, devicesPath:e.target.value }))} placeholder="/devices"/></Field>
          <Field label="Poll Interval (ms)"><Input type="number" value={centralForm.pollMs} onChange={e=>setCentralForm(p=>({ ...p, pollMs:e.target.value }))} placeholder="60000"/></Field>
          <Field label="Request Timeout (ms)"><Input type="number" value={centralForm.timeoutMs} onChange={e=>setCentralForm(p=>({ ...p, timeoutMs:e.target.value }))} placeholder="15000"/></Field>
          <div style={{ gridColumn:"1 / -1" }}>
            <label style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:TH.text }}>
              <input type="checkbox" checked={centralForm.autoPushToReaders} onChange={e=>setCentralForm(p=>({ ...p, autoPushToReaders:e.target.checked }))} />
              Auto push enrollment updates to readers after pull
            </label>
          </div>
        </div>
      </Modal>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════════ */
export default function App() {
  useEffect(() => {
    document.title = "Expo City Dubai";
    document
      .querySelectorAll("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")
      .forEach((el) => el.remove());
  }, []);

  const [lightTheme, setLightTheme] = useState(() => {
    try { return localStorage.getItem("acs_theme") === "light"; } catch { return false; }
  });
  useEffect(() => {
    if (lightTheme) {
      document.documentElement.classList.add("light-theme");
    } else {
      document.documentElement.classList.remove("light-theme");
    }
    try { localStorage.setItem("acs_theme", lightTheme ? "light" : "dark"); } catch {}
  }, [lightTheme]);
  const toggleTheme = () => setLightTheme(v => !v);

  // Restore session from token
  const [user, setUser] = useState(() => {
    try {
      const tok = localStorage.getItem(TK);
      if (!tok) return null;
      const payload = JSON.parse(atob(tok.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
      if (payload.exp && payload.exp*1000 < Date.now()) { clearToken(); return null; }
      return payload.user || payload;
    } catch { clearToken(); return null; }
  });

  const [page,     setPage]     = useState(() => parseHashPage() || "dashboard");
  const [pageHistory, setPageHistory] = useState([]);
  const [enrollTarget, setEnrollTarget] = useState(null);
  const [navOpen,  setNavOpen]  = useState(true);
  const [syncMsg,  setSyncMsg]  = useState(null);
  const [alertCount, setAlertCount] = useState(0);
  const mainRef = useRef(null);

  // Verify token with server on mount (retries: rapid refresh / cold API must not wipe a valid session)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) return;

      const maxAttempts = 4;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (cancelled) return;
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));

        try {
          const u = await api.me();
          if (cancelled) return;
          if (u) {
            setUser(u);
            return;
          }
          // null only after apiFetch handled 401 (token already cleared + acs:logout)
          setUser(null);
          return;
        } catch {
          /* transient: network, 5xx, aborted fetch — do NOT clearToken */
        }
      }

      if (!cancelled && getToken()) {
        console.warn(
          "[session] /auth/me failed after retries; keeping session until token expires or API recovers."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Global logout event
  useEffect(() => {
    const fn = () => {
      setUser(null);
      setPage("dashboard");
      setPageHistory([]);
      try {
        const u = new URL(window.location.href);
        u.hash = "";
        window.history.replaceState(null, "", u.pathname + u.search);
      } catch {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    window.addEventListener("acs:logout", fn);
    return () => window.removeEventListener("acs:logout", fn);
  }, []);

  // Keep URL hash in sync so refresh stays on the same screen (RBAC-safe).
  // useLayoutEffect: update address bar before paint so quick F5 keeps #/route.
  useLayoutEffect(() => {
    if (!user) return;
    if (!allowedPage(user, page)) {
      setPage("dashboard");
      setPageHistory([]);
      window.history.replaceState(null, "", hashForPage("dashboard"));
      return;
    }
    const want = hashForPage(page);
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [user, page]);

  // Offline sync
  const online = useOfflineSync(useCallback(msg => {
    setSyncMsg(msg);
    setTimeout(()=>setSyncMsg(null),6000);
    if (msg?.type === "devices" || msg?.type === "queue") {
      window.dispatchEvent(new CustomEvent("acs:sync-complete", { detail: msg }));
    }
  }, []));

  // Alert badge count (open + in-review + acknowledged — same as backend ack path)
  useEffect(() => {
    if (!user) return;
    const load = () => api.alerts().then(r=>setAlertCount(alertAttentionCount(r))).catch(()=>{});
    load();
    const iv = setInterval(load, 60000);
    const onUp = () => load();
    window.addEventListener("acs:alerts-updated", onUp);
    return () => { clearInterval(iv); window.removeEventListener("acs:alerts-updated", onUp); };
  }, [user]);

  // Live event alert bump via WS
  useWS(useCallback(msg => {
    if (msg.type==="NEW_ALERT") setAlertCount((n) => n + 1);
  }, []));

  // Navigate helper with RBAC (normalized role — matches Sidebar / JWT variants)
  const nav = useCallback(p => {
    const r = normRole(user);
    if (!(can(r, p) || r === "superadmin")) return;
    setPage((cur) => {
      if (cur === p) return cur;
      setPageHistory((h) => [...h, cur]);
      window.history.replaceState(null, "", hashForPage(p));
      return p;
    });
  }, [user]);
  const goBackPage = useCallback(() => {
    setPageHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setPage(prev);
      window.history.replaceState(null, "", hashForPage(prev));
      return h.slice(0, -1);
    });
  }, []);
  const goEnroll = useCallback((employee) => {
    setEnrollTarget(employee || null);
    setPage((cur) => {
      if (cur === "enrollment") return cur;
      setPageHistory((h) => [...h, cur]);
      window.history.replaceState(null, "", hashForPage("enrollment"));
      return "enrollment";
    });
  }, []);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [page]);

  const PAGES = {
    dashboard:   <DashboardPage    onNav={nav}/>,
    monitor:     <FRMonitorPage/>,
    logs:        <LogsPage         onNav={nav}/>,
    devices:     <DevicesPage      onNav={nav}/>,
    setup:       <DeviceSetupPage/>,
    models:      <DeviceModelsPage onNav={nav}/>,
    credentials: <CredentialsPage/>,
    companies:   <CompaniesPage/>,
    employees:   <EmployeesPage    onNav={nav} onEnroll={goEnroll}/>,
    enrollment:  <EnrollmentPage   preselectedEmployee={enrollTarget} onNav={nav}/>,
    visitors:    <VisitorsPage     onNav={nav} onEnroll={goEnroll}/>,
    footprints:  <FootprintsPage/>,
    alerts:      <AlertsPage/>,
    threats:     <ThreatIntelPage onNav={nav}/>,
    sync:        <SyncPage/>,
    reports:     <ReportsPage/>,
    export:      <ExportPage/>,
    locations:   <LocationsPage/>,
    superadmin:  <SuperAdminPage/>,
    settings:    <SettingsPage/>,
    ai:          <AIPage/>,
    ai_insights: <AIInsightsPage/>,
  };

  return (
    <ThemeCtx.Provider value={{ light: lightTheme, toggle: toggleTheme }}>
    <ToastProvider>
      <style>{GCSS}</style>
      {!user ? (
        <LoginPage onLogin={u=>{
          setUser(u);
          setPageHistory([]);
          const fromHash = parseHashPage() || "dashboard";
          const next = allowedPage(u, fromHash) ? fromHash : "dashboard";
          setPage(next);
          window.history.replaceState(null, "", hashForPage(next));
        }}/>
      ) : (
        <div className="app-shell" style={{ display:"flex", height:"100vh", overflow:"hidden", background:TH.bg }}>
          <Sidebar page={page} onNav={nav} user={user} open={navOpen} onToggle={()=>setNavOpen(o=>!o)} alertCount={alertCount}/>
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
            <TopBar page={page} user={user} onThemeToggle={toggleTheme} lightTheme={lightTheme} onLogout={()=>{
              setUser(null);
              setPage("dashboard");
              setPageHistory([]);
              try {
                const u = new URL(window.location.href);
                u.hash = "";
                window.history.replaceState(null, "", u.pathname + u.search);
              } catch {
                window.history.replaceState(null, "", window.location.pathname + window.location.search);
              }
            }} online={online} onNav={nav} onBack={goBackPage} canGoBack={pageHistory.length>0}/>
            <OfflineBanner online={online} syncMsg={syncMsg}/>
            <main ref={mainRef} className="app-content" style={{ flex:1, overflowY:"auto", padding:"16px 20px" }}>
              <div className="fade-page" key={page}>
                {can(normRole(user), page) || normRole(user) === "superadmin" || page === "dashboard"
                  ? (PAGES[page] || <DashboardPage onNav={nav}/>)
                  : (
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:320, gap:12, textAlign:"center" }}>
                      <div style={{ fontSize:52, opacity:.1 }}>🔒</div>
                      <div style={{ fontSize:18, fontWeight:800, color:TH.muted }}>Access Denied</div>
                      <div style={{ fontSize:13, color:TH.muted }}>Your role (<Badge color="blue" sm>{user.role}</Badge>) does not have permission to view this page.</div>
                    </div>
                  )
                }
              </div>
            </main>
          </div>
        </div>
      )}
    </ToastProvider>
    </ThemeCtx.Provider>
  );
}

