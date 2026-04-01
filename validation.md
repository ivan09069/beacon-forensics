# Validation: Second Dataset

## Case 1 — Operator (Safe-based)

**Address:** `0x13EFE153D837721CBC8C0EF9735C4C65F4A947D9`

| Metric | Value |
|---|---|
| Validators | 23 (788 across cluster) |
| Withdrawal Type | gnosis_safe |
| Operator Type | single_operator_like |
| Depositors | 1 EOA (40 deposits, 1,280 ETH) |
| Exact-Match Safes | 47 |
| Cluster Validators | 788 |
| Estimated Stake | 25,216 ETH |
| Confidence | **0.91** |

## Case 2 — Pooled Protocol

**Address:** `0x6be457e04092b28865e0cba84e3b2cfa0f871e67`

| Metric | Value |
|---|---|
| Validators | 550 |
| Withdrawal Type | eoa (contract, not Safe) |
| Operator Type | pooled_protocol |
| Depositors | 4,991 unique EOAs |
| Deposits | 15,013 |
| Total ETH Deposited | 7,832,791 |
| Safe Detected | No |
| Exact-Match Safes | N/A |
| Confidence | **0.40** |

### Confidence Breakdown

| Signal | Case 1 | Case 2 |
|---|---|---|
| Safe Detected | 0.20 | 0 |
| Validator Cohort Mapped | 0.20 | 0.20 |
| Depositor Attributed | 0.20 | 0.20 |
| Exact Owner-Set Cluster | 0.20 | 0 |
| Evidence Complete | 0.11 | 0 |
| **Total** | **0.91** | **0.40** |

## What Worked

- Validator cohort mapping generalizes across both architectures
- BQ depositor attribution works for both single-operator and pooled patterns
- Confidence scoring correctly reflects available evidence (0.91 vs 0.40)
- Tool correctly identifies absence of Safe-based operator structure and classifies as pooled staking pattern

## What Degrades

- **No Safe → no clustering**: Without a Gnosis Safe, there are no owners to correlate, so the cross-Safe clustering pipeline does not activate. This is correct behavior, not a failure.
- **Depositor explosion**: 4,991 depositors indicates a pool/protocol, not a single operator. The tool reports this honestly via `operator_type: pooled_protocol`.
- **No evidence block**: Without clustering, the evidence chain (exact-match Safes, withdrawal addresses) is not emitted. The tool degrades to validator + depositor attribution only.

## Conclusion

The pipeline **generalizes for Safe-based operators** and **degrades gracefully for non-Safe architectures**. The confidence scoring correctly distinguishes high-signal cases (institutional operator with full evidence chain) from low-signal cases (pooled protocol with no ownership surface).

The tool implicitly classifies two operator types without explicit protocol detection:

| Pattern | Signature | Type |
|---|---|---|
| Safe + few depositors + clustering | Case 1 | `single_operator_like` |
| No Safe + thousands of depositors | Case 2 | `pooled_protocol` |
