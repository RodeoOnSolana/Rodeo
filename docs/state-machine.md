# Rodeo Protocol v1 — State Machine

## Position status values

A `Position` has exactly one status at any time.

| Status | Meaning |
| --- | --- |
| `RandomnessPending` | The position has been staked and a reveal action is outstanding. The role, rank/tier, and suit are not yet known. |
| `Active` | The reveal has settled and the position has a resolved role, rank/tier, and suit. The position accrues rewards and may be claimed, listed, or unstaked. |
| `Closed` | The position has been fully unstaked. The `Position` account is closed and the receipt asset is burned. This status is terminal. |

There is no `Settled` status in Protocol v1. Phase 0 used `Settled` as an intermediate mock-reveal status; Protocol v1 collapses a successful reveal directly into `Active`.

## Pending action lock

`Position.pending_action_active` is a lock flag.

- `true` while any randomness action (reveal, unstake, etc.) is outstanding.
- `false` after the corresponding settlement instruction completes.
- While `true`, ownership transfer, marketplace sale, and gift are rejected.
- The lock follows the `Position`, not the owner. If a future owner decision permits transferring a position with a pending action, the pending action would continue against the same `Position` account and the new owner would settle it.

## Legal transitions

```
Stake ──► RandomnessPending
RandomnessPending ──reveal settled──► Active
Active ──claim────► Active
Active ──reroll?──► BLOCKED: OWNER DECISION REQUIRED
Active ──list/sale──► Active (ownership changes, PDA unchanged)
Active ──gift──────► Active (ownership changes, PDA unchanged)
Active ──mint theft──► Active (ownership changes, PDA unchanged)
Active ──unstake committed──► RandomnessPending (unstake action)
RandomnessPending ──unstake settled──► Closed
```

Rerolling is not approved in Protocol v1. Whether a reroll mechanism exists, what it costs, and whether it reuses the same `position_id` or creates a new position are all `BLOCKED: OWNER DECISION REQUIRED`.

## Transition details

### Stake

- Requirements: owner signs; `principal_amount == STAKE_AMOUNT_ATOMIC`; no existing `Position` at the derived PDA for the chosen `position_id`; no receipt asset exists for that position.
- Effects:
  - Transfer `STAKE_AMOUNT_ATOMIC` RODEO from owner to `principal_vault`.
  - Create `Position` with status `RandomnessPending`, role `Unassigned`, and an outstanding reveal action.
  - Create the reveal `PendingRandomness` account.
  - Emit `PositionStaked`.

### Reveal settle

- Requirements: the reveal `PendingRandomness` exists, is not already settled, and the supplied secret matches the stored commitment. The settling instruction is permissionless (any payer may provide the oracle/randomness proof).
- Effects:
  - Resolve role (Cowboy/Bull), Cowboy rank or Bull tier, and suit using the approved probability tables and independent domain-separated randomness draws.
  - Evaluate mint theft if eligibility criteria are met.
  - If a theft occurs, atomically transfer ownership of the entire position to the selected recipient Bull and emit `PositionStolen`.
  - If no theft occurs, ownership remains with the staker.
  - Mark `PendingRandomness` settled, clear `pending_action_active`, set status `Active`.
  - Emit `PositionRevealed`.

### Claim

- Requirements: owner signs; position is `Active`; wallet claim cooldown has elapsed; position has `claimable_ansem_atomic > 0`.
- Effects:
  - For normal Cowboys: allocate `80%` to owner, `20%` to Bull reward pool.
  - For Desperado: allocate `98%` to owner, `2%` to Bull reward pool.
  - Reduce position claimable balance and global ANSEM liability.
  - Transfer/burn from the reward vault according to the split.
  - Record wallet claim timestamp.
  - Emit `PositionClaimed`.

### Unstake

- Requirements: owner signs; position is `Active`; no other pending action on the position.
- Steps:
  1. Commit an unstake randomness action. Status remains `Active` but `pending_action_active` becomes `true` with `ActionType::Unstake`.
  2. Settle the unstake randomness. The result determines whether pending ANSEM is stolen (normal Cowboys only; 5% chance) or returned to the owner (95% chance). Desperado is immune.
  3. Apply the `5%` RODEO unstake tax, burn it, and return `95%` of the principal.
  4. Bulls settle accumulated rewards safely through the Bull reward pool.
  5. Burn the receipt asset and close the `Position` account.
  6. Emit `PositionUnstaked`.

### Marketplace sale

- Requirements: seller (owner) signs; position is `Active`; no pending action; a valid listing exists.
- Effects:
  1. Force-settle seller's pending ANSEM through the normal claim split.
  2. Atomically transfer the receipt asset and call `transfer_position`.
  3. Deduct `5%` of the sale price as marketplace fee and route it into the external revenue split.
  4. Transfer the remainder to the seller.
  5. Emit `PositionSold`.

### Direct gift

- Requirements: owner signs; position is `Active`; no pending action.
- Effects:
  1. Force-settle pending ANSEM through the normal claim split.
  2. Atomically transfer the receipt asset and call `transfer_position`.
  3. No marketplace fee is charged.
  4. Emit `PositionGifted`.

## Action ordering rules

- Only one randomness action per `Position` may be outstanding at any time.
- A second randomness action on the same position is rejected until the first settles or times out.
- Claim and transfer instructions are rejected while `pending_action_active` is `true`.
- Multiple claims by the same wallet may be batched, but the one-hour wallet cooldown is checked once per batch.
- The settlement nonce in `Position.settlement_nonce` increments on every successful randomness settlement, including the initial reveal and any subsequent unstake.
