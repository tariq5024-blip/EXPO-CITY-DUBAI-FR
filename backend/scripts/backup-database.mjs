import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";

const gzip = promisify(zlib.gzip);

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/expo-fr";
const dbName = process.env.DB_NAME || "expo-fr";
const outDir = process.env.BACKUP_DIR || path.resolve(process.cwd(), "..", "backups");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `expo-fr-backup-${stamp}.json.gz`);
const collections = [
  "accounts",
  "companies",
  "employees",
  "visitors",
  "devices",
  "logs",
  "alerts",
  "buildings",
  "zones",
  "system_config",
  "attendance_subscriptions"
];

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  await fs.mkdir(outDir, { recursive: true });

  const payload = {
    meta: { dbName, createdAt: new Date().toISOString(), collections },
    data: {}
  };

  for (const name of collections) {
    const rows = await db.collection(name).find({}).toArray();
    payload.data[name] = rows;
    console.log(`[backup] ${name}: ${rows.length}`);
  }

  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const zipped = await gzip(raw, { level: 9 });
  await fs.writeFile(outFile, zipped);
  await client.close();
  console.log(`[backup] done: ${outFile}`);
}

main().catch((err) => {
  console.error("[backup] failed:", err.message);
  process.exit(1);
});
