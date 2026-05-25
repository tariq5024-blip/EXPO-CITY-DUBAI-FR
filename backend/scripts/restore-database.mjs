import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { MongoClient, ObjectId } from "mongodb";

const gunzip = promisify(zlib.gunzip);

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/expo-fr";
const dbName = process.env.DB_NAME || "expo-fr";
const inFile = process.argv[2] ? path.resolve(process.argv[2]) : "";
const preserveAccounts = String(process.env.RESTORE_PRESERVE_ACCOUNTS ?? "false").toLowerCase() === "true";

function reviveObjectId(doc) {
  if (Array.isArray(doc)) return doc.map(reviveObjectId);
  if (!doc || typeof doc !== "object") return doc;
  if (doc.$oid && typeof doc.$oid === "string") return new ObjectId(doc.$oid);
  const out = {};
  for (const [k, v] of Object.entries(doc)) out[k] = reviveObjectId(v);
  return out;
}

async function main() {
  if (!inFile) {
    throw new Error("Usage: node scripts/restore-database.mjs <backup-file.json.gz>");
  }
  const rawZip = await fs.readFile(inFile);
  const raw = await gunzip(rawZip);
  const payload = JSON.parse(raw.toString("utf8"));
  const rowsByCollection = payload?.data || {};

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const ordered = Object.keys(rowsByCollection);
  for (const name of ordered) {
    if (name === "accounts" && preserveAccounts) {
      console.log("[restore] skipping accounts due to RESTORE_PRESERVE_ACCOUNTS=true");
      continue;
    }
    const rows = Array.isArray(rowsByCollection[name]) ? rowsByCollection[name].map(reviveObjectId) : [];
    await db.collection(name).deleteMany({});
    if (rows.length) {
      await db.collection(name).insertMany(rows, { ordered: false });
    }
    console.log(`[restore] ${name}: ${rows.length}`);
  }
  await client.close();
  console.log("[restore] done");
}

main().catch((err) => {
  console.error("[restore] failed:", err.message);
  process.exit(1);
});
