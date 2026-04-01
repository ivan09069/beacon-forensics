# beacon-forensics

CLI tool that maps an Ethereum validator operator's full infrastructure from a single withdrawal address.

Given one address, it identifies the validator cohort, detects Gnosis Safe multisig control, attributes the depositor via BigQuery, clusters sibling Safes by owner set, and quantifies the operator's total staked footprint.

## Quick Start

```bash
node index.mjs lookup --withdrawal 0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9
```

## What It Does

```
withdrawal address
  → Safe detection (threshold, owners)
  → validator cohort (via Blockscout withdrawals)
  → depositor attribution (via BigQuery)
  → sibling Safe clustering (via Safe Transaction Service)
  → exact vs partial owner-set classification
  → operator footprint rollup
```

## Sample Output (JSON)

```json
{
  "validators_found": 23,
  "withdrawal_type": "gnosis_safe",
  "deposit_attribution": {
    "method": "bigquery_live",
    "depositor_eoas": ["0x5a436013386f7d60b965e8ece3113036aa3cf212"],
    "deposit_count_matched": 40,
    "total_eth_deposited": 1280
  },
  "cluster_summary": {
    "exact_match_safes": 47,
    "exact_match_withdrawal_addresses": 24,
    "exact_match_validators": 788,
    "estimated_staked_eth": 25216
  },
  "confidence": 0.91,
  "confidence_breakdown": {
    "safe_detected": 0.2,
    "validator_cohort_mapped": 0.2,
    "depositor_attributed": 0.2,
    "exact_owner_set_cluster": 0.2,
    "evidence_complete": 0.11,
    "total": 0.91
  },
  "safe": { "threshold": 3, "owner_count": 6 }
}
```

## Markdown Report

```bash
node index.mjs lookup --withdrawal 0x13EFE153... --format markdown
```

Produces a structured report with Summary, Cluster Summary, Deposit Attribution, Evidence, Confidence Breakdown, Safe Configuration, and Limitations — directly publishable to GitHub or a gist.

## What This Proves

- **Withdrawal control**: Which multisig (owners, threshold) controls the withdrawal address
- **Validator cohort**: How many validators use this withdrawal address
- **Deposit-side attribution**: Which EOA deposited to the Beacon Deposit Contract for these validators
- **Operator scale**: How many sibling Safes share the exact same owner set, and how many total validators they control
- **Evidence chain**: Every address backing the claim is listed in the output

## What It Does Not Prove

- **Validator signing-key custody**: Withdrawal credentials prove fund destination, not who runs the validator software
- **Operator legal identity**: The tool identifies on-chain patterns, not entities
- **Completeness**: Blockscout withdrawal pagination may undercount; BigQuery provides full deposit counts
- **Partial-overlap attribution**: Safes sharing only some owners are reported but excluded from cluster counts

## Data Sources

| Source | Purpose | Key Required |
|---|---|---|
| Blockscout V2 | Withdrawals, transactions | No |
| Ethereum JSON-RPC | Safe contract calls | No |
| Safe Transaction Service | Owner-to-Safe mapping | No |
| BigQuery (public dataset) | Deposit contract event matching | gcloud auth |

## Prerequisites

- Node.js 20+
- `gcloud auth login` (for BigQuery depositor attribution)
- `gcloud config set project <your-project-id>`

Without gcloud, all features work except depositor attribution — the tool emits a ready-to-run BQ query instead.

## Options

```
node index.mjs lookup --withdrawal <address>              # JSON output
node index.mjs lookup --withdrawal <address> --format markdown  # Report output
node index.mjs lookup --withdrawal <address> --depositor <eoa>  # Manual depositor override
```

## Canonical Case Study

**Input:** One Gnosis Safe withdrawal address (`0x13EFE153...`)

**Discovery chain:**
1. 23 validators identified via Blockscout beacon withdrawals
2. 3-of-6 Gnosis Safe detected via on-chain `getOwners()` / `getThreshold()`
3. Depositor `0x5a4360...` attributed via BigQuery (40 deposits, 1,280 ETH)
4. 47 sibling Safes found via Safe Transaction Service owner correlation
5. 24 of those Safes serve as validator withdrawal addresses
6. **788 total validators, ~25,216 staked ETH** across the operator cluster

**Conclusion:** An unlabeled institutional staking operation using a consistent 6-person 3-of-6 multisig structure across 47+ Safes, managing ~$75M in staked ETH.

## Version History

| Version | Feature |
|---|---|
| v0.1.0 | Validator lookup + Safe detection |
| v0.2.0 | Depositor flag + Blockscout verification |
| v0.3.0 | Programmatic BigQuery depositor attribution |
| v0.4.0 | Cross-Safe owner correlation |
| v0.5.0 | Exact vs partial owner-set classification |
| v0.6.0 | Cluster summary rollup |
| v0.7.0 | Evidence block |
| v0.8.0 | Confidence breakdown |
| v0.9.0 | Markdown report export |
| v1.0.0 | README case study + repo positioning |
