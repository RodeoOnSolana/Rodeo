# Rodeo Protocol Specification v1

## Status

**Version:** 1.1.0  
**State:** authoritative source of truth for contract, frontend, indexer, keeper, marketplace, and treasury implementation.  
**Replaces:** any prior `rodeo-game-spec.md` drafts and the Phase 0 economic placeholders.  
**Scope:** Phase 1 protocol design only. No production Anchor instructions are implemented in this branch.

## Purpose

This document is the single source of truth for the Rodeo risk-to-earn protocol on Solana. It defines the tokenomics, account model, state machine, probability tables, emission schedule, marketplace mechanics, randomness requirements, governance boundaries, security invariants, and implementation order for all downstream work.

Every rule stated here is either an approved protocol decision (carried forward from Phase 0 or explicitly decided by the protocol owner) or explicitly marked as unresolved with the label `BLOCKED: OWNER DECISION REQUIRED`. No implementation may silently invent, modify, or relax a rule marked as approved.

## Approved protocol decisions

### Launch and token facts

- RODEO launches through pump.fun.
- Total RODEO supply: `1,000,000,000`.
- Stake requirement per position: `100,000` RODEO.
- Minimum active stake period: `24 hours`.
- No wallet-level position cap.
- One position has exactly one owner at a time.
- Position PDA identity is independent of owner (`[b"position", global_config, position_id]`).
- Partial unstaking and position splitting are not supported.
- Full unstake closes the position and returns the post-tax principal.
- Restaking is equivalent to creating a new position and opening a new reveal action.

### Role odds

- Fixed odds at launch; no dynamic population balancing.
- Total Cowboy probability: `90%` of reveals.
- Total Bull probability: `10%` of reveals.
- Desperado is included within the Cowboy total and has exactly `0.05%` probability across all reveals.
- Suit is assigned independently at `25%` each.
- See [probabilities-and-rarities.md](./probabilities-and-rarities.md) for exact integer tables and accrual weights.

### Cowboy distribution

| Rank | Probability | Accrual weight |
| --- | --- | --- |
| 4 | 40.4775% | 1.00x |
| 5 | 22.4875% | 1.05x |
| 6 | 11.6935% | 1.10x |
| 7 | 7.1960% | 1.18x |
| 8 | 4.4975% | 1.28x |
| 9 | 2.6985% | 1.40x |
| 10 | 0.8995% | 1.55x |
| Desperado | 0.05% | 1.00x |

### Bull distribution

| Tier | Probability | Buck power |
| --- | --- | --- |
| 1 | 6.00% | 4 |
| 2 | 2.50% | 6 |
| 3 | 1.00% | 8 |
| 4 | 0.50% | 10 |

### Claims

- Normal Cowboy claim: `80%` of pending ANSEM to owner, `20%` to the shared Bull reward pool.
- Desperado claim: `98%` to owner, `2%` to the Bull reward pool.
- Claim does not unstake the position.
- Claim cooldown: `1 hour` per wallet.
- A wallet may batch-claim multiple owned positions in one transaction.
- Bull rewards are distributed using reward-per-buck-power accounting.

### Unstaking

- All roles pay a `5%` tax on staked RODEO.
- The taxed RODEO is burned.
- `95%` of principal is returned to the owner.
- For normal Cowboys:
  - `5%` chance that `100%` of pending ANSEM is sent to the Bull pool.
  - `95%` chance that `100%` of pending ANSEM is sent to the owner.
- Desperado is immune to ANSEM unstake theft.
- Bulls settle accumulated rewards safely when unstaking.
- Unstake randomness must be committed before the result is known.
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
- Rolling runway: `10 days`, equal to `40 epochs`.
- Free ANSEM = vault balance minus all accrued and unclaimed liabilities.
- Epoch emission = free ANSEM divided by `40`.
- `90%` of each epoch emission goes to Cowboy production.
- `10%` goes to the current suit competition vault.
- No fixed APY or guaranteed payout.
- Already accrued rewards cannot be reused in future emission calculations.

### External revenue

- `70%` used to buy ANSEM for the reward vault.
- `15%` sent to team and marketing.
- `10%` used to buy and permanently burn RODEO.
- `5%` sent to security and operations.
- Use actual realized fee receipts, not a hardcoded pump.fun fee rate.
- Player claim taxes and theft distributions are not protocol revenue.

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
- Buyer receives role, rank/tier, suit, and locked principal.
- Buyer does not receive seller's pending ANSEM.
- Marketplace fee: `5%` of sale price, taken once from seller proceeds.
- Marketplace fees enter the external revenue split.
- Position cannot transfer while a randomness action is pending.
- Generic transfers outside approved Rodeo flows must be rejected.
- Direct gifts use forced settlement but no marketplace fee.
- Ownership authority and receipt asset transfer must occur atomically.

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
- User and admin cannot cancel after commitment because of an unfavorable result.
- Settlement is permissionless.
- Failed settlement cannot generate new randomness.
- Oracle timeout recovery must not trap player principal.
- Pending random actions block position transfer.

### Governance

- Upgrade authority controlled by a multisig and timelock.
- Treasury authority separated from program upgrade authority.
- Emergency guardians may pause risky new actions.
- Emergency controls cannot withdraw player principal.
- Safe claims and exits should remain available whenever possible.
- Core economic parameters become immutable after launch.
- No admin may modify: role odds, taxes, theft percentages, stake amount, buck power, revenue percentages, runway length, emission allocation, marketplace fee.

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
- a generic `transfer_position` primitive that changes `Position.owner` without changing the PDA;
- `PendingRandomness` addressing by `[position, action_type, action_nonce]`;
- an economic-simulator event reducer with explicit configuration required;
- local integration tests proving PDA identity survives ownership change.

Phase 1 fills in all economic and game rules while leaving production instruction implementations for Phase 2. No Phase 0 behavior is overturned; probability tables, constants, and emission formulas are added where Phase 0 intentionally left placeholders.

## Owner decisions applied in v1.1.0

The following decisions have been applied across the v1 sub-documents:

- Token mint addresses and decimals are supplied at production initialization and become immutable; decimals are read from the mint accounts and stored in `GlobalConfig`.
- `ACCRUAL_WEIGHT_SCALE = 10,000` and `REWARD_PER_WEIGHT_SCALE = 1,000,000,000,000,000,000`.
- Position receipt is a Metaplex Core Asset with Rodeo-controlled permanent transfer and freeze delegates.
- Marketplace sales are denominated in SOL only.
- Non-custodial `Listing` PDAs derive from `[b"listing", position, listing_nonce]`; stale listings are prevented by `Position.state_version` and `listing_nonce`.
- Wallet claim cooldown uses a `[b"claim_cooldown", global_config, wallet]` PDA.
- Randomness uses a provider-adapter architecture with Switchboard as the proposed v1 provider; 30-minute timeout; permissionless settlement; reveal principal recovery before assignment; unstake-request cancellation leaves the position staked.
- Governance: 3-of-5 Squads Upgrade Council (72-hour timelock), 3-of-5 Squads Treasury Council (48-hour timelock), 2-of-3 Emergency Guardians (immediate pause, 12-hour unpause delay).
- Jupiter is the approved v1 swap aggregator with $100-equivalent minimum batch, 1% max slippage, 0.5% max price impact, no arbitrary dust-sweep recipient.
- Logarithmic social scoring model with maximum three eligible posts per linked X account per epoch.
- Recommended off-chain stack: Helius RPC/webhooks, PostgreSQL, TypeScript indexer/keeper, IPFS/Arweave immutable result files, on-chain Merkle root and content hash.

## Intentionally unresolved for Protocol Specification v1

The following remain `BLOCKED: OWNER DECISION REQUIRED` in the relevant sub-documents:

- pending-action transfer behavior (whether any future action type may be transferred with the pending action following the new owner);
- production unstake instruction implementation (the economic rules are specified; the on-chain instruction remains Phase 2 work);
- production randomness provider exact Switchboard integration (queue, task format, CPI vs. callback, proof serialization) and whether commit/reveal hashing is retained as defense-in-depth;
- marketplace listing expiration policy, and future support for bids/auctions/private offers;
- marketplace secondary royalties, listing fees, and cancellation fees (v1 has none);
- exact Squads program addresses, member pubkeys, and timelock program instances;
- off-chain price oracle for the $100-equivalent minimum batch and Jupiter integration mode (v6 API vs. on-chain program vs. custom keeper);
- incentive/reward for permissionless randomness settler bot;
- policy for undistributed suit-competition rewards;
- exact X API integration and post-verification pipeline;
- tie-breaker rule if timestamp-based winning-suit resolution is infeasible;
- public API rate limits, caching strategy, and reproducible-build tooling.

No implementation in any branch may silently resolve these questions. Each requires an explicit owner decision and a follow-up spec amendment.
