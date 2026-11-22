import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function masterKey(): Buffer {
  const raw = process.env.OMP_MASTER_KEY;
  if (!raw) throw new Error("OMP_MASTER_KEY is required for provider credentials");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("OMP_MASTER_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptSecret(secret: string): { ciphertext: string; nonce: string; tag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function decryptSecret(ciphertext: string, nonce: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(nonce, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
export function credentialEnvName(providerId: string): string {
  return `OMP_BUILDER_KEY_${createHash("sha256").update(providerId).digest("hex").slice(0, 24).toUpperCase()}`;
}
export function validateProviderUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Provider URL must be an HTTP(S) base URL without credentials or query parameters");
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Non-local provider URLs must use HTTPS");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) return url.toString().replace(/\/$/, "");
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "0.0.0.0" || host === "[::]") throw new Error("Provider URL targets a private network address");
  return url.toString().replace(/\/$/, "");
}
