# Rodeo Protocol v1 — Economic Model

## Token units

All on-chain quantities are unsigned atomic integers. Token decimals are read from the mint accounts at initialization and stored in `GlobalConfig`; they are used only for display and input parsing, never for protocol arithmetic. The protocol operates in the smallest indivisible unit reported by each mint.

| Symbol | Unit | Notes |
| --- | --- | --- |
| RODEO | atomic RODEO | Principal, buyback burn, marketplace price. |
| ANSEM | atomic ANSEM | Rewards, suit-competition prizes. |
| REVENUE | atomic of the source token | External fee receipts before conversion. |

`AtomicAmount<Token>` branded types are used in TypeScript to prevent accidental cross-unit arithmetic. Rust uses checked `u128` intermediates for multiplication/division and `u64` for stored balances unless overflow analysis requires `u128`.

## Fixed economic constants (immutable after launch)

| Constant | Value | Description |
| --- | --- | --- |
| `TOTAL_RODEO_SUPPLY` | `1_000_000_000` | Total RODEO minted at launch. |
| `STAKE_AMOUNT_ATOMIC` | `100_000` | RODEO required to open one position. |
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
| `ACCRUAL_WEIGHT_SCALE` | `10_000` | Scale for Cowboy accrual weights. |
| `REWARD_PER_WEIGHT_SCALE` | `1_000_000_000_000_000_000` | Scale for Bull reward-per-buck-power accumulator. |

## External revenue split

External revenue is realized fee receipts denominated in SOL (Protocol v1). Marketplace fees are collected in SOL and routed through Jupiter. The split is applied after conversion to the destination token where applicable.

| Destination | Share | Rounding |
| --- | --- | --- |
| Buy ANSEM for reward vault | 70% | Floor atomic units; remainders stay in router pending account. |
| Team and marketing | 15% | Floor atomic units; remainder carried. |
| Buy and burn RODEO | 10% | Floor atomic units; remainders stay in router pending account. |
| Security and operations | 5% | Floor atomic units; remainder carried. |

The sum of floor allocations may leave dust in the router pending account. Dust is swept into the ANSEM reward vault at the end of a successful routing batch. This rule prevents any rounding direction from reducing the 70% reward-vault target below its floor.

## Principal flows

### Stake

- Owner transfers exactly `STAKE_AMOUNT_ATOMIC` RODEO into `principal_vault`.
- `Position.principal_amount` is set to `STAKE_AMOUNT_ATOMIC`.
- No RODEO is burned on stake.

### Unstake

1. Compute tax: `principal * UNSTAKE_TAX_BPS / 10_000`. Round down.
2. Compute return: `principal * UNSTAKE_RETURN_BPS / 10_000`. Round down.
3. The tax amount is burned.
4. The return amount is transferred to the owner's RODEO account.
5. Any rounding remainder (`principal - tax - return`) stays in the principal vault and is treated as a tiny burn. This guarantees `tax + return <= principal` and avoids creating RODEO.

## Reward flows

### ANSEM funding

- Initial `RewardVault` ANSEM balance is `0`.
- During `POT_FILL_SECONDS`, no ANSEM liability accrues.
- After the pot-fill period, epochs emit ANSEM from free balance.
- External revenue is converted to ANSEM and deposited into `RewardVault` by the keeper/router.

### Free ANSEM

```text
free_ansem = reward_vault_balance - ansem_liability_atomic
```

If `free_ansem <= 0`, the epoch emission is `0`.

### Epoch emission

```text
epoch_emission = free_ansem / RUNWAY_EPOCHS   // floor division
```

`90%` of `epoch_emission` is allocated to Cowboy production.
`10%` of `epoch_emission` is transferred to the suit-competition vault.

Cowboy production emission is distributed pro-rata by accrual weight among active Cowboy positions during the epoch. Distribution is lazy: a global reward index is updated each epoch, and positions record their last-claimed index.

### Claims

Normal Cowboy:
- Owner receives `claimable * CLAIM_OWNER_BPS / 10_000` (floor).
- Bull reward pool receives `claimable - owner_amount` (the remainder, capturing any rounding dust).

Desperado:
- Owner receives `claimable * DESPERADO_CLAIM_OWNER_BPS / 10_000` (floor).
- Bull reward pool receives `claimable - owner_amount`.

Bulls claim from the Bull reward pool using reward-per-buck-power accounting, not from Cowboy production.

### Suit competition reward

At the end of a seven-day social epoch:
1. 50% of the suit vault is divided equally among eligible active positions in the winning suit.
2. 50% is divided proportionally to verified contribution score.
3. Individual allocation is added as claimable ANSEM on each position.

If there are no eligible positions or no scores, the vault remains for the next competition or is burned per a future owner decision.

## Bull reward pool

The Bull reward pool is a conceptual allocation backed by ANSEM in the reward vault. It is accounted for through `BullAccumulator` using reward-per-buck-power.

```text
reward_per_weight_increment = pool_contribution * SCALE / total_buck_power   // floor
```

Each Bull position records the accumulator value at its last update. A Bull's claimable reward is:

```text
(current_accumulator - last_accumulator) * buck_power / SCALE   // floor
```

Remainders are carried in `division_remainder_atomic` and re-injected into the pool on the next contribution. This prevents reward-per-weight drift and preserves the invariant that total allocated Bull rewards do not exceed the pool balance.

## Marketplace accounting

- Sale price is paid by buyer to an escrow or directly to the program.
- Marketplace fee = `price * MARKETPLACE_FEE_BPS / 10_000` (floor).
- Seller receives `price - fee`.
- Fee enters external revenue split.
- Seller's pending ANSEM is force-claimed before transfer.
- Buyer starts with `claimable_ansem_atomic = 0`.

## Invariants

- `sum(Position.principal_amount) == principal_vault_balance`.
- `sum(Position.claimable_ansem_atomic) + bull_pool_allocated + suit_vault_allocated == ansem_liability_atomic`.
- `ansem_liability_atomic <= reward_vault_balance`.
- `total_allocated_ansem <= ansem_emitted_atomic + external_revenue_ansem`.
- No negative quantities anywhere.

## Rounding policy

- Multiplication followed by division floors unless the spec explicitly says ceiling.
- The only ceiling operation is converting a desired ANSEM purchase back into required revenue (`mulDivCeil`) to prevent underpaying.
- All rounding remainders are explicitly tracked or burned; no implicit truncation creates hidden supply.
- Every rounding direction is stated above and must be reproduced exactly in Rust and TypeScript.

## Open questions (BLOCKED)

- Maximum balance/supply bounds for account sizing: **BLOCKED: OWNER DECISION REQUIRED**.
- Whether leftover suit vaults rollover or burn: **BLOCKED: OWNER DECISION REQUIRED**.
