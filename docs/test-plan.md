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
- [ ] Conditional Cowboy rank probabilities sum to 100% over the Cowboy denominator.
- [ ] Conditional Bull tier probabilities sum to 100% over the Bull denominator.
- [ ] Total-probability shares are conditional * role probability.

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

- [ ] For any sequence of stakes, claims, unstakes, transfers, and thefts, `accounted_principal_atomic == sum(live_position.principal)` and `principal_vault_balance >= accounted_principal_atomic`.

### ANSEM liability cap

- [ ] For any sequence of funding, claims, unstake thefts, and suit distributions, `total_ansem_liability <= recognized_reward_balance <= reward_vault_balance`.

### ANSEM liability reconciliation

- [ ] For any sequence of events, `total_ansem_liability` equals the sum of the explicit liability buckets.

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
- [ ] Reveal creates Metaplex Core receipt for final owner.
- [ ] Reveal updates `GlobalGameState` population and power counters.

### Claim

- [ ] Normal Cowboy claim splits 80/20.
- [ ] Desperado claim splits 98/2.
- [ ] Claim cooldown is enforced per wallet.
- [ ] Batch claim across multiple positions works.
- [ ] Empty claim is rejected.

### Unstake

- [ ] Unstake returns 95% of principal and burns exactly 5% (principal - returned).
- [ ] Normal Cowboy unstake pays 100% of synchronized pending ANSEM to owner on the 95% outcome.
- [ ] Normal Cowboy unstake reclassifies 100% of synchronized pending ANSEM to the Bull pool on the 5% outcome.
- [ ] Normal Cowboy unstake does not apply the 80/20 claim tax.
- [ ] Desperado keeps 100% of pending ANSEM.
- [ ] Bull receives 100% of synchronized Bull-pool rewards before principal return.
- [ ] Minimum stake period is enforced via `Position.unstake_eligible_at`.
- [ ] Unstake request cannot be cancelled after commitment.
- [ ] Timeout recovery fails when the oracle value is already available.
- [ ] Unstake closes the position and burns the receipt.

### Mint theft

- [ ] Theft activates only after 50 reveals and 3 eligible Bulls.
- [ ] 5% theft rate matches expected distribution.
- [ ] Victim's Bull cannot be the recipient.
- [ ] Entire position transfers: principal, role, rank/tier, suit, receipt.
- [ ] Ineligibility or absence of an external recipient resolves safely as "not stolen" without reverting.

### Marketplace sale

- [ ] Sale is atomic and updates owner and receipt together.
- [ ] Seller's pending ANSEM is force-claimed before transfer.
- [ ] Buyer starts with zero pending ANSEM.
- [ ] 5% marketplace fee is routed to external revenue.
- [ ] Sale is rejected while randomness action is pending.
- [ ] Sale resets `Position.unstake_eligible_at = transfer_timestamp + 24 hours`.
- [ ] Owner cannot transfer the receipt directly through MPL Core; Rodeo transfer via delegate succeeds.
- [ ] Owner cannot burn the receipt directly through MPL Core; Rodeo unstake burn succeeds.
- [ ] Sale is rejected if `Position.owner` and Core Asset owner do not match.
- [ ] Stale listing cannot settle.

### Direct gift

- [ ] Gift changes owner and receipt atomically via Rodeo delegate.
- [ ] Force-settles pending ANSEM.
- [ ] No marketplace fee charged.
- [ ] Rejected while randomness action is pending.
- [ ] Resets `Position.unstake_eligible_at = transfer_timestamp + 24 hours`.
- [ ] Owner cannot transfer or burn the receipt directly through MPL Core.

### Epoch closure

- [ ] No emission during pot-fill period.
- [ ] `close_epochs` processes up to `CLOSE_EPOCH_BATCH_MAX` epochs per transaction.
- [ ] State-changing instructions require elapsed epochs to be closed.
- [ ] Epoch emission = `floor(free_ansem / RUNWAY_EPOCHS)`; uses recognized reward balance.
- [ ] 90/10 split between Cowboy production and suit vault.
- [ ] Cowboy production emission uses the snapshot of `total_active_cowboy_weight` at the epoch boundary.
- [ ] If `total_active_cowboy_weight == 0`, Cowboy portion remains free ANSEM.
- [ ] Suit portion is always reserved.
- [ ] Runway report reflects covered epochs.
- [ ] Emission is zero when `free_ansem` is zero.

### External revenue and reward recognition

- [ ] 70/15/10/5 split applied to realized receipts.
- [ ] ANSEM purchase deposits into reward vault but is not automatically recognized.
- [ ] Direct unsolicited transfer to reward vault is tracked as unrecognized surplus.
- [ ] `recognize_rewards` after catch-up moves ANSEM from surplus to recognized balance.
- [ ] Emission uses `min(actual_reward_vault_balance, recognized_reward_balance) - total_ansem_liability`.
- [ ] RODEO buyback is burned.
- [ ] Failed swap leaves funds pending.

### Suit competition

- [ ] 10% of each epoch emission accumulates in suit vault.
- [ ] Winning suit attestation requires valid multisig and includes `content_hash`.
- [ ] 50/50 equal/proportional split is applied.
- [ ] Proportional allocation is per X account, then divided among that account's eligible positions.
- [ ] Multi-position X-account allocation conserves the total proportional half.
- [ ] Ineligible positions receive nothing.
- [ ] Undistributed vault rolls into the next social epoch.

## Integration tests (Anchor localnet)

### Required for Phase 2

- [ ] `initialize_config` creates `GlobalConfig`, `GlobalGameState`, `RewardState`, `PrincipalVault`, `RewardVault`, `BullAccumulator`.
- [ ] `stake_and_commit` rejects non-standard stake amounts.
- [ ] `settle_reveal` assigns role/rank/tier/suit, creates receipt, and emits `PositionRevealed`.
- [ ] `claim_cowboy` and `claim_bull` respect role-specific splits and wallet cooldown.
- [ ] `request_unstake` + `settle_unstake` burn tax, return principal, and close position; no cancel after commitment.
- [ ] `transfer_position` is blocked while pending action is active and succeeds when cleared.
- [ ] `close_epochs` updates global reward index and suit vault using snapshot values.
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

- `accounted_principal_atomic == sum(live_position.principal)`
- `principal_vault_balance >= accounted_principal_atomic`; surplus is not withdrawable principal
- `total_ansem_liability <= recognized_reward_balance <= reward_vault_balance`
- `total_ansem_liability` equals sum of explicit liability buckets
- `position_claimable_liability == sum(position.claimable_ansem_atomic)`
- `settlement_nonce` strictly increases on randomness settlement
- `pending_action_active` cleared after settlement
- `Position.owner` equals `PositionReceipt` Core Asset owner

## Fuzz targets

- [ ] Random sequences of stake/reveal/claim/unstake/transfer with small reward ranges to trigger rounding edge cases.
- [ ] Concurrent randomness actions targeting the same position.
- [ ] Epoch closure under extremely low or high reward-vault balance.
- [ ] Delayed `close_epochs` calls that batch many epochs.
- [ ] Bull-pool distribution with zero, one, and many active Bulls.
- [ ] Marketplace sale with randomized prices and fees.
- [ ] Direct reward-vault transfers mixed with recognized funding.
- [ ] Multi-position X-account suit allocation conservation.

## Test deliverables

- `packages/economic-simulator/tests/*.test.ts` — simulator and property tests.
- `tests/integration/*.test.ts` — Anchor localnet instruction tests.
- `programs/rodeo_core/tests/` (optional) — Rust unit tests for pure helpers.
- CI must run all tests on every PR.

## Coverage goals

- 100% of approved economic rules have at least one simulator or integration test.
- 100% of error codes have a negative-path test.
- Every invariant in [security-invariants.md](./security-invariants.md) has a property test.
