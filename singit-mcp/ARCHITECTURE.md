# SingIt Agent Payments: architecture

Two autonomous agents pay each other in devnet USDC. A human sets the mandate, and only a human can resolve a dispute.

## Components

- **Buyer agent** (e.g. Claude Code with the SingIt MCP) holds a mandate and pays for services.
- **Seller agent / service** (SingIt) captures what it delivered, releases the rest and refunds.
- **SingIt MCP server** (`singit-mcp`, built here). Its **mandate engine** (`PaymentService`) enforces budget, per-tx cap, expiry, counterparties, mint and deadline sanity, plus disputes and the **audit log**. It is exposed as MCP tools over stdio or streamable HTTP.
- **PaymentBackend** is the contract (`INTERFACE.md`). Implementations are `MockBackend` (in-memory, demo/tests) and `Capture402Backend` → **capture402-solana** escrow program on **Solana devnet** (teammate).
- **Demo dashboard** (Demo/QA agent) shows the timeline, audit log and BLOCKED events, with an explorer link per `txSig`. It doubles as the human approval console.

```mermaid
flowchart LR
  B[Buyer agent] -- MCP tools --> S
  V[Seller agent / SingIt service] -- MCP tools --> S
  subgraph S[SingIt MCP server]
    M[Mandate engine<br/>PaymentService] --> A[(Audit log)]
  end
  M -- PaymentBackend --> MB[MockBackend]
  M -- PaymentBackend --> CB[Capture402Backend]
  CB -- authorize / capture / void / refund --> P[(capture402-solana<br/>escrow program, devnet USDC)]
  H((Human)) -- approval token<br/>npm run approve / dashboard --> M
  D[Demo dashboard] -- reads --> A
```

## Demo flow

```mermaid
sequenceDiagram
  actor H as Human
  participant B as Buyer agent
  participant S as SingIt MCP (mandate engine)
  participant V as Seller agent
  participant C as capture402 (devnet)
  H->>S: create_mandate(budget 10 USDC, per-tx 4, expiry, allow [seller])
  B->>S: hold(4 USDC → seller)
  S->>S: check mandate ✔
  S->>C: authorize (max 4, deadlines)
  V->>S: capture(2.5)
  S->>C: capture
  V->>S: release()
  S->>C: void (1.5 back to buyer)
  B->>S: hold(5 USDC)
  S-->>B: BLOCKED OVER_PER_TX_CAP (no tx)
  B->>S: open_dispute(evidence)
  Note over S: captures frozen on that hold
  B->>S: resolve_dispute(no token)
  S-->>B: BLOCKED HUMAN_APPROVAL_REQUIRED
  H->>H: npm run approve d-1 refund 2500000
  H->>S: resolve_dispute(token)
  S->>C: refund 2.5 (merchant-signed)
```

## Trust boundaries

| Limit | Where it is enforced |
|---|---|
| Total budget across payments, per-tx cap, mandate expiry, allowed counterparties | **Off-chain**, in the mandate engine, before any tx (QA M-1). |
| Mint = devnet USDC | **Off-chain**, checked on the request and on the hold read back. The program accepts any classic mint (QA M-2). |
| Deadline sanity (seconds not ms, max 7-day hold, refund window ≥ 1 h) | **Off-chain** (QA M-3). |
| A capture can never exceed the hold. Funds are locked until capture/void/reclaim. Refund only before the refund deadline. | **On-chain**: immutable `maximum` and deadlines in the capture402 escrow. |
| Payer reclaims an unused hold if the seller vanishes | **On-chain** `reclaim`, at or after the capture deadline, with no merchant consent needed. |
| Dispute resolution | **Off-chain plus a human.** capture402 has no arbiter (QA H-1). `resolve_dispute` requires an HMAC approval token tied to *(dispute, outcome, amount)*. Only the human holds `SINGIT_HUMAN_APPROVAL_SECRET` (CLI `npm run approve` or the dashboard console). No MCP tool returns the secret or a token, so an agent cannot approve itself or change the amount. The refund is then signed with the merchant key held by the backend. |

Every call, whether executed or **blocked**, writes an audit row: actor, action, outcome, code, reason, amounts, `txSig`, held/refundable after.

## Pre-existing vs built during the hackathon

- **Pre-existing:** SingIt (the product and its x402 paid API) and capture402-solana (the escrow program and x402 integration, by the teammate).
- **Built during the hackathon:** the SingIt MCP server, the mandate engine, the PaymentBackend contract, MockBackend, the Capture402Backend integration, the human-approval dispute flow, the audit log, the tests, the demo script and the demo dashboard.
