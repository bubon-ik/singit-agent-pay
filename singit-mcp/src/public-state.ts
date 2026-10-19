/** Public operation status only. Original signed evidence stays in the private journal. */
function fields(source: unknown, names: readonly string[]): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;
  for (const name of names) {
    const value = (source as Record<string, unknown>)[name];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[name] = value;
    } else if (typeof value === "bigint") {
      result[name] = value.toString();
    }
  }
  return result;
}

export function publicOperation(value: unknown): Record<string, unknown> {
  const op = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: Record<string, unknown> = fields(op, [
    "id", "action", "actor", "mandateId", "holdId", "disputeId",
    "state", "reservation", "createdAt", "updatedAt",
  ]);
  for (const [name, allowed] of [
    ["params", ["amount", "refundAmount"]],
    ["expected", ["held", "refundable"]],
    ["prepared", ["txSig", "holdId", "lastValidBlockHeight"]],
    ["result", ["txSig", "holdId"]],
    ["error", ["code", "message", "refusalCode"]],
  ] as const) {
    if (op[name] && typeof op[name] === "object") result[name] = fields(op[name], allowed);
  }
  return result;
}
