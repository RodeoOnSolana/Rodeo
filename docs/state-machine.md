# Rodeo Protocol v1 — State Machine

## Position status values

A `Position` has exactly one status at any time.

| Status | Meaning |
| --- | --- |
| `RevealPending` | The position has been staked and a reveal action is outstanding. The role, rank/tier, and suit are not yet known. No transferable receipt exists yet. |
| `Active` | The reveal has settled and the position has a resolved role, rank/tier, and suit. A Metaplex Core receipt exists for the final owner. The position accrues rewards and may be claimed, listed, gifted, or unstaked. |

There is no `Closed` position status in Protocol v1. A fully settled unstake burns the receipt and closes the `Position` account; historical closure is represented by events and the indexer.

There is no `Settled` status in Protocol v1. Phase 0 used `Settled` as an intermediate mock-reveal status; Protocol v1 collapses a successful reveal directly into `Active`.

## Pending action lock

`Position.pending_action_active` is a lock flag.

- `true` while any randomness action (reveal or unstake) is outstanding.
- `false` after the corresponding settlement instruction completes.
- While `true`, claims, ownership transfer, marketplace sale, gift, and competing randomness actions are rejected.
- The lock follows the `Position`, not the owner. If a future owner decision permits transferring a position with a pending action, the pending action would continue against the same `Position` account and the new owner would settle it.
- An unstake request keeps `status = Active`; only `pending_action_active` and `pending_action_type` change.
- There is no `cancel_unstake_request` instruction. Once committed, an unstake may only settle from valid randomness or timeout-recover after the 30-minute timeout when no valid oracle value exists.

## Legal transitions

```
Stake ──► RevealPending
RevealPending ──reveal settled──► Active
Active ──claim────► Active
Active ──list/sale──► Active (ownership changes, PDA unchanged)
Active ──gift──────► Active (ownership changes, PDA unchanged)
Active ──mint theft──► Active (ownership changes, PDA unchanged)
Active ──unstake request──► Active (pending_action_active = true)
Active ──unstake settled──► account closed (receipt burned, no Closed status)
```

Rerolling is not an in-place instruction in Protocol v1. A "reroll" is performed by fully unstaking the position, creating a new position, and requesting a new reveal. The new position receives a new `position_id` and a new randomness nonce.

## Transition details

### Stake

- Requirements: owner signs; `principal_amount == STAKE_AMOUNT_ATOMIC`; no existing `Position` at the derived PDA for the chosen `position_id`; no receipt asset exists for that position.
- Effects:
  - Transfer `STAKE_AMOUNT_ATOMIC` RODEO from owner to `principal_vault`.
  - Create `Position` with status `RevealPending`, role `Unassigned`, and an outstanding reveal action.
  - Create the reveal `PendingRandomness` account.
  - Update `GlobalGameState.live_position_count` and `GlobalGameState.total_completed_reveals` is unchanged.
  - Emit `PositionStaked`.

### Reveal settle

- Requirements: the reveal `PendingRandomness` exists, is not already settled, and the oracle proof verifies. The settling instruction is permissionless.
- Effects:
  - Resolve role (Cowboy/Bull), Cowboy rank or Bull tier, and suit using the approved probability tables and independent domain-separated randomness draws.
  - Evaluate mint theft. If eligibility criteria are met and an external eligible Bull recipient exists, atomically create the Metaplex Core receipt directly for the selected Bull owner and update `Position.owner`. If eligibility criteria are not met or no eligible external recipient exists, the theft resolves safely as "not stolen" with no additional ownership change.
  - If no theft occurs, create the receipt directly for the staker.
  - Record `receipt_asset`, `accrual_weight` or `buck_power`, `active_since`, `unstake_eligible_at = active_since + 24 hours`, and clear `pending_action_active`.
  - For Cowboy outcomes, represent the result as `CowboyKind::Rank(u8)` or `CowboyKind::Desperado` rather than an undocumented sentinel rank/tier value.
  - Update `GlobalGameState.total_completed_reveals`, `active_cowboy_count`, `active_bull_count`, `total_active_cowboy_weight`, `total_active_bull_power`.
  - Mark `PendingRandomness` settled, set status `Active`.
  - Emit `PositionRevealed`.

### Cowboy claim

- Requirements: owner signs; position is `Active` and role is `Cowboy`; wallet claim cooldown has elapsed; position has `claimable_ansem_atomic > 0`.
- Effects:
  - Synchronize pending Cowboy production rewards from `cowboy_unmaterialized_liability_atomic` to `position_claimable_liability_atomic`; `total_ansem_liability_atomic` is unchanged.
  - For normal Cowboys: allocate `80%` to owner, `20%` to Bull reward pool.
  - For Desperado: allocate `98%` to owner, `2%` to Bull reward pool.
  - Decrease `position_claimable_liability_atomic` by the full claimable, decrease `total_ansem_liability_atomic` only by the owner amount transferred out, and increase `bull_pool_liability_atomic` by the Bull-pool share.
  - Update `WalletClaimCooldown.last_claimed_at`.
  - Emit `PositionClaimed`.

### Bull claim

- Requirements: owner signs; position is `Active` and role is `Bull`; wallet claim cooldown has elapsed; position has `claimable_ansem_atomic > 0`.
- Effects:
  - Synchronize pending Bull rewards from `bull_pool_liability_atomic` to `position_claimable_liability_atomic`; `total_ansem_liability_atomic` is unchanged.
  - Reduce `position_claimable_liability_atomic` and `total_ansem_liability_atomic` by the amount transferred out.
  - `bull_pool_liability_atomic` was reduced during synchronization; it is not reduced again.
  - Transfer ANSEM to the owner and update the Bull checkpoint.
  - No Cowboy claim tax applies.
  - Emit `PositionClaimed`.

### Unstake

- Requirements: owner signs; position is `Active`; no other pending action on the position; `now >= Position.unstake_eligible_at`.
- Steps:
  1. **Request unstake**. Commit an unstake randomness action. `status` remains `Active`; `pending_action_active = true`; `pending_action_type = Unstake`. There is no voluntary cancellation after commitment.
  2. **Settle unstake**. The result determines whether pending ANSEM is stolen (normal Cowboys only; 5% chance) or returned to the owner (95% chance). Desperado is immune. If the oracle value is already available, timeout recovery fails; permissionless settlement must be used.
  3. Force-settle all pending ANSEM. For normal Cowboys, the full synchronized pending amount is either paid to the owner (95% outcome) or reclassified to the Bull pool (5% outcome); the normal 80/20 claim tax does not apply. For Desperado, 100% is paid to the owner. For Bulls, 100% of synchronized Bull rewards is paid to the owner.
  4. Apply the `5%` RODEO unstake tax, burn it (`principal - returned`), and return `95%` of the principal.
  5. Update `GlobalGameState` population and power counters.
  6. Burn the receipt asset and close the `Position` account.
  7. Emit `PositionUnstaked`.

### Marketplace sale

- Requirements: seller (owner) signs; position is `Active`; no pending action; a valid listing exists and is not stale; the receipt asset owner matches `Position.owner`.
- Effects:
  1. Ensure all elapsed epochs are closed or invoke the permissionless catch-up path.
  2. Synchronize the seller's reward indices.
  3. Force-settle seller's pending ANSEM through the normal claim split.
  4. Atomically transfer the receipt asset via the Rodeo-controlled permanent transfer delegate and call `transfer_position`.
  5. Set `Position.unstake_eligible_at = transfer_timestamp + 24 hours`.
  6. Deduct `5%` of the sale price (in SOL) as marketplace fee and route it into the external revenue split.
  7. Transfer the remainder to the seller.
  8. Emit `PositionSold`.

### Direct gift

- Requirements: owner signs; position is `Active`; no pending action; the receipt asset owner matches `Position.owner`.
- Effects:
  1. Ensure all elapsed epochs are closed or invoke the permissionless catch-up path.
  2. Synchronize and force-settle pending ANSEM through the normal claim split.
  3. Atomically transfer the receipt asset via the Rodeo-controlled permanent transfer delegate and call `transfer_position`.
  4. Set `Position.unstake_eligible_at = transfer_timestamp + 24 hours`.
  5. No marketplace fee is charged.
  6. Emit `PositionGifted`.

### Mint theft

Mint theft is described in detail in [randomness-design.md](./randomness-design.md) and [probabilities-and-rarities.md](./probabilities-and-rarities.md). It is a reveal-time ownership change, not a marketplace sale, but it uses the same atomic receipt+position transfer primitive. The victim's receipt is never minted; the selected Bull owner receives the receipt directly. `Position.unstake_eligible_at` is set to `active_since + 24 hours` for the new owner.

## Receipt ownership rule

A position is considered validly owned only when both of the following match:
- `Position.owner` equals the intended owner.
- The Metaplex Core receipt asset's on-chain owner equals `Position.owner`.

Neither record alone is sufficient proof of ownership. All ownership-changing instructions verify the pair. The receipt asset is created frozen with permanent transfer, freeze, and burn delegates controlled by the Rodeo receipt-authority PDA, so the owner cannot move or burn it directly.

## Action ordering rules

- Only one randomness action per `Position` may be outstanding at any time.
- A second randomness action on the same position is rejected until the first settles or times out.
- Claims, sales, gifts, and transfers are rejected while `pending_action_active` is `true`.
- Multiple claims by the same wallet may be batched, but the one-hour wallet cooldown is checked once per batch using the `WalletClaimCooldown` PDA.
- The settlement nonce in `Position.settlement_nonce` increments on every successful randomness settlement, including the initial reveal and any subsequent unstake.
- Any instruction that changes active Cowboy weight, active Bull power, reward-vault funding, ANSEM liabilities, or position ownership with forced settlement must first close all elapsed epochs or invoke the permissionless `close_epochs` catch-up path.
