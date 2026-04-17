# Attribution Case Studies

A reader-facing walkthrough of the two reference datasets shipped with `beacon-forensics`. The purpose here is to show *what a finding from this tool looks like*, and just as importantly, *what it stops short of claiming*. For the raw numbers and confidence tables, see [case-study.md](../case-study.md) and [validation.md](../validation.md).

## What this tool actually claims

`beacon-forensics` attributes validator infrastructure at the **operator level**, not the **named-entity level**. Starting from a single withdrawal address, it reconstructs:

- the Gnosis Safe (if any) that controls the withdrawal endpoint,
- the validator cohort paid out at that address,
- the EOA or EOAs that deposited stakes into the Beacon Deposit Contract,
- the set of sibling Safes sharing the exact same owner configuration, and
- the rollup of validators and staked ETH across that cluster.

What it does not do: name a company, prove who runs the validator software, or assert control over signing keys. The output describes a pattern of on-chain behavior; mapping that pattern to a legal entity is a separate, off-chain exercise.

## Case 1 — Safe-based operator (`0x13EFE153…`)

A single withdrawal address resolves to a 3-of-6 Gnosis Safe. On-chain owner correlation finds 47 sibling Safes with the identical 6-owner set, 24 of which themselves serve as validator withdrawal endpoints. Across the cluster: 788 validators and roughly 25,216 staked ETH.

Depositor attribution via BigQuery returns a single EOA (`0x5a4360…`) responsible for 40 deposits totaling 1,280 ETH into the validators behind the seed address. All five confidence components are present, yielding a total score of 0.91.

**What the tool is willing to say:** this is a consistent multisig infrastructure — one owner set, many Safes, one attributed depositor wallet — at institutional scale.

**What the tool does not say:** it does not name the operator. Exclusion analysis against labeled providers (Figment, Lido, Coinbase, Kraken, RocketPool, Kiln, P2P.org) leaves the operator unresolved. The confidence score reflects the completeness of the evidence chain, not an identity match.

## Case 2 — Pooled protocol (`0x6be457…`)

The same pipeline applied to a pooled staking withdrawal contract produces a very different output. The address is not a Safe, so the clustering stage does not activate. 550 validators are identified. The depositor set expands to 4,991 unique EOAs across 15,013 deposits (~7.8M ETH total), which is more consistent with pooled protocol infrastructure than with a single operator. Confidence is 0.40, reflecting that only the validator-cohort and depositor-attribution signals were available; the Safe-detection, exact-owner-set, and evidence-complete components are zero.

**What the tool is willing to say:** this is a pooled-protocol pattern (`operator_type: pooled_protocol`), and no single-operator claim is appropriate.

**What the tool does not say:** it does not name the protocol, and it does not attempt to cluster. The lower score is the intended output — the tool is reporting the shape of the evidence it could and couldn't gather, not a weak guess.

## Abstention by design

The two cases exist to demonstrate the same pipeline producing honest outputs on opposite ends of the architecture spectrum. The tool does not reach for a conclusion when the evidence isn't there:

- No Safe → no clustering, no sibling rollup, evidence block omitted.
- Thousands of depositors → `pooled_protocol` classification, not a spurious attribution.
- Missing BigQuery access → emits a ready-to-run query rather than fabricating depositor attribution.
- Partial-overlap Safes → reported, but excluded from exact-match cluster counts.

Confidence is a function of how many of the five evidence components are present, not a probability of being correct about an identity.

## Where these findings are and aren't appropriate

Appropriate uses:

- Describing the shape and scale of an unlabeled staking infrastructure.
- Establishing that two withdrawal addresses share operator-level control (same owner set).
- Bounding a cluster's staked footprint for sizing or monitoring.

Not appropriate uses:

- Asserting that a named company or individual operates the infrastructure.
- Proving who holds the validator signing keys.
- Treating the confidence score as a probability that a named-entity label is correct.

## References

- [README.md](../README.md) — tool overview, data sources, CLI options.
- [case-study.md](../case-study.md) — full numeric breakdown of both cases.
- [validation.md](../validation.md) — second-dataset validation tables.
