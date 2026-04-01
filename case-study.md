# Mapping Ethereum Staking Operators: From 1 Address to 788 Validators (and When It Breaks)

## TL;DR

One Gnosis Safe withdrawal address → 47 sibling Safes → 24 withdrawal endpoints → 788 validators → ~25,216 staked ETH (~$75M+). A different address → pooled protocol with 4,991 depositors, no clustering possible. The tool distinguishes both and degrades correctly.

## Method

`beacon-forensics` takes a single Ethereum withdrawal address and runs a five-stage attribution pipeline: (1) identify validators receiving beacon chain rewards at that address via Blockscout, (2) detect Gnosis Safe multisig structure via on-chain calls, (3) attribute the depositor who funded validators at the Beacon Deposit Contract via BigQuery, (4) correlate sibling Safes sharing the exact same owner set via the Safe Transaction Service, and (5) roll up the full operator footprint with a component-based confidence score.

## Case A — Institutional Operator

**Input:** `0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9`

```bash
node index.mjs lookup --withdrawal 0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9
```

**Key findings:**

| Metric | Value |
|---|---|
| Validators (this Safe) | 23 |
| Withdrawal Type | Gnosis Safe (3-of-6) |
| Operator Type | `single_operator_like` |
| Depositor | `0x5a436013...` (1 EOA) |
| Deposits | 40 × 32 ETH = 1,280 ETH |
| Exact-Match Sibling Safes | 47 |
| Withdrawal Addresses (with validators) | 24 |
| **Total Validators (cluster)** | **788** |
| **Estimated Staked ETH** | **25,216** |
| Confidence | **0.91** |

**Confidence breakdown:**

| Signal | Score |
|---|---|
| Safe Detected | 0.20 |
| Validator Cohort Mapped | 0.20 |
| Depositor Attributed (BQ) | 0.20 |
| Exact Owner-Set Cluster | 0.20 |
| Evidence Complete | 0.11 |
| **Total** | **0.91** |

**Interpretation:** An unlabeled institutional staking operation using a consistent 6-person 3-of-6 multisig structure across 47 Safes. The same depositor hot wallet (`0x5a4360...`) provisions validators across all withdrawal addresses. Provider identity remains unresolved — not Figment, Lido, Coinbase, Kraken, RocketPool, Kiln, or P2P.org based on exclusion analysis.

## Case B — Pooled Protocol

**Input:** `0x6be457e04092b28865e0cba84e3b2cfa0f871e67`

```bash
node index.mjs lookup --withdrawal 0x6be457e04092b28865e0cba84e3b2cfa0f871e67
```

**Key findings:**

| Metric | Value |
|---|---|
| Validators | 550 |
| Withdrawal Type | EOA (contract, not Safe) |
| Operator Type | `pooled_protocol` |
| Depositors | 4,991 unique EOAs |
| Deposits | 15,013 |
| Total ETH Deposited | 7,832,791 |
| Safe Detected | No |
| Sibling Safes | N/A |
| Confidence | **0.40** |

**Interpretation:** A pooled staking protocol where thousands of individual depositors fund validators through a shared withdrawal contract. The tool correctly identifies the absence of Safe-based operator structure, refuses to cluster, and downgrades confidence to 0.40 (only 2 of 5 evidence signals present). This is negative attribution — the tool tells you what it *can't* determine, which is still useful.

## Where It Works / Where It Breaks

**Works well:**
- Safe-based institutional operators with consistent owner sets
- Single-depositor or small-depositor-group staking arrangements
- Operators using multiple Safes for withdrawal segregation (vintage/cohort model)

**Degrades gracefully:**
- Pooled protocols (Lido, RocketPool, etc.) — identified as `pooled_protocol`, no false clustering
- Contracts without Safe interface — classified as `eoa`, confidence drops appropriately
- Missing BigQuery auth — emits ready-to-run BQ query, falls back to chain trace or manual override

**Known limitations:**
- Validator signing-key custody is not proven from withdrawal-side evidence
- Rotating owner sets break exact-match logic (future: partial-overlap scoring)
- Legacy solc contracts (< 0.5.0) may be skipped in bytecode verification contexts
- Blockscout pagination may undercount; BigQuery provides full deposit counts

## Reproduce

```bash
git clone https://github.com/ivan09069/beacon-forensics
cd beacon-forensics
# For BigQuery depositor attribution:
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Case A (operator)
node index.mjs lookup --withdrawal 0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9 --format markdown

# Case B (pool)
node index.mjs lookup --withdrawal 0x6be457e04092b28865e0cba84e3b2cfa0f871e67
```

## Repo

- **Source:** [github.com/ivan09069/beacon-forensics](https://github.com/ivan09069/beacon-forensics)
- **Validation:** [validation.md](https://github.com/ivan09069/beacon-forensics/blob/master/validation.md)
- **Version:** v1.1.0

---
*CLI that maps validator operators from a single withdrawal address — and tells you when it can't.*
