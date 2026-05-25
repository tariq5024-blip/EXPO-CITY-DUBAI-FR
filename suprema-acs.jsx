// Legacy monolith — superseded by frontend/src/App.jsx
// This file is kept for reference only and is NOT imported by the build.
import {
  useState, useEffect, useRef, useMemo, useCallback,
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
const BASE = (() => {
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1") return "http://localhost:4000/api";
  return `${window.location.origin}/api`;
})();
const WS = BASE.replace(/^http/, "ws").replace("/api", "/ws");

// ── Auth tokens ───────────────────────────────────────────────────────
const TK = "acs_v6_token";
const getToken  = () => { try { return localStorage.getItem(TK); } catch { return null; } };
const setToken  = t  => { try { localStorage.setItem(TK, t); } catch {} };
const clearToken= () => { try { localStorage.removeItem(TK); } catch {} };

// ── Offline queue ─────────────────────────────────────────────────────
const QK = "acs_v6_queue";
const getQ  = () => { try { return JSON.parse(localStorage.getItem(QK) || "[]"); } catch { return []; } };
const setQ  = q => { try { localStorage.setItem(QK, JSON.stringify(q)); } catch {} };
const pushQ = item => setQ([...getQ(), { ...item, t: Date.now() }]);

async function flushQueue(onProgress) {
  const q = getQ(); if (!q.length) return 0;
  let ok = 0; const fail = [];
  for (const item of q) {
    try {
      await apiFetch(item.path, item.opts);
      ok++;
      onProgress?.(ok, q.length);
    } catch { fail.push(item); }
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
  if (res.status === 401) { clearToken(); window.dispatchEvent(new Event("acs:logout")); return null; }
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
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── API surface ───────────────────────────────────────────────────────
const api = {
  // auth
  login:   b => apiFetch("/auth/login",  { method:"POST", body:JSON.stringify(b) }),
  me:      () => apiFetch("/auth/me"),
  logout:  () => apiFetch("/auth/logout", { method:"POST" }),

  // health
  health: () => apiFetch("/health"),

  // employees
  employees:       p => apiFetch(`/employees?${new URLSearchParams(p)}`),
  employee:        id => apiFetch(`/employees/${id}`),
  empCreate:       b  => apiFetch("/employees",           { method:"POST", body:JSON.stringify(b) }),
  empUpdate:       (id,b) => apiFetch(`/employees/${id}`, { method:"PUT",  body:JSON.stringify(b) }),
  empDelete:       id => apiFetch(`/employees/${id}`,     { method:"DELETE" }),
  empFootprint:    id => apiFetch(`/employees/${id}/footprint`),
  empBulkImport:   b  => apiFetch("/employees/bulk",      { method:"POST", body:JSON.stringify(b) }),

  // visitors
  visitors:        p  => apiFetch(`/visitors?${new URLSearchParams(p)}`),
  visitorCreate:   b  => apiFetch("/visitors",            { method:"POST", body:JSON.stringify(b) }),
  visitorUpdate:   (id,b) => apiFetch(`/visitors/${id}`, { method:"PUT",  body:JSON.stringify(b) }),
  visitorCheckin:  id => apiFetch(`/visitors/${id}/checkin`,  { method:"POST" }),
  visitorCheckout: id => apiFetch(`/visitors/${id}/checkout`, { method:"POST" }),
  visitorFootprint:id => apiFetch(`/visitors/${id}/footprint`),

  // devices
  devices:       () => apiFetch("/devices"),
  deviceConnect: b  => apiFetch("/devices/connect",       { method:"POST", body:JSON.stringify(b) }),
  deviceTest:    b  => apiFetch("/devices/test",          { method:"POST", body:JSON.stringify(b) }),
  deviceSync:    id => apiFetch(`/devices/${id}/sync`,    { method:"POST" }),
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
  reportAttendance:() => apiFetch("/reports/attendance"),

  // export
  exportData: b => apiFetch("/export/generate", { method:"POST", body:JSON.stringify(b) }),

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

  // sync
  syncAll:     () => apiFetch("/sync/all",         { method:"POST" }),
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

function allowedPage(user, p) {
  if (!user) return false;
  return can(user.role, p) || user.role === "superadmin" || p === "dashboard";
}

// ── Design tokens ─────────────────────────────────────────────────────
const TH = {
  // backgrounds
  bg:      "#090f1d",
  surface: "#101b2f",
  card:    "#15243b",
  hover:   "#1a2b47",
  navBg:   "#0d1829",

  // borders
  border:  "#223754",
  borderB: "#335178",

  // text
  text:    "#eef4ff",
  muted:   "#9ab3d1",
  faint:   "#223754",

  // brand
  blue:    "#4d8af0",
  blueHov: "#3a73d9",
  blueDim: "rgba(77,138,240,.12)",
  blueGlow:"rgba(77,138,240,.22)",

  // status
  green:   "#20d68a",
  greenDim:"rgba(32,214,138,.11)",
  amber:   "#f5a623",
  amberDim:"rgba(245,166,35,.11)",
  red:     "#ff6b78",
  redDim:  "rgba(255,107,120,.22)",
  redGlow: "rgba(255,107,120,.34)",
  violet:  "#9b6cf7",
  violetDim:"rgba(155,108,247,.11)",
  cyan:    "#00d4ff",
  cyanDim: "rgba(0,212,255,.10)",
  pink:    "#f06292",
  pinkDim: "rgba(240,98,146,.10)",

  // chart grid
  grid:    "rgba(255,255,255,.07)",
  mono:    "'DM Mono',monospace",

  // shadows
  shadow:  "0 10px 28px rgba(0,0,0,.42)",
  shadowLg:"0 16px 54px rgba(0,0,0,.58)",
};

// ── Global CSS ─────────────────────────────────────────────────────────
const GCSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px;scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{
  font-family:'Inter',system-ui,sans-serif;
  background-color:${TH.bg};
  background-image:
    radial-gradient(1200px 650px at 88% -10%, rgba(77,138,240,.16), transparent 60%),
    radial-gradient(900px 560px at -12% 0%, rgba(0,212,255,.10), transparent 56%),
    radial-gradient(700px 460px at 52% 118%, rgba(155,108,247,.08), transparent 58%),
    repeating-linear-gradient(135deg, rgba(255,255,255,.018) 0 2px, transparent 2px 8px);
  color:${TH.text};
  min-height:100vh;
  -webkit-font-smoothing:antialiased;
  overflow:hidden;
}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${TH.border};border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:${TH.borderB}}
input,select,textarea,button{font-family:inherit}
button{cursor:pointer}
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
.fr-chip{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;border:1px solid rgba(77,138,240,.38);background:rgba(10,22,39,.62);font-size:11px;color:${TH.muted}}
.fr-chip b{color:${TH.text};font-weight:700}
.login-stage{position:relative;isolation:isolate}
.login-aurora{
  position:absolute;inset:-20% -10%;
  background:
    radial-gradient(38% 42% at 12% 18%, rgba(0,212,255,.18), transparent 65%),
    radial-gradient(44% 40% at 88% 14%, rgba(77,138,240,.21), transparent 68%),
    radial-gradient(46% 46% at 52% 92%, rgba(155,108,247,.16), transparent 70%);
  filter:blur(16px);
  animation:loginAuroraMove 14s ease-in-out infinite alternate;
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
  transform:translateX(-120%);
  animation:loginSweepMove 7.2s linear infinite;
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
  animation:loginLinesDrift 12s linear infinite;
}
@keyframes loginLinesDrift{
  from{transform:translateX(0)}
  to{transform:translateX(28px)}
}
.login-particle{
  position:absolute;border-radius:999px;pointer-events:none;z-index:0;
  background:radial-gradient(circle, rgba(0,212,255,.85) 0 35%, rgba(0,212,255,.22) 55%, transparent 100%);
  box-shadow:0 0 18px rgba(0,212,255,.45);
  animation:loginParticle 7s ease-in-out infinite;
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
  animation:loginOrbFloat 11s ease-in-out infinite;
}
.login-orb.a{width:280px;height:280px;left:8%;top:10%;background:radial-gradient(circle at 30% 30%, rgba(0,212,255,.28), rgba(0,212,255,.06) 58%, transparent 75%)}
.login-orb.b{width:360px;height:360px;right:7%;top:16%;background:radial-gradient(circle at 30% 30%, rgba(77,138,240,.32), rgba(77,138,240,.08) 55%, transparent 76%);animation-delay:-2.5s}
.login-orb.c{width:330px;height:330px;left:38%;bottom:-10%;background:radial-gradient(circle at 30% 30%, rgba(155,108,247,.24), rgba(155,108,247,.07) 55%, transparent 77%);animation-delay:-5.5s}
@keyframes loginOrbFloat{
  0%,100%{transform:translateY(0) translateX(0)}
  50%{transform:translateY(-24px) translateX(12px)}
}
.signin-card{
  position:relative;
  backdrop-filter:blur(12px) saturate(120%);
  border:1px solid rgba(110,170,255,.45) !important;
  box-shadow:0 28px 68px rgba(10,26,54,.8), 0 0 38px rgba(77,138,240,.2), inset 0 1px 0 rgba(255,255,255,.09) !important;
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
.glow-blue{box-shadow:0 0 20px ${TH.blueGlow}}
.glow-green{box-shadow:0 0 20px rgba(32,214,138,.2)}
.glow-red{box-shadow:0 0 20px ${TH.redGlow}}
.no-select{user-select:none}
`;

// ── Contexts ──────────────────────────────────────────────────────────
const AuthCtx  = createContext({});
const ToastCtx = createContext({ show: () => {} });
const useAuth  = () => useContext(AuthCtx);
const useToast = () => useContext(ToastCtx);

// ── Hooks ──────────────────────────────────────────────────────────────

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    window.addEventListener("online",  () => setOn(true));
    window.addEventListener("offline", () => setOn(false));
  }, []);
  return on;
}

function useOfflineSync(cb) {
  const online  = useOnline();
  const prevRef = useRef(online);
  useEffect(() => {
    if (!prevRef.current && online) {
      flushQueue((done, total) => {
        if (done === total) cb?.({ type:"queue", count:total });
      }).catch(() => {});
      api.syncAll().then(() => cb?.({ type:"devices" })).catch(() => {});
    }
    prevRef.current = online;
  }, [online]);
  return online;
}

function useWS(handler) {
  const ws  = useRef(null);
  const tmr = useRef(null);
  const hRef= useRef(handler);
  useEffect(() => { hRef.current = handler; }, [handler]);

  useEffect(() => {
    function connect() {
      try {
        const sock = new WebSocket(WS);
        ws.current = sock;
        sock.onmessage = e => {
          try { hRef.current(JSON.parse(e.data)); } catch {}
        };
        sock.onclose = () => { tmr.current = setTimeout(connect, 3000); };
        sock.onerror = () => sock.close();
      } catch {}
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
    try { setLoading(true); setError(null); const r = await fn(); if (r !== null) setData(r); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, loading, error, reload: run, setData };
}

// ── Formatters ────────────────────────────────────────────────────────
const fT   = d => d ? new Date(d).toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";
const fD   = d => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric"}) : "—";
const fDT  = d => d ? new Date(d).toLocaleString("en-US",{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}) : "—";
const fRel = d => {
  if (!d) return "Never";
  const s = (Date.now()-new Date(d))/1000;
  if (s < 60)    return `${~~s}s ago`;
  if (s < 3600)  return `${~~(s/60)}m ago`;
  if (s < 86400) return `${~~(s/3600)}h ago`;
  return `${~~(s/86400)}d ago`;
};
const fNum = n => n == null ? "—" : Number(n).toLocaleString();
const formatProcUptime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
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
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding: sm ? "1px 7px" : "2px 9px",
      borderRadius:99, fontSize: sm ? 10 : 11, fontWeight:600,
      whiteSpace:"nowrap", background:bg, color:fg,
      letterSpacing:".2px", border:`1px solid ${fg}35`,
    }}>
      {dot && <span style={{ width:5,height:5,borderRadius:"50%",background:"currentColor",flexShrink:0 }}/>}
      {children}
    </span>
  );
}

function stBadge(s) {
  if (!s) return <Badge color="gray">—</Badge>;
  const map = {
    online:"green",offline:"gray",warning:"amber",active:"green",
    inactive:"gray",suspended:"red","checked-in":"green",
    "checked-out":"gray",expected:"blue",resolved:"green",
    reviewing:"amber",open:"red",critical:"red",high:"amber",
    medium:"blue",low:"gray",
  };
  const label = { online:"Online",offline:"Offline",warning:"Warning",active:"Active",inactive:"Inactive",suspended:"Suspended","checked-in":"Checked In","checked-out":"Checked Out",expected:"Expected",resolved:"Resolved",reviewing:"Reviewing",open:"Open",critical:"Critical",high:"High",medium:"Medium",low:"Low" };
  return <Badge color={map[s]||"gray"} dot>{label[s]||s}</Badge>;
}

// ── Button ────────────────────────────────────────────────────────────
const BV = {
  primary:   { bg:TH.blue,    fg:"#fff",  hv:TH.blueHov,  bd:"none" },
  success:   { bg:TH.green,   fg:"#0a1a0f",hv:"#18b876",  bd:"none" },
  danger:    { bg:TH.red,     fg:"#fff",  hv:"#f35f6e",   bd:"none" },
  amber:     { bg:TH.amber,   fg:"#1a0f00",hv:"#d4921f",  bd:"none" },
  secondary: { bg:"transparent",fg:TH.blue, hv:TH.blueDim, bd:`1px solid ${TH.blue}50` },
  ghost:     { bg:"transparent",fg:TH.muted,hv:TH.hover,   bd:`1px solid ${TH.border}` },
  destructive:{ bg:TH.redDim, fg:"#ffd9de", hv:"rgba(255,107,120,.34)",bd:`1px solid ${TH.red}66` },
};
const BSZ = { xs:{p:"3px 9px",f:11}, sm:{p:"5px 12px",f:12}, md:{p:"8px 16px",f:13}, lg:{p:"11px 22px",f:14}, xl:{p:"14px 28px",f:15} };

function Btn({ children, onClick, v="primary", sz="md", disabled, full, icon, loading:ld, style={}, type="button" }) {
  const { bg, fg, hv, bd } = BV[v] || BV.primary;
  const { p, f } = BSZ[sz] || BSZ.md;
  return (
    <button type={type} onClick={onClick} disabled={disabled||ld}
      style={{ background:bg, color:fg, border:bd||"none", borderRadius:9, padding:p, fontSize:f, fontWeight:600, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6, transition:"all .14s cubic-bezier(.4,0,.2,1)", width:full?"100%":"auto", opacity:(disabled||ld)?.45:1, cursor:(disabled||ld)?"not-allowed":"pointer", letterSpacing:".1px", ...style }}
      onMouseEnter={e=>{ if(!(disabled||ld)){ e.currentTarget.style.background=hv; e.currentTarget.style.transform="translateY(-1px)"; e.currentTarget.style.boxShadow=v==="primary"?`0 4px 16px ${TH.blueGlow}`:v==="danger"||v==="destructive"?`0 4px 16px ${TH.redGlow}`:"none"; }}}
      onMouseLeave={e=>{ e.currentTarget.style.background=bg; e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="none"; }}>
      {ld ? <><span className="spin" style={{ fontSize:13 }}>⟳</span>{typeof children==="string"?children:null}</> : <>{icon&&<span>{icon}</span>}{children}</>}
    </button>
  );
}

// ── Input ─────────────────────────────────────────────────────────────
function Input({ value, onChange, placeholder, type="text", disabled, onEnter, style={}, prefix, suffix }) {
  const focusStyle = { borderColor:TH.blue, boxShadow:`0 0 0 3px ${TH.blueDim}` };
  const base = { width:"100%", padding:"9px 12px", borderRadius:8, fontSize:13, background:TH.card, border:`1px solid ${TH.border}`, color:TH.text, outline:"none", transition:"all .14s", ...style };
  if (prefix || suffix) {
    return (
      <div style={{ position:"relative", display:"flex", alignItems:"center" }}>
        {prefix && <span style={{ position:"absolute",left:11,color:TH.muted,fontSize:14,pointerEvents:"none",zIndex:1 }}>{prefix}</span>}
        <input value={value??""} onChange={onChange} placeholder={placeholder} type={type} disabled={disabled}
          onKeyDown={e=>e.key==="Enter"&&onEnter?.()}
          style={{ ...base, paddingLeft:prefix?34:12, paddingRight:suffix?34:12 }}
          onFocus={e=>Object.assign(e.target.style, focusStyle)}
          onBlur={e=>{ e.target.style.borderColor=TH.border; e.target.style.boxShadow="none"; }}/>
        {suffix && <span style={{ position:"absolute",right:11,color:TH.muted,fontSize:14,pointerEvents:"none" }}>{suffix}</span>}
      </div>
    );
  }
  return (
    <input value={value??""} onChange={onChange} placeholder={placeholder} type={type} disabled={disabled}
      onKeyDown={e=>e.key==="Enter"&&onEnter?.()}
      style={base}
      onFocus={e=>Object.assign(e.target.style, focusStyle)}
      onBlur={e=>{ e.target.style.borderColor=TH.border; e.target.style.boxShadow="none"; }}/>
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
function Sel({ value, onChange, options, disabled, style={} }) {
  return (
    <select value={value??""} onChange={onChange} disabled={disabled}
      style={{ width:"100%",padding:"9px 12px",borderRadius:8,fontSize:13,background:TH.card,border:`1px solid ${TH.border}`,color:TH.text,outline:"none",cursor:disabled?"not-allowed":"pointer",...style }}
      onFocus={e=>{ e.target.style.borderColor=TH.blue; }}
      onBlur={e=>{ e.target.style.borderColor=TH.border; }}>
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
      {label&&<label style={{ display:"block",fontSize:11,fontWeight:600,color:error?TH.red:TH.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:".5px" }}>
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
  return (
    <div className={className} onClick={onClick}
      style={{ background:`linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0)), ${TH.card}`, border:`1px solid ${glow?glow:TH.border}`, borderRadius:14, padding:pad, boxShadow: glow?`0 0 24px ${glow}25,${TH.shadow}`:`${TH.shadow}, inset 0 1px 0 rgba(255,255,255,.05)`, cursor:hov?"pointer":"default", transition:"all .16s cubic-bezier(.4,0,.2,1)", ...style }}
      onMouseEnter={e=>{ if(hov){ e.currentTarget.style.background=TH.hover; e.currentTarget.style.transform="translateY(-2px)"; e.currentTarget.style.borderColor=TH.borderB; }}}
      onMouseLeave={e=>{ if(hov){ e.currentTarget.style.background=`linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0)), ${TH.card}`; e.currentTarget.style.transform="none"; e.currentTarget.style.borderColor=glow||TH.border; }}}>
      {children}
    </div>
  );
}

// ── GlassCard ─────────────────────────────────────────────────────────
function GlassCard({ children, style={}, color=TH.blue, onClick }) {
  return (
    <div onClick={onClick} style={{ background:`linear-gradient(135deg,${color}10,${color}06)`, border:`1px solid ${color}25`, borderRadius:14, padding:20, boxShadow:`0 8px 32px ${color}12`, backdropFilter:"blur(12px)", cursor:onClick?"pointer":"default", ...style }}>
      {children}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color=TH.blue, trend, onClick }) {
  return (
    <Card pad={18} onClick={onClick} style={{ cursor:onClick?"pointer":"default" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
        <div style={{ width:42,height:42,borderRadius:11,background:`${color}18`,border:`1px solid ${color}25`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>{icon}</div>
        {trend!=null&&<div style={{ display:"flex",alignItems:"center",gap:3,padding:"3px 8px",borderRadius:20,background:trend>=0?TH.greenDim:TH.redDim }}>
          <span style={{ fontSize:11,fontWeight:700,color:trend>=0?TH.green:TH.red }}>{trend>=0?"↑":"↓"}{Math.abs(trend)}%</span>
        </div>}
      </div>
      <div style={{ fontSize:26,fontWeight:800,color,fontFamily:TH.mono,lineHeight:1,marginBottom:5,letterSpacing:"-1px" }}>{value??<span style={{ opacity:.3 }}>—</span>}</div>
      <div style={{ fontSize:13,fontWeight:600,color:TH.text,marginBottom:sub?3:0 }}>{label}</div>
      {sub&&<div style={{ fontSize:11,color:TH.muted }}>{sub}</div>}
    </Card>
  );
}

// ── Section header ────────────────────────────────────────────────────
function PageHeader({ title, sub, action, back, onBack }) {
  return (
    <div style={{ display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:24,gap:12,flexWrap:"wrap" }}>
      <div style={{ display:"flex",gap:10,alignItems:"center" }}>
        {back&&<button onClick={onBack} style={{ background:TH.card,border:`1px solid ${TH.border}`,borderRadius:8,padding:"6px 10px",color:TH.muted,cursor:"pointer",fontSize:13 }}>← {back}</button>}
        <div>
          <h1 style={{ fontSize:22,fontWeight:800,color:TH.text,marginBottom:3,letterSpacing:"-.4px" }}>{title}</h1>
          {sub&&<p style={{ fontSize:13,color:TH.muted }}>{sub}</p>}
        </div>
      </div>
      {action&&<div style={{ display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>{action}</div>}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────
function Table({ headers, rows, onRow, loading, emptyIcon="📭", emptyText="No records found" }) {
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:500 }}>
        <thead>
          <tr style={{ background:`${TH.surface}cc`,borderBottom:`2px solid ${TH.border}` }}>
            {headers.map(h=><th key={h} style={{ padding:"10px 16px",textAlign:"left",fontSize:11,fontWeight:600,color:TH.muted,textTransform:"uppercase",letterSpacing:".6px",whiteSpace:"nowrap" }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {loading&&<tr><td colSpan={headers.length} style={{ textAlign:"center",padding:56,color:TH.muted }}><span className="spin" style={{ fontSize:24,color:TH.blue }}>⟳</span></td></tr>}
          {!loading&&rows.length===0&&<tr><td colSpan={headers.length}><Empty icon={emptyIcon} text={emptyText}/></td></tr>}
          {!loading&&rows.map((row,i)=>(
            <tr key={row.key||i} onClick={()=>onRow?.(row)} style={{ borderBottom:`1px solid ${TH.border}`,cursor:onRow?"pointer":"default",transition:"background .1s" }}
              onMouseEnter={e=>e.currentTarget.style.background=TH.hover}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              {row.cells.map((cell,j)=><td key={j} style={{ padding:"12px 16px",color:TH.text,verticalAlign:"middle" }}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────
function Pagination({ page, total, per, onChange }) {
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
      <div style={{ background:TH.surface,border:`1px solid ${TH.border}`,borderRadius:16,width:`min(${width}px,100%)`,maxHeight:"92vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 32px 96px rgba(0,0,0,.6)" }}>
        <div style={{ padding:"18px 22px",borderBottom:`1px solid ${TH.border}`,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexShrink:0 }}>
          <div>
            <div style={{ fontSize:17,fontWeight:700,color:TH.text }}>{title}</div>
            {subtitle&&<div style={{ fontSize:12,color:TH.muted,marginTop:3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background:TH.hover,border:`1px solid ${TH.border}`,borderRadius:8,width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:TH.muted,cursor:"pointer",flexShrink:0,marginLeft:16 }}>×</button>
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
      <span style={{ fontSize:13,color:TH.muted }}>{label}</span>
      <div style={{ display:"flex",alignItems:"center",gap:8 }}>
        <span style={{ fontSize:13,fontWeight:600,color:color||TH.text,fontFamily:mono?TH.mono:"inherit" }}>{value??<span style={{ opacity:.35 }}>—</span>}</span>
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
  if (img) return <img src={img} style={{ width:size,height:size,borderRadius:"50%",objectFit:"cover",border:`2px solid ${color}40`,flexShrink:0 }} alt={name}/>;
  return (
    <div style={{ width:size,height:size,borderRadius:"50%",background:`${color}18`,border:`2px solid ${color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.36,fontWeight:700,color,flexShrink:0 }}>
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
const TT_STYLE = { background:TH.surface, border:`1px solid ${TH.border}`, borderRadius:9, fontSize:12, color:TH.text, boxShadow:TH.shadow };
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
  const [busy, set] = useState(false);

  const go = async e => {
    e?.preventDefault();
    if (!u.trim()) { show("Enter username", "error"); return; }
    set(true);
    try {
      const r = await api.login({ username:u.trim(), password:p });
      if (rememberUser) localStorage.setItem("expo_last_user", u.trim());
      else localStorage.removeItem("expo_last_user");
      setToken(r.token);
      onLogin(r.user);
    } catch (e) { show(e.message||"Login failed","error"); }
    finally { set(false); }
  };

  const companyLogo = "/company-logo.png";

  return (
    <div className="login-stage" style={{ minHeight:"100vh",display:"flex",overflow:"hidden",background:TH.bg }}>
      <div className="login-aurora" />
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
      <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:`linear-gradient(135deg,${TH.surface},${TH.bg})`,borderRight:`1px solid ${TH.border}`,padding:40,position:"relative",overflow:"hidden",zIndex:1 }}>
        <div className="fr-grid" style={{ position:"absolute",inset:0,opacity:.32,pointerEvents:"none" }}/>
        {[{s:420,o:.04,t:-120,l:-120},{s:320,o:.05,t:220,l:110},{s:220,o:.06,b:-90,r:-90}].map((c,i)=>(
          <div key={i} style={{ position:"absolute",width:c.s,height:c.s,borderRadius:"50%",border:`1px solid ${TH.blue}`,opacity:c.o,top:c.t,left:c.l,bottom:c.b,right:c.r,pointerEvents:"none" }}/>
        ))}
        <div style={{ maxWidth:520,position:"relative",zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:44 }}>
          <div className="fr-scan-ring fr-corners" style={{ width:340,height:340 }} />
          <img src={companyLogo} alt="Expo City Dubai logo" className="logo-rotate-slow" style={{ width:320,height:320,objectFit:"contain",filter:"drop-shadow(0 16px 30px rgba(0,0,0,.45))",zIndex:1 }} />
          <div style={{ fontSize:44,fontWeight:800,letterSpacing:"-.6px",lineHeight:1,color:"#e0ad4e",textShadow:"0 6px 28px rgba(224,173,78,.25)" }}>
            Expo City Dubai
          </div>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:10,flexWrap:"wrap",marginTop:-20 }}>
            <span className="fr-chip"><span className="pulse-dot" style={{ width:7,height:7,borderRadius:"50%",background:TH.green,display:"inline-block" }}/> <b>FR Engine:</b> Ready</span>
            <span className="fr-chip"><span style={{ color:TH.cyan }}>◈</span> <b>Liveness:</b> Enabled</span>
            <span className="fr-chip"><span style={{ color:TH.blue }}>⟟</span> <b>Mode:</b> Real-time</span>
          </div>
        </div>
      </div>

      {/* Right login form */}
      <div style={{ width:640,display:"flex",alignItems:"center",justifyContent:"center",padding:36,position:"relative",zIndex:1 }}>
        <div style={{ width:"100%",maxWidth:560 }}>
          <h3 style={{ fontSize:34,fontWeight:900,color:TH.text,marginBottom:10,letterSpacing:"-.5px" }}>Sign in</h3>
          <p style={{ fontSize:15,color:TH.muted,marginBottom:34 }}>Access Expo City Dubai security command center</p>
          <div style={{ display:"flex",gap:10,flexWrap:"wrap",marginBottom:14 }}>
            <span className="fr-chip"><span style={{ color:TH.green }}>✓</span> Face Recognition Access Control</span>
            <span className="fr-chip"><span style={{ color:TH.cyan }}>⚡</span> Secure Session Handshake</span>
          </div>

          <Card className="signin-card" pad={0} style={{ marginBottom:20,overflow:"hidden",background:"linear-gradient(180deg, rgba(18,31,53,.88), rgba(14,24,41,.92))" }}>
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
                  <Input value={p} onChange={e=>setP(e.target.value)} placeholder="password" type={showPass ? "text" : "password"} prefix="🔒" onEnter={go}/>
                </Field>
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
                <Btn type="submit" full loading={busy} sz="lg" disabled={!u.trim() || !p}>Sign In →</Btn>
                <div style={{ marginTop:12,fontSize:12,color:TH.muted,textAlign:"center" }}>
                  Need access help? Contact your system administrator.
                </div>
              </div>
            </form>
          </Card>
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
  { id:"employees",    icon:"👥",  label:"Employees",        desc:"Staff management" },
  { id:"enrollment",   icon:"📷",  label:"Face Enrollment",  desc:"AI photo enrollment" },
  { id:"visitors",     icon:"🪪",  label:"Visitors",         desc:"Guest management" },
  { id:"footprints",   icon:"👣",  label:"Footprints",       desc:"Movement history" },
  { s:"Security" },
  { id:"alerts",       icon:"🔔",  label:"Alerts",           desc:"Notifications",         badge:"!", bc:"red" },
  { id:"threats",      icon:"🛡",   label:"Threat Intel",     desc:"AI risk engine" },
  { id:"sync",         icon:"⟳",   label:"Offline Sync",     desc:"Buffer recovery" },
  { s:"AI & Analytics" },
  { id:"ai",           icon:"◈",   label:"ARIA AI Chat",     desc:"Ollama assistant",      hl:true },
  { id:"ai_insights",  icon:"✦",   label:"AI Insights",      desc:"Automated analysis" },
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
  const logoWrap = open ? 54 : 40;
  const logoSize = open ? 45 : 30;
  return (
    <aside style={{ width:open?248:60,height:"100vh",minHeight:0,background:TH.navBg,borderRight:`1px solid ${TH.border}`,display:"flex",flexDirection:"column",flexShrink:0,transition:"width .22s cubic-bezier(.4,0,.2,1)",overflowY:"auto",overflowX:"hidden",position:"relative",zIndex:10 }}>
      {/* Logo */}
      <div style={{ padding:open?"14px 14px":"10px 8px",borderBottom:`1px solid ${TH.border}`,display:"flex",alignItems:"center",justifyContent:open?"flex-start":"center",gap:open?10:0,minHeight:60,flexShrink:0 }}>
        <div style={{ width:logoWrap,height:logoWrap,borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:`0 0 0 1px rgba(255,255,255,.08), 0 0 20px rgba(224,173,78,.4), 0 6px 16px rgba(0,0,0,.35)`,background:"radial-gradient(circle at 35% 30%, rgba(255,255,255,.24), rgba(255,255,255,.02) 55%)",border:`1px solid rgba(224,173,78,.4)` }}>
          <img src={sidebarLogo} alt="Expo City Dubai logo" style={{ width:logoSize,height:logoSize,objectFit:"contain",filter:"drop-shadow(0 0 12px rgba(224,173,78,.62))" }} />
        </div>
        {open&&<>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:16,fontWeight:900,color:TH.text,letterSpacing:"-.1px" }}>Expo City Dubai</div>
          </div>
          <button onClick={onToggle} style={{ background:TH.hover,border:`1px solid ${TH.border}`,color:TH.muted,cursor:"pointer",fontSize:13,padding:"4px 7px",borderRadius:7,flexShrink:0 }}>‹</button>
        </>}
        {!open&&<button onClick={onToggle} style={{ position:"absolute",inset:0,background:"none",border:"none",cursor:"pointer" }}/>}
      </div>

      {/* Nav items */}
      <nav style={{ flex:"0 0 auto",minHeight:0,overflow:"visible",padding:"6px 0 8px" }}>
        {NAV.map((item,i)=>{
          if (item.s) return open
            ? <div key={i} style={{ padding:"9px 12px 4px",fontSize:10,fontWeight:700,color:TH.faint,textTransform:"uppercase",letterSpacing:".9px" }}>{item.s}</div>
            : <div key={i} style={{ height:2 }}/>;

          if (!can(role, item.id) && !isSuperadmin) return null;

          const on = page===item.id;
          const bc = bColors[item.bc]||TH.blue;
          const badgeNum = item.id==="alerts"&&alertCount>0 ? alertCount : null;

          return (
            <button key={item.id} onClick={()=>onNav(item.id)} title={!open?item.label:undefined}
              style={{ width:"100%",display:"flex",alignItems:"center",gap:10,padding:open?"8px 12px":"8px 0",justifyContent:open?"flex-start":"center",background:on?TH.blueDim:"transparent",borderLeft:`3px solid ${on?TH.blue:"transparent"}`,border:"none",cursor:"pointer",textAlign:"left",transition:"all .12s",color:on?TH.blue:TH.muted }}
              onMouseEnter={e=>{ if(!on){e.currentTarget.style.background=TH.hover;} }}
              onMouseLeave={e=>{ if(!on)e.currentTarget.style.background="transparent"; }}>
              <span style={{ fontSize:15,width:18,textAlign:"center",flexShrink:0,color:on?TH.blue:TH.muted }}>{item.icon}</span>
              {open&&<>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:12.5,fontWeight:item.hl?700:500,color:on?TH.blue:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.25 }}>{item.label}</div>
                </div>
                {badgeNum!=null&&<span style={{ fontSize:10,padding:"1px 7px",borderRadius:10,background:TH.redDim,color:TH.red,fontWeight:700,flexShrink:0 }}>{badgeNum}</span>}
                {!badgeNum&&item.badge&&<span style={{ fontSize:9,padding:"1px 6px",borderRadius:10,background:`${bc}20`,color:bc,fontWeight:700,flexShrink:0 }}>{item.badge}</span>}
              </>}
            </button>
          );
        })}
      </nav>

      {/* Expand toggle when closed */}
      {!open&&<div style={{ padding:"10px 0",borderTop:`1px solid ${TH.border}`,display:"flex",justifyContent:"center" }}>
        <button onClick={onToggle} style={{ background:"none",border:"none",color:TH.muted,cursor:"pointer",fontSize:16,padding:4 }}>›</button>
      </div>}

      {/* User */}
      {open&&user&&<div style={{ padding:"10px 14px",borderTop:`1px solid ${TH.border}`,display:"flex",gap:9,alignItems:"center",flexShrink:0 }}>
        <Avatar name={user.name||user.username} size={30} color={TH.blue}/>
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ fontSize:13,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{user.name||user.username}</div>
          <div style={{ fontSize:11,color:TH.blue,fontWeight:500,textTransform:"capitalize" }}>{user.role}</div>
        </div>
      </div>}
    </aside>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TOPBAR
═══════════════════════════════════════════════════════════════════════ */
function TopBar({ page, user, onLogout, online, onNav }) {
  const { show } = useToast();
  const [now, setNow] = useState(new Date());
  const { data:health } = useFetch(()=>api.health(),[], null);

  useEffect(()=>{ const iv=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(iv); },[]);

  const label  = NAV.find(n=>n.id===page)?.label||"Dashboard";
  const devOn  = health?.devices?.online;
  const devTot = health?.devices?.total;
  const onSite = health?.onPremise;

  const doLogout = async () => {
    try { await api.logout(); } catch {}
    clearToken(); onLogout(); show("Signed out","info");
  };

  return (
    <header style={{ height:56,background:TH.navBg,borderBottom:`1px solid ${TH.border}`,display:"flex",alignItems:"center",padding:"0 22px",gap:16,flexShrink:0 }}>
      <h2 style={{ fontSize:16,fontWeight:700,color:TH.text,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",letterSpacing:"-.2px" }}>{label}</h2>

      <div style={{ display:"flex",gap:14,alignItems:"center" }}>
        {/* Live stats */}
        {[{l:"Devices",v:devOn!=null?`${devOn}/${devTot}`:"—",c:TH.green},{l:"On-Site",v:onSite??<span style={{ opacity:.4 }}>—</span>,c:TH.blue}].map(s=>(
          <div key={s.l} style={{ textAlign:"center" }}>
            <div style={{ fontSize:13,fontWeight:700,color:s.c,fontFamily:TH.mono,lineHeight:1.2 }}>{s.v}</div>
            <div style={{ fontSize:10,color:TH.muted }}>{s.l}</div>
          </div>
        ))}

        {/* Online status */}
        <div style={{ display:"flex",gap:5,alignItems:"center",padding:"4px 9px",borderRadius:20,background:online?TH.greenDim:TH.redDim,border:`1px solid ${online?TH.green:TH.red}30` }}>
          <div style={{ width:6,height:6,borderRadius:"50%",background:online?TH.green:TH.red }} className="pulse-dot"/>
          <span style={{ fontSize:11,fontWeight:600,color:online?TH.green:TH.red }}>{online?"Online":"Offline"}</span>
        </div>

        {/* Clock */}
        <span style={{ fontSize:12,color:TH.muted,fontFamily:TH.mono,letterSpacing:".5px" }}>{now.toLocaleTimeString("en-US",{hour12:false})}</span>

        {/* Role */}
        <Badge color="blue">{user?.role}</Badge>

        {/* Superadmin settings */}
        {user?.role==="superadmin"&&(
          <button onClick={()=>onNav?.("settings")} title="Settings"
            style={{ background:"none",border:"none",cursor:"pointer",color:TH.muted,fontSize:14,padding:"5px 10px",borderRadius:7,transition:"all .13s" }}
            onMouseEnter={e=>{ e.currentTarget.style.background=TH.blueDim; e.currentTarget.style.color=TH.blue; }}
            onMouseLeave={e=>{ e.currentTarget.style.background="none"; e.currentTarget.style.color=TH.muted; }}>
            ⚙
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
  const { data:stats,  loading:sLoad, reload:reloadStats } = useFetch(()=>api.logStats(),   [], null);
  const { data:health } = useFetch(()=>api.health(),     [], null);
  const { data:insightsRaw }           = useFetch(()=>api.aiInsights(),  [], null);
  const { data:empMeta }               = useFetch(()=>api.employees({ limit:1 }), [], { total:0 });
  const { data:visMeta }               = useFetch(()=>api.visitors({ limit:1 }), [], { total:0 });
  const { data:devRaw }                = useFetch(()=>api.devices(), [], []);
  const { data:riskData }              = useFetch(()=>api.aiRiskScore(), [], null);
  const [feed, setFeed] = useState([]);

  const insights = Array.isArray(insightsRaw)
    ? { items: insightsRaw, alerts: [], riskScore: null }
    : (insightsRaw || {});

  const devList = Array.isArray(devRaw) ? devRaw : [];
  const devOnline = devList.filter(d => String(d.status || "").toLowerCase() === "online").length;
  const devTotal = devList.length;
  const empTotal = Number(empMeta?.total ?? 0);
  const visTotal = Number(visMeta?.total ?? 0);
  const grantedN = Number(stats?.grantedToday ?? stats?.granted ?? 0);
  const deniedN  = Number(stats?.deniedToday ?? stats?.denied ?? 0);
  const unknownDeniedN = Number(stats?.unknownDenied ?? 0);
  const onPremN  = Number(health?.onPremise ?? stats?.onPremise ?? 0);
  const riskN    = riskData?.score != null ? Number(riskData.score) : (insights?.riskScore != null ? Number(insights.riskScore) : 0);

  // initial logs + WS
  useEffect(()=>{ api.logs({ limit:10, sort:"desc" }).then(r=>setFeed(r?.logs||[])).catch(()=>{}); },[]);
  useEffect(() => {
    const onSynced = () => {
      reloadStats();
      api.logs({ limit:10, sort:"desc" }).then(r=>setFeed(r?.logs||[])).catch(()=>{});
    };
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [reloadStats]);
  useWS(useCallback(msg=>{
    if(msg.type==="ACCESS_EVENT") setFeed(p=>[msg.data,...p.slice(0,49)]);
  },[]));

  const hourly  = stats?.hourly  || [];
  const authPie = stats?.authModes || [];
  const weekly  = stats?.weekly  || [];
  const openLogsFromCard = (kind) => {
    try {
      sessionStorage.setItem("acs_logs_filter", kind);
      sessionStorage.setItem("acs_logs_today", "1");
    } catch {}
    onNav("logs");
  };

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
      {/* KPI Row */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:14 }}>
        <StatCard icon="👥"  label="Employees"       value={fNum(empTotal)}              color={TH.blue}   sub="Registered"     trend={null} onClick={()=>onNav("employees")}/>
        <StatCard icon="🪪"  label="Visitors"        value={fNum(visTotal)}              color={TH.violet} sub="Registered"     trend={null} onClick={()=>onNav("visitors")}/>
        <StatCard icon="✅"  label="Granted Today"   value={fNum(grantedN)}              color={TH.green}  sub="Access events"  trend={stats?.grantedTrend} onClick={()=>openLogsFromCard("granted")}/>
        <StatCard icon="🚫"  label="Denied Today"    value={fNum(deniedN)}               color={TH.red}    sub="Blocked"          trend={stats?.deniedTrend} onClick={()=>openLogsFromCard("denied")}/>
        <StatCard icon="📍"  label="On Premises"     value={fNum(onPremN)}               color={TH.cyan}   sub="Right now"      onClick={()=>onNav("monitor")}/>
        <StatCard icon="◫"   label="Devices"         value={`${devOnline}/${devTotal}`} color={TH.green} sub="Online/Total"    onClick={()=>onNav("devices")}/>
        <StatCard icon="🤖"  label="Risk Score"      value={`${riskN}/100`}             color={riskN>=70?TH.red:riskN>=40?TH.amber:TH.green} sub="AI assessment" onClick={()=>onNav("ai_insights")}/>
      </div>
      {unknownDeniedN>0&&(
        <div style={{ display:"flex",justifyContent:"flex-end",marginTop:-8 }}>
          <button onClick={()=>{ try{sessionStorage.setItem("acs_logs_filter","unknown_denied");sessionStorage.setItem("acs_logs_today","1");}catch{} onNav("logs"); }}
            style={{ border:`1px solid ${TH.red}66`,background:TH.redDim,color:"#ffdce1",borderRadius:999,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer",boxShadow:`0 0 16px ${TH.redGlow}` }}>
            ⚠ Unknown Denied: {fNum(unknownDeniedN)}
          </button>
        </div>
      )}

      {/* AI Insights banner */}
      {insights?.alerts?.length>0&&(
        <GlassCard color={TH.amber}>
          <div style={{ display:"flex",gap:12,alignItems:"flex-start" }}>
            <span style={{ fontSize:22,flexShrink:0 }}>✦</span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14,fontWeight:700,color:TH.amber,marginBottom:6 }}>AI Insights — {insights.alerts.length} Item{insights.alerts.length!==1?"s":""}</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
                {insights.alerts.slice(0,3).map((a,i)=>(
                  <div key={i} style={{ fontSize:12,color:TH.muted,background:TH.card,padding:"5px 10px",borderRadius:7,border:`1px solid ${TH.border}` }}>{a.message||a}</div>
                ))}
              </div>
            </div>
            <Btn v="ghost" sz="sm" onClick={()=>onNav("ai_insights")}>View All</Btn>
          </div>
        </GlassCard>
      )}

      {/* Charts */}
      <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr",gap:16 }}>
        <Card>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
            <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>Access Events — Last 24h</div>
            {sLoad&&<span className="spin" style={{ color:TH.muted,fontSize:14 }}>⟳</span>}
          </div>
          {hourly.length===0&&!sLoad?<Empty icon="📊" text="No data yet" sub="Connect devices to see live charts"/>:(
            <div style={{ height:195 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourly} margin={{top:4,right:4,left:-20,bottom:0}}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={TH.green} stopOpacity={.25}/><stop offset="95%" stopColor={TH.green} stopOpacity={0}/></linearGradient>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={TH.red} stopOpacity={.2}/><stop offset="95%" stopColor={TH.red} stopOpacity={0}/></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                  <XAxis dataKey="hour" tick={{fill:TH.muted,fontSize:10}} interval={3}/>
                  <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                  <Tooltip contentStyle={TT_STYLE}/>
                  <Area type="monotone" dataKey="granted" name="Granted" stroke={TH.green} strokeWidth={2} fill="url(#g1)"/>
                  <Area type="monotone" dataKey="denied"  name="Denied"  stroke={TH.red}   strokeWidth={2} fill="url(#g2)"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Auth Methods</div>
          {authPie.length===0?<Empty icon="🔐" text="No auth data"/>:(
            <>
              <div style={{ height:145 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={authPie} cx="50%" cy="50%" innerRadius={40} outerRadius={65} paddingAngle={2} dataKey="value">
                      {authPie.map((_,i)=><Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]} opacity={.9}/>)}
                    </Pie>
                    <Tooltip contentStyle={TT_STYLE} formatter={(v,_,p)=>[`${v}%`,p.payload.name]}/>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                {authPie.slice(0,4).map((d,i)=>(
                  <div key={d.name} style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <div style={{ display:"flex",gap:7,alignItems:"center" }}>
                      <div style={{ width:8,height:8,borderRadius:"50%",background:CHART_COLORS[i%CHART_COLORS.length] }}/>
                      <span style={{ fontSize:11,color:TH.muted }}>{d.name}</span>
                    </div>
                    <span style={{ fontSize:12,fontWeight:700,color:TH.text,fontFamily:TH.mono }}>{d.value}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
        {/* Weekly */}
        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Weekly Volume</div>
          {weekly.length===0?<Empty icon="📈" text="No data"/>:(
            <div style={{ height:175 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekly} margin={{top:4,right:4,left:-20,bottom:0}} barSize={22}>
                  <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                  <XAxis dataKey="day" tick={{fill:TH.muted,fontSize:11}}/>
                  <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                  <Tooltip contentStyle={TT_STYLE}/>
                  <Bar dataKey="count" name="Events" fill={TH.blue} radius={[4,4,0,0]} opacity={.85}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Live feed */}
        <Card>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
            <div style={{ display:"flex",gap:7,alignItems:"center" }}>
              <span style={{ fontSize:14,fontWeight:700,color:TH.text }}>Live Feed</span>
              <div style={{ width:7,height:7,borderRadius:"50%",background:TH.green }} className="pulse-dot"/>
            </div>
            <Btn v="ghost" sz="xs" onClick={()=>onNav("logs")}>All logs →</Btn>
          </div>
          {feed.length===0?<Empty icon="⬡" text="Waiting for events…" sub="Events appear here in real-time"/>:(
            <div style={{ display:"flex",flexDirection:"column",gap:6,maxHeight:220,overflowY:"auto" }}>
              {feed.map((log,i)=>{
                const ok=log.accessGranted??log.granted;
                const name=log.employeeName||log.name||"Unknown";
                return (
                  <div key={(log._id||log.id||i)+i} style={{ display:"flex",alignItems:"center",gap:10,padding:"7px 10px",background:TH.surface,borderRadius:8,border:`1px solid ${TH.border}` }}>
                    <Avatar name={name} size={28} color={ok?TH.green:TH.red}/>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:12,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{name}</div>
                      <div style={{ fontSize:10,color:TH.muted }}>📍 {log.zone||"—"}</div>
                    </div>
                    {ok?<Badge color="green" sm>✓</Badge>:<Badge color="red" sm>✗</Badge>}
                    <span style={{ fontSize:10,color:TH.muted,fontFamily:TH.mono }}>{fT(log.timestamp||log.ts)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Quick actions */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12 }}>
        {[
          {icon:"⚙",  label:"Configure Device", desc:"Add Suprema terminal",  page:"setup",      c:TH.blue  },
          {icon:"📷", label:"Enroll Employee",   desc:"AI face enrollment",    page:"enrollment", c:TH.green },
          {icon:"🔔", label:"Open Alerts",        desc:"Review security alerts",page:"alerts",     c:TH.red   },
          {icon:"◈",  label:"Ask ARIA AI",        desc:"Ollama AI assistant",   page:"ai",         c:TH.violet},
        ].map(q=>(
          <GlassCard key={q.page} color={q.c} style={{ cursor:"pointer",padding:16 }} onClick={()=>onNav(q.page)}>
            <div style={{ fontSize:22,marginBottom:10 }}>{q.icon}</div>
            <div style={{ fontSize:13,fontWeight:700,color:TH.text,marginBottom:3 }}>{q.label}</div>
            <div style={{ fontSize:11,color:TH.muted }}>{q.desc}</div>
          </GlassCard>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FR LIVE MONITOR
═══════════════════════════════════════════════════════════════════════ */
function FRMonitorPage() {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("all");
  const [sel,    setSel]    = useState(null);
  const pausedRef = useRef(false);
  useEffect(()=>{ pausedRef.current=paused; },[paused]);

  const loadRecent = useCallback(() => {
    api.logs({limit:30,sort:"desc"}).then(r=>setEvents(r?.logs||[])).catch(()=>{});
  }, []);
  useEffect(()=>{ loadRecent(); }, [loadRecent]);
  useEffect(() => {
    const onSynced = () => loadRecent();
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [loadRecent]);
  useWS(useCallback(msg=>{
    if(msg.type==="ACCESS_EVENT"&&!pausedRef.current)
      setEvents(p=>[msg.data,...p.slice(0,71)]);
  },[]));

  const shown = events.filter(e=>filter==="all"?true:filter==="granted"?(e.accessGranted??e.granted):!(e.accessGranted??e.granted));
  const granted = e => e.accessGranted??e.granted;
  const name    = e => e.employeeName||e.name||e.employeeId||"Unknown";

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100%" }}>
      <PageHeader title="FR Live Monitor" sub="Real-time biometric events via WebSocket"/>
      <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap" }}>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["granted","✓ Granted"],["denied","✗ Denied"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{ padding:"7px 14px",fontSize:12,fontWeight:600,background:filter===v?TH.blue:"transparent",color:filter===v?"#fff":TH.muted,border:"none",cursor:"pointer",transition:"all .12s" }}>{l}</button>
          ))}
        </div>
        <Btn v={paused?"success":"ghost"} sz="sm" onClick={()=>setPaused(p=>!p)}>{paused?"▶ Resume":"⏸ Pause"}</Btn>
        <div style={{ marginLeft:"auto",display:"flex",gap:8,alignItems:"center" }}>
          {!paused&&<><div style={{ width:8,height:8,borderRadius:"50%",background:TH.green }} className="pulse-dot"/><span style={{ fontSize:12,color:TH.green,fontWeight:700 }}>LIVE</span></>}
          {paused&&<Badge color="amber">Paused</Badge>}
          <span style={{ fontSize:12,color:TH.muted }}>{shown.length} events</span>
        </div>
      </div>

      <div style={{ flex:1,overflowY:"auto" }}>
        {shown.length===0?<Empty icon="⬡" text="No events yet" sub="Events will appear when devices are connected"/>:(
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(215px,1fr))",gap:12 }}>
            {shown.map((ev,i)=>{
              const ok=granted(ev), n=name(ev);
              return (
                <div key={(ev._id||ev.id||i)+i} onClick={()=>setSel(ev)} className={i<4&&!paused?"fade-in":undefined}
                  style={{ background:TH.card,border:`2px solid ${ok?TH.green+"40":TH.red+"40"}`,borderRadius:13,padding:14,cursor:"pointer",position:"relative",overflow:"hidden",transition:"all .15s" }}
                  onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-3px)"; e.currentTarget.style.boxShadow=`0 10px 32px ${ok?TH.green+"20":TH.red+"20"}`; }}
                  onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="none"; }}>
                  <div style={{ position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${ok?TH.green:TH.red},${ok?TH.green+"50":TH.red+"50"})` }}/>
                  <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:10 }}>
                    <div style={{ position:"relative" }}>
                      <Avatar name={n} size={46} color={ok?TH.green:TH.red}/>
                      <div style={{ position:"absolute",bottom:-2,right:-2,width:16,height:16,borderRadius:"50%",background:ok?TH.green:TH.red,border:`2px solid ${TH.card}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:700 }}>{ok?"✓":"✗"}</div>
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:13,fontWeight:700,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{n}</div>
                      <div style={{ fontSize:11,color:TH.muted }}>{ev.department||ev.dept||"—"}</div>
                    </div>
                  </div>
                  <div style={{ fontSize:11,color:TH.muted,marginBottom:7 }}>📍 {ev.zone||"—"}</div>
                  <div style={{ display:"flex",gap:5,flexWrap:"wrap",marginBottom:9 }}>
                    <Badge color="blue" sm>{ev.authMode||"—"}</Badge>
                    {ok?<Badge color="green" sm>Granted</Badge>:<Badge color="red" sm>Denied</Badge>}
                  </div>
                  <div style={{ display:"flex",justifyContent:"space-between",paddingTop:9,borderTop:`1px solid ${TH.border}` }}>
                    {[["Conf.",`${ev.confidence||ev.matchScore||"—"}%`,ok?TH.green:TH.red],["Resp.",`${ev.processingMs||ev.responseMs||"—"}ms`,TH.muted],[fT(ev.timestamp||ev.ts),"","",true]].map(([l,v,c,last])=>(
                      <div key={l} style={{ textAlign:last?"right":"center" }}>
                        <div style={{ fontSize:12,fontWeight:700,color:c||TH.muted,fontFamily:TH.mono }}>{last?l:v}</div>
                        {!last&&<div style={{ fontSize:9,color:TH.muted,textTransform:"uppercase" }}>{l}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sel&&(
        <Modal title="Access Event" onClose={()=>setSel(null)} width={480}>
          <div style={{ display:"flex",gap:14,alignItems:"flex-start",marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${TH.border}` }}>
            <Avatar name={name(sel)} size={64} color={granted(sel)?TH.green:TH.red}/>
            <div>
              <div style={{ fontSize:17,fontWeight:700,color:TH.text,marginBottom:8 }}>{name(sel)}</div>
              {granted(sel)?<Badge color="green">✓ Access Granted</Badge>:<Badge color="red">✗ Access Denied</Badge>}
              <div style={{ fontSize:12,color:TH.muted,marginTop:6,fontFamily:TH.mono }}>{fDT(sel.timestamp||sel.ts)}</div>
            </div>
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
            {[["Zone",sel.zone],["Device",sel.deviceName||sel.device],["Auth Mode",sel.authMode],["Direction",sel.direction],["Confidence",sel.confidence?`${sel.confidence}%`:"—"],["Response",sel.processingMs?`${sel.processingMs}ms`:"—"],["Temperature",sel.temperature?`${sel.temperature}°C`:"—"],["Department",sel.department||sel.dept]].map(([k,v])=>(
              <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
                <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
                <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
              </div>
            ))}
          </div>
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
  const [search, setSearch] = useState("");
  const [tab,    setTab]    = useState("all");
  const [confirm,setConfirm]= useState(null);

  const devs = (data||[]).filter(d=>{
    if(search&&!(d.name+d.ip+d.zone).toLowerCase().includes(search.toLowerCase())) return false;
    if(tab==="online"&&d.status!=="online") return false;
    if(tab==="offline"&&d.status!=="offline") return false;
    return true;
  });
  const devKey = d => d._id || d.deviceId || d.id || d.ip || d.name;

  const doSync=async id=>{
    try { await api.deviceSync(id); show("Sync complete","success"); reload(); }
    catch(e){ show(e.message,"error"); }
  };
  const doDel=async id=>{
    try { await api.deviceDelete(id); show("Device removed","success"); reload(); setConfirm(null); setSel(null); }
    catch(e){ show(e.message,"error"); }
  };

  return (
    <div>
      <PageHeader title="My Devices" sub={`${(data||[]).length} devices registered`}
        action={<><Btn v="ghost" sz="sm" onClick={()=>onNav("models")}>📋 Models</Btn><Btn onClick={()=>onNav("setup")} icon="⚙">Add Device</Btn></>}/>

      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:20 }}>
        {[["🟢","Online",(data||[]).filter(d=>d.status==="online").length,TH.green],["🟡","Warning",(data||[]).filter(d=>d.status==="warning").length,TH.amber],["🔴","Offline",(data||[]).filter(d=>d.status==="offline").length,TH.red],["◫","Total",(data||[]).length,TH.blue]].map(([icon,label,val,c])=>(
          <StatCard key={label} icon={icon} label={label} value={val} color={c}/>
        ))}
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,display:"flex",gap:10,flexWrap:"wrap",alignItems:"center" }}>
          <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search device, IP, zone…" style={{ flex:1,minWidth:180 }}/>
          <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
            {["all","online","offline"].map(s=>(
              <button key={s} onClick={()=>setTab(s)} style={{ padding:"7px 13px",fontSize:12,fontWeight:600,background:tab===s?TH.blue:"transparent",color:tab===s?"#fff":TH.muted,border:"none",cursor:"pointer",textTransform:"capitalize" }}>{s}</button>
            ))}
          </div>
        </div>
        <Table loading={loading} headers={["Device","Model","Zone","IP","Status","Response","Enrolled","Actions"]} onRow={r=>setSel(r)}
          rows={devs.map(d=>({ key:devKey(d), d, cells:[
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <div style={{ width:9,height:9,borderRadius:"50%",background:d.status==="online"?TH.green:d.status==="warning"?TH.amber:TH.red,flexShrink:0,boxShadow:`0 0 6px ${d.status==="online"?TH.green:d.status==="warning"?TH.amber:TH.red}` }}/>
              <div><div style={{ fontWeight:600 }}>{d.name}</div><code style={{ fontSize:10,color:TH.muted }}>{devKey(d)}</code></div>
            </div>,
            <span style={{ fontSize:12 }}>{d.model}</span>,
            <span style={{ fontSize:12 }}>📍 {d.zone}</span>,
            <code style={{ fontSize:12 }}>{d.ip}:{d.port||51211}</code>,
            stBadge(d.status),
            <span style={{ fontSize:12,fontWeight:700,fontFamily:TH.mono,color:!d.responseMs?"inherit":d.responseMs<200?TH.green:d.responseMs<350?TH.amber:TH.red }}>{d.responseMs?`${d.responseMs}ms`:"—"}</span>,
            <span style={{ fontSize:12 }}>{fNum(d.enrolled)||"0"}</span>,
            <div style={{ display:"flex",gap:5 }}>
              <Btn v="ghost" sz="xs" onClick={e=>{e.stopPropagation();doSync(devKey(d));}}>⟳</Btn>
              <Btn v="destructive" sz="xs" onClick={e=>{e.stopPropagation();setConfirm(devKey(d));}}>✕</Btn>
            </div>
          ]}))}/>
      </Card>

      {sel&&<Modal title={`Device — ${sel.d.name}`} onClose={()=>setSel(null)} footer={<div style={{ display:"flex",gap:8 }}><Btn sz="sm" onClick={()=>{doSync(devKey(sel.d));setSel(null);}}>⟳ Sync</Btn><Btn v="secondary" sz="sm">Edit</Btn><Btn v="destructive" sz="sm" onClick={()=>{setConfirm(devKey(sel.d));setSel(null);}}>Remove</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["ID",devKey(sel.d)],["Model",sel.d.model],["Serial",sel.d.serialNo],["Zone",sel.d.zone],["IP",sel.d.ip],["Port",String(sel.d.port||51211)],["Firmware",sel.d.firmware],["Status",sel.d.status?.toUpperCase()],["SSL",sel.d.sslEnabled?"Yes":"No"],["Response",sel.d.responseMs?`${sel.d.responseMs}ms`:"—"],["Enrolled",fNum(sel.d.enrolled)],["Last Sync",fDT(sel.d.lastSync)]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text,fontFamily:["ID","IP","Port","Response"].includes(k)?TH.mono:"inherit" }}>{v||"—"}</div>
            </div>
          ))}
        </div>
      </Modal>}

      {confirm&&<Confirm title="Remove Device" message="This device will be disconnected. Enrolled users remain in the database." onConfirm={()=>doDel(confirm)} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DEVICE SETUP WIZARD
═══════════════════════════════════════════════════════════════════════ */
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
function emptyDeviceWizardForm() {
  return {
    name: "",
    model: "BioStation 3",
    ip: "",
    port: "",
    zone: "",
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

function DeviceSetupPage() {
  const { show } = useToast();
  const { data: zData } = useFetch(() => api.zones(), [], []);
  const [step,    setStep]    = useState(1);
  const [testing, setTesting] = useState(false);
  const [tested,  setTested]  = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [done,    setDone]    = useState(null);
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
  const STEPS = ["1. Network","2. Test","3. Settings","4. Auth","5. Confirm"];

  const runTest = async () => {
    if(!form.ip){ show("Enter IP first","error"); return; }
    setTesting(true); ff("testResult",null);
    try {
      const r = await api.deviceTest({
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

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.deviceConnect({
        name:form.name,model:form.model,ip:form.ip,port:parseInt(form.port)||51211,
        zone:form.zone,ssl:form.ssl,authMode:form.authMode,
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

  return (
    <div style={{ maxWidth:720,margin:"0 auto" }}>
      <PageHeader title="Configure Device" sub="Step-by-step: connect any Suprema terminal to G-SDK"/>

      {/* Step bar */}
      <div style={{ display:"flex",alignItems:"flex-start",marginBottom:28,gap:0 }}>
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

      <Card>
        {/* Step 1 */}
        {step===1&&<div style={{ display:"flex",flexDirection:"column",gap:18 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5,letterSpacing:"-.2px" }}>Network Details</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Device must be powered on and connected to your network.</p></div>
          <GlassCard color={TH.green} style={{ padding:"12px 16px" }}>
            <div style={{ fontSize:12,fontWeight:700,color:TH.green,marginBottom:7 }}>✓ Checklist before you start</div>
            {["PoE+ cable connected (green LED on device)","Ethernet to your switch","Device IP address (check device screen → Settings → Network)","TCP port 51211 open in firewall from this server to device IP"].map((s,i)=>(
              <div key={i} style={{ fontSize:12,color:TH.muted,marginBottom:4,display:"flex",gap:8 }}><span style={{ color:TH.green }}>☐</span>{s}</div>
            ))}
          </GlassCard>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
            <Field label="Device Name" required hint="e.g. Main Entrance A"><Input value={form.name} onChange={e=>ff("name",e.target.value)} placeholder="e.g. Main Entrance A" autoComplete="off"/></Field>
            <Field label="Model"><Sel value={form.model} onChange={e=>ff("model",e.target.value)} options={DM.map(m=>({value:m.model,label:m.model}))}/></Field>
            <Field label="IP Address" required hint="From device: Settings → Network"><Input value={form.ip} onChange={e=>ff("ip",e.target.value)} placeholder="192.168.x.x" autoComplete="off"/></Field>
            <Field label="Port" hint="51211 clear · 51212 SSL (empty = 51211)"><Input value={form.port} onChange={e=>ff("port",e.target.value)} placeholder="51211" autoComplete="off"/></Field>
            <Field label="Zone" hint="Define zones under Locations if missing"><Sel value={form.zone} onChange={e=>ff("zone",e.target.value)} options={zoneOptions}/></Field>
            <Field label="Security"><div style={{ display:"flex",flexDirection:"column",gap:8,marginTop:6 }}>
              {[["true","SSL/TLS Encrypted"],["false","No SSL (testing)"]].map(([v,l])=>(
                <label key={v} style={{ display:"flex",gap:9,alignItems:"center",cursor:"pointer" }}>
                  <input type="radio" name="ssl" value={v} checked={String(form.ssl)===v} onChange={()=>ff("ssl",v==="true")} style={{ accentColor:TH.blue }}/>
                  <span style={{ fontSize:13,color:TH.text }}>{l}</span>
                </label>
              ))}
            </div></Field>
          </div>
          <div style={{ display:"flex",justifyContent:"flex-end" }}><Btn disabled={!form.ip||!form.name||!form.zone} onClick={()=>setStep(2)}>Continue →</Btn></div>
        </div>}

        {/* Step 2 */}
        {step===2&&<div style={{ display:"flex",flexDirection:"column",gap:18 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Test Connection</h3>
          <p style={{ fontSize:13,color:TH.muted }}>Verify connectivity before saving.</p></div>
          <div style={{ padding:16,background:TH.surface,borderRadius:10,border:`1px solid ${TH.border}` }}>
            <div style={{ display:"flex",gap:12,alignItems:"center",marginBottom:14,flexWrap:"wrap" }}>
              <span style={{ fontSize:13,color:TH.muted }}>Target:</span>
              <code style={{ color:TH.blue }}>{form.ip}:{form.port || "51211"}</code>
              <Badge color={form.ssl?"green":"amber"}>{form.ssl?"SSL/TLS":"No SSL"}</Badge>
            </div>
            <Btn onClick={runTest} disabled={testing} icon={testing?<span className="spin">⟳</span>:"🔌"}>{testing?"Testing…":"Test Connection"}</Btn>
          </div>
          {form.testResult&&(form.testResult.ok?(
            <GlassCard color={TH.green}>
              <div style={{ fontSize:14,fontWeight:700,color:TH.green,marginBottom:10 }}>✓ Connected!</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:7 }}>
                {Object.entries(form.testResult).filter(([k])=>k!=="ok").map(([k,v])=>(
                  <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"6px 10px",background:"rgba(0,0,0,.12)",borderRadius:7 }}>
                    <span style={{ fontSize:12,color:TH.muted,textTransform:"capitalize" }}>{k}</span>
                    <span style={{ fontSize:12,fontWeight:600,color:TH.text,fontFamily:TH.mono }}>{String(v)}</span>
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
          <div style={{ display:"flex",justifyContent:"space-between" }}>
            <Btn v="ghost" onClick={()=>setStep(1)}>← Back</Btn>
            <Btn disabled={!tested} onClick={()=>setStep(3)}>Continue →</Btn>
          </div>
        </div>}

        {/* Step 3 */}
        {step===3&&<div style={{ display:"flex",flexDirection:"column",gap:18 }}>
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
        {step===4&&<div style={{ display:"flex",flexDirection:"column",gap:10 }}>
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
        {step===5&&<div style={{ display:"flex",flexDirection:"column",gap:16 }}>
          <div><h3 style={{ fontSize:17,fontWeight:800,color:TH.text,marginBottom:5 }}>Review & Save</h3></div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            {[["Name",form.name],["Model",form.model],["IP",form.ip],["Port",form.port],["Zone",form.zone],["SSL",form.ssl?"Yes":"No"],["Auth Mode",form.authMode],["Liveness",form.liveness?"On":"Off"],["Anti-Passback",form.apb?"On":"Off"],["Door",`${form.doorSec}s`],["Mask",form.mask],["Buffer",form.offlineBuf?"On":"Off"]].map(([k,v])=>(
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

      <Card style={{ marginTop:14 }}>
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
  const [todayOnly, setTodayOnly] = useState(false);
  const [unknownDeniedOnly, setUnknownDeniedOnly] = useState(false);
  const [page,   setPage]   = useState(1);
  const [sel,    setSel]    = useState(null);
  const [live,   setLive]   = useState([]);
  const PER = 20;

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

  const p = { page, limit:PER, ...(filter!=="all"&&{granted:filter==="granted"}), ...(search&&{search}), ...(todayOnly&&{today:1}), ...(unknownDeniedOnly&&{unknownDenied:1}) };
  const { data, loading, reload } = useFetch(()=>api.logs(p), [page,filter,search,todayOnly,unknownDeniedOnly], {logs:[],total:0});
  const { data:stats } = useFetch(()=>api.logStats(), [], null);

  useWS(useCallback(msg=>{
    if(msg.type==="ACCESS_EVENT") setLive(prev=>[msg.data,...prev.slice(0,99)]);
  },[]));
  useEffect(() => {
    const onSynced = () => {
      reload();
      setLive([]);
    };
    window.addEventListener("acs:sync-complete", onSynced);
    return () => window.removeEventListener("acs:sync-complete", onSynced);
  }, [reload]);

  const merged = page===1 ? [...live.slice(0,Math.max(0,PER-(data?.logs?.length||0))), ...(data?.logs||[])] : (data?.logs||[]);
  const logPhoto = l => l?.photo || l?.photoUrl || l?.image || l?.imageUrl || l?.faceImage || l?.facePhoto || l?.snapshot || l?.snapshotUrl || l?.capture || l?.captureUrl || null;
  const isDenied = l => !(l?.accessGranted ?? l?.granted);
  const isUnknownDenied = l => {
    if (!isDenied(l)) return false;
    const id = String(l?.employeeId || "").trim().toUpperCase();
    const nm = String(l?.employeeName || l?.name || "").trim().toUpperCase();
    return id.startsWith("UNKNOWN-") || nm.startsWith("UNKNOWN-") || nm === "UNKNOWN" || !nm;
  };

  const doExport = async fmt => {
    try {
      const res = await api.exportData({format:fmt,filters:{granted:filter!=="all"?filter==="granted":undefined,search,today:todayOnly?1:undefined,unknownDenied:unknownDeniedOnly?1:undefined}});
      await saveDownloadResponse(res, `access-logs-${fmt}`);
      show("Export downloaded","success");
    }
    catch(e){ show(e.message,"error"); }
  };
  const enrollUnknownAsEmployee = async l => {
    try {
      const uid = String(l?.employeeId || l?.employeeName || l?.name || `UNKNOWN-${Date.now().toString(36).toUpperCase()}`).trim();
      const payload = {
        name: l?.employeeName && !String(l.employeeName).toUpperCase().startsWith("UNKNOWN-") ? l.employeeName : `Unknown ${uid.slice(-6)}`,
        employeeId: uid,
        department: "Unassigned",
        email: "",
        phone: "",
        authMode: l?.authMode || "Face Only",
        accessLevel: "L1 General",
        status: "pending",
        enrolled: false,
        photo: logPhoto(l) || undefined,
        photoUrl: logPhoto(l) || undefined,
      };
      await api.empCreate(payload);
      show("Unknown person added as Employee. Continue enrollment from Employees/Enrollment page.","success");
      setSel(null);
      onNav?.("employees");
    } catch (e) {
      show(e.message, "error");
    }
  };
  const enrollUnknownAsVisitor = async l => {
    try {
      const uid = String(l?.employeeId || l?.employeeName || l?.name || `UNKNOWN-${Date.now().toString(36).toUpperCase()}`).trim();
      const payload = {
        name: `Visitor ${uid.slice(-6)}`,
        company: "Unknown",
        email: "",
        phone: "",
        host: "",
        purpose: "Walk-in Denied Attempt",
        scheduledEntry: "",
        photoUrl: logPhoto(l) || "",
        photo: logPhoto(l) || undefined,
        sourceUnknownId: uid,
      };
      await api.visitorCreate(payload);
      show("Unknown person added as Visitor record.","success");
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
        <SearchBar value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Employee, zone, auth mode…" style={{ flex:"1 1 200px" }}/>
        <Sel value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}} style={{ width:150 }} options={[{value:"all",label:"All"},{value:"granted",label:"Granted"},{value:"denied",label:"Denied"}]}/>
        <Btn v={todayOnly?"primary":"ghost"} sz="sm" onClick={()=>{setTodayOnly(v=>!v);setPage(1);}}>{todayOnly?"Today Only: ON":"Today Only"}</Btn>
        <Btn v={unknownDeniedOnly?"danger":"ghost"} sz="sm" onClick={()=>{setUnknownDeniedOnly(v=>!v);setPage(1);}}>
          {unknownDeniedOnly ? `Unknown Denied: ON (${fNum(stats?.unknownDenied||0)})` : `Unknown Denied (${fNum(stats?.unknownDenied||0)})`}
        </Btn>
        {live.length>0&&<div style={{ display:"flex",gap:5,alignItems:"center" }}><div style={{ width:7,height:7,borderRadius:"50%",background:TH.green }} className="pulse-dot"/><span style={{ fontSize:12,color:TH.green,fontWeight:600 }}>Live</span></div>}
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Time","Photo","Employee","Zone","Auth","Result","Conf.","Resp.","Temp"]} onRow={r=>setSel(r.l)}
          rows={merged.map(l=>({ key:l._id||l.id,l, cells:[
            <span style={{ fontSize:11,fontFamily:TH.mono,color:TH.muted }}>{fT(l.timestamp||l.ts)}</span>,
            logPhoto(l)
              ? <img src={logPhoto(l)} alt={l.employeeName||l.name||"photo"} style={{ width:34,height:34,borderRadius:8,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
              : <Avatar name={l.employeeName||l.name||"?"} size={30} color={(l.accessGranted??l.granted)?TH.green:TH.red}/>,
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <Avatar name={l.employeeName||l.name||"?"} size={28} color={(l.accessGranted??l.granted)?TH.green:TH.red}/>
              <div><div style={{ fontWeight:600,fontSize:13 }}>{l.employeeName||l.name||"—"}</div><div style={{ fontSize:10,color:TH.muted }}>{l.department||l.dept||"—"}</div></div>
            </div>,
            <span style={{ fontSize:12 }}>📍 {l.zone||"—"}</span>,
            <Badge color="blue" sm>{l.authMode||"—"}</Badge>,
            (l.accessGranted??l.granted)?<Badge color="green" sm>✓</Badge>:<Badge color="red" sm>✗</Badge>,
            <span style={{ fontSize:12,fontWeight:600,fontFamily:TH.mono,color:!l.confidence?"inherit":l.confidence>=82?TH.green:l.confidence>=60?TH.amber:TH.red }}>{l.confidence?`${l.confidence}%`:"—"}</span>,
            <span style={{ fontSize:12,fontWeight:600,fontFamily:TH.mono,color:!(l.processingMs||l.responseMs)?"inherit":(l.processingMs||l.responseMs)<220?TH.green:(l.processingMs||l.responseMs)<380?TH.amber:TH.red }}>{l.processingMs||l.responseMs?`${l.processingMs||l.responseMs}ms`:"—"}</span>,
            <span style={{ fontSize:12 }}>{l.temperature?`${l.temperature}°C`:"—"}</span>,
          ]}))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>

      {sel&&<Modal title="Event Detail" onClose={()=>setSel(null)} width={560}
        footer={isUnknownDenied(sel)
          ? <div style={{ display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap" }}>
              <Btn v="ghost" onClick={()=>setSel(null)}>Close</Btn>
              <Btn v="secondary" onClick={()=>enrollUnknownAsVisitor(sel)} icon="🪪">Enroll as Visitor</Btn>
              <Btn v="success" onClick={()=>enrollUnknownAsEmployee(sel)} icon="👤">Enroll as Employee</Btn>
            </div>
          : undefined}>
        <div style={{ display:"flex",gap:14,marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${TH.border}` }}>
          {logPhoto(sel)
            ? <img src={logPhoto(sel)} alt={sel.employeeName||sel.name||"photo"} style={{ width:68,height:68,borderRadius:12,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
            : <Avatar name={sel.employeeName||sel.name||"?"} size={68} color={(sel.accessGranted??sel.granted)?TH.green:TH.red}/>}
          <div>
            <div style={{ fontSize:18,fontWeight:800,color:TH.text,marginBottom:8 }}>{sel.employeeName||sel.name||"Unknown"}</div>
            {(sel.accessGranted??sel.granted)?<Badge color="green">✓ Access Granted</Badge>:<Badge color="red">✗ Access Denied</Badge>}
            <div style={{ fontSize:12,color:TH.muted,marginTop:6,fontFamily:TH.mono }}>{fDT(sel.timestamp||sel.ts)}</div>
          </div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["Zone",sel.zone],["Device",sel.deviceName||sel.device],["Auth Mode",sel.authMode],["Direction",sel.direction],["Confidence",sel.confidence?`${sel.confidence}%`:"—"],["Response",sel.processingMs?`${sel.processingMs}ms`:"—"],["Temperature",sel.temperature?`${sel.temperature}°C`:"—"],["Department",sel.department||sel.dept]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
        {isUnknownDenied(sel)&&(
          <div style={{ marginTop:12,padding:"10px 12px",border:`1px solid ${TH.amber}40`,borderRadius:10,background:TH.amberDim,fontSize:12,color:TH.amber }}>
            Unknown denied event detected. You can enroll this person directly as Employee or Visitor using the actions below.
          </div>
        )}
      </Modal>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   EMPLOYEES
═══════════════════════════════════════════════════════════════════════ */
function EmployeesPage({ onNav }) {
  const { show } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page,   setPage]   = useState(1);
  const [sel,    setSel]    = useState(null);
  const [add,    setAdd]    = useState(false);
  const [del,    setDel]    = useState(null);
  const [form,   setForm]   = useState({name:"",employeeId:"",department:"",email:"",phone:"",authMode:"Face Only",accessLevel:"L1 General"});
  const PER = 15;

  const pp = { page, limit:PER, ...(filter!=="all"&&{status:filter}), ...(search&&{search}) };
  const { data, loading, reload } = useFetch(()=>api.employees(pp),[page,filter,search],{employees:[],total:0});
  const emps = data?.employees||[];

  const doAdd = async () => {
    try { await api.empCreate(form); show("Employee created","success"); setAdd(false); reload(); setForm({name:"",employeeId:"",department:"",email:"",phone:"",authMode:"Face Only",accessLevel:"L1 General"}); }
    catch(e){ show(e.message,"error"); }
  };
  const doDel = async id => {
    try { await api.empDelete(id); show("Deleted","success"); setDel(null); setSel(null); reload(); }
    catch(e){ show(e.message,"error"); }
  };

  return (
    <div>
      <PageHeader title="Employees" sub={`${fNum(data?.total||0)} registered`}
        action={<Btn onClick={()=>setAdd(true)} icon="+">Add Employee</Btn>}/>
      <div style={{ display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center" }}>
        <SearchBar value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Name, ID, department…" style={{ flex:"1 1 200px" }}/>
        <Sel value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}} style={{ width:170 }}
          options={[{value:"all",label:"All"},{value:"active",label:"Active"},{value:"enrolled",label:"Enrolled"},{value:"pending",label:"Not Enrolled"},{value:"suspended",label:"Suspended"}]}/>
        <Btn v="ghost" sz="xs" onClick={reload}>⟳</Btn>
      </div>

      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Employee","Department","Auth Mode","Status","Enrolled","Face Score","Last Seen",""]} onRow={r=>setSel(r.e)}
          rows={emps.map(e=>({ key:e._id,e, cells:[
            <div style={{ display:"flex",gap:9,alignItems:"center" }}>
              <Avatar name={e.name} size={32} color={e.enrolled?TH.green:TH.blue}/>
              <div><div style={{ fontWeight:600 }}>{e.name}</div><code style={{ fontSize:10,color:TH.muted }}>{e.employeeId||e._id}</code></div>
            </div>,
            e.department||"—",
            <Badge color="blue" sm>{e.authMode||"—"}</Badge>,
            stBadge(e.status||"active"),
            e.enrolled?<Badge color="green" sm>✓</Badge>:<Badge color="gray" sm>Pending</Badge>,
            e.faceScore?<div style={{ minWidth:70 }}><div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}><span style={{ fontSize:11,fontFamily:TH.mono,fontWeight:700,color:e.faceScore>=90?TH.green:e.faceScore>=75?TH.amber:TH.red }}>{e.faceScore}%</span></div><Progress value={e.faceScore} color={e.faceScore>=90?TH.green:e.faceScore>=75?TH.amber:TH.red} height={3}/></div>:<span style={{ color:TH.faint }}>—</span>,
            <span style={{ fontSize:11,color:TH.muted }}>{fRel(e.lastSeen)}</span>,
            <div style={{ display:"flex",gap:4 }}>
              <Btn v="ghost" sz="xs" onClick={ev=>{ev.stopPropagation();onNav("footprints");}}>👣</Btn>
              <Btn v="ghost" sz="xs" onClick={ev=>{ev.stopPropagation();onNav("enrollment");}}>📷</Btn>
              <Btn v="destructive" sz="xs" onClick={ev=>{ev.stopPropagation();setDel(e._id);}}>✕</Btn>
            </div>
          ]}))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>

      {sel&&<Modal title={sel.name} onClose={()=>setSel(null)} footer={<div style={{ display:"flex",gap:8 }}>
        <Btn sz="sm" onClick={()=>{setSel(null);onNav("enrollment");}}>📷 Enroll</Btn>
        <Btn v="secondary" sz="sm" onClick={()=>{setSel(null);onNav("footprints");}}>👣 Footprints</Btn>
        <Btn v="destructive" sz="sm" onClick={()=>{setDel(sel._id);setSel(null);}}>Delete</Btn>
      </div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9 }}>
          {[["Employee ID",sel.employeeId||sel._id],["Department",sel.department],["Email",sel.email],["Phone",sel.phone],["Access Level",sel.accessLevel],["Auth Mode",sel.authMode],["Face Score",sel.faceScore?`${sel.faceScore}%`:"—"],["Card No.",sel.cardNo],["Status",sel.status],["Enrolled At",fD(sel.enrolledAt)],["Last Seen",fRel(sel.lastSeen)],["Created",fD(sel.createdAt)]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
      </Modal>}

      {add&&<Modal title="Add Employee" onClose={()=>setAdd(false)} footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setAdd(false)}>Cancel</Btn><Btn onClick={doAdd} disabled={!form.name}>Create Employee</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="Full Name" required><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full name"/></Field>
          <Field label="Employee ID" hint="Auto-generated if blank"><Input value={form.employeeId} onChange={e=>setForm(p=>({...p,employeeId:e.target.value}))} placeholder="EMP-00001"/></Field>
          <Field label="Department"><Input value={form.department} onChange={e=>setForm(p=>({...p,department:e.target.value}))} placeholder="Engineering"/></Field>
          <Field label="Email"><Input value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} type="email" placeholder="user@company.com"/></Field>
          <Field label="Phone"><Input value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))} placeholder="+1-555-0000"/></Field>
          <Field label="Auth Mode"><Sel value={form.authMode} onChange={e=>setForm(p=>({...p,authMode:e.target.value}))} options={["Face Only","Face + Card","Face + PIN","Card Only","Card + PIN","Face + Card + PIN"].map(m=>({value:m,label:m}))}/></Field>
          <Field label="Access Level"><Sel value={form.accessLevel} onChange={e=>setForm(p=>({...p,accessLevel:e.target.value}))} options={["L1 General","L2 Restricted","L3 Confidential","L4 Classified"].map(l=>({value:l,label:l}))}/></Field>
        </div>
      </Modal>}

      {del&&<Confirm title="Delete Employee" message="This employee and all enrollment data will be permanently deleted." onConfirm={()=>doDel(del)} onCancel={()=>setDel(null)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FACE ENROLLMENT — Claude Vision AI
═══════════════════════════════════════════════════════════════════════ */
function EnrollmentPage() {
  const { show } = useToast();
  const [step,   setStep]   = useState("select");
  const [emp,    setEmp]    = useState(null);
  const [photo,  setPhoto]  = useState(null);
  const [busy,   setBusy]   = useState(false);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const fileRef = useRef(null);

  const { data, loading } = useFetch(()=>api.employees({limit:48,search}),[search],{employees:[]});
  const emps = data?.employees||[];

  const analyze = async () => {
    if (!photo||!emp) return;
    setBusy(true); setResult(null);
    try {
      const base64 = photo.split(",")[1];
      const r = await api.analyzePhoto({ base64, employeeId:emp._id, employeeName:emp.name });
      setResult(r);
    } catch(e){ show(e.message,"error"); }
    finally { setBusy(false); }
  };

  const doEnroll = async () => {
    setSaving(true);
    try {
      await api.enroll({ employeeId:emp._id, photoBase64:photo.split(",")[1], analysisResult:result });
      show(`${emp.name} enrolled!`,"success");
      setStep("select"); setEmp(null); setPhoto(null); setResult(null);
    } catch(e){ show(e.message,"error"); }
    finally { setSaving(false); }
  };

  const onFile = e => {
    const f=e.target.files?.[0]; if(!f)return;
    e.target.value="";
    const r=new FileReader();
    r.onload=ev=>{ setPhoto(ev.target.result); setResult(null); };
    r.readAsDataURL(f);
  };

  const VC = {APPROVE:TH.green,CONDITIONAL:TH.amber,REJECT:TH.red,FRAUD:TH.red};

  if (step==="select") return (
    <div>
      <PageHeader title="Face Enrollment" sub="Claude Vision AI analyzes photos and detects fakes automatically"/>
      <Card>
        <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:12 }}>Select Employee to Enroll</div>
        <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search employee…" style={{ marginBottom:16 }}/>
        {loading?<Loader/>:emps.length===0?<Empty icon="👥" text="No employees found" sub="Add employees first"/>:(
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10 }}>
            {emps.map(e=>(
              <div key={e._id} onClick={()=>{setEmp(e);setPhoto(null);setResult(null);setStep("upload");}}
                style={{ display:"flex",gap:10,alignItems:"center",padding:"11px 14px",background:TH.surface,borderRadius:10,border:`1px solid ${TH.border}`,cursor:"pointer",transition:"all .14s" }}
                onMouseEnter={el=>{ el.currentTarget.style.borderColor=TH.blue; el.currentTarget.style.background=TH.hover; }}
                onMouseLeave={el=>{ el.currentTarget.style.borderColor=TH.border; el.currentTarget.style.background=TH.surface; }}>
                <Avatar name={e.name} size={42} color={e.enrolled?TH.green:TH.blue}/>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:13,fontWeight:600,color:TH.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.name}</div>
                  <div style={{ fontSize:11,color:TH.muted }}>{e.department||"—"}</div>
                  {e.enrolled?<Badge color="green" sm>Enrolled</Badge>:<Badge color="gray" sm>Pending</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );

  return (
    <div>
      <PageHeader title="Face Enrollment" sub={`Enrolling: ${emp?.name}`}
        back="Employee List" onBack={()=>{setStep("select");setEmp(null);setPhoto(null);setResult(null);}}/>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
        {/* Upload */}
        <Card>
          <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:18,paddingBottom:14,borderBottom:`1px solid ${TH.border}` }}>
            <Avatar name={emp?.name} size={42} color={TH.blue}/>
            <div><div style={{ fontWeight:700,color:TH.text }}>{emp?.name}</div><div style={{ fontSize:12,color:TH.muted }}>{emp?.department} · {emp?.employeeId||emp?._id}</div></div>
          </div>

          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display:"none" }}/>
          <div onClick={()=>!busy&&fileRef.current?.click()}
            style={{ padding:"28px 16px",background:TH.surface,border:`2px dashed ${photo?TH.blue:TH.border}`,borderRadius:12,textAlign:"center",cursor:busy?"default":"pointer",marginBottom:14,transition:"all .15s" }}
            onMouseEnter={e=>{ if(!busy)e.currentTarget.style.borderColor=TH.blue; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=photo?TH.blue:TH.border; }}>
            {busy?(
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:10 }}>
                <div style={{ width:40,height:40,border:`3px solid ${TH.border}`,borderTop:`3px solid ${TH.blue}`,borderRadius:"50%" }} className="spin"/>
                <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>Claude Vision Analyzing…</div>
                <div style={{ fontSize:12,color:TH.muted }}>Checking: real human · liveness · quality · anti-spoof · depth</div>
              </div>
            ):photo?(
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:8 }}>
                <img src={photo} style={{ width:120,height:140,objectFit:"cover",borderRadius:10,border:`2px solid ${TH.blue}`,boxShadow:`0 4px 20px ${TH.blueGlow}` }}/>
                <div style={{ fontSize:12,color:TH.muted }}>Click to change</div>
              </div>
            ):(
              <>
                <div style={{ fontSize:40,marginBottom:10,opacity:.15 }}>📷</div>
                <div style={{ fontSize:15,fontWeight:700,color:TH.text }}>Upload Employee Photo</div>
                <div style={{ fontSize:12,color:TH.muted,marginTop:5 }}>ID · Passport · Selfie · Any clear photo</div>
                <div style={{ fontSize:12,color:TH.blue,marginTop:8,fontWeight:600 }}>Claude Vision checks 12 biometric parameters</div>
              </>
            )}
          </div>

          {photo&&!busy&&<Btn full onClick={analyze} icon="🤖" loading={busy}>Analyze with Claude Vision</Btn>}

          <Card style={{ marginTop:12,padding:12,background:TH.surface }}>
            <div style={{ fontSize:12,fontWeight:700,color:TH.amber,marginBottom:7 }}>💡 Best results</div>
            {["Plain background","Even front lighting","Both eyes visible","No sunglasses","Neutral expression","Recent — within 12 months"].map(s=>(
              <div key={s} style={{ fontSize:11,color:TH.muted,marginBottom:4,display:"flex",gap:7 }}><span style={{ color:TH.green }}>✓</span>{s}</div>
            ))}
          </Card>
        </Card>

        {/* Analysis result */}
        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>AI Analysis Result</div>
          {!result&&!busy&&<Empty icon="🤖" text="Upload and analyze a photo" sub="Claude Vision checks 12 parameters including liveness, depth, and anti-spoofing"/>}
          {result&&(
            <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
              {/* Verdict */}
              <GlassCard color={VC[result.verdict]||TH.muted} style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:16,fontWeight:800,color:VC[result.verdict]||TH.muted,marginBottom:5,letterSpacing:"-.2px" }}>
                  {result.verdict==="APPROVE"?"✓ APPROVED — Ready to enroll":result.verdict==="CONDITIONAL"?"⚠ CONDITIONAL — Enroll with caution":result.verdict==="FRAUD"?"🚨 FRAUD — Fake photo detected":"✗ REJECTED — Quality too low"}
                </div>
                <div style={{ fontSize:13,color:TH.muted,lineHeight:1.65 }}>{result.recommendation||result.message}</div>
              </GlassCard>

              {/* Score bars */}
              {["qualityScore","livenessScore","depthScore"].filter(k=>result[k]!=null).map(k=>(
                <Progress key={k} value={result[k]} color={result[k]>=85?TH.green:result[k]>=65?TH.amber:TH.red}
                  label={k==="qualityScore"?"Quality Score":k==="livenessScore"?"Liveness Score":"Depth Score"}/>
              ))}

              {/* Check grid */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                {[
                  ["Real Human",    result.isRealHuman,       result.isRealHuman?"Confirmed":"Failed"],
                  ["Anti-Spoof",    !result.isFakeDetected,   !result.isFakeDetected?"Clean":result.fakeType||"FAKE"],
                  ["Liveness",      result.livenessScore>=70, result.livenessScore?`${result.livenessScore}%`:"—"],
                  ["Face Angle",    result.angleAcceptable,   result.faceAngle||"—"],
                  ["Lighting",      result.lighting==="good", result.lighting||"—"],
                  ["Sharpness",     result.blur!=="blurry",   result.blur||"—"],
                  ["Eyes",          result.eyesVisible,       result.eyesVisible?"Visible":"Hidden"],
                  ["Face Centered", result.faceCentered,      result.faceCentered?"Yes":"Off-center"],
                ].map(([k,ok,v])=>(
                  <div key={k} style={{ padding:"9px 11px",background:TH.surface,borderRadius:9,border:`1px solid ${ok?TH.green+"30":TH.redDim}` }}>
                    <div style={{ fontSize:10,color:TH.muted,marginBottom:3,textTransform:"uppercase",letterSpacing:".4px" }}>{k}</div>
                    <div style={{ fontSize:13,fontWeight:700,color:ok?TH.green:TH.red }}>{v}</div>
                  </div>
                ))}
              </div>

              {(result.verdict==="APPROVE"||result.verdict==="CONDITIONAL")
                ? <Btn v="success" full loading={saving} onClick={doEnroll} icon="✅">Confirm & Enroll to All Devices</Btn>
                : <Btn v="ghost" full onClick={()=>{setPhoto(null);setResult(null);}}>↺ Upload Different Photo</Btn>
              }
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
  const [type,    setType]    = useState("employee");
  const [search,  setSearch]  = useState("");
  const [selId,   setSelId]   = useState(null);
  const [selName, setSelName] = useState("");
  const [view,    setView]    = useState("timeline");

  const { data:eData, loading:eLoad } = useFetch(()=>api.employees({limit:60,search,status:"active"}),[search],{employees:[]});
  const { data:vData, loading:vLoad } = useFetch(()=>api.visitors({limit:60,search}),[search],{visitors:[]});
  const list = (type==="employee"?eData?.employees:vData?.visitors)||[];
  const listLoad = type==="employee"?eLoad:vLoad;

  const { data:fp, loading:fpLoad } = useFetch(()=>{
    if(!selId) return Promise.resolve(null);
    return type==="employee"?api.empFootprint(selId):api.visitorFootprint(selId);
  },[selId,type],null);

  const trail    = fp?.trail     ||[];
  const zones    = fp?.zones     ||[];
  const hourDist = fp?.hourlyDist||[];
  const stats    = fp?.stats     ||{};

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
                <Avatar name={nm} size={34} color={on?TH.blue:TH.muted}/>
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
                <Avatar name={selName} size={46} color={TH.blue}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:17,fontWeight:800,color:TH.text,letterSpacing:"-.3px" }}>{selName}</div>
                  <div style={{ fontSize:12,color:TH.muted }}>{fNum(stats.total||trail.length)} events · {stats.granted||0} granted · {stats.denied||0} denied{zones[0]?` · Most visited: ${zones[0].zone}`:""}</div>
                </div>
                <div style={{ display:"flex",gap:0,border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
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
                    <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Access by Hour of Day</div>
                    {hourDist.length===0?<Empty icon="🕐" text="No hourly data"/>:(
                      <div style={{ height:280 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={hourDist} margin={{top:4,right:4,left:-20,bottom:0}} barSize={18}>
                            <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                            <XAxis dataKey="hour" tick={{fill:TH.muted,fontSize:10}} interval={3}/>
                            <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                            <Tooltip contentStyle={TT_STYLE}/>
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
function VisitorsPage() {
  const { show } = useToast();
  const [filter, setFilter] = useState("all");
  const [page,   setPage]   = useState(1);
  const [add,    setAdd]    = useState(false);
  const [search, setSearch] = useState("");
  const [sel,    setSel]    = useState(null);
  const [fp,     setFp]     = useState([]);
  const [fpLoading, setFpLoading] = useState(false);
  const [form,   setForm]   = useState({name:"",company:"",email:"",phone:"",host:"",purpose:"Meeting",scheduledEntry:"",photoUrl:""});
  const PER = 15;

  const pp = { page, limit:PER, ...(filter!=="all"&&{status:filter}) };
  const { data, loading, reload } = useFetch(()=>api.visitors(pp),[page,filter],{visitors:[],total:0});
  const { data:eData } = useFetch(()=>api.employees({limit:60}),[],{employees:[]});
  const normVs = s => ({ checked_in:"checked-in", checked_out:"checked-out", pending:"expected", checkedin:"checked-in", checkedout:"checked-out" }[String(s||"").toLowerCase()] || s || "expected");
  const visitors = (data?.visitors||[]).map(v=>({ ...v, status:normVs(v.status) }));
  const visitorPhoto = v => v?.photo || v?.photoUrl || v?.image || v?.imageUrl || null;
  const shown = visitors.filter(v => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [v.name, v.company, v.host, v.purpose, v.email, v.phone].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
  const emps     = eData?.employees||[];

  const checkin  = async id=>{ try{await api.visitorCheckin(id);show("Checked in","success");reload();}catch(e){show(e.message,"error");} };
  const checkout = async id=>{ try{await api.visitorCheckout(id);show("Checked out","success");reload();}catch(e){show(e.message,"error");} };
  const doAdd    = async()=>{
    try{
      const created = await api.visitorCreate(form);
      const mailMsg = created?.email?.emailSent
        ? " QR generated and email sent."
        : " QR generated. Configure SMTP to send email automatically.";
      show(`Visitor registered.${mailMsg}`,"success");
      setAdd(false);
      reload();
    }catch(e){show(e.message,"error");}
  };
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

  return (
    <div>
      <PageHeader title="Visitors" sub={`${fNum(data?.total||0)} visitors`}
        action={<Btn onClick={()=>setAdd(true)} icon="+">Register Visitor</Btn>}/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="🕐" label="Expected"    value={visitors.filter(v=>v.status==="expected").length}    color={TH.blue}/>
        <StatCard icon="✅" label="Checked In"  value={visitors.filter(v=>v.status==="checked-in").length}  color={TH.green}/>
        <StatCard icon="🚶" label="Checked Out" value={visitors.filter(v=>v.status==="checked-out").length} color={TH.muted}/>
        <StatCard icon="👥" label="Total Today" value={data?.total||0}                                       color={TH.violet}/>
      </div>
      <div style={{ display:"flex",gap:8,marginBottom:16,flexWrap:"wrap" }}>
        <SearchBar value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search visitor…" style={{ width:220 }}/>
        <div style={{ display:"flex",border:`1px solid ${TH.border}`,borderRadius:9,overflow:"hidden" }}>
          {[["all","All"],["expected","Expected"],["checked-in","In"],["checked-out","Out"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setFilter(v);setPage(1);}} style={{ padding:"7px 13px",fontSize:12,fontWeight:600,background:filter===v?TH.blue:"transparent",color:filter===v?"#fff":TH.muted,border:"none",cursor:"pointer" }}>{l}</button>
          ))}
        </div>
        <Btn v="ghost" sz="xs" onClick={reload}>⟳</Btn>
      </div>
      <Card pad={0} style={{ overflow:"hidden" }}>
        <Table loading={loading} headers={["Photo","Visitor","Company","Host","Purpose","Status","Scheduled","Actions"]}
          onRow={r=>openFp(r.v)}
          rows={shown.map(v=>({ key:v._id, v, cells:[
            visitorPhoto(v)
              ? <img src={visitorPhoto(v)} alt={v.name||"visitor"} style={{ width:34,height:34,borderRadius:8,objectFit:"cover",border:`1px solid ${TH.border}` }}/>
              : <Avatar name={v.name||"?"} size={30} color={TH.blue}/>,
            <div style={{ fontWeight:600 }}>{v.name}</div>,
            v.company||"—", v.host||"—", v.purpose||"—",
            stBadge(v.status),
            <span style={{ fontSize:12,fontFamily:TH.mono }}>{v.scheduledEntry?fDT(v.scheduledEntry):"—"}</span>,
            <div style={{ display:"flex",gap:5 }}>
              {v.status==="expected"&&<Btn v="success" sz="xs" onClick={e=>{e.stopPropagation();checkin(v._id);}}>Check In</Btn>}
              {v.status==="checked-in"&&<Btn v="ghost" sz="xs" onClick={e=>{e.stopPropagation();checkout(v._id);}}>Check Out</Btn>}
            </div>
          ]}))}/>
        <Pagination page={page} total={data?.total||0} per={PER} onChange={setPage}/>
      </Card>
      {sel&&<Modal title={`Visitor Footprint — ${sel.name||"Visitor"}`} onClose={()=>setSel(null)} width={640}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:14 }}>
          {[["Company",sel.company],["Host",sel.host],["Purpose",sel.purpose],["Status",sel.status],["Email",sel.email],["Phone",sel.phone]].map(([k,v])=>(
            <div key={k} style={{ padding:"9px 12px",background:TH.surface,borderRadius:9,border:`1px solid ${TH.border}` }}>
              <div style={{ fontSize:11,color:TH.muted,marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13,fontWeight:600,color:TH.text }}>{v||"—"}</div>
            </div>
          ))}
        </div>
        {fpLoading ? <Loader text="Loading footprint..."/> : fp.length===0 ? (
          <Empty icon="👣" text="No footprint records yet" sub="Entries will appear after visitor movements are recorded"/>
        ) : (
          <Card pad={0} style={{ overflow:"hidden" }}>
            <Table headers={["Time","Zone","Device","Direction","Event"]}
              rows={fp.map((x,i)=>({ key:x._id||i, cells:[
                <span style={{ fontSize:12,fontFamily:TH.mono }}>{fDT(x.timestamp||x.ts||x.createdAt)}</span>,
                x.zone||"—",
                x.device||x.deviceName||"—",
                x.direction||"—",
                x.event||x.type||"Movement"
              ]}))}/>
          </Card>
        )}
      </Modal>}
      {add&&<Modal title="Register Visitor" onClose={()=>setAdd(false)} footer={<div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}><Btn v="ghost" onClick={()=>setAdd(false)}>Cancel</Btn><Btn onClick={doAdd} disabled={!form.name}>Register</Btn></div>}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 }}>
          <Field label="Full Name" required><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full name"/></Field>
          <Field label="Company"><Input value={form.company} onChange={e=>setForm(p=>({...p,company:e.target.value}))} placeholder="Company"/></Field>
          <Field label="Email"><Input value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} type="email" placeholder="email@company.com"/></Field>
          <Field label="Phone"><Input value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))} placeholder="+1-555-0000"/></Field>
          <Field label="Photo URL"><Input value={form.photoUrl} onChange={e=>setForm(p=>({...p,photoUrl:e.target.value}))} placeholder="https://.../visitor-photo.jpg"/></Field>
          <Field label="Host Employee"><Sel value={form.host} onChange={e=>setForm(p=>({...p,host:e.target.value}))} options={[{value:"",label:"Select host…"},...emps.map(e=>({value:e.name,label:e.name}))]}/></Field>
          <Field label="Purpose"><Sel value={form.purpose} onChange={e=>setForm(p=>({...p,purpose:e.target.value}))} options={["Meeting","Interview","Delivery","Maintenance","Audit","Demo","Inspection"].map(x=>({value:x,label:x}))}/></Field>
          <Field label="Scheduled Entry" hint="Date and time"><Input value={form.scheduledEntry} onChange={e=>setForm(p=>({...p,scheduledEntry:e.target.value}))} type="datetime-local"/></Field>
        </div>
      </Modal>}
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

  const ack     = async id=>{ try{await api.alertAck(id);show("Acknowledged","success");reload();}catch(e){show(e.message,"error");} };
  const resolve = async id=>{ try{await api.alertResolve(id);show("Resolved","success");reload();}catch(e){show(e.message,"error");} };

  const shown = filter==="all"?alerts:alerts.filter(a=>a.status===filter);
  const sColor= s=>({critical:TH.red,high:TH.amber,medium:TH.blue,low:TH.muted})[s]||TH.muted;

  return (
    <div>
      <PageHeader title="Security Alerts" action={<Btn v="ghost" sz="sm" onClick={reload}>⟳ Refresh</Btn>}/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20 }}>
        <StatCard icon="🚨" label="Critical" value={alerts.filter(a=>a.severity==="critical"&&a.status!=="resolved").length} color={TH.red}/>
        <StatCard icon="⚠"  label="High"    value={alerts.filter(a=>a.severity==="high"&&a.status!=="resolved").length}     color={TH.amber}/>
        <StatCard icon="🔓" label="Open"    value={alerts.filter(a=>a.status==="open").length}                               color={TH.blue}/>
        <StatCard icon="✅" label="Resolved"value={alerts.filter(a=>a.status==="resolved").length}                          color={TH.green}/>
      </div>
      <Tabs active={filter} onChange={setFilter} items={[{id:"all",label:"All",count:alerts.length},{id:"open",label:"Open",count:alerts.filter(a=>a.status==="open").length},{id:"reviewing",label:"Reviewing",count:alerts.filter(a=>a.status==="reviewing").length},{id:"resolved",label:"Resolved",count:alerts.filter(a=>a.status==="resolved").length}]}/>
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
                    {a.status==="open"&&<Btn v="amber" sz="xs" onClick={()=>ack(a._id||a.id)}>Ack</Btn>}
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
    try{await api.deviceSync(id);show("Sync done","success");reload();}
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
                        <div style={{ width:46,height:46,borderRadius:11,background:`${tc(tier)}16`,border:`1px solid ${tc(tier)}25`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0 }}>{m.icon}</div>
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
  const [cols,     setCols]     = useState(["timestamp","employeeName","zone","authMode","accessGranted","confidence","processingMs","temperature"]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [filter,   setFilter]   = useState("all");
  const [zone,     setZone]     = useState("all");
  const [exporting,setEx]       = useState(null);
  const ALL_COLS = ["timestamp","employeeName","employeeId","department","zone","building","device","authMode","accessGranted","confidence","processingMs","temperature","direction","date"];

  const doExport = async fmt => {
    if (!cols.length) { show("Select at least one column","warning"); return; }
    setEx(fmt);
    try {
      const res = await api.exportData({ format:fmt, columns:cols, filters:{ dateFrom, dateTo, granted:filter!=="all"?filter==="granted":undefined, zone:zone!=="all"?zone:undefined } });
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
              <Field label="From Date"><Input value={dateFrom} onChange={e=>setDateFrom(e.target.value)} type="date"/></Field>
              <Field label="To Date"><Input value={dateTo} onChange={e=>setDateTo(e.target.value)} type="date"/></Field>
              <Field label="Access Result">
                <Sel value={filter} onChange={e=>setFilter(e.target.value)} options={[{value:"all",label:"All"},{value:"granted",label:"Granted Only"},{value:"denied",label:"Denied Only"}]}/>
              </Field>
              <Field label="Zone">
                <Sel value={zone} onChange={e=>setZone(e.target.value)} options={[{value:"all",label:"All Zones"},...ZONES_LIST.map(z=>({value:z,label:z}))]}/>
              </Field>
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
                <div style={{ width:44, height:44, borderRadius:10, background:`${f.color}18`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>{f.icon}</div>
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
function ThreatIntelPage() {
  const [tab, setTab] = useState("overview");
  const { data, loading } = useFetch(()=>api.reportSecurity(),[],null);
  const riskScore = data?.riskScore||0;
  const riskColor = riskScore>=70?TH.red:riskScore>=40?TH.amber:TH.green;
  const threats   = data?.threats||[];
  const riskTrend = data?.riskTrend||[];

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
                      <Btn v="ghost" sz="xs">Investigate</Btn>
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
            <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Risk Score — Last 14 Days</div>
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
                  <Tooltip contentStyle={TT_STYLE}/>
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
                <div style={{ width:40,height:40,borderRadius:10,background:TH.blueDim,border:`1px solid ${TH.blue}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0 }}>{d.icon}</div>
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
      <PageHeader title="ARIA AI Assistant" sub="Ollama-powered intelligence — live access to your ACS data"/>

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
  const { data:anomalies,  loading:aLoad }          = useFetch(()=>api.aiAnomalyReport(),[],null);
  const { data:predictive, loading:pLoad }          = useFetch(()=>api.aiPredictive(),[],null);

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
function ReportsPage() {
  const [tab, setTab] = useState("overview");
  const { data:daily,    loading:dLoad } = useFetch(()=>api.reportDaily(),    [], null);
  const { data:security, loading:sLoad } = useFetch(()=>api.reportSecurity(), [], null);
  const { data:attend }                  = useFetch(()=>api.reportAttendance(),[], null);

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
                  <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Daily Trend — Last 14 Days</div>
                  <div style={{ height:210 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={daily.dailyTrend} margin={{top:4,right:4,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                        <XAxis dataKey="date" tick={{fill:TH.muted,fontSize:10}}/>
                        <YAxis tick={{fill:TH.muted,fontSize:10}}/>
                        <Tooltip contentStyle={TT_STYLE}/>
                        <Line type="monotone" dataKey="granted" name="Granted" stroke={TH.green} strokeWidth={2} dot={false}/>
                        <Line type="monotone" dataKey="denied"  name="Denied"  stroke={TH.red}   strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
                {daily?.byZone?.length>0&&(
                  <Card>
                    <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Top Zones</div>
                    <div style={{ height:210 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={daily.byZone.slice(0,7)} layout="vertical" margin={{top:0,right:8,left:0,bottom:0}}>
                          <CartesianGrid strokeDasharray="3 5" stroke={TH.grid}/>
                          <XAxis type="number" tick={{fill:TH.muted,fontSize:10}}/>
                          <YAxis type="category" dataKey="zone" tick={{fill:TH.muted,fontSize:10}} width={84}/>
                          <Tooltip contentStyle={TT_STYLE}/>
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
        !attend?<Empty icon="📅" text="No attendance data"/>:(
          <Card pad={0} style={{ overflow:"hidden" }}>
            <div style={{ padding:"12px 16px",borderBottom:`1px solid ${TH.border}`,fontSize:14,fontWeight:700,color:TH.text }}>Attendance by Department</div>
            <Table headers={["Department","Employees","Avg Daily","On-Time Rate"]}
              rows={(attend.departments||[]).map(d=>({ cells:[
                d.name, fNum(d.employeeCount),
                <span style={{ fontFamily:TH.mono }}>{d.avgDailyAccess||0}/day</span>,
                <div style={{ minWidth:90 }}><Progress value={d.onTimeRate||0} color={d.onTimeRate>=90?TH.green:d.onTimeRate>=75?TH.amber:TH.red} height={4} label={`${d.onTimeRate||0}%`}/></div>
              ]}))}/>
          </Card>
        )
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
  const zoneDevices = z => devices.filter(d => {
    const zoneName = String(d.zone || d.zoneName || "").trim().toLowerCase();
    const zoneId = String(d.zoneId || d.zone_id || "").trim();
    return zoneName === String(z?.name || "").trim().toLowerCase() || idEq(zoneId, z?._id);
  });

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
                    {[["Floors",b.floors||"—"],["Zones",bz.length],["Devices",bz.reduce((s,z)=>s+(z.devices||0),0)]].map(([k,v])=>(
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
                      <span style={{ fontSize:12,fontFamily:TH.mono }}>{z.devices||0}</span>,
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
                <Table headers={["Device","Model","IP","Status","Enrolled"]}
                  rows={zoneDevices(selZone).map(d=>({ key:d._id||d.deviceId||d.id||d.ip||d.name, cells:[
                    <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                      <span style={{ fontSize:14 }}>◫</span>
                      <div>
                        <div style={{ fontWeight:600 }}>{d.name||"Unnamed Device"}</div>
                        <code style={{ fontSize:10,color:TH.muted }}>{d._id||d.deviceId||d.id||"—"}</code>
                      </div>
                    </div>,
                    d.model||"—",
                    <code style={{ fontSize:12 }}>{d.ip||"—"}:{d.port||51211}</code>,
                    stBadge(d.status||"offline"),
                    <span style={{ fontSize:12,fontFamily:TH.mono }}>{fNum(d.enrolled||0)}</span>
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
function SettingsPage({ user, onNav }) {
  const { show } = useToast();
  const { data:health } = useFetch(()=>api.health(),[],null);
  const { data:smtp, reload:reloadSmtp } = useFetch(()=>api.smtpSettings(),[],null);
  const [smtpOpen, setSmtpOpen] = useState(false);
  const [smtpForm, setSmtpForm] = useState({ host:"", port:587, user:"", pass:"", from:"" });
  const qLen = () => { try { return JSON.parse(localStorage.getItem(QK)||"[]").length; } catch { return 0; } };
  const mongoHost = (health?.config?.mongodbUri || "").replace(/^mongodb:\/\//, "").split("/")[0] || "localhost:27017";
  const ollamaHost = (health?.config?.ollamaHost || "").replace(/^https?:\/\//, "") || "localhost:11434";
  const gsdkUp = health?.services?.gsdk === "up";
  const mongoUp = health?.services?.mongodb === "up";
  const ollamaUp = health?.services?.ollama === "up";
  const smtpConfigured = Boolean(smtp?.configured);

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

  return (
    <div>
      <PageHeader title="Settings" sub="System configuration and service connections"/>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16 }}>
        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>G-SDK Gateway</div>
          <KV label="Host"      value={health?.config?.gsdkGateway||"Not set"} mono/>
          <KV label="Port"      value={health?.config?.gsdkDevicePort||"51211"} mono/>
          <KV label="Mode"      value={health?.config?.gsdkUseSsl?"SSL":"Insecure"} color={health?.config?.gsdkUseSsl?TH.amber:TH.green}/>
          <KV label="Version"   value="1.7.2" mono/>
          <KV label="Status"    value={gsdkUp?"Connected":"Disconnected"} color={gsdkUp?TH.green:TH.red}/>
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>MongoDB</div>
          <KV label="Host"      value={mongoHost} mono/>
          <KV label="Database"  value="expo-fr" mono/>
          <KV label="Status"    value={mongoUp?"Connected":"Disconnected"} color={mongoUp?TH.green:TH.red}/>
          <KV label="Employees" value={fNum(health?.counts?.employees ?? 0)} mono/>
          <KV label="Visitors" value={fNum(health?.counts?.visitors ?? 0)} mono/>
          <KV label="Log Records" value={fNum(health?.counts?.logs ?? 0)} mono/>
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Ollama / ARIA AI</div>
          <KV label="Host"          value={ollamaHost} mono/>
          <KV label="Active Model"  value={health?.ollama?.model||"llama3.2"} mono/>
          <KV label="Status"        value={ollamaUp?"Online":"Offline"} color={ollamaUp?TH.green:TH.red}/>
          <KV label="Claude Vision" value="Active (Enrollment AI)" color={TH.green}/>
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>Offline Sync</div>
          <KV label="Queue Size"     value={`${qLen()} actions`} mono/>
          <KV label="Auto-Sync"      value="On reconnect" color={TH.green}/>
          <KV label="Device Buffer"  value="Auto-recover" color={TH.green}/>
          <KV label="WebSocket"      value="Auto-reconnect 3s" color={TH.blue}/>
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>API process</div>
          <KV label="Hostname" value={health?.serverRuntime?.hostname ?? "—"} mono/>
          <KV label="Platform" value={health?.serverRuntime?.platform ?? "—"} mono/>
          <KV label="Node.js" value={health?.serverRuntime?.nodeVersion ?? "—"} mono/>
          <KV label="Uptime" value={health?.serverRuntime?.uptimeSec != null ? formatProcUptime(health.serverRuntime.uptimeSec) : "—"} mono/>
          <KV label="Memory (used/total)" value={health?.serverRuntime?.memory ?? "—"} mono/>
        </Card>

        <Card>
          <div style={{ fontSize:14,fontWeight:700,color:TH.text,marginBottom:14 }}>RBAC Permissions</div>
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
            <div style={{ fontSize:14,fontWeight:700,color:TH.text }}>SMTP / Email</div>
            <Btn sz="xs" onClick={()=>setSmtpOpen(true)}>{smtpConfigured ? "Edit" : "Setup"}</Btn>
          </div>
          <KV label="Status" value={smtpConfigured ? "Configured" : "Not configured"} color={smtpConfigured ? TH.green : TH.amber}/>
          <KV label="Host" value={smtp?.host || "Not set"} mono/>
          <KV label="Port" value={smtp?.port || 587} mono/>
          <KV label="User" value={smtp?.user || "Not set"} mono/>
          <KV label="From" value={smtp?.from || "Not set"} mono/>
        </Card>
      </div>

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
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════════ */
export default function App() {
  useEffect(() => {
    document.title = "ExpoCity Dubai";
    document
      .querySelectorAll("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")
      .forEach((el) => el.remove());
  }, []);

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
  const [navOpen,  setNavOpen]  = useState(true);
  const [syncMsg,  setSyncMsg]  = useState(null);
  const [alertCount, setAlertCount] = useState(0);
  const mainRef = useRef(null);

  // Verify token with server on mount (same behavior as frontend/src/App.jsx)
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
          setUser(null);
          return;
        } catch {
          /* transient — do not clearToken */
        }
      }
      if (!cancelled && getToken()) {
        console.warn("[session] /auth/me failed after retries; keeping session.");
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

  useEffect(() => {
    if (!user) return;
    if (!allowedPage(user, page)) {
      setPage("dashboard");
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

  // Alert badge count
  useEffect(() => {
    if (!user) return;
    const load = () => api.alerts().then(r=>setAlertCount((r||[]).filter(a=>a.status==="open").length)).catch(()=>{});
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [user]);

  // Live event alert bump via WS
  useWS(useCallback(msg => {
    if (msg.type==="NEW_ALERT") setAlertCount(n=>n+1);
  }, []));

  // Navigate helper with RBAC
  const nav = useCallback(p => {
    if (can(user?.role, p) || user?.role==="superadmin") setPage(p);
  }, [user]);

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
    employees:   <EmployeesPage    onNav={nav}/>,
    enrollment:  <EnrollmentPage/>,
    visitors:    <VisitorsPage/>,
    footprints:  <FootprintsPage/>,
    alerts:      <AlertsPage/>,
    threats:     <ThreatIntelPage/>,
    sync:        <SyncPage/>,
    reports:     <ReportsPage/>,
    export:      <ExportPage/>,
    locations:   <LocationsPage/>,
    superadmin:  <SuperAdminPage/>,
    settings:    <SettingsPage user={user} onNav={nav}/>,
    ai:          <AIPage/>,
    ai_insights: <AIInsightsPage/>,
  };

  return (
    <ToastProvider>
      <style>{GCSS}</style>
      {!user ? (
        <LoginPage onLogin={u=>{
          const fromHash = parseHashPage() || "dashboard";
          const next = allowedPage(u, fromHash) ? fromHash : "dashboard";
          setUser(u);
          setPage(next);
          window.history.replaceState(null, "", hashForPage(next));
        }}/>
      ) : (
        <div style={{ display:"flex", height:"100vh", overflow:"hidden", background:TH.bg }}>
          <Sidebar page={page} onNav={nav} user={user} open={navOpen} onToggle={()=>setNavOpen(o=>!o)} alertCount={alertCount}/>
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
            <TopBar page={page} user={user} onLogout={()=>{
              setUser(null);
              setPage("dashboard");
              try {
                const u = new URL(window.location.href);
                u.hash = "";
                window.history.replaceState(null, "", u.pathname + u.search);
              } catch {
                window.history.replaceState(null, "", window.location.pathname + window.location.search);
              }
            }} online={online} onNav={nav}/>
            <OfflineBanner online={online} syncMsg={syncMsg}/>
            <main ref={mainRef} style={{ flex:1, overflowY:"auto", padding:22, background:TH.bg, backgroundImage:"radial-gradient(900px 420px at 85% -20%, rgba(77,138,240,.14), transparent 62%), radial-gradient(760px 360px at -20% 0%, rgba(0,212,255,.08), transparent 60%), repeating-linear-gradient(135deg, rgba(255,255,255,.02) 0 1px, transparent 1px 7px)" }}>
              <div className="fade-page" key={page}>
                {can(user.role, page) || user.role==="superadmin" || page==="dashboard"
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
  );
}
