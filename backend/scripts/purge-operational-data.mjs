/**
 * One-shot: remove operational collections (same set as Settings → Reset Application, minus auth).
 * Usage: MONGODB_URI=mongodb://localhost:27017/expo-fr node scripts/purge-operational-data.mjs
 * Does not delete accounts or system_config.
 */
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/expo-fr";
const dbName = "expo-fr";
const targets = [
  "employees",
  "visitors",
  "logs",
  "alerts",
  "devices",
  "buildings",
  "zones",
  "companies",
  "attendance_subscriptions"
];

const client = new MongoClient(uri);
async function main() {
  await client.connect();
  const db = client.db(dbName);
  const deleted = {};
  for (const name of targets) {
    const r = await db.collection(name).deleteMany({});
    deleted[name] = r.deletedCount;
  }
  console.log("[purge]", JSON.stringify({ ok: true, deleted, at: new Date().toISOString() }, null, 2));
  await client.close();
}
main().catch((e) => {
  console.error("[purge] failed:", e.message);
  process.exit(1);
});
