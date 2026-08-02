# Rodeo Protocol v1 — Test Plan

## Testing philosophy

Every state transition, economic rule, rounding direction, and security invariant must have an explicit test. Tests are organized into unit tests, property tests, integration tests, and invariant tests. The economic simulator is the reference model for on-chain behavior; integration tests must validate that `rodeo_core` matches the simulator for the same event trace.

## Test categories

| Category | Scope | Tool |
| --- | --- | --- |
| Unit | Individual pure functions (probability tables, arithmetic helpers, outcome mapping) | Vitest |
| Property | Invariants across randomized event traces and inputs | Vitest + fast-check |
| Simulator | Event-reducer correctness against approved rules | Vitest |
| Integration | Anchor localnet deployment and instruction execution | Vitest + `@coral-xyz/anchor` |
| Invariant | On-chain account reconciliation after each instruction | Integration assertions |
| Fuzz/negative | Malformed inputs, duplicate settlement IDs, overflow edges | fast-check |

## Unit tests

### Probability tables

- [x] Every approved table is normalized (sum equals denominator).
- [x] Outcome mapping produces the correct outcome for boundary draws.
- [x] `isNormalized` rejects negative weights, zero denominator, and mismatched sums.
- [ ] Rank/tier/suit outcome mapping uses the correct sub-table and domain.

### Arithmetic helpers

- [x] `checkedAdd` rejects overflow and negative inputs.
- [x] `checkedSub` rejects underflow and negative inputs.
- [x] `mulDivFloor` and `mulDivCeil` produce exact floor/ceiling results.
- [ ] BPS split functions match the approved rounding direction.

### Outcome sampling

- [ ] Deterministic samples with known randomness produce expected roles/ranks/tiers/suits.
- [ ] Mint theft flag resolves correctly given eligibility criteria.
- [ ] Thief selection weights by buck power.
- [ ] Unstake theft flag resolves correctly for normal Cowboys and is skipped for Desperado and Bulls.

## Property tests

### Principal conservation

- [ ] For any sequence of stakes, claims, unstakes, transfers, and thefts, `sum(active_position.principal) + burned_rounding_remainder == principal_vault_balance`.

### ANSEM liability cap

- [ ] For any sequence of funding, claims, unstake thefts, and suit distributions, `ansem_liability <= reward_vault_balance`.

### No duplicate settlement

- [ ] Replaying any `SimulationEvent` with the same `settlementId` always throws.

### Position identity

- [ ] A position retains its ID and PDA across arbitrary ownership transfers.

### Pending action lock

- [ ] No transfer, sale, or gift succeeds while `pending_action_active == true`.

### Probability distribution

- [ ] Large samples converge to the approved probabilities within statistical tolerance.
- [ ] Desperado probability is exactly `0.05%` of all reveals.
- [ ] Bull total probability is exactly `10%` of all reveals.
- [ ] Each suit is exactly `25%` independent of role.

## Simulator tests

### Stake

- [ ] Stake with exactly `STAKE_AMOUNT_ATOMIC` creates a position.
- [ ] Stake with wrong amount is rejected.
- [ ] Duplicate `position_id` is rejected.

### Reveal

- [ ] Reveal assigns role, rank/tier, and suit.
- [ ] Reveal increments settlement nonce.
- [ ] Reveal cannot settle twice.

### Claim

- [ ] Normal Cowboy claim splits 80/20.
- [ ] Desperado claim splits 98/2.
- [ ] Claim cooldown is enforced per wallet.
- [ ] Batch claim across multiple positions works.
- [ ] Empty claim is rejected.

### Unstake

- [ ] Unstake returns 95% of principal and burns 5%.
- [ ] Normal Cowboy loses pending ANSEM to Bull pool 5% of the time.
- [ ] Normal Cowboy receives pending ANSEM 95% of the time.
- [ ] Desperado keeps pending ANSEM.
- [ ] Bull receives Bull-pool rewards before principal return.
- [ ] Minimum stake period is enforced.
- [ ] Unstake closes the position and burns the receipt.

### Mint theft

- [ ] Theft activates only after 50 reveals and 3 eligible Bulls.
- [ ] 5% theft rate matches expected distribution.
- [ ] Victim's Bull cannot be the recipient.
- [ ] Entire position transfers: principal, role, rank/tier, suit, receipt.
- [ ] No theft occurs if no eligible external Bull exists.

### Marketplace sale

- [ ] Sale is atomic and updates owner and receipt together.
- [ ] Seller's pending ANSEM is force-claimed before transfer.
- [ ] Buyer starts with zero pending ANSEM.
- [ ] 5% marketplace fee is routed to external revenue.
- [ ] Sale is rejected while randomness action is pending.
- [ ] Stale listing cannot settle.

### Direct gift

- [ ] Gift changes owner and receipt atomically.
- [ ] Force-settles pending ANSEM.
- [ ] No marketplace fee charged.
- [ ] Rejected while randomness action is pending.

### Epoch closure

- [ ] No emission during pot-fill period.
- [ ] Epoch emission equals `free_ansem / 40` (floor).
- [ ] 90/10 split between Cowboy production and suit vault.
- [ ] Runway report reflects covered epochs.
- [ ] Emission is zero when `free_ansem` is zero.

### External revenue

- [ ] 70/15/10/5 split applied to realized receipts.
- [ ] ANSEM purchase deposits into reward vault.
- [ ] RODEO buyback is burned.
- [ ] Failed swap leaves funds pending.

### Suit competition

- [ ] 10% of each epoch emission accumulates in suit vault.
- [ ] Winning suit attestation requires valid multisig.
- [ ] 50/50 equal/proportional split is applied.
- [ ] Ineligible positions receive nothing.

## Integration tests (Anchor localnet)

### Required for Phase 2

- [ ] `initialize_config` creates `GlobalConfig`, `RewardState`, `PrincipalVault`, `RewardVault`.
- [ ] `stake_and_commit` rejects non-standard stake amounts.
- [ ] `settle_reveal` assigns role/rank/tier/suit and emits `PositionRevealed`.
- [ ] `claim` respects role-specific splits and wallet cooldown.
- [ ] `request_unstake` + `settle_unstake` burn tax, return principal, and close position.
- [ ] `transfer_position` is blocked while pending action is active and succeeds when cleared.
- [ ] `close_epoch` updates global reward index and suit vault.
- [ ] Bull reward pool distribution matches reward-per-buck-power accounting.

### Negative-path integration tests

- [ ] Wrong `PendingRandomness` PDA (wrong position/type/nonce) fails.
- [ ] Duplicate reveal settlement fails.
- [ ] Claim with insufficient reward vault fails.
- [ ] Unstake before minimum period fails.
- [ ] Transfer by non-owner fails.
- [ ] Marketplace sale with mismatched receipt fails.
- [ ] Stale listing after ownership change fails.

## Invariant assertions

Every integration test must assert at least one of:

- `sum(position.principal) == principal_vault_balance`
- `ansem_liability <= reward_vault_balance`
- `settlement_nonce` strictly increases on randomness settlement
- `pending_action_active` cleared after settlement
- `Position.owner` equals `MarketReceipt.owner`

## Fuzz targets

- [ ] Random sequences of stake/reveal/claim/unstake/transfer with small principal ranges to trigger rounding edge cases.
- [ ] Concurrent randomness actions targeting the same position.
- [ ] Epoch closure under extremely low or high reward-vault balance.
- [ ] Marketplace sale with randomized prices and fees.

## Test deliverables

- `packages/economic-simulator/tests/*.test.ts` — simulator and property tests.
- `tests/integration/*.test.ts` — Anchor localnet instruction tests.
- `programs/rodeo_core/tests/` (optional) — Rust unit tests for pure helpers.
- CI must run all tests on every PR.

## Coverage goals

- 100% of approved economic rules have at least one simulator or integration test.
- 100% of error codes have a negative-path test.
- Every invariant in [security-invariants.md](./security-invariants.md) has a property test.
