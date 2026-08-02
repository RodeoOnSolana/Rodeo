# Rodeo Protocol v1 — Emissions and Rewards

## Epoch schedule

- Epoch duration: `6 hours` = `21,600` seconds.
- Runway length: `10 days` = `40 epochs`.
- Pot-fill period: `12 hours` = `2 epochs` after launch.
- Social competition epoch: `7 days` = `28 six-hour epochs`.

The first epoch begins at launch time plus `POT_FILL_SECONDS`. No ANSEM accrues during the pot-fill period even if the reward vault holds ANSEM.

## Timing sources

On-chain epoch boundaries use Solana cluster `Clock::unix_timestamp`. Off-chain indexers and keepers may use the same timestamp or a block-height derived schedule, but on-chain rewards use `Clock`.

## Free ANSEM

```text
free_ansem = reward_vault_balance - ansem_liability_atomic
```

`free_ansem` is the portion of the reward vault that is not already promised as unclaimed liabilities. It must be recomputed immediately before every epoch close. Free ANSEM is never negative; if liabilities exceed balance, the protocol is insolvent and the epoch emission is `0` while the keeper routes more revenue.

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
increment_per_weight = cowboy_emission * ACCRUAL_WEIGHT_SCALE / total_active_cowboy_weight   // floor
position_share = increment_per_weight * position_weight / ACCRUAL_WEIGHT_SCALE   // floor
```

Lazy accounting implementation (recommended):

- `RewardState` stores a global `cowboy_reward_index: u128` scaled by `ACCRUAL_WEIGHT_SCALE`.
- Each `Position` stores `last_cowboy_reward_index: u128` at the same scale.
- On epoch close:
  - `global_increment = cowboy_emission * SCALE / total_active_cowboy_weight` (floor).
  - `cowboy_reward_index += global_increment`.
- On claim or transfer:
  - `accrued = (cowboy_reward_index - last_cowboy_reward_index) * position_weight / SCALE` (floor).
  - `claimable_ansem_atomic += accrued`.
  - `ansem_liability_atomic += accrued`.
  - `last_cowboy_reward_index = cowboy_reward_index`.

If `total_active_cowboy_weight == 0`, the Cowboy production emission is not distributed. The fate of undistributed emission is **BLOCKED: OWNER DECISION REQUIRED** (carry over, return to reward vault, or burn).

## Bull reward pool

The Bull reward pool receives:

- `20%` of every normal Cowboy claim.
- `2%` of every Desperado claim.
- `100%` of normal Cowboy pending ANSEM on the 5% "stolen" unstake outcome.

Bulls do not earn Cowboy production rewards. Their rewards come from the Bull pool distributed by buck power.

```text
total_active_bull_power = sum(buck_power(position.tier)) for all Active Bulls
pool_contribution = amount_added_to_bull_pool
power_increment = pool_contribution * REWARD_PER_WEIGHT_SCALE / total_active_bull_power   // floor
```

Lazy accounting:

- `BullAccumulator` stores `reward_per_weight_scaled: u128`.
- Each `Position` stores `last_bull_reward_per_weight: u128`.
- On Bull pool contribution:
  - `reward_per_weight_scaled += pool_contribution * SCALE / total_active_bull_power` (floor).
- On Bull claim:
  - `accrued = (reward_per_weight_scaled - last_bull_reward_per_weight) * buck_power / SCALE` (floor).
  - Add to `claimable_ansem_atomic` and `ansem_liability_atomic`.
  - Update `last_bull_reward_per_weight`.

If `total_active_bull_power == 0`, contributions remain in the pool and `reward_per_weight_scaled` does not change. The unallocated balance is tracked as a pool surplus and reallocated on the next contribution.

## Suit competition rewards

Every epoch, `10%` of the epoch emission is moved to the suit-competition vault. The vault accumulates for seven days (28 epochs). At the end of the social epoch, the entire vault is distributed to the winning suit.

### Distribution within the winning suit

| Portion | Share | Rule |
| --- | --- | --- |
| Equal split | 50% | Divided equally among eligible Active positions in the winning suit. |
| Proportional split | 50% | Divided by verified contribution score. |

Eligibility rules:

- Position must be `Active` at the end of the social epoch.
- Position's linked X account must have posted at least one eligible post in the epoch.
- An X account may only link to one wallet per epoch.
- Maximum three scored posts per linked X account per epoch.

Individual allocation:

```text
equal_amount_per_position = equal_half / eligible_position_count   // floor
proportional_share = proportional_half * position_score / total_eligible_score   // floor
position_suit_reward = equal_amount_per_position + proportional_share
```

The remainder from floor divisions is carried into the next social epoch or burned. The exact policy is **BLOCKED: OWNER DECISION REQUIRED**.

## Runway reporting

The protocol reports runway after every epoch close:

```text
required_ansem = sum(emission_target[epoch_i]) for the next 40 epochs
available_ansem = free_ansem + (pending_fee_revenue * ansem_buy_rate)   // floor
covered = available_ansem >= required_ansem
covered_epochs = count of fully covered future epochs
```

This is a reporting and keeper signal, not an automatic cap. Emissions continue even if runway is below 40 epochs, as long as `free_ansem > 0`.

## No fixed APY

There is no guaranteed yield, fixed APY, or minimum payout. All rewards are funded by realized protocol revenue and distributed according to the formulas above. Protocol documentation and UI must not display fixed APY.

## Already accrued rewards cannot be reused

`ansem_liability_atomic` tracks all unclaimed ANSEM allocated to positions, the Bull pool, and suit vaults. Once allocated, ANSEM remains a liability until claimed or forfeited (e.g., lost to the Bull pool on unstake theft). It is never subtracted from `free_ansem` again and cannot fund new emissions.

## Open questions (BLOCKED)

- Exact `ACCRUAL_WEIGHT_SCALE` and `REWARD_PER_WEIGHT_SCALE`: **BLOCKED: OWNER DECISION REQUIRED** (must be chosen after token decimals and max-supply analysis; minimum `1_000_000` recommended).
- Fate of Cowboy production emission when no Active Cowboys exist: **BLOCKED: OWNER DECISION REQUIRED**.
- Fate of suit-competition vault remainder: **BLOCKED: OWNER DECISION REQUIRED**.
- Whether Bull pool surplus is distributed retroactively or only on new contributions: **BLOCKED: OWNER DECISION REQUIRED**.
