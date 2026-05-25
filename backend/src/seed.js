import "dotenv/config";
import { MongoClient } from "mongodb";

/**
 * Minimal bootstrap: upserts the default Mongo-backed account only.
 * Does not insert sample employees, devices, logs, or companies.
 */
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/expo-fr";
const DB_NAME = "expo-fr";
const client = new MongoClient(MONGODB_URI);

const now = new Date();
const accounts = [
  {
    username: "superadmin",
    name: "Super Admin",
    role: "superadmin",
    status: "active",
    password: process.env.SEED_SUPERADMIN_PASSWORD || "password",
    createdAt: now,
    updatedAt: now
  }
];

async function main() {
  await client.connect();
  const db = client.db(DB_NAME);

  console.log("[seed] Upserting default account (no sample dataset).");
  for (const doc of accounts) {
    await db.collection("accounts").updateOne(
      { username: doc.username },
      { $set: doc },
      { upsert: true }
    );
  }

  console.log("[seed] Completed.");
  await client.close();
}

main().catch(async (error) => {
  console.error("[seed] Failed:", error.message);
  await client.close();
  process.exit(1);
});
