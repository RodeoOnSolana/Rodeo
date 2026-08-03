# Rodeo Protocol Specification v1

## Status

**Version:** 1.3.3  
**State:** authoritative source of truth for contract, frontend, indexer, keeper, marketplace, and treasury implementation.  
**Replaces:** any prior `rodeo-game-spec.md` drafts and the Phase 0 economic placeholders.  
**Scope:** Phase 1 protocol design only. No production Anchor instructions are implemented in this branch.

## Purpose

This document is the single source of truth for the Rodeo risk-to-earn protocol on Solana. It defines the tokenomics, account model, state machine, probability tables, emission schedule, marketplace mechanics, randomness requirements, governance boundaries, security invariants, and implementation order for all downstream work.

Every rule stated here is either an approved protocol decision (carried forward from Phase 0 or explicitly decided by the protocol owner) or explicitly marked as unresolved with the label `BLOCKED: OWNER DECISION REQUIRED`. No implementation may silently invent, modify, or relax a rule marked as approved.

## Approved protocol decisions

### Launch and token facts

- RODEO launches through pump.fun.
- Total RODEO supply: `1,000,000,000` whole RODEO.
- Stake requirement per position: `100,000` whole RODEO.
- `GlobalConfig` stores `stake_amount_atomic` and `expected_total_supply_atomic` computed as `whole_amount * 10^rodeo_decimals`.
- Minimum active stake period: `24 hours`.
- No wallet-level position cap.
- One position has exactly one owner at a time.
- Position PDA identity is independent of owner (`[b"position", global_config, position_id]`).
- Partial unstaking and position splitting are not supported.
- Full unstake closes the position and returns the post-tax principal.
- Restaking is equivalent to creating a new position and opening a new reveal action.
- Principal accounting tracks `accounted_principal_atomic` and reports surplus as `actual_principal_vault_balance - accounted_principal_atomic`. Surplus is never withdrawable as player principal.
- Reward vault accounting tracks `recognized_reward_balance_atomic`; ANSEM arriving after an elapsed epoch boundary is recognized only after catch-up closes that boundary. Direct unsolicited transfers are unrecognized until recognized.

### Role odds

- Fixed odds at launch; no dynamic population balancing.
- Total Cowboy probability: `90%` of reveals.
- Total Bull probability: `10%` of reveals.
- Desperado is included within the Cowboy total and has exactly `0.05%` probability across all reveals.
- Suit is assigned independently at `25%` each.
- See [probabilities-and-rarities.md](./probabilities-and-rarities.md) for exact integer tables and accrual weights.

### Cowboy distribution

Conditional probabilities given Cowboy; total probability across all reveals is `conditional * 0.9`.

| Rank | Conditional probability | Total probability | Accrual weight |
| --- | --- | --- | --- |
| 4 | 44.9750% | 40.4775% | 1.00x |
| 5 | 24.9861% | 22.4875% | 1.05x |
| 6 | 12.9928% | 11.6935% | 1.10x |
| 7 | 7.9956% | 7.1960% | 1.18x |
| 8 | 4.9972% | 4.4975% | 1.28x |
| 9 | 2.9983% | 2.6985% | 1.40x |
| 10 | 0.9994% | 0.8995% | 1.55x |
| Desperado | 0.055556% | 0.0500% | 1.00x |

### Bull distribution

Conditional probabilities given Bull; total probability across all reveals is `conditional * 0.1`.

| Tier | Conditional probability | Total probability | Buck power |
| --- | --- | --- | --- |
| 1 | 60% | 6.00% | 4 |
| 2 | 25% | 2.50% | 6 |
| 3 | 10% | 1.00% | 8 |
| 4 | 5% | 0.50% | 10 |

### Claims

- Normal Cowboy claim: synchronize pending production rewards, then `80%` of claimable to owner, `20%` reclassified to Bull reward pool.
- Desperado claim: synchronize pending production rewards, then `98%` of claimable to owner, `2%` reclassified to Bull reward pool.
- Bull claim: synchronize Bull-pool rewards, then pay 100% of claimable to owner (no second Bull-pool decrement).
- Claim does not unstake the position.
- Claim cooldown: `1 hour` per wallet.
- A wallet may batch-claim multiple owned positions in one transaction.
- Bull rewards are distributed using reward-per-buck-power accounting.

### Unstaking

- All roles pay a `5%` tax on staked RODEO; `95%` is returned.
- `UNSTAKE_TAX_BPS + UNSTAKE_RETURN_BPS == 10_000`; burned amount = principal - returned, so there is no rounding remainder.
- An unstake request commits randomness but keeps the position `Active` while pending.
- There is no voluntary cancel after commitment; the unstake settles from randomness or timeout-recovers after 30 minutes if no oracle value is available.
- For normal Cowboys:
  - `5%` outcome: 100% of synchronized pending production ANSEM is reclassified to the Bull pool.
  - `95%` outcome: 100% of synchronized pending production ANSEM is paid to the owner.
  - The normal 80/20 claim tax does not apply during unstake.
- Desperado is immune to ANSEM unstake theft and receives 100% of pending ANSEM.
- Bulls receive 100% of synchronized Bull rewards safely when unstaking.
- Unstake closes the position asset and account state.

### Mint theft

- Activates only after:
  - at least `50` completed reveals protocol-wide;
  - at least `3` eligible active Bulls exist.
- `5%` chance the newly revealed position is stolen.
- The entire position transfers: NFT/receipt, role, rank or tier, suit, and `100,000` RODEO principal.
- One Bull receives the position directly.
- Recipient Bull is selected randomly, weighted by buck power.
- A Bull owned by the victim wallet cannot receive the theft.
- Victim and recipient are publicly identifiable.
- If no eligible external Bull exists, the reveal resolves safely without theft.

### ANSEM emissions

- Initial team-funded ANSEM reward balance: `zero`.
- Rewards are funded only by realized protocol revenue.
- Pot-fill period: `12 hours` after launch.
- No ANSEM liability accrues during the pot-fill period.
- Production uses six-hour epochs.
- Epochs are advanced by permissionless `close_epochs(max_epochs)`, processing up to `8` epochs per transaction and using per-epoch snapshots.
- Rolling runway: `10 days`, equal to `40 epochs`.
- Free ANSEM = `min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic`.
- Epoch emission = `floor(free_ansem / RUNWAY_EPOCHS)`.
- `90%` of each epoch emission is reserved as Cowboy production liability; if no active Cowboys, it remains free ANSEM.
- `10%` is always reserved for the current suit competition vault.
- Undistributed Cowboy production emission remains free ANSEM in the reward vault; undistributed suit vault rewards roll into the next social epoch.
- No fixed APY or guaranteed payout.
- Already accrued rewards cannot be reused in future emission calculations.

### External revenue

- Sources: RODEO pump.fun creator fees, Rodeo marketplace fees, approved protocol-controlled sponsorships.
- `70%` used to buy ANSEM for the reward vault.
- `15%` sent to team and marketing.
- `10%` used to buy and permanently burn RODEO.
- `5%` sent to security and operations.
- Use actual realized fee receipts, not a hardcoded pump.fun fee rate.
- Player claim taxes and theft distributions are not protocol revenue.
- Source-token dust from split rounding rolls into the next routing batch; no automatic sweep redirects dust.

### Treasury router

- Approved swap venues only.
- Fixed output destinations.
- Minimum output and slippage protections.
- No authority over player principal.
- No authority over accrued ANSEM liabilities.
- ANSEM purchases deposit directly into the reward vault.
- RODEO buybacks burn immediately.
- Failed or unsafe swaps leave funds pending rather than forcing execution.

### Marketplace

- Position ownership must be represented by a program-controlled, transferable receipt asset.
- Position PDA does not change when ownership changes.
- Marketplace sale must be atomic.
- Seller rewards are force-settled before transfer.
- Normal claim tax applies during forced settlement.
- Buyer receives role, `cowboy_kind`/`bull_tier`, suit, and locked principal.
- Buyer does not receive seller's pending ANSEM.
- Marketplace fee: `5%` of sale price, taken once from seller proceeds.
- Marketplace fees enter the external revenue split.
- Position ownership cannot change while a randomness action is pending.
- There is no public, generic `transfer_position` instruction. Sale and gift share one internal ownership-mutation helper; reveal-time mint theft uses a separate internal initial-owner path. Transfers outside approved Rodeo flows must be rejected.
- Sale and gift synchronize/force-settle the outgoing owner's rewards, transfer the existing frozen receipt, set the new owner's checkpoints to current global indices, reset `claimable_ansem_atomic`, and reset `unstake_eligible_at`. If the resulting claimable amount is zero, the forced settlement is a successful no-op and the transfer continues; `NoClaimableRewards` never blocks a sale or gift.
- Mint theft performs no reward settlement: it occurs during the initial reveal, before the position has accrued any rewards. The initial-owner path selects the final owner, sets `Position.owner` directly, initializes reward checkpoints, and creates the receipt directly for the final owner; it never transfers a nonexistent receipt and never requires the victim's signature.
- Direct gifts use forced settlement but no marketplace fee.
- Ownership authority and receipt asset transfer must occur atomically.
- Marketplace v1 supports only fixed-price direct listings with no automatic expiration; bids, auctions, and private offers are out of scope for v1.

### Suits and social competition

- Hearts, Diamonds, Clubs, Spades.
- `25%` probability each, independent of role/rank.
- Seven-day competition epochs.
- `10%` of ANSEM emissions fund the suit competition.
- `$RODEO` is required in eligible posts.
- `$ANSEM` is optional.
- Original posts only.
- Maximum three scored posts per linked X account per epoch.
- One X account linked to one wallet per epoch.
- Off-chain scoring publishes a complete public result file and Merkle root.
- Social result requires multisignature oracle attestation.
- Winning suit reward: `50%` equal distribution among eligible active positions; `50%` proportional to verified contribution score.

### Randomness

- Production randomness must use reviewed verifiable randomness.
- Every request binds position, action type, and action nonce.
- Separate randomness domains for: role, Cowboy rank, Bull tier, suit, mint theft flag, thief selection, unstake theft flag.
- User and admin cannot cancel after commitment because of an unfavorable result; once an unstake is committed it settles or timeout-recovers only when no oracle value is available.
- Settlement is permissionless.
- Failed settlement cannot generate new randomness.
- Oracle timeout recovery must not trap player principal; timeout recovery fails if a valid oracle value is already available.
- Pending random actions block position transfer.

### Governance

- Upgrade authority controlled by a 3-of-5 Upgrade Council Squads multisig and a 72-hour timelock.
- Treasury authority separated from program upgrade authority (3-of-5 Treasury Council, 48-hour timelock).
- Emergency Guardians (2-of-3) may toggle action-specific pause flags: `pause_new_stakes`, `pause_new_reveal_requests`, `pause_new_marketplace_listings`, `pause_router_swaps`.
- Emergency controls cannot withdraw player principal or accrued liabilities.
- Safe claims and exits remain available whenever technically possible.
- Core economic parameters are governance-protected (timelocked, published upgrade), not technically immutable, because the program remains upgradeable.
- No single authority may modify: role odds, taxes, theft percentages, stake amount, buck power, revenue percentages, runway length, emission allocation, marketplace fee without a published upgrade.

## Document map

| Document | Responsibility |
| --- | --- |
| [state-machine.md](./state-machine.md) | Complete position lifecycle, status values, and legal transitions. |
| [account-model.md](./account-model.md) | PDAs, account schemas, version map, and authority boundaries. |
| [economic-model.md](./economic-model.md) | Token units, principal/reward flows, rounding, and invariants. |
| [probabilities-and-rarities.md](./probabilities-and-rarities.md) | Approved integer probability tables and accrual/buck-power weights. |
| [emissions-and-rewards.md](./emissions-and-rewards.md) | Epoch schedule, runway math, Cowboy production reward, Bull pool, suit vault. |
| [randomness-design.md](./randomness-design.md) | Domain separation, commit/settle, oracle integration, timeout, settlement rules. |
| [marketplace-design.md](./marketplace-design.md) | Receipt asset, atomic sale, forced settlement, fees, gifts. |
| [treasury-and-governance.md](./treasury-and-governance.md) | Revenue split, swap router, burn, multisig, immutability list, emergency controls. |
| [suits-and-social-competition.md](./suits-and-social-competition.md) | Suit assignment, social epochs, scoring oracle, reward split. |
| [events-and-errors.md](./events-and-errors.md) | Event schemas and error codes for every state transition. |
| [security-invariants.md](./security-invariants.md) | Critical invariants that must hold before and after every instruction. |
| [public-metrics-and-indexing.md](./public-metrics-and-indexing.md) | On-chain events, off-chain indexer responsibilities, keeper duties, public dashboards. |
| [implementation-plan.md](./implementation-plan.md) | Ordered implementation phases with acceptance criteria. |
| [test-plan.md](./test-plan.md) | Unit, integration, property, invariant, and fuzz test scaffolding. |

## Relationship to Phase 0

Phase 0 delivered:

- monorepo scaffolding;
- Anchor workspace and localnet tooling;
- SDK generation from IDLs;
- an internal ownership-mutation primitive that changes `Position.owner` without changing the PDA (not exposed as a public, generic instruction);
- `PendingRandomness` addressing by `[position, action_type, action_nonce]`;
- an economic-simulator event reducer with explicit configuration required;
- local integration tests proving PDA identity survives ownership change.

Phase 1 fills in all economic and game rules while leaving production instruction implementations for Phase 2. No Phase 0 behavior is overturned; probability tables, constants, and emission formulas are added where Phase 0 intentionally left placeholders.

## Owner decisions applied in v1.3.1

The following decisions have been applied across the v1 sub-documents:

- **Single sources of truth:** `RewardState` alone owns `current_epoch`, `epoch_started_at`, `last_closed_epoch_timestamp`, `cowboy_reward_index`, and `cowboy_index_remainder_scaled`. `BullAccumulator` alone owns `reward_per_weight_scaled` and `bull_index_remainder_scaled` (it no longer stores `cowboy_reward_index`). `GlobalGameState` holds only population, power, and accounted-principal counters (no `current_epoch`, `last_closed_epoch_timestamp`, or `launch_timestamp`; launch timing lives solely in `GlobalConfig`).
- **Exact accumulator rounding:** global scaled carries (`RewardState.cowboy_index_remainder_scaled`, `BullAccumulator.bull_index_remainder_scaled`) and per-position carries (`Position.cowboy_accrual_remainder_scaled`, `Position.bull_accrual_remainder_scaled`) ensure emission and per-position accrual formulas never drop rounding dust.
- **Claim ordering:** synchronization is never gated on `claimable_ansem_atomic > 0`. Claims and forced settlements first close elapsed epochs and synchronize indices, then update `Position.claimable_ansem_atomic` and the liability buckets, and reject only if the resulting claimable amount is zero. Forced settlements bypass the one-hour claim cooldown but still update `WalletClaimCooldown.last_claimed_at`.
- **Recognized reward balance:** `unrecognized_reward_surplus_atomic` is not a stored field; it is computed dynamically as `reward_vault_balance - recognized_reward_balance_atomic`. `recognized_reward_balance_atomic` decreases with every ANSEM transfer out of the reward vault.
- **Bull-pool routing:** Cowboy claim tax, Desperado claim tax, and unstake-theft contributions route to `bull_pool_liability_atomic` (with accumulator update) when `total_active_bull_power > 0`, or to `bull_pool_unallocated_liability_atomic` otherwise; the unallocated bucket is distributed and cleared when an eligible Bull set becomes active.
- **Suit snapshot claims:** suit rewards belong permanently to `owner_at_snapshot` and do not require the `Position` to remain open/active, nor that the current owner match `owner_at_snapshot`.
- **Randomness:** unbiased integer mapping uses deterministic rejection sampling instead of modulo reduction; `PendingRandomness` records `registry_version_snapshot`; `RandomnessRequested` emits provider-specific details (VRF key, callback id, etc.).
- **Role and event schemas:** `Position` stores `cowboy_kind` and `bull_tier`; `rank_or_tier` is removed everywhere. `PositionRevealed` emits role, cowboy_kind, bull_tier, suit, final_owner, previous_owner (only when stolen), stolen, receipt_asset, active_since, unstake_eligible_at, and settlement_nonce.
- **Ownership mutation:** there is no public, generic `transfer_position` instruction. Sale and gift call the same internal ownership-mutation helper, which synchronizes/force-settles the outgoing owner's rewards, sets the new owner's checkpoints to current global indices, resets `claimable_ansem_atomic`, transfers the frozen Core receipt atomically, updates `Position.owner`, and resets `unstake_eligible_at`. As of v1.3.2, reveal-time mint theft uses a separate internal initial-owner path instead of this helper; see "Owner decisions applied in v1.3.3" below.
- **Marketplace V1 scope:** listings have no automatic expiration (`ListingExpired` is removed from the error list); bids, auctions, and private offers are out of scope for v1.
- **Events and metrics:** added `ListingCreated`, `ListingCancelled`, `PositionSold`, `PositionGifted`, `RewardFundingRecognized`, `RewardPaid`, `SuitRewardClaimed`, `OrphanedRewardReleased`, `ReceiptCreated`, `ReceiptBurned`, and an updated `EpochClosed` (with recognized-balance and total-liability snapshots).

## Owner decisions applied in v1.3.3

This is a consistency patch. The following nine owner decisions are applied across the v1 sub-documents; no probability table changes:

1. **Zero-reward forced settlement:** a manual claim synchronizes first and rejects with `NoClaimableRewards` only if the resulting claimable amount is zero. Sale and gift also synchronize first, but if the resulting claimable amount is zero, forced settlement is a successful no-op and the transfer continues; `NoClaimableRewards` must never block a sale or gift. Mint theft performs no reward settlement at all, because it happens during the initial reveal before any reward has accrued.
2. **Separate mint-theft initial ownership:** sale and gift use the internal ownership-mutation helper (force-settle outgoing owner, transfer the existing frozen receipt, update `Position.owner`, reset checkpoints and `unstake_eligible_at`). Reveal-time mint theft uses a distinct internal initial-owner path: select the final owner, set `Position.owner` to the final owner, initialize reward checkpoints, and create the receipt directly for the final owner. It never transfers a nonexistent receipt, never force-settles rewards, and never requires the victim's signature.
3. **Initial reward checkpoints:** on Cowboy reveal, `last_cowboy_reward_index = RewardState.cowboy_reward_index`, `cowboy_accrual_remainder_scaled = 0`, `last_bull_reward_per_weight = 0`, `bull_accrual_remainder_scaled = 0`. On Bull reveal, `last_bull_reward_per_weight = BullAccumulator.reward_per_weight_scaled`, `bull_accrual_remainder_scaled = 0`, `last_cowboy_reward_index = 0`, `cowboy_accrual_remainder_scaled = 0`. When the first eligible Bull activates while `bull_pool_unallocated_liability_atomic > 0`: (1) initialize the new Bull's checkpoint to the current accumulator; (2) add the Bull to `total_active_bull_power`; (3) distribute the unallocated amount through the accumulator; (4) move the amount from `bull_pool_unallocated_liability_atomic` to `bull_pool_liability_atomic`; (5) leave `total_ansem_liability_atomic` unchanged.
4. **Position remainder lifecycle:** `RewardState.cowboy_orphaned_accrual_remainder_scaled` and `BullAccumulator.bull_orphaned_accrual_remainder_scaled` collect the role-appropriate sub-atomic carry of positions that leave synchronization. Sale/gift preserve the carry on the `Position` (it follows the position to the new owner, whose global checkpoint is reset to the current index). Unstake/closure moves the carry into the matching global orphaned field before the account closes. When an orphaned remainder reaches its scale, the whole-atomic portion is materialized by reducing the matching unmaterialized liability bucket and `total_ansem_liability_atomic`; the released ANSEM becomes free balance that may fund future epochs. `recognized_reward_balance_atomic` is unchanged, no ANSEM token transfer occurs, no Bull-pool or suit-vault liability is created, and the operation must fail if it would underflow the matching liability bucket. The cumulative `orphaned_reward_released_atomic` counter is increased by `whole_amount` and an `OrphanedRewardReleased` event is emitted. The per-role materialization is:
   - **Cowboy orphan materialization:**
     - `whole_amount = cowboy_orphaned_accrual_remainder_scaled / COWBOY_REWARD_INDEX_SCALE`
     - `cowboy_orphaned_accrual_remainder_scaled %= COWBOY_REWARD_INDEX_SCALE`
     - `cowboy_unmaterialized_liability_atomic -= whole_amount`
     - `total_ansem_liability_atomic -= whole_amount`
   - **Bull orphan materialization:**
     - `whole_amount = bull_orphaned_accrual_remainder_scaled / REWARD_PER_WEIGHT_SCALE`
     - `bull_orphaned_accrual_remainder_scaled %= REWARD_PER_WEIGHT_SCALE`
     - `bull_pool_liability_atomic -= whole_amount`
     - `total_ansem_liability_atomic -= whole_amount`
5. **Accounted principal transitions:** `GlobalGameState.accounted_principal_atomic` increases by `principal_amount` on stake, decreases by `principal_amount` on a successful unstake, and decreases by `principal_amount` (with `live_position_count -= 1`) on a reveal-timeout refund. Ownership changes never alter accounted principal.
6. **Tied suits:** `SocialResult`/`SuitCompetitionResultAttested` and the public indexer schema replace the singular `winning_suit` with `winning_suits_mask: u8`. For `N` tied suits, the distributable suit vault is divided equally among the `N` suits, the 50/50 equal/proportional split is applied independently inside each tied suit, and all integer-division remainder rolls into the next competition.
7. **Randomness event consistency:** `RandomnessRequested` adds `committed_protocol_epoch: u64` and `timeout_timestamp: i64` so its schema matches `PendingRandomness` and the indexer's `randomness_requests` table.
8. **Recognized balance wording:** `recognized_reward_balance_atomic` decreases only when ANSEM actually leaves `RewardVault`. It does not decrease for Cowboy tax reclassification, Desperado tax reclassification, unstake theft routed to the Bull pool, or active/unallocated Bull-pool routing, because none of those move ANSEM out of the vault.
9. **Stale cleanup:** the "next 40 supplied epoch targets" wording is removed in favor of `epoch_emission = floor(free_ansem / 40)` and `required runway amount = epoch_emission * 40`. Remaining generic "rank/tier" wording in account/event field descriptions is reconciled to `cowboy_kind`/`bull_tier`; probability tables are unchanged.

- Token mint addresses and decimals are supplied at production initialization and stored in `GlobalConfig`; `stake_amount_atomic` and `expected_total_supply_atomic` are computed as `whole_amount * 10^rodeo_decimals`.
- `ACCRUAL_WEIGHT_SCALE = 10,000` and `REWARD_PER_WEIGHT_SCALE = 1,000,000,000,000,000,000`.
- Whole-token values: total RODEO supply = `1,000,000,000`, stake amount = `100,000` whole RODEO.
- Position receipt is a Metaplex Core Asset created frozen with Rodeo-controlled permanent transfer, freeze (`frozen=true`), and burn delegates; created at reveal settlement directly for the final owner.
- Marketplace sales are denominated in SOL only.
- Non-custodial `Listing` PDAs derive from `[b"listing", position, listing_nonce]`; stale listings are prevented by `Position.state_version` and `listing_nonce`.
- Wallet claim cooldown uses a `[b"claim_cooldown", global_config, wallet]` PDA.
- Randomness uses a provider-adapter architecture with Switchboard as the proposed v1 provider; 30-minute timeout; permissionless settlement; reveal principal recovery before assignment; after an unstake is committed it settles or timeout-recovers when no oracle value is available.
- Governance: 3-of-5 Squads Upgrade Council (72-hour timelock), 3-of-5 Squads Treasury Council (48-hour timelock), 2-of-3 Emergency Guardians (immediate pause, 12-hour unpause delay).
- Governance rules are governance-protected and timelocked, not technically immutable; upgrade proposals must publish source diff, reproducible build, program-data hash, and activation time.
- Jupiter is the approved v1 swap aggregator with $100-equivalent minimum batch, 1% max slippage, 0.5% max price impact; source-token dust rolls into the next routing batch.
- Logarithmic social scoring model with maximum three eligible posts per linked X account per epoch; undistributed suit vault rolls over.
- Winning-suit proportional reward is allocated per X account first, then divided equally among that account's eligible positions.
- Recommended off-chain stack: Helius RPC/webhooks, PostgreSQL, TypeScript indexer/keeper, IPFS/Arweave immutable result files, on-chain Merkle root and content hash.
- ANSEM liabilities are explicitly bucketed (`total_ansem_liability_atomic`, `cowboy_unmaterialized_liability_atomic`, `position_claimable_liability_atomic`, `bull_pool_liability_atomic`, `bull_pool_unallocated_liability_atomic`, `suit_vault_liability_atomic`) and must be vault-backed.
- Cowboy synchronization reclassifies `accrued` from `cowboy_unmaterialized_liability_atomic` to `position_claimable_liability_atomic` with no change to `total_ansem_liability_atomic`.
- Bull synchronization reclassifies `accrued` from `bull_pool_liability_atomic` to `position_claimable_liability_atomic` with no change to `total_ansem_liability_atomic`; Bull claim pays from `position_claimable_liability_atomic` and reduces `total_ansem_liability_atomic` but does not decrement `bull_pool_liability_atomic` a second time.
- Reward vault accounting tracks `recognized_reward_balance_atomic`; the unrecognized reward surplus is computed dynamically as `reward_vault_balance - recognized_reward_balance_atomic`, not stored. Free ANSEM = `min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic`.
- Principal vault accounting tracks `accounted_principal_atomic` and reports surplus as `actual_principal_vault_balance - accounted_principal_atomic`; surplus is never player principal.
- Unstake burn = `principal - principal_returned`; no burn remainder sits in the vault.
- Bull rewards use a single global `BullAccumulator`; mint-theft selection requires a finalized `BullRegistry` design with Merkle-sum root and snapshot availability before implementation.
- Epoch closure is permissionless `close_epochs(max_epochs)` with a maximum of `8` epochs per transaction and per-epoch snapshots; state-changing instructions require elapsed epochs to be closed.
- Epoch emission = `floor(free_ansem / RUNWAY_EPOCHS)`; there are no approved per-epoch target tables.
- A "reroll" is performed by unstaking and staking again with a new `position_id`, not as an in-place instruction.
- Desperado is represented as `CowboyKind::Desperado`, not as an undocumented rank/tier sentinel.
- Cowboy rank conditional probabilities are given over the Cowboy denominator; Bull tier conditional probabilities are given over the Bull denominator.

## Intentionally unresolved for Protocol Specification v1

The following remain `BLOCKED: OWNER DECISION REQUIRED` in the relevant sub-documents:

- Final `BullRegistry` design, account sizes, page capacity, maximum supported live positions/Bulls/owners, Merkle-sum proof format, historical snapshot availability, and compute benchmarks (mint-theft reveal implementation is blocked until reviewed);
- Exact per-source-mint `PendingBatch` account schema;
- Exact Metaplex Core plugin configuration and receipt-authority PDA for permanent transfer, freeze, and burn delegates;
- Production randomness provider exact Switchboard integration (queue, task format, CPI vs. callback, proof serialization) and whether commit/reveal hashing is retained as defense-in-depth;
- Future support for bids/auctions/private offers (v1 listings have no automatic expiration and support only fixed-price direct sale);
- Marketplace secondary royalties, listing fees, and cancellation fees (v1 has none);
- Exact Squads program addresses, member pubkeys, and timelock program instances;
- Off-chain price oracle for the $100-equivalent minimum batch and Jupiter integration mode (v6 API vs. on-chain program vs. custom keeper);
- Incentive/reward for permissionless randomness settler bot;
- Exact X API integration and post-verification pipeline;
- Tie-breaker rule if timestamp-based winning-suit resolution is infeasible;
- Public API rate limits, caching strategy, and reproducible-build tooling.

No implementation in any branch may silently resolve these questions. Each requires an explicit owner decision and a follow-up spec amendment.
