import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const envFilePath = path.join(projectRoot, ".env");

// Only the repository-root file is loaded, and only values that the process
// environment does not already define. This makes workspace scripts and
// service managers deterministic instead of cwd-dependent.
dotenv.config({ path: envFilePath, override: false });

const appEnvironment = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
export const isProduction = appEnvironment === "production";

function parsePort(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric TCP port`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function parseOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Invalid WEB_ORIGINS entry: ${value}`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`Invalid WEB_ORIGINS entry: ${value}`);
  return parsed.origin;
}

const configuredOriginValue = process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173";
const allowedOrigins = new Set(configuredOriginValue.split(",").map((candidate) => candidate.trim()).filter(Boolean).map(parseOrigin));
if (!allowedOrigins.size) throw new Error("WEB_ORIGINS must contain at least one origin");
const dynamicForwardOriginEnabled = !isProduction && process.env.DEV_DYNAMIC_FORWARD_ORIGIN !== "false";
const devForwardHost = process.env.DEV_FORWARD_HOST ?? "new-lovable.localhost";
if (devForwardHost !== "new-lovable.localhost") throw new Error("DEV_FORWARD_HOST must be new-lovable.localhost");
const devForwardPort = parsePort(process.env.DEV_FORWARD_PORT, "DEV_FORWARD_PORT");
const databasePathExplicit = Boolean(process.env.DATABASE_PATH?.trim());
const databasePath = path.resolve(projectRoot, process.env.DATABASE_PATH ?? "data/omp-builder.db");

if (databasePathExplicit && !existsSync(databasePath)) {
  throw new Error(`DATABASE_PATH does not exist: ${databasePath}. Refusing to create an empty database at an explicitly configured path.`);
}
if (databasePathExplicit && !statSync(databasePath).isFile()) {
  throw new Error(`DATABASE_PATH is not a regular file: ${databasePath}`);
}

export const config = {
  appEnvironment,
  envFilePath,
  projectRoot,
  port: Number(process.env.API_PORT ?? 8787),
  host: process.env.API_HOST ?? "127.0.0.1",
  cookieName: process.env.SESSION_COOKIE_NAME ?? "omp_builder_session",
  sessionTtlMs: Number(process.env.SESSION_TTL_DAYS ?? 14) * 86_400_000,
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === "true",
  databasePath,
  databasePathConfigured: databasePathExplicit,
  projectsRoot: path.resolve(projectRoot, process.env.PROJECTS_ROOT ?? "data/projects"),
  sessionRoot: path.resolve(projectRoot, process.env.OMP_SESSION_ROOT ?? "data/omp-sessions"),
  configDir: path.resolve(projectRoot, process.env.OMP_CONFIG_DIR ?? "data/omp-config"),
  ompBinary: process.env.OMP_BIN ?? "omp",
  ompMaxProcesses: Math.max(1, Number(process.env.OMP_MAX_PROCESSES ?? 2)),
  ompIdleMs: Math.max(1_000, Number(process.env.OMP_IDLE_MS ?? 900_000)),
  // Phase 3.5 §2: OMP RPC children run as the omp-builder service user by
  // default (the API itself runs as that user; see
  // docs/MIGRATION-PHASE3.5-2.md). An explicit OMP_RUN_AS_USER_PROJECT_IDS
  // list still acts as an allowlist when set; an empty/unset list now
  // means ALL projects. Set OMP_RUN_AS_USER=false to restore root spawn
  // for every project (escape hatch for rollback/debug only).
  ompRunAsUserAll: process.env.OMP_RUN_AS_USER !== "false",
  ompRunAsUserProjectIds: new Set((process.env.OMP_RUN_AS_USER_PROJECT_IDS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)),
  allowedOrigins,
  devForwardHost,
  devForwardPort,
  dynamicForwardOriginEnabled,
  ompMasterKeyConfigured: Boolean(process.env.OMP_MASTER_KEY),
  ompMasterKeyValid: (() => {
    const raw = process.env.OMP_MASTER_KEY;
    if (!raw) return false;
    try {
      return Buffer.from(raw, "base64").length === 32;
    } catch {
      return false;
    }
  })(),
  sessionSecretConfigured: Boolean(process.env.SESSION_SECRET),
};

export function isAllowedOrigin(value: string | undefined): boolean {
  if (!value) return false;
  if (config.allowedOrigins.has(value)) return true;
  if (!config.dynamicForwardOriginEnabled) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.hostname !== config.devForwardHost) return false;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    if (!/^\d+$/.test(parsed.port)) return false;
    const port = Number(parsed.port);
    if (port < 1 || port > 65535) return false;
    return config.devForwardPort === undefined || port === config.devForwardPort;
  } catch {
    return false;
  }
}

export function startupDiagnostics(): Record<string, unknown> {
  return {
    environmentFile: config.envFilePath,
    databasePath: config.databasePath,
    permittedDevelopmentOrigins: [
      ...config.allowedOrigins,
      ...(config.dynamicForwardOriginEnabled ? [`http://${config.devForwardHost}:${config.devForwardPort ?? "<numeric-port>"}`] : []),
    ],
    ompExecutable: config.ompBinary,
    ompMasterKeyConfigured: config.ompMasterKeyConfigured,
    ompMasterKeyValid: config.ompMasterKeyValid,
    sessionSecretConfigured: config.sessionSecretConfigured,
  };
}
