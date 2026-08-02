# Rodeo Protocol v1 — Security Invariants

These invariants must hold before and after every successful instruction, and no instruction may complete if any of them would be violated.

## Token invariants

### RODEO principal conservation

```text
accounted_principal_atomic = sum(Position.principal_amount for every live Position)
actual_principal_vault_balance >= accounted_principal_atomic
principal_vault_surplus_atomic = actual_principal_vault_balance - accounted_principal_atomic
```

Live positions include `RevealPending`, `Active`, and positions with a pending unstake action. The principal vault balance must be at least the sum of all live-position principals. Any surplus is not player principal and cannot be withdrawn through normal unstake. No RODEO principal may be moved to a treasury, reward, or external account except through the approved unstake return/burn path.

### ANSEM liability cap

```text
free_ansem = min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic
total_ansem_liability_atomic <= recognized_reward_balance_atomic <= actual_reward_vault_balance
```

Total unclaimed ANSEM liabilities must never exceed the reward vault balance. Explicit buckets:

```text
total_ansem_liability_atomic ==
  cowboy_unmaterialized_liability_atomic
  + position_claimable_liability_atomic
  + bull_pool_liability_atomic
  + bull_pool_unallocated_liability_atomic
  + suit_vault_liability_atomic
```

The same ANSEM must never be emitted, reserved, or counted twice.

### No double spend

Every settlement has a unique identifier (`settlementId` in the simulator, or a combination of `(position, action_type, action_nonce)` and transaction signature on-chain). The same settlement cannot be applied twice.

### No negative balances

No account or vault may hold a negative atomic quantity. All arithmetic is checked.

## Ownership invariants

### Single owner per position

A `Position` has exactly one `owner` pubkey at any time. A position is validly owned only when `Position.owner` and the Metaplex Core receipt asset owner match. Neither record alone is sufficient proof of ownership.

### Ownership cannot change during pending randomness

`Position.pending_action_active == true` implies no ownership transfer, marketplace sale, gift, or forced settlement may occur on that position. The owner must first settle or timeout-recover the pending action.

### Owner-gated instructions

`claim`, `unstake`, `list`, `cancel_listing`, `gift`, and owner-initiated `transfer_position` require the current `Position.owner` signature. Randomness settlement is permissionless.

## Randomness invariants

### Unique randomness address

`PendingRandomness` PDAs are unique per `(position, action_type, action_nonce)`. A new action always consumes a new nonce, so no two actions collide.

### No selective cancellation

Neither users nor admins may cancel a committed randomness action because the outcome is unfavorable. Once an unstake is committed, it may only settle from valid randomness or timeout-recover after the 30-minute timeout when no valid oracle value exists. Timeout recovery fails if the oracle value is already available.

### Outcome binding

Randomness outcomes are bound to specific domains (role, rank, tier, suit, theft flags, thief selection, unstake theft). A single output is never reused across domains.

### Settlement replay protection

A `PendingRandomness` with `settled == true` cannot be settled again. Attempting to do so fails before any state change.

## Economic invariants

### Governance-protected constants

Because the program is upgradeable, constants are governance-protected through the Upgrade Council and 72-hour timelock, not technically immutable. No instruction or authority may modify the following without a published upgrade proposal:

- role odds, rank/tier/suit probabilities;
- stake amount (`STAKE_AMOUNT_ATOMIC`) and expected total supply;
- unstake tax (`UNSTAKE_TAX_BPS`);
- claim splits (`CLAIM_OWNER_BPS`, `CLAIM_BULL_POOL_BPS`, `DESPERADO_CLAIM_OWNER_BPS`, `DESPERADO_CLAIM_BULL_POOL_BPS`);
- mint theft percentage (`MINT_THEFT_BPS`) and eligibility thresholds (`MIN_REVEALS_FOR_THEFT`, `MIN_BULLS_FOR_THEFT`);
- unstake ANSEM theft percentage (`UNSTAKE_ANSEM_THEFT_BPS`);
- buck power per Bull tier;
- external revenue split (70/15/10/5);
- runway length and epoch duration;
- emission allocation (90/10);
- marketplace fee (`MARKETPLACE_FEE_BPS`).

All upgrade proposals must publish source diff, reproducible build, program-data hash, and activation time before the timelock begins.

### No guaranteed yield

No protocol code may promise or enforce a fixed APY, minimum payout, or guaranteed emission beyond the formulas in [emissions-and-rewards.md](./emissions-and-rewards.md).

### No principal authority for treasury

No treasury, governance, emergency, or router authority may withdraw or redirect staked RODEO principal. Principal leaves the principal vault only through unstake return/burn.

### No liability authority

No authority may reduce, cancel, or reallocate accrued ANSEM liabilities except through the approved claim, unstake theft, or Bull-pool settlement paths.

## Marketplace invariants

### Atomic ownership transfer

Marketplace sale, gift, and mint theft must atomically update both the receipt asset owner and `Position.owner`. A transaction that updates one without the other must fail.

### Seller keeps pending rewards

Before a sale or gift, the seller's pending ANSEM is force-claimed. The buyer's `claimable_ansem_atomic` starts at `0`. The seller cannot sell pending ANSEM to the buyer.

### Marketplace fee routing

`5%` of the sale price is routed to protocol revenue. No larger or smaller fee is permitted, and no additional royalty may be charged in Protocol v1. The receipt asset remains frozen with permanent transfer, freeze, and burn delegates controlled by Rodeo; the owner cannot move or burn it outside approved Rodeo flows.

### No stale settlement

A marketplace settlement must verify that the listing is still valid (ownership unchanged, position active, no pending action, not expired). A stale listing cannot settle.

## Governance invariants

### Upgrade authority separation

Program upgrade authority is distinct from treasury authority and from emergency guardian authority.

### Timelock

Material program upgrades must pass a **72-hour timelock** before deployment. Treasury routing changes must pass a **48-hour timelock**. The proposal must publish source diff, reproducible build, program-data hash, and activation time before the timelock begins.

### Action-specific emergency pause limits

Emergency Guardians may toggle `pause_new_stakes`, `pause_new_reveal_requests`, `pause_new_marketplace_listings`, and `pause_router_swaps`. Pause is immediate; unpause requires a 12-hour delay. The following remain available whenever technically safe: claims, randomness settlements, unstake requests, unstake settlements, and timeout recovery. Pausing must not withdraw principal or accrued liabilities.

## Liveness invariants

### Timeout recovery

If a randomness request times out (after 30 minutes), a recovery path must exist that returns the position to a safe state without trapping principal. A reveal timeout before role assignment closes the position and returns the full principal. An unstake timeout cancels the unstake request and leaves the position staked and Active. Timeout recovery fails if a valid oracle value is already available.

### Permissionless settlement

Settlement must not require the original user's availability. Any party may submit a valid proof and pay fees.

## Testing obligations

Every invariant above must have at least one property test or integration test. See [test-plan.md](./test-plan.md) for the test matrix.
