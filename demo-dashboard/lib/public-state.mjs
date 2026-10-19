/** Public operation status for both remote and in-process dashboard sources. */
function fields(source, names) {
  const result = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;
  for (const name of names) {
    const value = source[name];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[name] = value;
    } else if (typeof value === "bigint") {
      result[name] = value.toString();
    }
  }
  return result;
}

export function publicOperation(value) {
  const op = value && typeof value === "object" ? value : {};
  const result = fields(op, [
    "id", "action", "actor", "mandateId", "holdId", "disputeId",
    "state", "reservation", "createdAt", "updatedAt",
  ]);
  for (const [name, allowed] of [
    ["params", ["amount", "refundAmount"]],
    ["expected", ["held", "refundable"]],
    ["prepared", ["txSig", "holdId", "lastValidBlockHeight"]],
    ["result", ["txSig", "holdId"]],
    ["error", ["code", "message", "refusalCode"]],
  ]) {
    if (op[name] && typeof op[name] === "object") result[name] = fields(op[name], allowed);
  }
  return result;
}
