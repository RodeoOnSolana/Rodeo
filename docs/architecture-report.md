# Rodeo Phase 0 architecture report

## Status and authority

This report gates further game logic. Phase 0 is infrastructure, state-layout, simulation, and invariant scaffolding only. The forthcoming Rodeo Protocol Specification v1 must replace every unresolved placeholder and is the sole authority for economic behavior. No simulator behavior is approved for direct translation into on-chain economics.

## Monorepo boundaries

| Path | Responsibility in Phase 0 |
| --- | --- |
| `apps/web` | Empty typed application boundary; no game UI yet. |
| `apps/indexer` | Empty typed indexing boundary; event persistence is unresolved. |
| `apps/keeper` | Empty typed automation boundary; no privileged economic actions. |
| `programs/rodeo_core` | Principal custody, initial accounts, and local-only stake/commit/reveal. |
| `programs/rodeo_market` | Deployable marketplace boundary with no economic instructions. |
| `programs/rodeo_router` | Deployable swap/router boundary with no integrations. |
| `packages/protocol-definition` | Shared timing constants, integer unit types, probability-table shape, account versions, and event schemas. |
| `packages/sdk` | Deterministic TypeScript generation from Anchor JSON IDLs. |
| `packages/shared` | Checked integer and explicit floor/ceiling arithmetic. |
| `packages/economic-simulator` | Off-chain event reducer and invariant model with all unknown economics supplied by callers. |
| `tests/integration` | Anchor localnet deployment smoke test. |

## On-chain ownership and custody

`GlobalConfig` is a PDA with immutable mint and vault addresses and no administrator field. Economic constants are therefore not mutable through it. Its RODEO principal vault and ANSEM reward vault are separate token accounts. Both are program-controlled, but their balances and liabilities are modeled independently. No treasury account can sign for or withdraw player principal in Phase 0.

A `Position` is a PDA derived from owner and caller-selected position ID. Stake transfers RODEO from the owner's token account into only the principal vault. Position ownership is represented by one pubkey. No unstake, treasury withdrawal, role assignment, emission, theft, burn, reroll, claim, or market settlement instruction exists yet.

## Initial account definitions

- `GlobalConfig`: schema version, token mints, separate principal/reward vaults, PDA bumps.
- `RewardState`: epoch marker, fee revenue, emissions, claims, and aggregate ANSEM liability counters.
- `Position`: one owner, principal, unresolved role, lifecycle status, epoch marker, settlement nonce, and local mock output.
- `RoleStatistics`: Cowboy/Bull population and principal aggregates per epoch.
- `BullAccumulator`: integer weight, scaled reward-per-weight, and explicit division remainder storage.
- `PendingRandomness`: owner/position-bound commitment, commit slot, settlement flag, and PDA bump.

Only `GlobalConfig`, `Position`, and `PendingRandomness` are initialized by Phase 0 instructions. The other definitions intentionally have no production transitions until the specification defines them.

## Local mock randomness

`stake_and_commit` escrows principal and records `SHA-256(secret)` supplied as a commitment. `mock_reveal` checks the commitment and derives a deterministic local output from a domain separator, secret, and position pubkey. It increments a settlement nonce and marks both accounts so a second reveal fails.

This is not production randomness. It has no oracle, validator entropy, delayed reveal policy, expiry, cancellation, slashing, anti-withholding protection, or economic outcome mapping. It must not be deployed beyond local testing.

## Simulator

The simulator accepts, rather than defaults, an epoch emission schedule and revenue-to-ANSEM conversion ratio. It models:

- fee revenue purchasing/funding ANSEM emissions;
- six-hour epoch closure and a 40-epoch/10-day runway report;
- Cowboy/Bull position populations;
- claims, unstaking, rerolls, burns, thefts, and ownership transfers;
- marketplace volume and protocol revenue;
- unique settlement IDs, principal reconciliation, and vault-backed liabilities.

The reducer describes accounting mechanics for testing hypotheses. Event rates, eligibility, role probabilities, fee rates, and economic formulas are absent.

## SDK and IDLs

`anchor build` creates JSON IDLs in `target/idl`. `pnpm sdk:generate` converts every IDL to a checked TypeScript constant and IDL type under `packages/sdk/src/generated`. Generation fails when no IDL exists rather than producing stale clients. `pnpm sdk:validate` verifies that all three IDs match across `Anchor.toml`, Rust `declare_id!` macros, actual IDLs, and generated clients.

## Reproducible verification

The pinned environment uses Ubuntu 24.04, Rust 1.83.0, Solana/Agave CLI 2.1.0, Anchor CLI 0.31.1, Node.js 22, pnpm 10.30.3, and the committed pnpm lockfile. `environment.yaml` describes interactive setup, while `.github/workflows/ci.yml` runs TypeScript build/tests, Rust formatting/checks, Anchor build, IDL-backed SDK generation, local validator deployment/integration tests, and generated-client drift detection.

Localnet program keypairs are deterministically derived from public labels by `scripts/prepare-localnet-program-keys.mjs`. They exist only under ignored `target/deploy`, make deployments reproducible, and are categorically unsuitable for any non-local deployment.

## Verification gates before Phase 1

1. Supply and approve Rodeo Protocol Specification v1.
2. Resolve every question in `assumptions-and-open-questions.md` without adding admin-mutability for economic constants.
3. Freeze token units, probability denominators, accumulator scale, and all rounding rules in `protocol-definition`.
4. Replace mock randomness with an independently reviewed production design.
5. Add instruction-level integration/property tests for every production state transition.
6. Threat-model custody, settlement ordering, oracle/randomness failure, and upgrade authority.
7. Review generated IDLs and account sizes before deployment.
