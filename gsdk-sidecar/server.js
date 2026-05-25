import express from "express";
import path from "node:path";
import { existsSync, readFileSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const __sidecarDir = path.dirname(fileURLToPath(import.meta.url));

const app = express();
/** Enrollment posts multi‑MB base64 JPEGs; default express.json (100kb) rejects with 413 before push-face runs. */
app.use(express.json({ limit: process.env.GSDK_JSON_BODY_LIMIT || "12mb" }));

const PORT = Number(process.env.PORT || 4500);
const GSDK_ROOT = process.env.GSDK_ROOT || "/opt/gsdk/g-sdk-1.9.0/client/node";
const GSDK_GATEWAY = process.env.GSDK_GATEWAY || process.env.SUPREMA_HOST || "";
function envTlsEnabled() {
  const primary = process.env.GSDK_USE_SSL;
  if (primary !== undefined && primary !== "") {
    return String(primary).toLowerCase() === "true";
  }
  const secondary = process.env.SUPREMA_SSL;
  if (secondary !== undefined && secondary !== "") {
    return String(secondary).toLowerCase() === "true";
  }
  return true;
}
const GSDK_USE_SSL = envTlsEnabled();
const GSDK_DEVICE_PORT = Number(process.env.GSDK_DEVICE_PORT || 51211);
/** Connect / Event gRPC use rpc_server (see gateway config.json), not device_server TCP (51211). */
const GSDK_RPC_PORT = Number(process.env.GSDK_RPC_PORT || process.env.GATEWAY_RPC_PORT || 4100);
/** PEM path(s) for gateway TLS (rpc_server on 4100 uses TLS). */
const GSDK_TLS_CA = process.env.GSDK_TLS_CA || "/opt/gateway-cert/ca.crt";
const GSDK_GRPC_MS = Number(process.env.GSDK_GRPC_MS || 12000);
const SIDE_CAR_PULL_SINGLE_FLIGHT_MS = Number(process.env.GSDK_PULL_SINGLE_FLIGHT_MS || 15000);
const IMAGE_PARSER_FAIL_THRESHOLD = Math.max(1, Number(process.env.GSDK_IMAGE_PARSER_FAIL_THRESHOLD || 3));
const IMAGE_RAW_COOLDOWN_MS = Math.max(10000, Number(process.env.GSDK_IMAGE_RAW_COOLDOWN_MS || 10 * 60 * 1000));
// Some gateways return image logs slightly later than event logs; retry a bounded recent range.
const IMAGE_RETRY_WINDOW = Math.max(50, Number(process.env.GSDK_IMAGE_RETRY_WINDOW || 300));
const IMAGE_RETRY_LIMIT = Math.max(50, Math.min(2000, Number(process.env.GSDK_IMAGE_RETRY_LIMIT || 600)));
const SCAN_ENROLL_RETRY_DELAY_MS = Math.max(200, Number(process.env.GSDK_SCAN_ENROLL_RETRY_DELAY_MS || 1200));
const PUSH_FACE_NORMALIZE_PASSES = Math.max(1, Math.min(4, Number(process.env.GSDK_PUSH_FACE_NORMALIZE_PASSES || 2)));
const PUSH_FACE_EXTRACT_PASSES = Math.max(1, Math.min(4, Number(process.env.GSDK_PUSH_FACE_EXTRACT_PASSES || 3)));
const PUSH_FACE_PASS_DELAY_MS = Math.max(120, Number(process.env.GSDK_PUSH_FACE_PASS_DELAY_MS || 700));
/**
 * LOCKED enrollment profile — verified live (scan-and-enroll) + remote (push-face) on BS3 + gateway.
 * Exposed in GET /health as enrollmentProfile. Do not rename or reorder template flags casually;
 * changing scan retry / push-face passes requires retesting both enrollment paths.
 */
const ENROLLMENT_LOCK_PROFILE = Object.freeze({
  name: "visual-face-stable-v1",
  templateFlagOrder: Object.freeze(["EX_TEMPLATE_ONLY", "TEMPLATE_ONLY"]),
  scanRetryDelayMs: SCAN_ENROLL_RETRY_DELAY_MS,
  pushFaceNormalizePasses: PUSH_FACE_NORMALIZE_PASSES,
  pushFaceExtractPasses: PUSH_FACE_EXTRACT_PASSES
});

// Prevent dog-pile pulls on the same device and avoid "hang" behavior under high polling.
const inflightPulls = new Map();
// Circuit breaker for generated getImageLog parser mismatch.
const imageParserBreaker = new Map();
const imageDiag = {
  pulls: 0,
  eventRows: 0,
  imageRows: 0,
  eventRowsWithPhoto: 0,
  parserFallbacks: 0,
  retryWindowRuns: 0,
  rawModeByBreaker: 0,
  lastAt: null
};

/**
 * Bundled g-sdk EventLog proto stops at hasImage (field 9). Gateway wire format matches BS2 docs:
 * changedOnDevice=10, temperature=11. Deserialize raw GetLogResponse bytes so temperature survives.
 */
const GET_LOG_RESPONSE_EXT_ROOT = protobuf.parse(`
syntax = "proto3";
message EventLogExt {
  uint32 id = 1;
  uint32 timestamp = 2;
  uint32 deviceID = 3;
  string userID = 4;
  uint32 entityID = 5;
  uint32 eventCode = 6;
  uint32 subCode = 7;
  bytes tnakey = 8;
  bool hasImage = 9;
  bool changedOnDevice = 10;
  uint32 temperature = 11;
}
message GetLogResponseExt {
  repeated EventLogExt events = 1;
}
`).root;
const GetLogResponseExtType = GET_LOG_RESPONSE_EXT_ROOT.lookupType("GetLogResponseExt");

function mergeExtendedSupremaEventRows(eventsList, grpcResponse) {
  const list = Array.isArray(eventsList) ? eventsList : [];
  if (!grpcResponse || typeof grpcResponse.serializeBinary !== "function") return list;
  let buf;
  try {
    buf = grpcResponse.serializeBinary();
  } catch {
    return list;
  }
  let decoded;
  try {
    decoded = GetLogResponseExtType.decode(buf);
  } catch {
    return list;
  }
  const extArr = decoded?.events || decoded?.eventsList || [];
  if (!Array.isArray(extArr) || extArr.length === 0) return list;
  const byId = new Map();
  for (const x of extArr) {
    const id = Number(x?.id ?? 0);
    if (id > 0) byId.set(id, x);
  }
  return list.map((ev) => {
    const id = Number(ev?.id ?? ev?.Id ?? 0);
    const x = id > 0 ? byId.get(id) : null;
    if (!x) return ev;
    const tRaw = x.temperature ?? x.Temperature;
    const out = { ...ev };
    if (tRaw !== undefined && tRaw !== null) {
      const tn = Number(tRaw);
      if (Number.isFinite(tn) && tn > 0) out.temperature = tn;
    }
    return out;
  });
}

/**
 * Single @grpc/grpc-js instance: must be the same object graph as connect_grpc_pb.js
 * (otherwise ChannelCredentials fail instanceof inside grpc-js — "Channel credentials must be a ChannelCredentials object").
 * Docker: symlink /opt/gsdk/.../node_modules/@grpc/grpc-js → /app/node_modules/@grpc/grpc-js (see Dockerfile).
 */
let cachedGrpcJs = null;
function getGrpcJs() {
  if (cachedGrpcJs) return cachedGrpcJs;
  const stub = path.join(GSDK_ROOT, "biostar/service/connect_grpc_pb.js");
  if (!existsSync(stub)) {
    throw new Error(`G-SDK Connect stub missing: ${stub} (set GSDK_ROOT)`);
  }
  // Self-heal: fix missing/broken grpc-js symlink on every cold start — no rebuild needed.
  const grpcSymlink = path.join(GSDK_ROOT, "node_modules/@grpc/grpc-js");
  const appGrpcPath = path.join(__sidecarDir, "node_modules/@grpc/grpc-js");
  try {
    const stat = lstatSync(grpcSymlink, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) {
      rmSync(grpcSymlink, { recursive: true, force: true });
      symlinkSync(appGrpcPath, grpcSymlink);
      console.log("[gsdk-sidecar] Self-healed grpc-js: replaced dir with symlink");
    } else if (!stat) {
      symlinkSync(appGrpcPath, grpcSymlink);
      console.log("[gsdk-sidecar] Self-healed grpc-js: created symlink");
    }
  } catch (healErr) {
    console.warn("[gsdk-sidecar] grpc-js self-heal failed (non-fatal):", healErr.message);
  }
  const fromStub = createRequire(stub)("@grpc/grpc-js");
  try {
    const fromSidecar = createRequire(path.join(__sidecarDir, "package.json"))("@grpc/grpc-js");
    if (fromSidecar !== fromStub) {
      console.warn("[gsdk-sidecar] Two @grpc/grpc-js copies still detected after self-heal.");
    }
  } catch { /* stripped image */ }
  cachedGrpcJs = fromStub;
  return cachedGrpcJs;
}

/** Fail fast if credentials and generated clients came from different grpc-js copies. */
function assertConnectClientAcceptsGatewayCreds(connectGrpc, grpc) {
  const creds = grpc.credentials.createInsecure();
  try {
    // eslint-disable-next-line no-new
    new connectGrpc.ConnectClient("127.0.0.1:1", creds);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Channel credentials must be a ChannelCredentials object/i.test(msg)) {
      throw new Error(
        "gRPC-js duplicate install: @grpc/grpc-js resolved twice (different ChannelCredentials class). " +
          "Docker: rebuild gsdk-sidecar image (grpc-js symlink). Host: remove extra node_modules/@grpc/grpc-js under GSDK_ROOT or set one NODE_PATH."
      );
    }
  }
}
/** Normalize + Extract run on the reader via gateway and can exceed 45s on busy links/readers. */
const GSDK_ENROLL_MS = Number(process.env.GSDK_ENROLL_MS || Math.max(GSDK_GRPC_MS, 120000));

/** Suprema face.md: BS2_FACE_FLAG_EX implies irTemplates + irImageData on RGB visual devices. */
const BS2_FACE_FLAG_WARPED = 0x01 >>> 0;
const BS2_FACE_FLAG_TEMPLATE_ONLY = 0x20 >>> 0;
const BS2_FACE_FLAG_EX = 0x100 >>> 0;
const TEMPLATE_FLAG_ATTEMPTS = Object.freeze([
  (BS2_FACE_FLAG_EX | BS2_FACE_FLAG_TEMPLATE_ONLY) >>> 0,
  BS2_FACE_FLAG_TEMPLATE_ONLY
]);

/**
 * G-SDK 1.9.0 Node `face_pb.FaceData` has no irTemplates/irImageData; decode skips unknown wire fields,
 * so scan responses lose IR while the EX bit stays set. Re-sending EX without IR yields INVALID_ARGUMENT
 * (often misreported as "Invalid finger data").
 * @param {number} flag
 */
function faceEnrollmentFlagsWithoutExIr(flag) {
  let f = (Number(flag) || 0) >>> 0;
  if (f & BS2_FACE_FLAG_EX) f = (f & ~BS2_FACE_FLAG_EX) >>> 0;
  return f >>> 0;
}

/**
 * Doors deny access unless the user belongs to an access group permitted by the reader/door policy.
 * Omitting groups yields “identified but denied” / failed auth in logs even when Face Only matches visually.
 * @param {Record<string, unknown>} body
 * @returns {{ authGroupId: number, accessGroupIds: number[] }}
 */
function resolveSupremaAccessGroups(body = {}) {
  const rawList = body.accessGroupIds ?? body.access_groups;
  if (Array.isArray(rawList) && rawList.length) {
    const ids = rawList
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => n >>> 0);
    const primary = ids[0] ? ids[0] >>> 0 : 1;
    return { authGroupId: primary, accessGroupIds: ids };
  }
  const raw =
    body.authGroupId ??
    body.authGroupID ??
    body.auth_group_id ??
    process.env.GSDK_DEFAULT_AUTH_GROUP ??
    process.env.DEFAULT_SUPREMA_ACCESS_GROUP;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      const u = n >>> 0;
      if (u === 0) return { authGroupId: 0, accessGroupIds: [] };
      return { authGroupId: u, accessGroupIds: [u] };
    }
  }
  return { authGroupId: 1, accessGroupIds: [1] };
}

/**
 * @param {*} userInfo proto.user.UserInfo
 * @param {*} userHdr proto.user.UserHdr
 * @param {{ authGroupId: number, accessGroupIds: number[] }} ag
 */
function applyAccessGroupsToUserInfo(userInfo, userHdr, ag) {
  if (userInfo.clearAccessgroupidsList) userInfo.clearAccessgroupidsList();
  for (const g of ag.accessGroupIds) {
    userInfo.addAccessgroupids(g >>> 0);
  }
  if (ag.authGroupId > 0 && userHdr.setAuthgroupid) userHdr.setAuthgroupid(ag.authGroupId >>> 0);
}

/** BioStar auth.md: AUTH_EXT_MODE_FACE_ONLY = 11; 0xFF = undefined (use reader AuthConfig). BioStation 3 needs faceAuthExtMode on the user or identify can fail after enroll. */
const AUTH_EXT_MODE_FACE_ONLY = 11;
const AUTH_EXT_MODE_UNDEFINED = 0xff;

function applyVisualFaceUserSetting(userInfo, um) {
  const Ctor = um?.userPb?.UserSetting;
  if (!userInfo || typeof userInfo.setSetting !== "function" || typeof Ctor !== "function") return;
  if (typeof Ctor.prototype.setFaceauthextmode !== "function") return;
  const st = new Ctor();
  st.setFaceauthextmode(AUTH_EXT_MODE_FACE_ONLY);
  st.setFingerauthextmode(AUTH_EXT_MODE_UNDEFINED);
  st.setCardauthextmode(AUTH_EXT_MODE_UNDEFINED);
  st.setIdauthextmode(AUTH_EXT_MODE_UNDEFINED);
  userInfo.setSetting(st);
}

const FACE_RPC_PROTO = `
syntax = "proto3";
message NormalizeRequest {
  uint32 deviceID = 1;
  bytes unwrappedImageData = 2;
}
message NormalizeResponse {
  bytes warpedImageData = 1;
  bytes wrappedImageData = 2;
}
message ExtractRequest {
  uint32 deviceID = 1;
  bytes imageData = 2;
  bool isWarped = 3;
}
message ExtractResponse {
  bytes templateData = 1;
  repeated bytes templates = 2;
}
`;

let faceProtoRoot = null;
function getFaceProtoTypes() {
  if (!faceProtoRoot) {
    faceProtoRoot = protobuf.parse(FACE_RPC_PROTO).root;
  }
  const NR = faceProtoRoot.lookupType("NormalizeRequest");
  const NResp = faceProtoRoot.lookupType("NormalizeResponse");
  const ER = faceProtoRoot.lookupType("ExtractRequest");
  const EResp = faceProtoRoot.lookupType("ExtractResponse");
  return { NR, NResp, ER, EResp };
}

/** When gateway proto drifts, still pull length-delimited payload bytes (template / warped image). */
function scavengeLengthDelimitedFields(buf, preferredFields = [], minLen = 16) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const byField = new Map();
  let pos = 0;
  while (pos < u8.length) {
    const tag = u8[pos++];
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      let len = 0;
      let shift = 0;
      for (;;) {
        if (pos >= u8.length) return null;
        const b = u8[pos++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) return null;
      }
      if (pos + len > u8.length) return null;
      const chunk = u8.subarray(pos, pos + len);
      pos += len;
      const prev = byField.get(fieldNumber);
      if (!prev || chunk.length > prev.length) byField.set(fieldNumber, chunk);
    } else if (wireType === 0) {
      for (;;) {
        if (pos >= u8.length) return null;
        if ((u8[pos++] & 0x80) === 0) break;
      }
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      return null;
    }
  }
  for (const f of preferredFields) {
    const ch = byField.get(f);
    if (ch && ch.length >= minLen) return Buffer.from(ch);
  }
  let best = null;
  for (const ch of byField.values()) {
    if (ch.length >= minLen && (!best || ch.length > best.length)) best = ch;
  }
  return best ? Buffer.from(best) : null;
}

function makeNormalizeResponseDeserializer(NResp) {
  return (buf) => {
    let dec = {};
    try {
      dec = NResp.decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    } catch {
      dec = {};
    }
    let w = dec.warpedImageData?.length ? dec.warpedImageData : null;
    if (!w?.length && dec.wrappedImageData?.length) w = dec.wrappedImageData;
    if (!w?.length) {
      const scav = scavengeLengthDelimitedFields(buf, [1, 2, 3], 16);
      if (scav?.length) w = scav;
    }
    return { ...dec, warpedImageData: w?.length ? w : new Uint8Array(0) };
  };
}

function templateBytesFromExtractDecoded(dec) {
  if (!dec) return null;
  if (dec.templateData?.length) return Buffer.from(dec.templateData);
  const list = dec.templates;
  if (Array.isArray(list)) {
    for (const t of list) {
      if (t?.length) return Buffer.from(t);
    }
  }
  return null;
}

function makeExtractResponseDeserializer(EResp) {
  return (buf) => {
    let dec = {};
    try {
      dec = EResp.decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    } catch {
      dec = {};
    }
    let t = templateBytesFromExtractDecoded(dec);
    if (!t?.length) t = scavengeLengthDelimitedFields(buf, [1, 2, 3], 24);
    return { ...dec, templateData: t?.length ? t : new Uint8Array(0) };
  };
}

function isLikelyJpegBytes(b) {
  return b && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8;
}
function isLikelyBmpBytes(b) {
  return b && b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d;
}
function isLikelyPngBytes(b) {
  return b && b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/** G-SDK: device warped output is usually BMP (isWarped=true); some gateways return JPEG/PNG — try isWarped=false first for those. */
function orderedWarpedExtractAttempts(warpedBuf) {
  const out = [];
  if (!warpedBuf?.length) return out;
  if (isLikelyJpegBytes(warpedBuf) || isLikelyPngBytes(warpedBuf)) {
    out.push({ isWarped: false, label: "warped:jpegOrPng:false" });
    out.push({ isWarped: true, label: "warped:jpegOrPng:true" });
  } else if (isLikelyBmpBytes(warpedBuf)) {
    out.push({ isWarped: true, label: "warped:bmp:true" });
    out.push({ isWarped: false, label: "warped:bmp:false" });
  } else {
    out.push({ isWarped: true, label: "warped:opaque:true" });
    out.push({ isWarped: false, label: "warped:opaque:false" });
  }
  return out;
}

/** G-SDK file-based Visual Face: JPG or PNG (see Face API Extract). Browsers often upload WebP — reject early with a clear error. */
function visualUploadImageKind(buf) {
  if (!buf || buf.length < 12) return "unknown";
  if (isLikelyJpegBytes(buf)) return "jpeg";
  if (isLikelyPngBytes(buf)) return "png";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }
  return "unknown";
}

let cachedUserModules = null;
function getSdkUserModules() {
  if (cachedUserModules) return cachedUserModules;
  const req = createRequire(path.join(GSDK_ROOT, "package.json"));
  const base = path.resolve(GSDK_ROOT, "biostar/service");
  cachedUserModules = {
    userPb: req(path.join(base, "user_pb.js")),
    facePb: req(path.join(base, "face_pb.js")),
    authPb: req(path.join(base, "auth_pb.js"))
  };
  return cachedUserModules;
}

function gatewayGrpcJsCredentials(useSSL) {
  const grpc = getGrpcJs();
  if (!useSSL) return grpc.credentials.createInsecure();
  if (!existsSync(GSDK_TLS_CA)) {
    throw new Error(`GSDK_USE_SSL=true but CA missing: ${GSDK_TLS_CA}`);
  }
  const root = readFileSync(GSDK_TLS_CA);
  return grpc.credentials.createSsl(root);
}

async function unaryWithDeadline(endpoint, creds, grpcPath, serialize, deserialize, requestObj, deadlineMs) {
  const grpc = getGrpcJs();
  return new Promise((resolve, reject) => {
    const client = new grpc.Client(endpoint, creds);
    const deadline = new Date(Date.now() + deadlineMs);
    client.waitForReady(deadline, (readyErr) => {
      if (readyErr) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        return reject(readyErr);
      }
      client.makeUnaryRequest(
        grpcPath,
        serialize,
        deserialize,
        requestObj,
        new grpc.Metadata(),
        { deadline },
        (callErr, resp) => {
          try {
            client.close();
          } catch {
            /* ignore */
          }
          if (callErr) return reject(callErr);
          resolve(resp);
        }
      );
    });
  });
}

/** If the first enroll attempt fails for transport/deadline, do not fall through — fallback steps mislead and waste time. */
function isTransientGrpcCallError(err) {
  const c = Number(err?.code);
  if (c === 4 || c === 14 || c === 12) return true; // DEADLINE_EXCEEDED, UNAVAILABLE, UNIMPLEMENTED
  const m = String(err?.message || err);
  if (/No message received|Response message parsing error|DEADLINE_EXCEEDED|UNAVAILABLE|ECONNRESET|EPIPE|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|TLS|handshake|socket/i.test(m))
    return true;
  return false;
}

async function tryGrpcPaths(paths, call) {
  let lastErr = null;
  for (const p of paths) {
    try {
      return await call(p);
    } catch (e) {
      lastErr = e;
      const code = Number(e?.code);
      const msg = String(e?.message || e || "");
      if (code === 12 || /UNIMPLEMENTED|unknown service|No route|status\s+details/i.test(msg)) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("gRPC failed");
}

function gatewayGrpcCredentials(_grpc, useSSL) {
  const grpc = getGrpcJs();
  if (!useSSL) return grpc.credentials.createInsecure();
  if (!existsSync(GSDK_TLS_CA)) {
    throw new Error(`GSDK_USE_SSL=true but CA missing: ${GSDK_TLS_CA}`);
  }
  const root = readFileSync(GSDK_TLS_CA);
  return grpc.credentials.createSsl(root);
}

let loaderError = null;
let modules = null;
function loadGsdk() {
  try {
    const req = createRequire(path.join(GSDK_ROOT, "package.json"));
    const connectPbPath = path.join(GSDK_ROOT, "biostar/service/connect_pb.js");
    const connectGrpcPath = path.join(GSDK_ROOT, "biostar/service/connect_grpc_pb.js");
    const eventPbPath = path.join(GSDK_ROOT, "biostar/service/event_pb.js");
    const eventGrpcPath = path.join(GSDK_ROOT, "biostar/service/event_grpc_pb.js");
    if (!existsSync(connectPbPath) || !existsSync(connectGrpcPath) || !existsSync(eventPbPath) || !existsSync(eventGrpcPath)) {
      throw new Error("biostar connect/event service files not found");
    }
    const connectPb = req(connectPbPath);
    const connectGrpc = req(connectGrpcPath);
    const eventPb = req(eventPbPath);
    const eventGrpc = req(eventGrpcPath);
    // Native `grpc` does not build on Node 18+; stubs must use @grpc/grpc-js (see Dockerfile minimal G-SDK deps).
    const grpc = getGrpcJs();
    assertConnectClientAcceptsGatewayCreds(connectGrpc, grpc);
    modules = { grpc, connectPb, connectGrpc, eventPb, eventGrpc };
    loaderError = null;
  } catch (error) {
    modules = null;
    loaderError = error.message;
  }
}
loadGsdk();

function normalizeBodySsl(body = {}) {
  const raw = body.useSSL ?? body.ssl ?? body.sslEnabled;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "string") {
      return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase().trim());
    }
    return Boolean(raw);
  }
  return GSDK_USE_SSL;
}

/**
 * Resolve host:port for Connect / Event gRPC (gateway rpc_server).
 * Prefer GSDK_GATEWAY / gateway over a lone reader IP — readers attach to the gateway’s device_server;
 * management API is always on rpc_server (default 4100 TLS).
 */
function resolveRpcEndpoint(body = {}) {
  const useSSL = normalizeBodySsl(body);
  const rawTarget = String(
    body.gatewayRpc || body.rpcTarget || body.gateway || GSDK_GATEWAY || body.target || body.ip || ""
  ).trim();
  if (!rawTarget) {
    return { useSSL, endpoint: "", host: "", port: GSDK_RPC_PORT, target: "" };
  }
  let host;
  let port = GSDK_RPC_PORT;
  if (rawTarget.includes(":")) {
    const idx = rawTarget.lastIndexOf(":");
    host = rawTarget.slice(0, idx).replace(/^\[/, "").replace(/\]$/, "");
    port = Number(rawTarget.slice(idx + 1)) || GSDK_RPC_PORT;
  } else {
    host = rawTarget;
  }
  if (Number(body.rpcPort) > 0) port = Number(body.rpcPort);
  const endpoint = `${host}:${port}`;
  return { useSSL, endpoint, host, port, target: rawTarget };
}

function endpointHost(endpoint = "") {
  const raw = String(endpoint || "").trim();
  if (!raw) return "";
  const idx = raw.lastIndexOf(":");
  const host = idx > 0 ? raw.slice(0, idx) : raw;
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

function isIpLiteral(host = "") {
  const h = String(host || "").trim();
  if (!h) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (h.includes(":")) return true; // IPv6 literal (or host:port already split)
  return false;
}

function grpcClientOptions(endpoint = "", useSSL = false, extra = {}) {
  const opts = { ...(extra || {}) };
  if (useSSL && isIpLiteral(endpointHost(endpoint))) {
    // Avoid Node DEP0123 warning: TLS SNI should be a DNS name, not IP.
    opts["grpc.ssl_target_name_override"] = "localhost";
    opts["grpc.default_authority"] = "localhost";
  }
  return opts;
}

async function withTimeout(promise, timeoutMs = 3000, label = "request") {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pullKey(endpoint, deviceId, startEventId, limit) {
  return `${endpoint}|${Number(deviceId) || 0}|${Number(startEventId) || 0}|${Number(limit) || 0}`;
}

function imageBreakerKey(endpoint, deviceId) {
  return `${endpoint}|${Number(deviceId) || 0}`;
}

function shouldUseRawImagePath(endpoint, deviceId) {
  const key = imageBreakerKey(endpoint, deviceId);
  const row = imageParserBreaker.get(key);
  if (!row) return false;
  if (Date.now() > row.untilMs) {
    imageParserBreaker.delete(key);
    return false;
  }
  return true;
}

function recordImageParserFailure(endpoint, deviceId) {
  const key = imageBreakerKey(endpoint, deviceId);
  const now = Date.now();
  const prev = imageParserBreaker.get(key) || { count: 0, untilMs: 0 };
  const count = Number(prev.count || 0) + 1;
  const untilMs = count >= IMAGE_PARSER_FAIL_THRESHOLD ? now + IMAGE_RAW_COOLDOWN_MS : 0;
  imageParserBreaker.set(key, { count, untilMs });
  imageDiag.parserFallbacks += 1;
  imageDiag.lastAt = new Date().toISOString();
  return { count, untilMs };
}

function recordImageParserSuccess(endpoint, deviceId) {
  const key = imageBreakerKey(endpoint, deviceId);
  imageParserBreaker.delete(key);
}

function imageDiagSnapshot() {
  const pulls = Number(imageDiag.pulls || 0);
  const eventRows = Number(imageDiag.eventRows || 0);
  const eventRowsWithPhoto = Number(imageDiag.eventRowsWithPhoto || 0);
  const imageMatchRatio = eventRows > 0 ? Number((eventRowsWithPhoto / eventRows).toFixed(4)) : 0;
  const rowsPerPull = pulls > 0 ? Number((eventRows / pulls).toFixed(2)) : 0;
  return {
    pulls,
    eventRows,
    imageRows: Number(imageDiag.imageRows || 0),
    eventRowsWithPhoto,
    imageMatchRatio,
    rowsPerPull,
    parserFallbacks: Number(imageDiag.parserFallbacks || 0),
    retryWindowRuns: Number(imageDiag.retryWindowRuns || 0),
    rawModeByBreaker: Number(imageDiag.rawModeByBreaker || 0),
    parserBreakerActive: imageParserBreaker.size,
    lastAt: imageDiag.lastAt
  };
}

function isFaceTemplateExtractError(msg = "") {
  return /BS_ERR_NORMALIZE_FACE|Cannot extract face template|normalize|extract face template|async packet/i.test(
    String(msg || "")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    gsdk: {
      loaded: Boolean(modules),
      root: GSDK_ROOT,
      gateway: GSDK_GATEWAY || null,
      useSSL: GSDK_USE_SSL,
      tlsCa: GSDK_TLS_CA,
      devicePort: GSDK_DEVICE_PORT,
      rpcPort: GSDK_RPC_PORT,
      error: loaderError,
      mode: "grpc-gateway",
      features: {
        setAcceptFilter: true,
        getAcceptFilter: true
      }
    },
    diagnostics: {
      imagePull: imageDiagSnapshot(),
      enrollmentProfile: ENROLLMENT_LOCK_PROFILE
    }
  });
});

app.get("/", (_req, res) => {
  res.type("json");
  res.json({
    service: "gsdk-sidecar",
    version: 2,
    see: "GET /health for G-SDK status; features.setAcceptFilter must be true on a current build",
    post: {
      test: "/devices/test",
      setAcceptFilter: ["/connect/set-accept-filter", "/devices/set-accept-filter"],
      getAcceptFilter: ["/connect/get-accept-filter", "/devices/get-accept-filter"],
      pullLogs: ["/logs/pull", "/events/pull"],
      enrollmentPushFace: "/enrollment/push-face",
      usersDelete: "/users/delete"
    }
  });
});

app.post("/devices/test", async (req, res) => {
  if (!modules) {
    return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  }
  const body = req.body || {};
  const { useSSL, port, target, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) {
    return res.json({
      ok: true,
      message: "G-SDK loaded. Set GSDK_GATEWAY to your device gateway host (gRPC rpc_server, usually port 4100 TLS)."
    });
  }
  try {
    const creds = gatewayGrpcCredentials(modules.grpc, useSSL);
    const client = new modules.connectGrpc.ConnectClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const request = new modules.connectPb.GetDeviceListRequest();
    const result = await withTimeout(new Promise((resolve, reject) => {
      client.getDeviceList(request, (err, response) => {
        if (err) return reject(err);
        return resolve(response?.toObject?.() ?? {});
      });
    }), GSDK_GRPC_MS, "connect.getDeviceList");
    return res.json({
      ok: true,
      endpoint,
      gateway: endpoint,
      useSSL,
      rpcPort: port,
      grpcPort: String(endpoint).split(":").pop() || String(port),
      devices: result.deviceinfosList || []
    });
  } catch (e) {
    let hint = "";
    const msg = String(e.message || e || "");
    if (/UNAVAILABLE|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|No connection established/i.test(msg)) {
      hint =
        " Use gateway rpc_server (default :4100 with TLS), not the reader’s device port 51211. If the device shows “not allowed” on the gateway, call POST /connect/set-accept-filter on this sidecar with { \"allowAll\": true } (or add deviceIDs). `config.json` does not support allowlists; use Connect.SetAcceptFilter.";
    }
    return res.status(502).json({
      ok: false,
      endpoint,
      gateway: endpoint,
      target,
      useSSL,
      rpcPort: GSDK_RPC_PORT,
      error: msg + hint
    });
  }
});

async function handleSetAcceptFilter(req, res) {
  if (!modules) {
    return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  }
  const body = req.body || {};
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error: "Set GSDK_GATEWAY or pass gateway / rpcTarget / gatewayRpc for the management API (rpc_server, usually :4100)."
    });
  }
  const allowAll = Boolean(body.allowAll);
  const deviceIDs = Array.isArray(body.deviceIDs)
    ? body.deviceIDs.map((n) => Number(n) >>> 0).filter((n) => n > 0)
    : [];
  if (!allowAll && deviceIDs.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Provide allowAll: true and/or deviceIDs: [<uint32 gateway device id>] (see gateway logs "devID:…").'
    });
  }
  try {
    const creds = gatewayGrpcCredentials(modules.grpc, useSSL);
    const client = new modules.connectGrpc.ConnectClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const filter = new modules.connectPb.AcceptFilter();
    filter.setAllowall(allowAll);
    for (const id of deviceIDs) {
      filter.addDeviceids(id);
    }
    const setReq = new modules.connectPb.SetAcceptFilterRequest();
    setReq.setFilter(filter);
    await withTimeout(
      new Promise((resolve, reject) => {
        client.setAcceptFilter(setReq, (err) => {
          if (err) return reject(err);
          resolve();
        });
      }),
      GSDK_GRPC_MS,
      "connect.setAcceptFilter"
    );
    return res.json({ ok: true, endpoint, useSSL, allowAll, deviceIDs });
  } catch (e) {
    return res.status(502).json({ ok: false, endpoint, error: String(e.message || e) });
  }
}

async function handleGetAcceptFilter(req, res) {
  if (!modules) {
    return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  }
  const body = req.body || {};
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: "Set GSDK_GATEWAY or pass gateway address for rpc_server." });
  }
  try {
    const creds = gatewayGrpcCredentials(modules.grpc, useSSL);
    const client = new modules.connectGrpc.ConnectClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const out = await withTimeout(
      new Promise((resolve, reject) => {
        client.getAcceptFilter(new modules.connectPb.GetAcceptFilterRequest(), (err, response) => {
          if (err) return reject(err);
          resolve(response?.toObject?.() ?? {});
        });
      }),
      GSDK_GRPC_MS,
      "connect.getAcceptFilter"
    );
    return res.json({ ok: true, endpoint, useSSL, filter: out.filter || out });
  } catch (e) {
    return res.status(502).json({ ok: false, endpoint, error: String(e.message || e) });
  }
}

app.post("/connect/set-accept-filter", handleSetAcceptFilter);
app.post("/devices/set-accept-filter", handleSetAcceptFilter);
app.post("/connect/get-accept-filter", handleGetAcceptFilter);
app.post("/devices/get-accept-filter", handleGetAcceptFilter);

async function pullEvents(req, res) {
  if (!modules) return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  const body = req.body || {};
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) return res.status(400).json({ ok: false, error: "gateway / GSDK_GATEWAY required for rpc_server (default port 4100)" });
  const startEventId = Number(body.startEventId || 0);
  const limit = Math.max(1, Math.min(1000, Number(body.limit || 200)));
  const reqKey = pullKey(endpoint, body.deviceId, startEventId, limit);
  const existing = inflightPulls.get(reqKey);
  if (existing && Date.now() - existing.startedAt < SIDE_CAR_PULL_SINGLE_FLIGHT_MS) {
    try {
      const shared = await existing.promise;
      return res.json({ ...shared, deduped: true });
    } catch (e) {
      return res.status(502).json({ ok: false, endpoint, error: String(e?.message || e), deduped: true });
    }
  }
  const work = (async () => {
  try {
    const creds = gatewayGrpcCredentials(modules.grpc, useSSL);
    const connectClient = new modules.connectGrpc.ConnectClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const listReq = new modules.connectPb.GetDeviceListRequest();
    const list = await withTimeout(new Promise((resolve, reject) => {
      connectClient.getDeviceList(listReq, (err, response) => {
        if (err) return reject(err);
        return resolve(response?.toObject?.() ?? {});
      });
    }), GSDK_GRPC_MS, "connect.getDeviceList");
    const devices = list.deviceinfosList || [];
    const requested = Number(body.deviceId || 0);
    const wantIp = String(body.ip || "")
      .trim()
      .toLowerCase();
    let picked = 0;
    if (Number.isFinite(requested) && requested > 0) {
      picked = Math.floor(requested);
    } else if (wantIp && devices.length) {
      const row = devices.find(
        (x) => String(x.ipaddr || "").trim().toLowerCase() === wantIp
      );
      if (row) {
        picked = Number(row.deviceid ?? row.deviceId ?? 0);
      }
    }
    if (!picked && devices.length) {
      picked = Number(devices[0]?.deviceid ?? devices[0]?.deviceId ?? 0);
    }
    if (!picked) {
      return res.status(404).json({
        ok: false,
        error:
          "No Suprema device id for GetLog: set supremaDeviceId on the device, or enroll the reader so GetDeviceList is non-empty, or pass deviceId in the pull body.",
        endpoint,
        devices
      });
    }

    const eventClient = new modules.eventGrpc.EventClient(
      endpoint,
      creds,
      grpcClientOptions(endpoint, useSSL, {
        "grpc.max_receive_message_length": 20971520,
        "grpc.max_send_message_length": 5242880
      })
    );
    const logReq = new modules.eventPb.GetLogRequest();
    logReq.setDeviceid(picked);
    logReq.setStarteventid(startEventId);
    logReq.setMaxnumoflog(limit);
    const events = await withTimeout(new Promise((resolve, reject) => {
      eventClient.getLog(logReq, (err, response) => {
        if (err) return reject(err);
        const obj = response?.toObject?.() ?? {};
        const list = obj.eventsList || [];
        resolve(mergeExtendedSupremaEventRows(list, response));
      });
    }), Math.max(GSDK_GRPC_MS, 8000), "event.getLog");

    const grantCodes = new Set([0x1000, 0x1200, 0x1300, 0x1500, 0x1600]);
    const denyCodes = new Set([0x1100, 0x1400, 0x1700, 0x1800, 0x1900, 0x1a00]);
    function inferGrantedFromCode(code) {
      const low = (Number(code) >>> 0) & 0xffff;
      if (grantCodes.has(low)) return true;
      if (denyCodes.has(low)) return false;
      return null;
    }

    let merged = events;
    try {
      const imgReq = new modules.eventPb.GetImageLogRequest();
      imgReq.setDeviceid(picked);
      imgReq.setStarteventid(startEventId);
      imgReq.setMaxnumoflog(limit);
      // Parse guards: some gateway/build combos return payloads that break generated deserializers.
      // We first try generated getImageLog; on parser failures we retry via raw unary decode.
      function mapImageRows(imgs = []) {
        return imgs.map((im) => {
          const raw = im.jpgimage ?? im.jpgImage ?? null;
          let jpgimage = null;
          if (typeof raw === "string" && raw) {
            jpgimage = raw;
          } else if (raw && raw.length) {
            jpgimage = Buffer.from(raw).toString("base64");
          }
          return {
            id: im.id,
            timestamp: im.timestamp,
            userid: im.userid ?? im.userID,
            jpgimage
          };
        });
      }
      async function fetchImageLogsRaw() {
        const imgRoot = protobuf.parse(`
          syntax = "proto3";
          message ImageLog {
            uint32 id = 1;
            uint32 timestamp = 2;
            uint32 deviceID = 3;
            string userID = 4;
            bytes jpgImage = 7;
          }
          message GetImageLogResponse {
            repeated ImageLog imageEventsList = 1;
          }
        `).root;
        const RespType = imgRoot.lookupType("GetImageLogResponse");
        return new Promise((resolve) => {
          eventClient.makeUnaryRequest(
            "/gsdk.event.Event/GetImageLog",
            () => Buffer.from(imgReq.serializeBinary()),
            (buf) => {
              try {
                return RespType.decode(buf);
              } catch {
                return { imageEventsList: [] };
              }
            },
            imgReq,
            new modules.grpc.Metadata(),
            { deadline: new Date(Date.now() + Math.max(GSDK_GRPC_MS, 8000)) },
            (err, resp) => {
              if (err) {
                console.log("[img:raw]", err.code, err.message);
                resolve([]);
                return;
              }
              resolve(mapImageRows(resp?.imageEventsList || []));
            }
          );
        });
      }
      async function fetchImageLogsForRange(startId, maxNum) {
        const req = new modules.eventPb.GetImageLogRequest();
        req.setDeviceid(picked);
        req.setStarteventid(Math.max(0, Number(startId) || 0));
        req.setMaxnumoflog(Math.max(1, Number(maxNum) || limit));
        const imageRows = await withTimeout(
          new Promise((resolve) => {
            try {
              if (shouldUseRawImagePath(endpoint, picked) || typeof eventClient.getImageLog !== "function") {
                if (shouldUseRawImagePath(endpoint, picked)) {
                  imageDiag.rawModeByBreaker += 1;
                  imageDiag.lastAt = new Date().toISOString();
                }
                // reuse raw path serializer with alternate request range
                const rawReq = req;
                const imgRoot = protobuf.parse(`
                  syntax = "proto3";
                  message ImageLog {
                    uint32 id = 1;
                    uint32 timestamp = 2;
                    uint32 deviceID = 3;
                    string userID = 4;
                    bytes jpgImage = 7;
                  }
                  message GetImageLogResponse {
                    repeated ImageLog imageEventsList = 1;
                  }
                `).root;
                const RespType = imgRoot.lookupType("GetImageLogResponse");
                eventClient.makeUnaryRequest(
                  "/gsdk.event.Event/GetImageLog",
                  () => Buffer.from(rawReq.serializeBinary()),
                  (buf) => {
                    try {
                      return RespType.decode(buf);
                    } catch {
                      return { imageEventsList: [] };
                    }
                  },
                  rawReq,
                  new modules.grpc.Metadata(),
                  { deadline: new Date(Date.now() + Math.max(GSDK_GRPC_MS, 8000)) },
                  (err, resp) => {
                    if (err) {
                      console.log("[img:raw]", err.code, err.message);
                      resolve([]);
                      return;
                    }
                    resolve(mapImageRows(resp?.imageEventsList || []));
                  }
                );
                return;
              }
              eventClient.getImageLog(req, async (err, response) => {
                if (!err) {
                  const obj = response?.toObject?.() ?? {};
                  recordImageParserSuccess(endpoint, picked);
                  resolve(mapImageRows(obj.imageeventsList || obj.imageEventsList || []));
                  return;
                }
                const msg = String(err?.message || err);
                if (/Response message parsing error|Assertion failed/i.test(msg)) {
                  const state = recordImageParserFailure(endpoint, picked);
                  const rawMode = state.untilMs > 0;
                  console.warn(
                    `[img] parser mismatch on generated client, retrying raw decode (count=${state.count}${rawMode ? ", raw-only cooldown active" : ""})`
                  );
                  const imgRoot = protobuf.parse(`
                    syntax = "proto3";
                    message ImageLog {
                      uint32 id = 1;
                      uint32 timestamp = 2;
                      uint32 deviceID = 3;
                      string userID = 4;
                      bytes jpgImage = 7;
                    }
                    message GetImageLogResponse {
                      repeated ImageLog imageEventsList = 1;
                    }
                  `).root;
                  const RespType = imgRoot.lookupType("GetImageLogResponse");
                  eventClient.makeUnaryRequest(
                    "/gsdk.event.Event/GetImageLog",
                    () => Buffer.from(req.serializeBinary()),
                    (buf) => {
                      try {
                        return RespType.decode(buf);
                      } catch {
                        return { imageEventsList: [] };
                      }
                    },
                    req,
                    new modules.grpc.Metadata(),
                    { deadline: new Date(Date.now() + Math.max(GSDK_GRPC_MS, 8000)) },
                    (rawErr, rawResp) => {
                      if (rawErr) {
                        console.log("[img:raw]", rawErr.code, rawErr.message);
                        resolve([]);
                        return;
                      }
                      resolve(mapImageRows(rawResp?.imageEventsList || []));
                    }
                  );
                  return;
                }
                console.log("[img]", err.code, msg);
                resolve([]);
              });
            } catch (e) {
              console.log("[img] err:", e.message);
              resolve([]);
            }
          }),
          Math.max(GSDK_GRPC_MS, 8000),
          "event.getImageLog"
        );
        return imageRows;
      }

      let imageEvents = await fetchImageLogsForRange(startEventId, limit);
      const eventIds = events
        .map((ev) => Number(ev?.id ?? ev?.Id ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0);
      const minEventId = eventIds.length ? Math.min(...eventIds) : Math.max(0, Number(startEventId) || 0);
      const maxEventId = eventIds.length ? Math.max(...eventIds) : 0;
      const eventIdsSet = new Set(eventIds);
      const matchedPrimary = imageEvents.filter((im) => eventIdsSet.has(Number(im?.id ?? 0))).length;
      const needRetryWindow = eventIds.length > 0 && (imageEvents.length === 0 || matchedPrimary < Math.ceil(eventIds.length * 0.5));
      if (needRetryWindow) {
        imageDiag.retryWindowRuns += 1;
        imageDiag.lastAt = new Date().toISOString();
        const retryStart = Math.max(0, minEventId - IMAGE_RETRY_WINDOW);
        const retryLimit = Math.max(limit, Math.min(IMAGE_RETRY_LIMIT, (maxEventId - retryStart + 1) || IMAGE_RETRY_LIMIT));
        const retryRows = await fetchImageLogsForRange(retryStart, retryLimit);
        if (retryRows.length) {
          const byId = new Map();
          for (const row of [...imageEvents, ...retryRows]) {
            const id = Number(row?.id ?? 0);
            if (!id) continue;
            const prev = byId.get(id);
            const curLen = String(row?.jpgimage || "").length;
            const prevLen = String(prev?.jpgimage || "").length;
            if (!prev || curLen > prevLen) byId.set(id, row);
          }
          imageEvents = [...byId.values()];
        }
      }
      console.log("[img] count:", imageEvents.length);
      imageDiag.pulls += 1;
      imageDiag.eventRows += Number(events.length || 0);
      imageDiag.imageRows += Number(imageEvents.length || 0);
      imageDiag.lastAt = new Date().toISOString();
      const imgById = new Map(
        imageEvents.map((im) => [Number(im.id ?? im.Id ?? 0), im])
      );
      const tsKey = (t) => {
        const n = Number(t);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n < 1e12 ? n : Math.floor(n / 1000);
      };
      const imgByTs = new Map();
      for (const im of imageEvents) {
        const k = tsKey(im.timestamp ?? im.date ?? im.time ?? im.datetime);
        if (k != null && !imgByTs.has(k)) imgByTs.set(k, im);
      }
      merged = events.map((ev, idx) => {
        let row = imgById.get(Number(ev.id ?? ev.Id ?? 0));
        if (!row) {
          const k = tsKey(ev.timestamp ?? ev.date ?? ev.time ?? ev.datetime);
          if (k != null) row = imgByTs.get(k);
        }
        if (!row && imageEvents.length === events.length) {
          row = imageEvents[idx];
        }
        const out = { ...ev };
        const jpg = row?.jpgimage ?? row?.jpgImage;
        if (jpg && typeof jpg === "string") {
          out.jpgimage = jpg;
          out.photo = `data:image/jpeg;base64,${jpg}`;
        }
        const ec = out.eventcode ?? out.eventCode ?? 0;
        const inferred = inferGrantedFromCode(ec);
        if (inferred !== null) {
          out.accessGranted = inferred;
          out.granted = inferred;
        }
        return out;
      });
      imageDiag.eventRowsWithPhoto += merged.filter((ev) => Boolean(ev?.photo || ev?.jpgimage)).length;
    } catch (imgErr) {
      console.warn("[gsdk-sidecar] getImageLog skipped:", imgErr?.message || imgErr);
    }

    merged = Array.isArray(merged)
      ? merged.map((ev) => {
          const out = { ...ev };
          if (typeof out.accessGranted !== "boolean") {
            const inferred = inferGrantedFromCode(out.eventcode ?? out.eventCode);
            if (inferred !== null) {
              out.accessGranted = inferred;
              out.granted = inferred;
            }
          }
          return out;
        })
      : merged;

    return { ok: true, endpoint, deviceId: picked, events: merged, pulled: merged.length };
  } catch (e) {
    throw e;
  }
  })();
  inflightPulls.set(reqKey, { startedAt: Date.now(), promise: work });
  try {
    const payload = await work;
    return res.json(payload);
  } catch (e) {
    return res.status(502).json({ ok: false, endpoint, error: String(e?.message || e) });
  } finally {
    inflightPulls.delete(reqKey);
  }
}

app.post("/logs/pull", pullEvents);
app.post("/events/pull", pullEvents);

/**
 * Remove one or more users from a reader via gateway User.Delete (clears templates / access on device).
 */
app.post("/users/delete", async (req, res) => {
  if (!modules) return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? body.supremaDeviceId ?? 0) >>> 0;
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  const rawIds = body.userIds ?? body.userIDs ?? (body.userId != null ? [body.userId] : []);
  const userIds = (Array.isArray(rawIds) ? rawIds : [rawIds])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 64);
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: "Set GSDK_GATEWAY or pass gateway so rpc_server is reachable." });
  }
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: "deviceId (gateway Suprema device id) is required." });
  }
  if (!userIds.length) {
    return res.status(400).json({ ok: false, error: "userId or userIds is required." });
  }
  try {
    const um = getSdkUserModules();
    const creds = gatewayGrpcJsCredentials(useSSL);
    const delReq = new um.userPb.DeleteRequest();
    delReq.setDeviceid(deviceId);
    for (const id of userIds) delReq.addUserids(id);
    const deletePaths = ["/gsdk.user.User/Delete", "/user.User/Delete"];
    await tryGrpcPaths(deletePaths, (grpcPath) =>
      unaryWithDeadline(
        endpoint,
        creds,
        grpcPath,
        (arg) => Buffer.from(arg.serializeBinary()),
        (buf) => um.userPb.DeleteResponse.deserializeBinary(new Uint8Array(buf)),
        delReq,
        GSDK_ENROLL_MS
      )
    );
    return res.json({ ok: true, endpoint, useSSL, deviceId, userIds });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      endpoint,
      deviceId,
      error: String(e?.message || e),
      hint: "User.Delete removes the user from the reader; gateway must expose gsdk.user.User/Delete."
    });
  }
});

/**
 * Remote / uploaded photo only — Visual Face on BS3-class readers (no device camera).
 * LOCKED flow: Normalize → Extract → template via User.Delete + shell User.Enroll + User.SetFace
 * (monolithic Enroll+face for templates caused INVALID_ARGUMENT Invalid finger data on production).
 * Do not route failures to Face.Scan here; backend uses allowLiveScanFallback:false for this path.
 * Gateway: Face.Normalize, Face.Extract, User.* on rpc_server (often /gsdk.face.Face/*, /gsdk.user.User/*).
 */
app.post("/enrollment/push-face", async (req, res) => {
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? body.supremaDeviceId ?? 0) >>> 0;
  const imageBase64 = String(body.imageBase64 || "").replace(/\s/g, "");
  const userId = String(body.userId || "").trim().slice(0, 48);
  const name = String(body.name || userId || "").trim().slice(0, 128);
  const { useSSL, endpoint } = resolveRpcEndpoint(body);

  if (!endpoint) {
    return res.status(400).json({
      ok: false,
      error: "Set GSDK_GATEWAY or pass gateway so rpc_server (TLS :4100) is reachable."
    });
  }
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: "deviceId (gateway Suprema device id, uint32) is required." });
  }
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required (maps to device UserHdr.ID)." });
  }
  if (imageBase64.length < 120) {
    return res.status(400).json({ ok: false, error: "imageBase64 (JPEG/PNG) is missing or too short." });
  }

  let jpeg;
  try {
    jpeg = Buffer.from(imageBase64, "base64");
  } catch {
    return res.status(400).json({ ok: false, error: "invalid base64 for image" });
  }

  const uploadKind = visualUploadImageKind(jpeg);
  if (uploadKind === "webp") {
    return res.status(400).json({
      ok: false,
      error:
        "WebP is not supported for remote Visual Face enrollment. Export the photo as JPEG or PNG and upload again.",
      hint: "Suprema G-SDK expects JPG/PNG for image-file Normalize/Extract (device gateway)."
    });
  }

  const ag = resolveSupremaAccessGroups(body);

  try {
    const creds = gatewayGrpcJsCredentials(useSSL);
    const { NR, NResp, ER, EResp } = getFaceProtoTypes();
    const um = getSdkUserModules();

    const normalizePaths = ["/gsdk.face.Face/Normalize", "/face.Face/Normalize"];
    const extractPaths = ["/gsdk.face.Face/Extract", "/face.Face/Extract"];

    let warped = null;
    let normalizeError = "";
    for (let pass = 1; pass <= PUSH_FACE_NORMALIZE_PASSES; pass += 1) {
      try {
        if (pass > 1) await sleep(PUSH_FACE_PASS_DELAY_MS);
        console.log("[push-face] normalize pass", pass, "for userId:", userId, "imageLen:", jpeg.length);
        const normResp = await tryGrpcPaths(normalizePaths, (grpcPath) =>
          unaryWithDeadline(
            endpoint,
            creds,
            grpcPath,
            (arg) => Buffer.from(NR.encode(arg).finish()),
            makeNormalizeResponseDeserializer(NResp),
            { deviceID: deviceId, unwrappedImageData: jpeg },
            GSDK_ENROLL_MS
          )
        );
        const warpedRaw = normResp.warpedImageData ?? normResp.wrappedImageData;
        warped = warpedRaw && warpedRaw.length ? Buffer.from(warpedRaw) : null;
        if (warped && warped.length > 0) break;
        normalizeError = `Normalize returned empty image (pass ${pass})`;
      } catch (normErr) {
        normalizeError = String(normErr?.message || normErr);
      }
    }
    if (!warped || warped.length === 0) {
      console.warn("[push-face] normalize failed/empty after passes; trying non-template fallbacks:", normalizeError);
    }

    const enrollFace = async (faceData, mode = "template") => {
      const sdkReqU = createRequire(path.join(GSDK_ROOT, "package.json"));
      const userGrpcU = sdkReqU("./biostar/service/user_grpc_pb.js");
      const userClientU = new userGrpcU.UserClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
      const hdr = new um.userPb.UserHdr();
      hdr.setId(userId);
      hdr.setNumofcard(0);
      hdr.setNumoffinger(0);
      hdr.setNumofface(1);
      const userInfo = new um.userPb.UserInfo();
      userInfo.clearFingersList();
      userInfo.clearCardsList();
      userInfo.clearFacesList();
      userInfo.setHdr(hdr);
      userInfo.setName(name || userId);
      applyVisualFaceUserSetting(userInfo, um);
      applyAccessGroupsToUserInfo(userInfo, hdr, ag);
      userInfo.addFaces(faceData);
      // Delete user first to clear any stale finger data on device
      try {
        const delReq = new um.userPb.DeleteRequest();
        delReq.setDeviceid(deviceId);
        delReq.addUserids(userId);
        await withTimeout(new Promise((resolve, reject) => {
          userClientU.delete(delReq, (err, resp) => err ? reject(err) : resolve(resp));
        }), 5000, "user.delete.before.enroll");
      } catch(delErr) { /* ignore - user may not exist */ }
      const enrollReq = new um.userPb.EnrollRequest();
      enrollReq.setDeviceid(deviceId);
      enrollReq.addUsers(userInfo);
      enrollReq.setOverwrite(true);
      await withTimeout(new Promise((resolve, reject) => {
        userClientU.enroll(enrollReq, (err, resp) => err ? reject(err) : resolve(resp));
      }), 15000, "user.enroll.pushface");
      if (ag.accessGroupIds.length) {
        const uag = new um.userPb.UserAccessGroup();
        uag.setUserid(userId);
        ag.accessGroupIds.forEach((g) => uag.addAccessgroupids(g >>> 0));
        const sag = new um.userPb.SetAccessGroupRequest();
        sag.setDeviceid(deviceId);
        sag.addUseraccessgroups(uag);
        await withTimeout(new Promise((resolve, reject) => {
          userClientU.setAccessGroup(sag, (err, resp) => err ? reject(err) : resolve(resp));
        }), 12000, "user.setAccessGroup.pushface");
      }
      return mode;
    };

    const enrollTemplateViaSetFace = async (templateBuf, mode = "template_ex") => {
      const sdkReqU = createRequire(path.join(GSDK_ROOT, "package.json"));
      const userGrpcU = sdkReqU("./biostar/service/user_grpc_pb.js");
      const userClientU = new userGrpcU.UserClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
      const shellHdr = new um.userPb.UserHdr();
      shellHdr.setId(userId);
      shellHdr.setNumofcard(0);
      shellHdr.setNumoffinger(0);
      shellHdr.setNumofface(0);
      const shellInfo = new um.userPb.UserInfo();
      shellInfo.clearFingersList();
      shellInfo.clearCardsList();
      shellInfo.clearFacesList();
      shellInfo.setHdr(shellHdr);
      shellInfo.setName(name || userId);
      applyVisualFaceUserSetting(shellInfo, um);
      try {
        const delReq = new um.userPb.DeleteRequest();
        delReq.setDeviceid(deviceId);
        delReq.addUserids(userId);
        await withTimeout(new Promise((resolve, reject) => {
          userClientU.delete(delReq, (err, resp) => err ? reject(err) : resolve(resp));
        }), 8000, "user.delete.before.setFace");
      } catch (_) { /* ignore */ }
      const shellEnrollReq = new um.userPb.EnrollRequest();
      shellEnrollReq.setDeviceid(deviceId);
      shellEnrollReq.addUsers(shellInfo);
      shellEnrollReq.setOverwrite(true);
      await withTimeout(new Promise((resolve, reject) => {
        userClientU.enroll(shellEnrollReq, (err, resp) => err ? reject(err) : resolve(resp));
      }), 15000, "user.enroll.shell.pushface");

      const fd = new um.facePb.FaceData();
      fd.setIndex(0);
      fd.setFlag(mode === "template_ex" ? (TEMPLATE_FLAG_ATTEMPTS[0] >>> 0) : (TEMPLATE_FLAG_ATTEMPTS[1] >>> 0));
      fd.addTemplates(templateBuf);
      const uf = new um.userPb.UserFace();
      uf.setUserid(userId);
      uf.addFaces(fd);
      const sfr = new um.userPb.SetFaceRequest();
      sfr.setDeviceid(deviceId);
      sfr.addUserfaces(uf);
      await withTimeout(new Promise((resolve, reject) => {
        userClientU.setFace(sfr, (err, resp) => err ? reject(err) : resolve(resp));
      }), 20000, "user.setFace.pushface");

      if (ag.accessGroupIds.length) {
        const uag = new um.userPb.UserAccessGroup();
        uag.setUserid(userId);
        ag.accessGroupIds.forEach((g) => uag.addAccessgroupids(g >>> 0));
        const sag = new um.userPb.SetAccessGroupRequest();
        sag.setDeviceid(deviceId);
        sag.addUseraccessgroups(uag);
        await withTimeout(new Promise((resolve, reject) => {
          userClientU.setAccessGroup(sag, (err, resp) => err ? reject(err) : resolve(resp));
        }), 12000, "user.setAccessGroup.pushface.setFace");
      }
      return mode;
    };

    // Prefer normalized warped visual image without EX (Node proto cannot send irTemplates/irImageData with EX).
    try {
      if (!warped || warped.length < 32) throw new Error("skip warped image enroll: empty or too small");
      const faceImg = new um.facePb.FaceData();
      faceImg.setIndex(0);
      faceImg.setFlag(BS2_FACE_FLAG_WARPED);
      faceImg.setImagedata(warped);
      const enrolledMode = await enrollFace(faceImg, "warped_image");
      console.log("[push-face] warped enroll SUCCESS mode:", enrolledMode);
      return res.json({
        ok: true,
        endpoint,
        useSSL,
        deviceId,
        userId,
        extractVariant: "none",
        enrolledMode,
        enrollmentPath: "warped_image"
      });
    } catch (e1) {
      if (isTransientGrpcCallError(e1)) throw e1;
      console.warn("[push-face] warped e1:", String(e1?.message||e1));
      /* fall through to extract + template / image fallbacks for device/face rejections */
    }

    // Some gateways/readers are picky about the Extract input mode.
    // Try multiple variants before falling back to image-data enrollment.
    let tpl = null;
    let extractVariant = "";
    let extractError = "";
    const extractAttempts = [];
    if (warped?.length) {
      for (const v of orderedWarpedExtractAttempts(warped)) {
        extractAttempts.push({ imageData: warped, isWarped: v.isWarped, label: v.label });
      }
    }
    extractAttempts.push({ imageData: jpeg, isWarped: false, label: "raw:upload:false" });
    for (const attempt of extractAttempts) {
      if (!attempt.imageData || !attempt.imageData.length) continue;
      for (let pass = 1; pass <= PUSH_FACE_EXTRACT_PASSES; pass += 1) {
        try {
          if (pass > 1) await sleep(PUSH_FACE_PASS_DELAY_MS);
          const extResp = await tryGrpcPaths(extractPaths, (grpcPath) =>
            unaryWithDeadline(
              endpoint,
              creds,
              grpcPath,
              (arg) => Buffer.from(ER.encode(arg).finish()),
              makeExtractResponseDeserializer(EResp),
              { deviceID: deviceId, imageData: attempt.imageData, isWarped: attempt.isWarped },
              GSDK_ENROLL_MS
            )
          );
          const tplRaw = extResp.templateData;
          const candidate = tplRaw ? Buffer.from(tplRaw) : null;
          if (candidate && candidate.length > 0) {
            tpl = candidate;
            extractVariant = `${attempt.label}:pass${pass}`;
            break;
          }
          extractError = `empty template (${attempt.label}, pass ${pass})`;
        } catch (exErr) {
          extractError = String(exErr?.message || exErr);
        }
      }
      if (tpl && tpl.length > 0) break;
    }
    if (tpl && tpl.length > 0) {
      // Suprema reference path: EX + TEMPLATE_ONLY for Visual Face template import.
      // Keep TEMPLATE_ONLY-only fallback for firmware variants that reject EX.
      const templateFlagAttempts = [
        { mode: "template_ex" },
        { mode: "template_only" }
      ];
      let lastTplErr = null;
      for (const tf of templateFlagAttempts) {
        try {
          const enrolledMode = await enrollTemplateViaSetFace(tpl, tf.mode);
          return res.json({
            ok: true,
            endpoint,
            useSSL,
            deviceId,
            userId,
            extractVariant,
            enrolledMode,
            enrollmentPath: tf.mode
          });
        } catch (te) {
          lastTplErr = String(te?.message || te);
        }
      }
      return res.status(502).json({
        ok: false,
        step: "enroll_template",
        error: lastTplErr || "Template enroll failed"
      });
    }

    // Suprema docs note Visual Face can also be enrolled from warped/raw image.
    const imageEnrollAttempts = [
      { imageData: warped, flag: BS2_FACE_FLAG_WARPED, mode: "warped_image" },
      { imageData: jpeg, flag: 0, mode: "raw_image" }
    ];
    let lastImageEnrollError = null;
    for (const attempt of imageEnrollAttempts) {
      if (!attempt.imageData || !attempt.imageData.length) continue;
      try {
        const faceData = new um.facePb.FaceData();
        faceData.setIndex(0);
        faceData.setFlag(attempt.flag);
        faceData.setImagedata(attempt.imageData);
        const enrolledMode = await enrollFace(faceData, attempt.mode);
        return res.json({
          ok: true,
          endpoint,
          useSSL,
          deviceId,
          userId,
          extractVariant: "none",
          enrolledMode,
          enrollmentPath: attempt.mode
        });
      } catch (enrollErr) {
        lastImageEnrollError = String(enrollErr?.message || enrollErr);
      }
    }

    return res.status(502).json({
      ok: false,
      step: "extract",
      error: "Extract returned empty template data.",
      hint:
        "Suprema Visual Face template extraction failed on uploaded photo. Use a clearer frontal photo (600x600+, even light, no blur, no sunglasses).",
      fallbackError: lastImageEnrollError || undefined,
      normalizeError: normalizeError || undefined,
      extractError: extractError || undefined
    });
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("[push-face] OUTER catch:", msg);
    return res.status(502).json({
      ok: false,
      endpoint,
      deviceId,
      error: msg,
      hint:
        "Enrollment requires gateway Face.Normalize → Face.Extract → User.Enroll. Reader must stay connected to gateway. Alternatively enroll on the device or BioStar 2."
    });
  }
});


/**
 * Live enrollment — opens device camera / Face.Scan. LOCKED: keep shell+setFace + monolithic fallbacks;
 * do not merge this path with remote push-face (remote must never call Scan on upload failure).
 */
app.post("/enrollment/scan-and-enroll", async (req, res) => {
  if (!modules) return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? 0) >>> 0;
  const userId = String(body.userId || "").trim().slice(0, 48);
  const name = String(body.name || userId || "").trim().slice(0, 48);
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) return res.status(400).json({ ok: false, error: "Set GSDK_GATEWAY" });
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
  try {
    const um = getSdkUserModules();
    const sdkReq = createRequire(path.join(GSDK_ROOT, "package.json"));
    const faceGrpc = sdkReq("./biostar/service/face_grpc_pb.js");
    const userGrpc = sdkReq("./biostar/service/user_grpc_pb.js");
    const grpc = getGrpcJs();
    const creds = useSSL
      ? grpc.credentials.createSsl(readFileSync(GSDK_TLS_CA))
      : grpc.credentials.createInsecure();

    // Step 1: Scan face on device
    const faceClient = new faceGrpc.FaceClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const scanReq = new um.facePb.ScanRequest();
    scanReq.setDeviceid(deviceId);
    // scanReq.setEnrollthreshold(0); // disabled
    let scanResp;
    let scanAttempt = 1;
    try {
      scanResp = await withTimeout(new Promise((resolve, reject) => {
        faceClient.scan(scanReq, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 35000, "face.scan");
    } catch (scanErr) {
      const scanMsg = String(scanErr?.message || scanErr);
      if (!isFaceTemplateExtractError(scanMsg)) throw scanErr;
      console.warn("[scan-and-enroll] scan attempt 1 normalize/extract failed, retrying once:", scanMsg);
      await sleep(SCAN_ENROLL_RETRY_DELAY_MS);
      scanAttempt = 2;
      scanResp = await withTimeout(new Promise((resolve, reject) => {
        faceClient.scan(scanReq, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 35000, "face.scan.retry");
    }
    console.log("[scan-and-enroll] scan completed for userId:", userId);
    const rawFaceData = scanResp.getFacedata ? scanResp.getFacedata() : null;
    if (!rawFaceData) return res.status(502).json({ ok: false, error: "No face data from scan" });
    console.log("[scan-and-enroll] faceData flag:", rawFaceData.getFlag ? rawFaceData.getFlag() : "n/a",
      "imageLen:", rawFaceData.getImagedata ? rawFaceData.getImagedata().length : 0,
      "templates:", rawFaceData.getTemplatesList ? rawFaceData.getTemplatesList().length : 0);

    const hasImage = rawFaceData.getImagedata && rawFaceData.getImagedata().length > 0;
    const hasTemplates = rawFaceData.getTemplatesList && rawFaceData.getTemplatesList().length > 0;

    // Build a "safe" monolithic FaceData:
    // - Prefer TEMPLATE_ONLY if templates exist (most stable on BS3 for persistence).
    // - Else fallback to warped image path.
    // Avoid EX flag in Node runtime because IR payload fields are not preserved.
    const faceData = new um.facePb.FaceData();
    faceData.setIndex(0);
    if (hasTemplates) {
      faceData.setFlag(BS2_FACE_FLAG_TEMPLATE_ONLY);
      rawFaceData.getTemplatesList().forEach((t) => faceData.addTemplates(t));
    } else {
      let scanFlag = faceEnrollmentFlagsWithoutExIr(rawFaceData.getFlag ? rawFaceData.getFlag() : 0);
      if (hasImage && !(scanFlag & BS2_FACE_FLAG_WARPED)) {
        scanFlag = (scanFlag | BS2_FACE_FLAG_WARPED) >>> 0;
      }
      faceData.setFlag(scanFlag);
      if (hasImage) faceData.setImagedata(rawFaceData.getImagedata());
    }

    const userClient = new userGrpc.UserClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const ag = resolveSupremaAccessGroups(body);
    const verifyFaceOnDevice = async () => {
      const gr = new um.userPb.GetRequest();
      gr.setDeviceid(deviceId);
      gr.addUserids(userId);
      const resp = await withTimeout(new Promise((resolve, reject) => {
        userClient.get(gr, (err, out) => (err ? reject(err) : resolve(out)));
      }), 12000, "user.get.verifyFace");
      const users = resp?.getUsersList ? resp.getUsersList() : [];
      if (!users.length) return false;
      const u = users[0];
      const hdr = u?.getHdr ? u.getHdr() : null;
      const numFace = hdr?.getNumofface ? Number(hdr.getNumofface() || 0) : 0;
      const faces = u?.getFacesList ? u.getFacesList() : [];
      return numFace > 0 || (Array.isArray(faces) && faces.length > 0);
    };

    const enrollShellOnly = async () => {
      const userHdr = new um.userPb.UserHdr();
      userHdr.setId(userId);
      userHdr.setNumofcard(0);
      userHdr.setNumoffinger(0);
      userHdr.setNumofface(0);
      const userInfo = new um.userPb.UserInfo();
      userInfo.clearFingersList();
      userInfo.clearCardsList();
      userInfo.clearFacesList();
      userInfo.setHdr(userHdr);
      userInfo.setName(name);
      applyVisualFaceUserSetting(userInfo, um);
      // Access groups applied separately after SetFace (applying here causes Invalid face data on BS3)
      const enrollReq = new um.userPb.EnrollRequest();
      enrollReq.setDeviceid(deviceId);
      enrollReq.addUsers(userInfo);
      enrollReq.setOverwrite(true);
      await withTimeout(new Promise((resolve, reject) => {
        userClient.enroll(enrollReq, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 15000, "user.enroll.shell");
    };

    const setFaceFromScan = async () => {
      const tpls = rawFaceData.getTemplatesList ? rawFaceData.getTemplatesList() : [];
      const flagAttempts = TEMPLATE_FLAG_ATTEMPTS;
      let lastErr = null;
      for (const ff of flagAttempts) {
        try {
          const fd = new um.facePb.FaceData();
          fd.setIndex(0);
          fd.setFlag(ff >>> 0);
          tpls.forEach((t) => fd.addTemplates(t));
          const uf = new um.userPb.UserFace();
          uf.setUserid(userId);
          uf.addFaces(fd);
          const sfr = new um.userPb.SetFaceRequest();
          sfr.setDeviceid(deviceId);
          sfr.addUserfaces(uf);
          await withTimeout(new Promise((resolve, reject) => {
            userClient.setFace(sfr, (err, resp) => (err ? reject(err) : resolve(resp)));
          }), 20000, `user.setFace.flag_${ff}`);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error("setFace failed");
    };

    const enrollMonolithic = async () => {
      const userHdr = new um.userPb.UserHdr();
      userHdr.setId(userId);
      userHdr.setNumofcard(0);
      userHdr.setNumoffinger(0);
      userHdr.setNumofface(1);
      const userInfo = new um.userPb.UserInfo();
      userInfo.clearFingersList();
      userInfo.clearCardsList();
      userInfo.clearFacesList();
      userInfo.setHdr(userHdr);
      userInfo.setName(name);
      applyVisualFaceUserSetting(userInfo, um);
      applyAccessGroupsToUserInfo(userInfo, userHdr, ag);
      if (hasTemplates) {
        const tpls = rawFaceData.getTemplatesList ? rawFaceData.getTemplatesList() : [];
        const flagAttempts = TEMPLATE_FLAG_ATTEMPTS;
        let lastErr = null;
        for (const ff of flagAttempts) {
          try {
            const fd = new um.facePb.FaceData();
            fd.setIndex(0);
            fd.setFlag(ff >>> 0);
            tpls.forEach((t) => fd.addTemplates(t));
            userInfo.clearFacesList();
            userInfo.addFaces(fd);
            const enrollReq = new um.userPb.EnrollRequest();
            enrollReq.setDeviceid(deviceId);
            enrollReq.addUsers(userInfo);
            enrollReq.setOverwrite(true);
            await withTimeout(new Promise((resolve, reject) => {
              userClient.enroll(enrollReq, (err, resp) => (err ? reject(err) : resolve(resp)));
            }), 15000, `user.enroll.monolithic.flag_${ff}`);
            return;
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr || new Error("monolithic template enroll failed");
      }
      userInfo.addFaces(faceData);
      const enrollReq = new um.userPb.EnrollRequest();
      enrollReq.setDeviceid(deviceId);
      enrollReq.addUsers(userInfo);
      enrollReq.setOverwrite(true);
      await withTimeout(new Promise((resolve, reject) => {
        userClient.enroll(enrollReq, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 15000, "user.enroll.monolithic");
    };

    const tryDeleteUser = async () => {
      const dr = new um.userPb.DeleteRequest();
      dr.setDeviceid(deviceId);
      dr.addUserids(userId);
      await withTimeout(new Promise((resolve, reject) => {
        userClient.delete(dr, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 12000, "user.delete");
    };

    let enrollmentPath = "shell_then_setFace";
    try {
      try { await tryDeleteUser(); } catch (_) {}
      await enrollShellOnly();
      await setFaceFromScan();
    } catch (e1) {
      const m1 = String(e1?.message || e1);
      console.warn("[scan-and-enroll] shell+setFace failed:", m1);
      if (/Invalid finger/i.test(m1)) {
        try {
          await tryDeleteUser();
        } catch (delErr) {
          console.warn("[scan-and-enroll] delete before retry (ignored):", delErr?.message || delErr);
        }
        try {
          await enrollShellOnly();
          await setFaceFromScan();
          enrollmentPath = "delete_then_shell_setFace";
        } catch (e2) {
          console.warn("[scan-and-enroll] retry shell+setFace failed:", e2?.message || e2);
          await enrollMonolithic();
          enrollmentPath = "monolithic_after_shell_fail";
        }
      } else {
        await enrollMonolithic();
        enrollmentPath = "monolithic_after_shell_fail";
      }
    }

    if (ag.accessGroupIds.length) {
      const uag = new um.userPb.UserAccessGroup();
      uag.setUserid(userId);
      ag.accessGroupIds.forEach((g) => uag.addAccessgroupids(g >>> 0));
      const sag = new um.userPb.SetAccessGroupRequest();
      sag.setDeviceid(deviceId);
      sag.addUseraccessgroups(uag);
      await withTimeout(new Promise((resolve, reject) => {
        userClient.setAccessGroup(sag, (err, resp) => (err ? reject(err) : resolve(resp)));
      }), 12000, "user.setAccessGroup");
    }

    // Ensure the reader really stored face templates (some flows create the user but face remains empty).
    let faceSaved = false;
    try {
      faceSaved = await verifyFaceOnDevice();
    } catch (verifyErr) {
      console.warn("[scan-and-enroll] verify face failed:", verifyErr?.message || verifyErr);
    }
    if (!faceSaved) {
      console.warn("[scan-and-enroll] face not persisted after", enrollmentPath, "- forcing monolithic enroll");
      await enrollMonolithic();
      if (ag.accessGroupIds.length) {
        const uag2 = new um.userPb.UserAccessGroup();
        uag2.setUserid(userId);
        ag.accessGroupIds.forEach((g) => uag2.addAccessgroupids(g >>> 0));
        const sag2 = new um.userPb.SetAccessGroupRequest();
        sag2.setDeviceid(deviceId);
        sag2.addUseraccessgroups(uag2);
        await withTimeout(new Promise((resolve, reject) => {
          userClient.setAccessGroup(sag2, (err, resp) => (err ? reject(err) : resolve(resp)));
        }), 12000, "user.setAccessGroup.verifyFallback");
      }
      faceSaved = await verifyFaceOnDevice();
      if (faceSaved) enrollmentPath = `${enrollmentPath}->monolithic_verify`;
    }

    // Final hard fallback for stubborn devices: delete user and rebuild as shell + setFace once more.
    if (!faceSaved) {
      console.warn("[scan-and-enroll] face still not persisted after monolithic; forcing delete+shell+setFace");
      try { await tryDeleteUser(); } catch (_) {}
      await enrollShellOnly();
      await setFaceFromScan();
      if (ag.accessGroupIds.length) {
        const uag3 = new um.userPb.UserAccessGroup();
        uag3.setUserid(userId);
        ag.accessGroupIds.forEach((g) => uag3.addAccessgroupids(g >>> 0));
        const sag3 = new um.userPb.SetAccessGroupRequest();
        sag3.setDeviceid(deviceId);
        sag3.addUseraccessgroups(uag3);
        await withTimeout(new Promise((resolve, reject) => {
          userClient.setAccessGroup(sag3, (err, resp) => (err ? reject(err) : resolve(resp)));
        }), 12000, "user.setAccessGroup.finalFallback");
      }
      faceSaved = await verifyFaceOnDevice();
      if (faceSaved) enrollmentPath = `${enrollmentPath}->delete_shell_setFace_verify`;
    }

    if (!faceSaved) {
      return res.status(502).json({
        ok: false,
        step: "verify-face",
        error: "Reader accepted enrollment call but did not persist face template (numOfFace=0).",
        hint: "Use Reader menu/BioStar to set Face-only auth for this user, then retry Live Enroll.",
        userId,
        deviceId,
        enrollmentPath
      });
    }

    return res.json({
      ok: true,
      message: "Face enrolled on device!",
      userId,
      deviceId,
      enrollmentPath,
      scanAttempt,
      faceSaved,
      authGroupId: ag.authGroupId || undefined,
      accessGroupIds: ag.accessGroupIds.length ? ag.accessGroupIds : undefined
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const payload = { ok: false, step: "scan-enroll", error: msg };
    if (/Invalid finger/i.test(msg)) {
      payload.hint =
        "Reader auth mode may require a fingerprint (e.g. Face+Finger). On the device: Menu → Authentication → Auth Mode → choose Face-only (or a mode that does not require finger), then retry. Also check the same user in BioStar 2.";
    }
    return res.status(502).json(payload);
  }
});

/**
 * Set BioStar access groups for an existing user on a reader (no full re-enroll).
 * Use when the face template is fine but door policy denies (e.g. Reader detail: invalid access group / 0x1900:0x01).
 */
app.post("/users/set-access-groups", async (req, res) => {
  if (!modules) return res.status(503).json({ ok: false, error: loaderError || "G-SDK not loaded" });
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? 0) >>> 0;
  const userId = String(body.userId || "").trim().slice(0, 48);
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: "Set GSDK_GATEWAY or pass gateway (rpc_server :4100)." });
  }
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
  try {
    const um = getSdkUserModules();
    const sdkReq = createRequire(path.join(GSDK_ROOT, "package.json"));
    const userGrpc = sdkReq("./biostar/service/user_grpc_pb.js");
    const grpc = getGrpcJs();
    const creds = useSSL ? grpc.credentials.createSsl(readFileSync(GSDK_TLS_CA)) : grpc.credentials.createInsecure();
    const userClient = new userGrpc.UserClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const ag = resolveSupremaAccessGroups(body);
    if (!ag.accessGroupIds || !ag.accessGroupIds.length) {
      return res.status(400).json({
        ok: false,
        error:
          "No access groups resolved. Pass accessGroupIds in the body or set DEFAULT_SUPREMA_ACCESS_GROUP / SUPREMA_ACCESS_GROUP_IDS in the sidecar environment."
      });
    }
    const uag = new um.userPb.UserAccessGroup();
    uag.setUserid(userId);
    ag.accessGroupIds.forEach((g) => uag.addAccessgroupids(g >>> 0));
    const sag = new um.userPb.SetAccessGroupRequest();
    sag.setDeviceid(deviceId);
    sag.addUseraccessgroups(uag);
    await withTimeout(
      new Promise((resolve, reject) => {
        userClient.setAccessGroup(sag, (err, resp) => (err ? reject(err) : resolve(resp)));
      }),
      12000,
      "user.setAccessGroup"
    );
    return res.json({
      ok: true,
      deviceId,
      userId,
      authGroupId: ag.authGroupId,
      accessGroupIds: ag.accessGroupIds
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/events/clear", async (req, res) => {
  if (!modules) return res.status(503).json({ ok: false, error: "G-SDK not loaded" });
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? 0) >>> 0;
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint || !deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  try {
    const creds = gatewayGrpcCredentials(modules.grpc, useSSL);
    const sdkReq = createRequire(path.join(GSDK_ROOT, "package.json"));
    const eventGrpc = sdkReq("./biostar/service/event_grpc_pb.js");
    const eventPb = sdkReq("./biostar/service/event_pb.js");
    const client = new eventGrpc.EventClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const r = new eventPb.ClearLogRequest();
    r.setDeviceid(deviceId);
    await withTimeout(new Promise((resolve, reject) => {
      client.clearLog(r, (err, resp) => err ? reject(err) : resolve(resp));
    }), 10000, "event.clearLog");
    return res.json({ ok: true, deviceId });
  } catch(e) { return res.status(502).json({ ok: false, error: e.message }); }
});

app.post("/users/delete-all", async (req, res) => {
  if (!modules) return res.status(503).json({ ok: false, error: "G-SDK not loaded" });
  const body = req.body || {};
  const deviceId = Number(body.deviceId ?? 0) >>> 0;
  const { useSSL, endpoint } = resolveRpcEndpoint(body);
  if (!endpoint || !deviceId) return res.status(400).json({ ok: false, error: "deviceId and gateway required" });
  try {
    const um = getSdkUserModules();
    const sdkReq = createRequire(path.join(GSDK_ROOT, "package.json"));
    const userGrpc = sdkReq("./biostar/service/user_grpc_pb.js");
    const grpc = getGrpcJs();
    const creds = useSSL ? grpc.credentials.createSsl(readFileSync(GSDK_TLS_CA)) : grpc.credentials.createInsecure();
    const client = new userGrpc.UserClient(endpoint, creds, grpcClientOptions(endpoint, useSSL));
    const r = new um.userPb.DeleteAllRequest();
    r.setDeviceid(deviceId);
    await withTimeout(new Promise((resolve, reject) => {
      client.deleteAll(r, (err, resp) => err ? reject(err) : resolve(resp));
    }), 10000, "user.deleteAll");
    return res.json({ ok: true, deviceId });
  } catch(e) { return res.status(502).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`[gsdk-sidecar] listening on ${PORT} - mode: grpc-gateway`);
  console.log(
    `[gsdk-sidecar] GSDK_GATEWAY=${GSDK_GATEWAY || "(unset)"} — Connect/Event use rpc_server :${GSDK_RPC_PORT} (device TCP is :${GSDK_DEVICE_PORT})`
  );
});