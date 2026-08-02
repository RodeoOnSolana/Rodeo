# Rodeo Protocol v1 — Emissions and Rewards

## Epoch schedule

- Epoch duration: `6 hours` = `21,600` seconds.
- Runway length: `10 days` = `40 epochs`.
- Pot-fill period: `12 hours` = `2 epochs` after launch.
- Social competition epoch: `7 days` = `28 six-hour epochs`.

The first epoch begins at launch time plus `POT_FILL_SECONDS`. No ANSEM accrues during the pot-fill period even if the reward vault holds ANSEM.

## `close_epochs`

Epochs are advanced by a permissionless `close_epochs(max_epochs)` instruction. It processes epochs sequentially and advances the protocol clock atomically with each epoch boundary.

| Parameter | Value |
| --- | --- |
| Maximum per transaction | `8` epochs |
| Input | `max_epochs` capped at `8` |
| Behavior | Closes all elapsed epochs up to `max_epochs` or until current |

Any instruction that changes active Cowboy weight, active Bull power, reward-vault funding, ANSEM liabilities, or position ownership with forced settlement must first require all elapsed epochs to be closed, or the transaction must invoke the permissionless `close_epochs` catch-up path before performing the state change.

If `close_epochs` is not called, the protocol state remains on the last closed epoch boundary. Funding deposited after an epoch boundary cannot be applied retroactively to that expired epoch. Population changes after an epoch boundary cannot receive rewards retroactively for that expired epoch.

## Epoch snapshot

For each closed epoch, the protocol snapshots the following values at the epoch boundary:

- `actual_reward_vault_balance`
- `recognized_reward_balance_atomic`
- `total_ansem_liability_atomic`
- `total_active_cowboy_weight`
- `total_active_bull_power`

The emission for that epoch is computed from these snapshot values, not from any intermediate state that may have occurred during the epoch.

## Timing sources

On-chain epoch boundaries use Solana cluster `Clock::unix_timestamp`. Off-chain indexers and keepers may use the same timestamp or a block-height derived schedule, but on-chain rewards use `Clock`.

## Free ANSEM

```text
free_ansem = min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic
```

`free_ansem` is the portion of the reward vault that is recognized and not already promised as unclaimed liabilities. It must be recomputed immediately before every epoch close. Free ANSEM is never negative; if liabilities exceed the recognized balance, the epoch emission is `0` while the keeper routes more revenue.

ANSEM arriving after an elapsed epoch boundary is not recognized until a permissionless recognition instruction runs after catch-up closes that boundary. Direct unsolicited transfers to the reward vault also remain unrecognized until recognized. The recognized balance can never exceed the actual vault balance.

## Epoch emission

```text
epoch_emission = free_ansem / RUNWAY_EPOCHS   // floor
```

If `free_ansem == 0`, `epoch_emission == 0`.

The epoch emission is split:

| Destination | Share | Formula |
| --- | --- | --- |
| Cowboy production | 90% | `epoch_emission * 9_000 / 10_000` (floor) |
| Suit competition vault | 10% | `epoch_emission - cowboy_production` (remainder captures rounding dust) |

## Cowboy production rewards

The Cowboy production portion is distributed pro-rata by accrual weight among all `Active` Cowboy positions at the epoch close.

```text
total_active_cowboy_weight = sum(accrual_weight(position.rank)) for all Active Cowboys
cowboy_emission = floor(epoch_emission * 9_000 / 10_000)
numerator = cowboy_emission * COWBOY_REWARD_INDEX_SCALE + cowboy_index_remainder_scaled
index_increment = numerator / total_active_cowboy_weight             // floor
cowboy_index_remainder_scaled = numerator % total_active_cowboy_weight
```

Lazy accounting implementation:

- `RewardState` is the sole owner of the global `cowboy_reward_index: u128` (scaled by `COWBOY_REWARD_INDEX_SCALE`) and its exact-rounding carry `cowboy_index_remainder_scaled: u128`. No other account duplicates these fields.
- Each `Position` stores `last_cowboy_reward_index: u128` at the same scale, plus a per-position rounding carry `cowboy_accrual_remainder_scaled: u128`.
- On epoch close:
  - `numerator = cowboy_emission * COWBOY_REWARD_INDEX_SCALE + cowboy_index_remainder_scaled`.
  - `global_increment = numerator / total_active_cowboy_weight` (floor).
  - `cowboy_index_remainder_scaled = numerator % total_active_cowboy_weight`.
  - `cowboy_reward_index += global_increment`.
- On claim, forced settlement, or transfer (never gated on `claimable_ansem_atomic > 0`):
  - `position_numerator = (cowboy_reward_index - last_cowboy_reward_index) * position_weight + cowboy_accrual_remainder_scaled`.
  - `accrued = position_numerator / COWBOY_REWARD_INDEX_SCALE` (floor).
  - `cowboy_accrual_remainder_scaled = position_numerator % COWBOY_REWARD_INDEX_SCALE`.
  - Reclassify `accrued` from `cowboy_unmaterialized_liability_atomic` to `position_claimable_liability_atomic`; `total_ansem_liability_atomic` is unchanged.
  - `last_cowboy_reward_index = cowboy_reward_index`.

If `total_active_cowboy_weight == 0`, the Cowboy production emission is not reserved as a liability. It remains free ANSEM in the reward vault and is available for future epochs. No Cowboy production emission is burned.

## Bull reward pool

The Bull reward pool receives:

- `20%` of every normal Cowboy claim.
- `2%` of every Desperado claim.
- `100%` of normal Cowboy pending ANSEM on the 5% "stolen" unstake outcome.

Bulls do not earn Cowboy production rewards. Their rewards come from the Bull pool distributed by buck power.

```text
total_active_bull_power = sum(buck_power(position.tier)) for all Active Bulls
pool_contribution = amount_added_to_bull_pool
numerator = pool_contribution * REWARD_PER_WEIGHT_SCALE + bull_index_remainder_scaled
power_increment = numerator / total_active_bull_power             // floor
bull_index_remainder_scaled = numerator % total_active_bull_power
```

Every contribution — Cowboy claim tax, Desperado claim tax, and unstake-theft contributions — is routed through this same rule.

Lazy accounting:

- `BullAccumulator` is the sole owner of `reward_per_weight_scaled: u128` and its exact-rounding carry `bull_index_remainder_scaled: u128`.
- Each `Position` stores `last_bull_reward_per_weight: u128`, plus a per-position rounding carry `bull_accrual_remainder_scaled: u128`.
- On Bull pool contribution, if `total_active_bull_power > 0`:
  - `numerator = pool_contribution * REWARD_PER_WEIGHT_SCALE + bull_index_remainder_scaled`.
  - `reward_per_weight_scaled += numerator / total_active_bull_power` (floor).
  - `bull_index_remainder_scaled = numerator % total_active_bull_power`.
  - `bull_pool_liability_atomic` increases by `pool_contribution`.
- If `total_active_bull_power == 0`, the contribution instead increases `bull_pool_unallocated_liability_atomic`.
- On Bull synchronization (claim, unstake, or transfer; never gated on `claimable_ansem_atomic > 0`):
  - `position_numerator = (reward_per_weight_scaled - last_bull_reward_per_weight) * buck_power + bull_accrual_remainder_scaled`.
  - `accrued = position_numerator / REWARD_PER_WEIGHT_SCALE` (floor).
  - `bull_accrual_remainder_scaled = position_numerator % REWARD_PER_WEIGHT_SCALE`.
  - Reclassify `accrued` from `bull_pool_liability_atomic` to `position_claimable_liability_atomic`; `total_ansem_liability_atomic` is unchanged.
  - Update `last_bull_reward_per_weight`.
- On Bull claim payment:
  - `position_claimable_liability_atomic -= claimable` and `total_ansem_liability_atomic -= claimable`; `bull_pool_liability_atomic` has already been reduced by the synchronization step.
  - Transfer `claimable` ANSEM to the owner; `recognized_reward_balance_atomic` decreases by `claimable`; emit `RewardPaid`.

If `total_active_bull_power == 0`, contributions accumulate in `bull_pool_unallocated_liability_atomic`. When an eligible Bull set becomes active, the unallocated amount is distributed into the accumulator using the same numerator/remainder formula and `bull_pool_unallocated_liability_atomic` is cleared to zero. Unallocated Bull-pool ANSEM is never burned.

## Suit competition rewards

Every epoch, `10%` of the epoch emission is moved to the suit-competition vault. The vault accumulates for seven days (28 epochs). At the end of the social epoch, the entire vault is distributed to the winning suit.

### Distribution within the winning suit

| Portion | Share | Rule |
| --- | --- | --- |
| Equal split | 50% | Divided equally among eligible Active positions in the winning suit. |
| Proportional split | 50% | Divided by verified contribution score per X account, then split among that account's eligible positions. |

Eligibility rules:

- Position must be `Active` at the end of the social epoch.
- Position's linked X account must have posted at least one eligible post in the epoch.
- An X account may only link to one wallet per epoch.
- Maximum three scored posts per linked X account per epoch.

Individual allocation:

```text
equal_amount_per_position = equal_half / eligible_position_count   // floor
account_reward = proportional_half * account_score / total_account_score   // floor
position_proportional_share = account_reward / account_eligible_position_count   // floor
position_suit_reward = equal_amount_per_position + position_proportional_share
```

The proportional half prevents one X account's score from being multiplied by its number of positions. The X account's reward is divided equally among its eligible positions.

The remainder from floor divisions rolls into the next social epoch. A suit epoch with no eligible winner rolls the full suit vault into the next social epoch. No suit-competition ANSEM is burned.

## Runway reporting

The protocol reports runway after every epoch close:

```text
free_ansem = min(actual_reward_vault_balance, recognized_reward_balance_atomic) - total_ansem_liability_atomic
epoch_emission = free_ansem / RUNWAY_EPOCHS   // floor
required_ansem = epoch_emission * RUNWAY_EPOCHS
purchasable_ansem = sum over source mints(pending_batch_atomic * ansem_buy_rate)   // floor per mint
available_ansem = free_ansem + purchasable_ansem
covered = available_ansem >= required_ansem
covered_epochs = count of fully covered future epochs
```

This is a reporting and keeper signal, not an automatic cap. Emissions continue even if runway is below 40 epochs, as long as `free_ansem > 0`.

## No fixed APY

There is no guaranteed yield, fixed APY, or minimum payout. All rewards are funded by realized protocol revenue and distributed according to the formulas above. Protocol documentation and UI must not display fixed APY.

## Already accrued rewards cannot be reused

`ansem_liability_atomic` tracks all unclaimed ANSEM allocated to positions, the Bull pool, and suit vaults. Once allocated, ANSEM remains a liability until claimed or forfeited (e.g., lost to the Bull pool on unstake theft). It is never subtracted from `free_ansem` again and cannot fund new emissions.

## Open questions (BLOCKED)

- None for the approved emission and reward mechanics. Implementation sizing and compute costs for the Bull registry remain blocked in [account-model.md](./account-model.md) and [randomness-design.md](./randomness-design.md).
