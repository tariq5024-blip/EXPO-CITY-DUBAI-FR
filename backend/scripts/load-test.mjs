import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/expo-fr";
const dbName = process.env.DB_NAME || "expo-fr";
const companyCount = Number(process.env.LOADTEST_COMPANIES || 100);
const employeeCount = Number(process.env.LOADTEST_EMPLOYEES || 6000);
const logsPerEmployee = Number(process.env.LOADTEST_LOGS_PER_EMPLOYEE || 4);

function rnd(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[rnd(0, arr.length - 1)];
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const now = new Date();

  console.log("[loadtest] start");
  const t0 = Date.now();

  const companies = Array.from({ length: companyCount }).map((_, i) => ({
    name: `Company ${String(i + 1).padStart(3, "0")}`,
    code: `C${String(i + 1).padStart(3, "0")}`,
    status: "active",
    createdAt: now,
    updatedAt: now
  }));
  await db.collection("companies").deleteMany({});
  if (companies.length) await db.collection("companies").insertMany(companies, { ordered: false });
  const companyRows = await db.collection("companies").find({}, { projection: { _id: 1, code: 1, name: 1 } }).toArray();

  const employees = Array.from({ length: employeeCount }).map((_, i) => {
    const c = pick(companyRows);
    const employeeId = String(100000 + i);
    return {
      employeeId,
      supremaUserId: employeeId,
      name: `Employee ${i + 1}`,
      companyId: c?._id || null,
      companyCode: c?.code || "",
      companyName: c?.name || "",
      designation: pick(["Guard", "Operator", "Manager", "Supervisor"]),
      department: pick(["Security", "Operations", "Facilities", "Admin"]),
      division: pick(["North", "South", "East", "West"]),
      status: "active",
      enrolled: true,
      authMode: "Face Only",
      createdAt: now,
      updatedAt: now
    };
  });
  await db.collection("employees").deleteMany({});
  if (employees.length) await db.collection("employees").insertMany(employees, { ordered: false });

  const logs = [];
  const eventTypes = ["ACCESS_GRANTED", "ACCESS_DENIED"];
  for (const e of employees) {
    for (let i = 0; i < logsPerEmployee; i++) {
      const granted = pick([true, true, true, false]);
      const minsAgo = rnd(1, 60 * 24 * 30);
      const ts = new Date(Date.now() - minsAgo * 60 * 1000);
      logs.push({
        employeeId: e.employeeId,
        employeeName: e.name,
        eventType: granted ? "ACCESS_GRANTED" : "ACCESS_DENIED",
        accessGranted: granted,
        granted,
        authMode: "Face Only",
        zone: pick(["Main Gate", "Lobby", "Server Room", "Parking"]),
        device: pick(["BS3-1", "BS3-2", "FSF2-1"]),
        deviceId: String(rnd(500000000, 599999999)),
        supremaLogId: rnd(1, 9999999),
        confidence: granted ? rnd(82, 99) : rnd(40, 79),
        processingMs: rnd(120, 390),
        createdAt: ts,
        timestamp: ts
      });
    }
  }
  await db.collection("logs").deleteMany({});
  if (logs.length) {
    const chunk = 10000;
    for (let i = 0; i < logs.length; i += chunk) {
      await db.collection("logs").insertMany(logs.slice(i, i + chunk), { ordered: false });
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[loadtest] done in ${elapsed} ms (companies=${companies.length}, employees=${employees.length}, logs=${logs.length})`
  );
  await client.close();
}

main().catch((err) => {
  console.error("[loadtest] failed:", err.message);
  process.exit(1);
});
