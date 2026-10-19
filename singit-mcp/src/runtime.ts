/** Restore the private devnet journal before exposing any MCP or HTTP writes. */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { buildBackendFromEnv } from "./backend/factory.js";
import { Capture402Backend } from "./backend/capture402.js";
import type { PaymentBackend } from "./backend/types.js";
import { PaymentService } from "./service.js";
import { FileStateStore } from "./store.js";

export class StartupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "StartupError";
  }
}

function outsideCheckout(dir: string): void {
  for (let parent = dir; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) {
      throw new StartupError("PRIVATE_STATE_REQUIRED", "SINGIT_STATE_DIR must be outside every Git checkout");
    }
    if (parent === dirname(parent)) break;
  }
}

function privateStore(dir: string | undefined): { store: FileStateStore; close: () => void } {
  if (!dir || !isAbsolute(dir) || dir === parse(dir).root) {
    throw new StartupError("PRIVATE_STATE_REQUIRED", "capture402 MCP requires an absolute SINGIT_STATE_DIR outside Git for its private durable journal");
  }
  outsideCheckout(dir);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new StartupError("PRIVATE_STATE_REQUIRED", "SINGIT_STATE_DIR must be a real directory, not a symlink");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(dir);
  if (canonical === parse(canonical).root) {
    throw new StartupError("PRIVATE_STATE_REQUIRED", "SINGIT_STATE_DIR must be a dedicated directory");
  }
  outsideCheckout(canonical);
  const journal = join(canonical, "state.jsonl");
  const journalInfo = lstatSync(journal, { throwIfNoEntry: false });
  if (journalInfo && (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.nlink !== 1)) {
    throw new StartupError("PRIVATE_STATE_REQUIRED", "The private journal must be a regular file, not a symlink");
  }
  chmodSync(canonical, 0o700);
  const close = exclusiveLock(
    join(canonical, ".singit-mcp.lock"),
    new StartupError("STATE_STORE_LOCKED", "Private state is locked by another or interrupted runtime. Verify that the previous process has stopped before removing .singit-mcp.lock"),
  );
  try {
    return { store: new FileStateStore(canonical), close };
  } catch (error) {
    close();
    throw error;
  }
}

/** O_EXCL lock file holding this pid; `locked` is thrown when it already exists. Never removed by age. */
function exclusiveLock(lock: string, locked: StartupError): () => void {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw locked;
    throw error;
  }
  const identity = fstatSync(fd);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
    try {
      const current = lstatSync(lock);
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * MVP-04: one writer per economic namespace (program + payer + merchant), not just per state
 * directory. A second runtime pointed at another SINGIT_STATE_DIR with the same wallets refuses,
 * because two journals for one set of wallets could each believe a reservation is free. The lock
 * lives in a host-wide directory (SINGIT_NAMESPACE_LOCK_DIR, default ~/.singit-mcp/locks); it does
 * not coordinate separate hosts. Skipped only when no economic identity is configured at all
 * (injected test backends), since there is then no namespace to protect.
 */
function namespaceLock(env: NodeJS.ProcessEnv): () => void {
  const parts = [env.SINGIT_PROGRAM_ID, env.SINGIT_PAYER_ADDRESS, env.SINGIT_MERCHANT_ADDRESS].map((v) => v ?? "");
  if (parts.every((v) => !v)) return () => {};
  const dir = env.SINGIT_NAMESPACE_LOCK_DIR || join(homedir(), ".singit-mcp", "locks");
  if (!isAbsolute(dir)) throw new StartupError("PRIVATE_STATE_REQUIRED", "SINGIT_NAMESPACE_LOCK_DIR must be an absolute path");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(`singit-namespace-v1|${parts.join("|")}`).digest("hex").slice(0, 32);
  return exclusiveLock(
    join(dir, `${name}.lock`),
    new StartupError("NAMESPACE_LOCKED", "Another or interrupted runtime holds these payer/merchant wallets (possibly with a different SINGIT_STATE_DIR). Verify it has stopped before removing its namespace lock"),
  );
}

export async function createServiceRuntime(
  env: NodeJS.ProcessEnv,
  options: { backend?: PaymentBackend; approvalSecret?: string; now?: () => number } = {},
): Promise<{ service: PaymentService; backendName: "devnet" | "mock"; close: () => void }> {
  const live = env.SINGIT_BACKEND === "capture402";
  if (!live && env.SINGIT_STATE_DIR) {
    throw new StartupError("MOCK_STATE_NOT_DURABLE", "SINGIT_STATE_DIR is for capture402; the mock ledger is in memory and cannot be restored from an operation journal alone");
  }
  // Startup order (MVP-04): path/permissions -> exclusive custody (state dir, then economic
  // namespace) -> load -> read-only reconciliation of originals -> preflight -> admission.
  const persistence = live ? privateStore(env.SINGIT_STATE_DIR) : undefined;
  let releaseNamespace = () => {};
  const closeAll = () => {
    releaseNamespace();
    persistence?.close();
  };
  try {
    if (live) releaseNamespace = namespaceLock(env);
    const backend = options.backend ?? buildBackendFromEnv(env);
    const service = new PaymentService({
      backend,
      approvalSecret: options.approvalSecret,
      now: options.now,
      store: persistence?.store,
      live,
    });
    if (live) {
      // Only the original transaction can settle an uncertain outcome. Recovery cannot send.
      await service.reconcilePending({ readOnly: true });
      const unresolved = service.listOperations().filter(op => op.state === "pending" || op.state === "unknown");
      if (unresolved.length) {
        throw new StartupError("STARTUP_RECONCILIATION_REQUIRED", `Startup stopped: ${unresolved.length} original operation(s) remain unresolved; journal and reservations retained. Inspect original signatures before restarting`);
      }
      if (backend instanceof Capture402Backend) {
        await backend.preflight(env.SINGIT_PAYER_ADDRESS ?? "", env.SINGIT_MERCHANT_ADDRESS ?? "");
      }
    }
    const close = () => {
      // Graceful shutdown: stop admitting economic writes first; journal and evidence stay as they are.
      service.closeAdmission("ADMISSION_CLOSED", "runtime is shutting down");
      closeAll();
    };
    return { service, backendName: live ? "devnet" : "mock", close };
  } catch (error) {
    closeAll();
    throw error;
  }
}
