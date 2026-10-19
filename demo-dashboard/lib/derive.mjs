export function deriveTimeline(audit, mandates) {
  const holdById = new Map(mandates.flatMap((m) => (m.holds ?? []).map((h) => [h.id, h])));
  const kinds = { create_mandate: "mandate", hold: "hold", capture: "capture", release: "release", refund: "refund", open_dispute: "dispute", resolve_dispute: "resolve", reset: "reset" };
  return audit.map((a, index) => {
    const failed = a.outcome !== "ok", code = a.code ?? null;
    const blockedLabels = { OVER_PER_TX_CAP: "over per-tx cap", COUNTERPARTY_NOT_ALLOWED: "counterparty not allowed", OVER_BUDGET: "over budget", HUMAN_APPROVAL_REQUIRED: "human approval required", PRINCIPAL_FORBIDDEN: "not allowed for this agent" };
    const hold = holdById.get(a.holdId);
    const amount = (value) => value == null ? null : `${(Number(value) / 1_000_000).toFixed(2)} USDC`;
    const mandate = mandates.find((m) => m.id === a.mandateId);
    const a0 = amount(a.amount);
    const payee = String(hold?.payee ?? "").replace(/^agent:/, "");
    let message;
    let detail;
    if (code === "OPERATION_UNKNOWN") {
      message = "OUTCOME UNKNOWN: funds reserved, reconciling";
      detail = String(a.reason ?? "").replace(/^BLOCKED:\s*/, "");
    } else if (code === "OPERATION_PENDING") {
      message = "WAIT: operation already in flight";
      detail = String(a.reason ?? "").replace(/^BLOCKED:\s*/, "");
    } else if (/outcome_unknown/i.test(a.action ?? "")) {
      message = `Outcome unknown${a0 ? ` · ${a0}` : ""} — funds reserved`;
      detail = String(a.reason ?? "").replace(/^BLOCKED:\s*/, "");
    } else if (/reconcile/i.test(a.action ?? "")) {
      message = `Reconciled${a0 ? ` ${a0}` : ""}: ${a.reason || a.outcome}`;
      detail = String(a.reason ?? "").replace(/^BLOCKED:\s*/, "");
    } else if (failed) {
      message = `BLOCKED: ${blockedLabels[code] ?? String(code ?? "error").toLowerCase().replaceAll("_", " ")}`;
      detail = String(a.reason ?? "").replace(/^BLOCKED:\s*/, "");
    } else if (a.action === "create_mandate") {
      const created = a0 ?? amount(mandate?.totalBudget);
      message = `Mandate ${a.mandateId} created${created ? ` · ${created}` : ""}`;
    }
    else if (a.action === "hold") message = `Hold${a0 ? ` ${a0}` : ""} → ${payee}`;
    else if (a.action === "capture") message = `Captured${a0 ? ` ${a0}` : ""}`;
    else if (a.action === "release") message = `Released${a0 ? ` ${a0}` : ""} to payer`;
    else if (a.action === "refund") message = `Refunded${a0 ? ` ${a0}` : ""} (budget not restored)`;
    else if (a.action === "open_dispute") message = `Dispute ${a.disputeId} opened`;
    else if (a.action === "resolve_dispute") {
      const reason = String(a.reason ?? "");
      if (/\brejected\b/i.test(reason)) message = "Human rejected dispute";
      else if (/refund|approved/i.test(reason) || (a.amount != null && Number(a.amount) > 0)) message = `Human approved refund${a0 ? ` ${a0}` : ""}`;
      else message = "Dispute resolved";
    }
    else if (a.action === "reset") message = "Mock state reset by human";
    else message = a.reason;
    const kind = code === "OPERATION_UNKNOWN" || /outcome_unknown/i.test(a.action ?? "") ? "unknown" : code === "OPERATION_PENDING" ? "pending" : /reconcile/i.test(a.action ?? "") ? "reconcile" : a.action === "reset" ? "reset" : failed ? "blocked" : kinds[a.action] ?? "blocked";
    const ok = kind === "unknown" || kind === "pending" || kind === "reconcile" ? true : !failed;
    return { key: a.seq ?? `${a.ts}:${index}`, ts: a.ts, kind, ok, message, detail, code, amount: a.amount, txRef: a.txSig, mandateId: a.mandateId, holdId: a.holdId, disputeId: a.disputeId, payee: hold?.payee };
  });
}
