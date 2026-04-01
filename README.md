# beacon-forensics

CLI tool for Ethereum validator cluster attribution. Given a withdrawal address, identifies the validator cohort, detects Safe/multisig control structures, and infers operator patterns.

## Usage

```bash
node index.mjs lookup --withdrawal <address>
```

## Example

```bash
node index.mjs lookup --withdrawal 0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9
```

## Output

```json
{
  "withdrawal_address": "0x13EFE153...",
  "validators_found": 23,
  "withdrawal_type": "gnosis_safe",
  "depositor_cluster": [],
  "suspected_operator": "unlabeled_institutional",
  "pattern": "staking-as-a-service",
  "confidence": 0.85,
  "validators": [
    { "index": 2236975, "status": "active", "withdrawal_count": 1, "total_withdrawn": 0.002242 }
  ],
  "safe": {
    "threshold": 3,
    "owner_count": 6,
    "owners": ["0x82b9...", "0xe553...", "0x351d...", "0x07d9...", "0x8219...", "0x03e7..."]
  }
}
```

## What it does

1. Queries Blockscout V2 for all beacon chain withdrawals to the given address
2. Deduplicates by validator index, counts withdrawal events per validator
3. Calls `getOwners()` and `getThreshold()` on the address to detect Gnosis Safe
4. Infers operator type from Safe configuration and validator count

## Data sources

- **Blockscout V2** — withdrawal events, transaction history (free, no key)
- **Ethereum JSON-RPC** — Safe contract calls via publicnode.com

## Heuristics

| Pattern | Trigger | Confidence |
|---------|---------|------------|
| `staking-as-a-service` | 6-owner 3-of-6 Safe, 20+ validators | 0.85 |
| `managed_multisig` | 4+ owners, threshold >= 2 | 0.70 |
| `self_custody` | 1-2 owners | 0.50 |
| `eoa_withdrawal` | No Safe detected | 0.30 |

## Limitations

- `depositor_cluster` not yet populated (requires beacon deposit contract event tracing)
- beaconcha.in API requires auth; currently uses Blockscout withdrawals only
- No validator pubkey or balance data (Blockscout withdrawals don't include these)
- Heuristics are pattern-based, not identity-verified

## Roadmap

- Deposit contract event tracing for depositor attribution
- BigQuery integration for bulk validator analysis
- Cross-Safe owner correlation
- MEV builder/relay attribution
