import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

const scrypt = promisify(scryptCallback);
const databasePath = path.resolve(process.env.DATABASE_PATH ?? "./data/omp-builder.db");
const prompt = createInterface({ input, output });
const lines = [];
for await (const line of prompt) lines.push(line);
const email = (lines[0] ?? "").trim();
const password = lines[1] ?? "";
if (!email || password.length < 12) throw new Error("Email is required and password must be at least 12 characters");
const db = new Database(databasePath);
try {
  const admin = db.prepare("SELECT id FROM admins ORDER BY created_at LIMIT 1").get();
  if (!admin) throw new Error("No administrator exists; use the browser first-time setup flow instead");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  const hash = Buffer.from(derived).toString("hex");
  db.prepare("UPDATE admins SET email = ?, password_hash = ?, password_salt = ? WHERE id = ?").run(email, hash, salt, admin.id);
  db.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE admin_id = ?").run(new Date().toISOString(), admin.id);
  console.log("Administrator credentials updated; existing sessions revoked.");
} finally {
  db.close();
}
