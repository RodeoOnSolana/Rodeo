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

A `Position` is a PDA derived from `[b"position", global_config, position_id]`: its address depends only on the global config and a caller-chosen position ID, never on the current owner. `Position.owner` is an ordinary mutable field, changed only through an internal ownership-mutation helper (not a public, generic instruction), so a marketplace sale, gift, or mint-theft resolution can move ownership without the Position account ever changing address, without a close/reopen, and without disturbing anything keyed by that address (listings, indexer state, pending randomness). Sale and gift require the current owner's signature; mint theft is resolved by the protocol at reveal settlement. Every path rejects the change while the position has a pending randomness action, so authority and in-flight randomness can never be transferred out from under a settlement. The previous owner has no further authority over the position once ownership changes; `has_one = owner` re-checks the signer against the account's current owner field on every owner-gated instruction. Stake transfers RODEO from the owner's token account into only the principal vault. No unstake, treasury withdrawal, role assignment, emission, theft, burn, reroll, claim, or market settlement instruction exists yet; sale, gift, and mint theft are expected to call the same internal ownership-mutation helper rather than exposing it as a public instruction.

## Initial account definitions

- `GlobalConfig`: schema version, token mints, separate principal/reward vaults, PDA bumps.
- `RewardState`: epoch marker, fee revenue, emissions, claims, and aggregate ANSEM liability counters.
- `Position`: mutable owner, immutable position ID, principal, unresolved role, lifecycle status, epoch marker, settlement nonce, local mock output, and pending-action lock (active flag, action type, action nonce, next action nonce).
- `RoleStatistics`: Cowboy/Bull population and principal aggregates per epoch.
- `BullAccumulator`: integer weight, scaled reward-per-weight, and explicit division remainder storage.
- `PendingRandomness`: position/action-bound commitment, commit slot, settlement flag, and PDA bump.

Only `GlobalConfig`, `Position`, and `PendingRandomness` are initialized by Phase 0 instructions. The other definitions intentionally have no production transitions until the specification defines them.

## Local mock randomness and action addressing

`PendingRandomness` is a PDA derived from `[b"randomness", position, action_type, action_nonce]`. `action_type` is a stable, append-only integer enum (`ActionType`: `Reveal = 0`, `Unstake = 1`) identifying what kind of randomness action the request represents; `action_nonce` is drawn from a per-position monotonic counter (`Position.next_action_nonce`) so no two action instances, even of the same type, ever collide on the same address. Because the settling instruction re-derives this PDA from the position account, a fixed expected action type, and the position's own record of which nonce is currently outstanding (`Position.pending_action_nonce`), a randomness request can only ever settle the exact position, action type, and nonce it was opened for — passing any other position, type, or nonce fails PDA/account validation before the instruction body runs. `Position.pending_action_active` is set when a request opens and cleared only when it settles; the internal ownership-mutation helper used by sale, gift, and mint theft is rejected while it is set, so a position can only change hands once its outstanding randomness action is resolved through the explicit reveal path (or, in the future, an equivalent explicit resolution for other action types).

`stake_and_commit` escrows principal and opens a `Reveal` action at nonce zero, recording `SHA-256(secret)` as the commitment. `mock_reveal` checks the commitment and derives a deterministic local output from a domain separator, secret, and position pubkey. It increments the position's settlement nonce, clears the pending-action lock, and marks the request settled so a second reveal fails.

This is not production randomness. It has no oracle, validator entropy, delayed reveal policy, expiry, cancellation, slashing, anti-withholding protection, or economic outcome mapping. It must not be deployed beyond local testing. The `Unstake` action type exists only to reserve a stable discriminant for a future randomness-gated action; Phase 0 implements no unstake instruction or economics.

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

The pinned environment uses Ubuntu 24.04, Rust 1.85.1, Solana/Agave CLI 2.1.0, Anchor CLI 0.31.1, Node.js 22, pnpm 10.30.3, and committed pnpm/Cargo lockfiles. The Cargo lockfile explicitly pins Edition 2021 releases of transitive crates that otherwise resolve to Edition 2024 versions unsupported by Agave 2.1.0's SBF Cargo 1.79. `environment.yaml` describes interactive setup, while `.github/workflows/ci.yml` runs TypeScript build/tests, Rust formatting/checks, Anchor build, IDL-backed SDK generation, local validator deployment/integration tests, and generated-client drift detection.

Localnet program keypairs are deterministically derived from public labels by `scripts/prepare-localnet-program-keys.mjs`. They exist only under ignored `target/deploy`, make deployments reproducible, and are categorically unsuitable for any non-local deployment.

## Verification gates before Phase 1

1. Supply and approve Rodeo Protocol Specification v1.
2. Resolve every question in `assumptions-and-open-questions.md` without adding admin-mutability for economic constants.
3. Freeze token units, probability denominators, accumulator scale, and all rounding rules in `protocol-definition`.
4. Replace mock randomness with an independently reviewed production design.
5. Add instruction-level integration/property tests for every production state transition.
6. Threat-model custody, settlement ordering, oracle/randomness failure, and upgrade authority.
7. Review generated IDLs and account sizes before deployment.
