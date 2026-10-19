/**
 * Trusted principals. The caller's role and wallet identity come from the transport (an HTTP
 * bearer token, or the stdio process environment), never from tool input. Agents are "buyer"
 * (spends from mandates whose payer is its wallet) or "merchant" (captures/releases/refunds holds
 * whose payee is its wallet). The human is not an MCP principal: it uses the HTTP /human/* routes
 * (SINGIT_HUMAN_ROUTE_SECRET) or the out-of-band `npm run approve` CLI.
 */
import { timingSafeEqual } from "node:crypto";

export type AgentRole = "buyer" | "merchant";

export interface Principal {
  role: AgentRole;
  /** The configured wallet identity this role acts as (payer address for buyer, merchant address for merchant). */
  id: string;
}

export interface AgentCredential extends Principal {
  token: string;
}

export const MIN_SECRET_LENGTH = 16;

/** Identities used by the mock backend when no wallet address is configured (both are seeded in DEFAULT_MOCK_BALANCES). */
export const MOCK_BUYER_ID = "agent:research-bot";
export const MOCK_MERCHANT_ID = "agent:data-vendor";

export class PrincipalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalConfigError";
  }
}

/** Constant-time string compare; unequal lengths are rejected without a timingSafeEqual call. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Resolves `Authorization: Bearer <token>` to a principal. Compares against every credential (no early exit). */
export function principalFromAuthorization(header: string | undefined, credentials: AgentCredential[]): Principal | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (!match) return undefined;
  let found: Principal | undefined;
  for (const credential of credentials) {
    if (secretsMatch(match[1], credential.token) && !found) found = { role: credential.role, id: credential.id };
  }
  return found;
}

export interface PrincipalConfig {
  buyerId?: string;
  merchantId?: string;
  credentials: AgentCredential[];
}

/**
 * Reads SINGIT_BUYER_TOKEN / SINGIT_MERCHANT_TOKEN (>= 16 chars) and binds them to
 * SINGIT_PAYER_ADDRESS / SINGIT_MERCHANT_ADDRESS. The mock backend falls back to the
 * MOCK_* identities. Throws on ambiguous configuration (shared tokens or identities).
 */
export function principalConfigFromEnv(env: Record<string, string | undefined>, opts: { mock: boolean }): PrincipalConfig {
  const buyerId = env.SINGIT_PAYER_ADDRESS || (opts.mock ? MOCK_BUYER_ID : undefined);
  const merchantId = env.SINGIT_MERCHANT_ADDRESS || (opts.mock ? MOCK_MERCHANT_ID : undefined);
  if (buyerId && merchantId && buyerId === merchantId) {
    throw new PrincipalConfigError("buyer and merchant identities must differ");
  }
  const credentials: AgentCredential[] = [];
  const add = (role: AgentRole, token: string | undefined, id: string | undefined, tokenVar: string) => {
    if (!token) return;
    if (token.length < MIN_SECRET_LENGTH) throw new PrincipalConfigError(`${tokenVar} must contain at least ${MIN_SECRET_LENGTH} characters`);
    if (!id) throw new PrincipalConfigError(`${tokenVar} is set but the ${role} wallet identity is not configured`);
    credentials.push({ role, id, token });
  };
  add("buyer", env.SINGIT_BUYER_TOKEN, buyerId, "SINGIT_BUYER_TOKEN");
  add("merchant", env.SINGIT_MERCHANT_TOKEN, merchantId, "SINGIT_MERCHANT_TOKEN");
  const secrets = [
    ...credentials.map((c) => c.token),
    env.SINGIT_HUMAN_ROUTE_SECRET,
    env.SINGIT_HUMAN_APPROVAL_SECRET,
  ].filter((s): s is string => !!s);
  if (new Set(secrets).size !== secrets.length) {
    throw new PrincipalConfigError("agent tokens and human secrets must all be distinct");
  }
  return { buyerId, merchantId, credentials };
}

/** stdio: the process environment fixes the principal (SINGIT_MCP_PRINCIPAL=buyer|merchant). */
export function stdioPrincipalFromEnv(env: Record<string, string | undefined>, config: PrincipalConfig): Principal {
  const role = env.SINGIT_MCP_PRINCIPAL;
  if (role !== "buyer" && role !== "merchant") {
    throw new PrincipalConfigError("stdio requires SINGIT_MCP_PRINCIPAL=buyer or SINGIT_MCP_PRINCIPAL=merchant");
  }
  const id = role === "buyer" ? config.buyerId : config.merchantId;
  if (!id) throw new PrincipalConfigError(`stdio ${role} principal requires its wallet identity to be configured`);
  return { role, id };
}

export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/** Hostname part of a Host header value ("127.0.0.1:8787" -> "127.0.0.1", "[::1]:80" -> "[::1]"). */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/** Comma-separated env list -> lowercased entries (empty -> undefined so callers keep their default). */
export function listFromEnv(raw: string | undefined): string[] | undefined {
  const items = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : undefined;
}
