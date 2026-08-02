# Rodeo Protocol v1 — Economic Model

## Token units

All on-chain quantities are unsigned atomic integers. Token decimals are read from the mint accounts at initialization and stored in `GlobalConfig`; they are used only for display and input parsing, never for protocol arithmetic. The protocol operates in the smallest indivisible unit reported by each mint.

| Symbol | Unit | Notes |
| --- | --- | --- |
| RODEO | atomic RODEO | Principal, buyback burn, marketplace price. |
| ANSEM | atomic ANSEM | Rewards, suit-competition prizes. |
| REVENUE | atomic of the source token | External fee receipts before conversion. |

`AtomicAmount<Token>` branded types are used in TypeScript to prevent accidental cross-unit arithmetic. Rust uses checked `u128` intermediates for multiplication/division and `u64` for stored balances unless overflow analysis requires `u128`.

## Fixed economic constants (code-enforced)

| Constant | Value | Description |
| --- | --- | --- |
| `RODEO_TOTAL_SUPPLY_WHOLE` | `1_000_000_000` | Total whole RODEO minted at launch. |
| `STAKE_AMOUNT_WHOLE_RODEO` | `100_000` | Whole RODEO required to open one position. |
| `STAKE_AMOUNT_ATOMIC` | `100_000 * 10^rodeo_decimals` | Computed at initialization and stored in `GlobalConfig`. |
| `EXPECTED_TOTAL_SUPPLY_ATOMIC` | `1_000_000_000 * 10^rodeo_decimals` | Computed at initialization and stored in `GlobalConfig`. |
| `MIN_STAKE_SECONDS` | `86_400` | 24-hour minimum active stake. |
| `UNSTAKE_TAX_BPS` | `500` | 5% unstake tax on RODEO principal. |
| `UNSTAKE_RETURN_BPS` | `9_500` | 95% of RODEO principal returned on unstake. |
| `CLAIM_BULL_POOL_BPS` | `2_000` | 20% of normal Cowboy claim to Bull pool. |
| `CLAIM_OWNER_BPS` | `8_000` | 80% of normal Cowboy claim to owner. |
| `DESPERADO_CLAIM_OWNER_BPS` | `9_800` | 98% of Desperado claim to owner. |
| `DESPERADO_CLAIM_BULL_POOL_BPS` | `200` | 2% of Desperado claim to Bull pool. |
| `MINT_THEFT_BPS` | `500` | 5% chance a reveal is a mint theft. |
| `MIN_REVEALS_FOR_THEFT` | `50` | Protocol-wide completed reveals before theft activates. |
| `MIN_BULLS_FOR_THEFT` | `3` | Eligible active Bulls before theft activates. |
| `UNSTAKE_ANSEM_THEFT_BPS` | `500` | 5% chance normal Cowboy loses pending ANSEM on unstake. |
| `MARKETPLACE_FEE_BPS` | `500` | 5% marketplace fee on sale price. |
| `EPOCH_DURATION_SECONDS` | `21_600` | 6 hours. |
| `RUNWAY_EPOCHS` | `40` | 10 days. |
| `POT_FILL_SECONDS` | `43_200` | 12 hours after launch. |
| `EMISSION_COWBOY_BPS` | `9_000` | 90% of epoch emission to Cowboy production. |
| `EMISSION_SUITS_BPS` | `1_000` | 10% of epoch emission to suit competition. |
| `SUIT_EQUAL_SPLIT_BPS` | `5_000` | 50% of suit vault distributed equally. |
| `SUIT_PROPORTIONAL_SPLIT_BPS` | `5_000` | 50% of suit vault distributed by score. |
| `ACCRUAL_WEIGHT_SCALE` | `10_000` | Scale for Cowboy rank accrual weights. |
| `COWBOY_REWARD_INDEX_SCALE` | `1_000_000_000_000_000_000` | Scale for Cowboy production reward index. |
| `REWARD_PER_WEIGHT_SCALE` | `1_000_000_000_000_000_000` | Scale for Bull reward-per-buck-power accumulator. |

These values are code-enforced. A program upgrade can change code-enforced constants, but only through the governance-protected upgrade process (3-of-5 Upgrade Council, 72-hour timelock). They are not technically immutable.

## External revenue sources

External revenue includes protocol-controlled fee receipts:

- RODEO pump.fun creator fees.
- Rodeo marketplace fees.
- Protocol-controlled fee receipts from approved sponsorships or partnerships.

Explicitly **not** external protocol revenue:

- Player claim taxes (Cowboy 20%, Desperado 2%).
- Unstake theft distributions.
- Mint theft transfers.
- RODEO unstake taxes.
- Any player-to-player transfers.

Protocol v1 denominates marketplace fees in SOL. Each source mint has its own `PendingBatch` router account.

## External revenue split

For each batch of external revenue receipts denominated in a source token, the keeper/router applies the following split before conversion where applicable:

| Destination | Share | Rounding |
| --- | --- | --- |
| Buy ANSEM for reward vault | 70% | Floor atomic units of source token. |
| Team and marketing | 15% | Floor atomic units of source token. |
| Buy and burn RODEO | 10% | Floor atomic units of source token. |
| Security and operations | 5% | Floor atomic units of source token. |

The sum of floor allocations may leave source-token dust in the corresponding `PendingBatch`. All source-token dust remains in that `PendingBatch` and rolls into the next routing batch. There is no automatic sweep that redirects split-rounding dust into the ANSEM allocation.

## Principal flows

### Stake

- Owner transfers exactly `STAKE_AMOUNT_ATOMIC` RODEO into `principal_vault`.
- `Position.principal_amount` is set to `STAKE_AMOUNT_ATOMIC`.
- `GlobalConfig.stake_amount_atomic` and `expected_total_supply_atomic` are computed as `whole_amount * 10^rodeo_decimals` at initialization.
- Initialization rejects any mint configuration whose required values overflow `u64` or `u128` intermediates.
- No RODEO is burned on stake.

### Unstake

1. Compute tax: `principal * UNSTAKE_TAX_BPS / 10_000`. Round down.
2. Compute return: `principal * UNSTAKE_RETURN_BPS / 10_000`. Round down.
3. The tax amount is burned: `burned = principal - returned`.
4. The return amount is transferred to the owner's RODEO account.
5. `UNSTAKE_TAX_BPS + UNSTAKE_RETURN_BPS == 10_000`, so there is no rounding remainder and the burned amount is exactly the tax.

## Reward flows

### ANSEM funding

- Initial `RewardVault` ANSEM balance is `0`.
- During `POT_FILL_SECONDS`, no ANSEM liability accrues.
- After the pot-fill period, epochs emit ANSEM from free balance.
- External revenue is converted to ANSEM and deposited into `RewardVault` by the keeper/router.

### Free ANSEM

```text
free_ansem = min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic
```

If `free_ansem <= 0`, the epoch emission is `0`.

### Epoch emission

```text
epoch_emission = free_ansem / RUNWAY_EPOCHS   // floor division
```

`90%` of `epoch_emission` is reserved as Cowboy production liability.
`10%` of `epoch_emission` is reserved as suit-competition liability.

If `total_active_cowboy_weight == 0`, the Cowboy portion remains free ANSEM in the reward vault; no Cowboy liability is created. The suit portion is always reserved.

Cowboy production emission is distributed pro-rata by accrual weight among active Cowboy positions during the epoch. Distribution is lazy: a global reward index is updated each epoch, and positions record their last-claimed index. The Cowboy index uses `COWBOY_REWARD_INDEX_SCALE`.

### Reward synchronization (before any claim or unstake)

Cowboy synchronization:
- `accrued = (current_cowboy_index - last_index) * position_weight / COWBOY_REWARD_INDEX_SCALE` (floor).
- `cowboy_unmaterialized_liability_atomic -= accrued`.
- `position_claimable_liability_atomic += accrued`.
- `total_ansem_liability_atomic` unchanged.

Bull synchronization:
- `accrued = (current_bull_reward_per_weight - last_value) * buck_power / REWARD_PER_WEIGHT_SCALE` (floor).
- `bull_pool_liability_atomic -= accrued`.
- `position_claimable_liability_atomic += accrued`.
- `total_ansem_liability_atomic` unchanged.

### Claims

Normal Cowboy:
- Synchronize the position first.
- Owner receives `claimable * CLAIM_OWNER_BPS / 10_000` (floor).
- The remainder `claimable - owner_amount` is reclassified from `position_claimable_liability_atomic` to `bull_pool_liability_atomic`.
- `total_ansem_liability_atomic` decreases by `owner_amount`.

Desperado:
- Owner receives `claimable * DESPERADO_CLAIM_OWNER_BPS / 10_000` (floor).
- The remainder goes to the Bull pool.

Bull:
- Synchronize the position first.
- Claim the full synchronized `claimable` amount.
- `position_claimable_liability_atomic -= claimable`.
- `total_ansem_liability_atomic -= claimable`.
- `bull_pool_liability_atomic` was already reduced during synchronization; it is not reduced again.

Normal Cowboy unstake:
- Synchronize pending production rewards before settlement.
- `95%` outcome: 100% of synchronized pending ANSEM is paid to the owner.
- `5%` outcome: 100% of synchronized pending ANSEM is reclassified to the Bull pool.
- The normal 80/20 claim tax does **not** apply during unstake.

Desperado and Bull unstake: 100% of synchronized claimable ANSEM is paid to the owner safely.

### Suit competition reward

At the end of a seven-day social epoch:
1. 50% of the suit vault is divided equally among eligible active positions in the winning suit (the "equal half").
2. 50% is divided proportionally to verified contribution score (the "proportional half").
3. The proportional half is computed per linked X account:
   `account_reward = proportional_half * account_score / total_account_score` (floor).
4. Each X account's reward is then divided equally among that account's eligible positions.
5. Individual allocations are stored as Merkle leaves bound to `competition_epoch`, `position`, `owner_at_snapshot`, `amount`, and `leaf_nonce`.
6. Suit claims pay 100% to the snapshot owner and are not subject to the Cowboy 80/20 claim tax.
7. A claim receipt/bitmap prevents replay of the same leaf.

If there are no eligible positions or no scores, the vault rolls into the next social epoch. It is never burned.

## Bull reward pool

The Bull reward pool is a conceptual allocation backed by ANSEM in the reward vault. It is accounted for through `BullAccumulator` using reward-per-buck-power.

```text
reward_per_weight_increment = pool_contribution * SCALE / total_buck_power   // floor
```

Each Bull position records the accumulator value at its last update. A Bull's claimable reward is:

```text
(current_accumulator - last_accumulator) * buck_power / SCALE   // floor
```

Remainders from scaled accumulator divisions remain in the global accumulator value; they are not tracked as separate liabilities. They carry forward into future distributions.

## Marketplace accounting

- Sale price is paid by buyer to an escrow or directly to the program.
- Marketplace fee = `price * MARKETPLACE_FEE_BPS / 10_000` (floor).
- Seller receives `price - fee`.
- Fee enters external revenue split.
- Seller's pending ANSEM is force-claimed before transfer.
- Buyer starts with `claimable_ansem_atomic = 0`.

## Invariants

- `accounted_principal_atomic == sum(Position.principal_amount for every live Position)`.
- `actual_principal_vault_balance >= accounted_principal_atomic`.
- `principal_vault_surplus_atomic = actual_principal_vault_balance - accounted_principal_atomic`. Surplus is never treated as player principal and cannot be withdrawn through normal unstake.
- Live positions include: `RevealPending`, `Active`, and positions with a pending unstake action.
- `total_ansem_liability_atomic == cowboy_unmaterialized_liability_atomic + position_claimable_liability_atomic + bull_pool_liability_atomic + bull_pool_unallocated_liability_atomic + suit_vault_liability_atomic`.
- `position_claimable_liability_atomic == sum(Position.claimable_ansem_atomic for every live Position)`.
- `free_ansem = min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic`.
- `total_ansem_liability_atomic <= recognized_reward_balance_atomic <= actual_reward_vault_balance`.
- `unrecognized_reward_surplus_atomic` tracks ANSEM in the reward vault that has not been recognized for liability accounting. Direct unsolicited transfers and ANSEM purchased before catch-up are held here.
- `total_allocated_ansem <= ansem_emitted_atomic + recognized_external_ansem`.
- The same ANSEM is never emitted, reserved, or counted twice.
- No negative quantities anywhere.

## Rounding policy

- Multiplication followed by division floors unless the spec explicitly says ceiling.
- The only ceiling operation is converting a desired ANSEM purchase back into required revenue (`mulDivCeil`) to prevent underpaying.
- All rounding remainders are explicitly tracked or burned; no implicit truncation creates hidden supply.
- Every rounding direction is stated above and must be reproduced exactly in Rust and TypeScript.

## Open questions (BLOCKED)

- Maximum balance/supply bounds for account sizing: **BLOCKED: OWNER DECISION REQUIRED**.
- Exact `PendingBatch` account schema for each source mint: **BLOCKED: OWNER DECISION REQUIRED**.
