# Rodeo Protocol v1 — Probabilities and Rarities

## Probability arithmetic rules

- All probabilities are represented as integer weights over a common denominator.
- The protocol uses no floating-point arithmetic.
- A table is valid only when every weight is non-negative and the exact sum equals the denominator.
- Randomness outcomes are produced by a single uniform draw `r` in `[0, denominator - 1]` and selecting the first interval whose cumulative weight exceeds `r`.
- Domain separation prevents a single randomness output from being reused across different decisions.

## Denominator

To express all approved percentages exactly, the protocol uses a denominator of `10_000_000` (ten million). This gives four decimal places of precision in basis-point form and exactly represents every approved value.

```text
Denominator = 10_000_000
```

## Role assignment

| Outcome | Weight | Probability |
| --- | --- | --- |
| Cowboy | 9_000_000 | 90.0000% |
| Bull | 1_000_000 | 10.0000% |

## Cowboy rank distribution

The Cowboy conditional denominator is `9_000_000`. Each weight is the conditional probability of that Cowboy outcome given that the role is Cowboy. The total-probability share is `conditional * 0.9` because Cowboy occurs 90% of the time.

| Rank | Weight | Conditional probability | Total probability across all reveals |
| --- | --- | --- | --- |
| 4 | 4_047_750 | 44.9750% | 40.4775% |
| 5 | 2_248_750 | 24.9861% | 22.4875% |
| 6 | 1_169_350 | 12.9928% | 11.6935% |
| 7 | 719_600 | 7.9956% | 7.1960% |
| 8 | 449_750 | 4.9972% | 4.4975% |
| 9 | 269_850 | 2.9983% | 2.6985% |
| 10 | 89_950 | 0.9994% | 0.8995% |
| Desperado | 5_000 | 0.055556% | 0.0500% |
| **Cowboy total** | **9_000_000** | **100.0000%** | **90.0000%** |

Verification:

```text
4_047_750 + 2_248_750 + 1_169_350 + 719_600 + 449_750 + 269_850 + 89_950 + 5_000 = 9_000_000
```

## Bull tier distribution

The Bull conditional denominator is `1_000_000`. Each weight is the conditional probability of that Bull tier given that the role is Bull. The total-probability share is `conditional * 0.1` because Bull occurs 10% of the time.

| Tier | Weight | Conditional probability | Total probability across all reveals |
| --- | --- | --- | --- |
| 1 | 600_000 | 60% | 6% |
| 2 | 250_000 | 25% | 2.5% |
| 3 | 100_000 | 10% | 1% |
| 4 | 50_000 | 5% | 0.5% |
| **Bull total** | **1_000_000** | **100.0000%** | **10.0000%** |

## Suit assignment

Suit is assigned independently of role and rank/tier.

| Suit | Weight | Probability |
| --- | --- | --- |
| Hearts | 2_500_000 | 25.0000% |
| Diamonds | 2_500_000 | 25.0000% |
| Clubs | 2_500_000 | 25.0000% |
| Spades | 2_500_000 | 25.0000% |

## Accrual weights (Cowboy production rewards)

Rank accrual weight determines a Cowboy position's share of the Cowboy production portion of each epoch emission.

| Rank | Accrual weight | Relative production share per rank |
| --- | --- | --- |
| 4 | 1.00x | 1.0000 |
| 5 | 1.05x | 1.0500 |
| 6 | 1.10x | 1.1000 |
| 7 | 1.18x | 1.1800 |
| 8 | 1.28x | 1.2800 |
| 9 | 1.40x | 1.4000 |
| 10 | 1.55x | 1.5500 |
| Desperado | 1.00x | 1.0000 |

To avoid floating-point math, accrual weights are stored as scaled integers. With a `ACCRUAL_WEIGHT_SCALE` of `10_000`, the weights become `10000`, `10500`, `11000`, `11800`, `12800`, `14000`, `15500`, and `10000`.

Cowboy production rewards use a separate reward index with scale `COWBOY_REWARD_INDEX_SCALE = 1_000_000_000_000_000_000`. The index is updated each epoch as:

```text
index_increment = cowboy_emission * COWBOY_REWARD_INDEX_SCALE / total_active_cowboy_weight   // floor
```

A position's accumulated production reward is:

```text
accrued = (current_index - last_index) * position_weight / COWBOY_REWARD_INDEX_SCALE   // floor
```

`ACCRUAL_WEIGHT_SCALE` is used only to represent the rank weights shown above.

## Buck power (Bull rewards and theft selection)

| Tier | Buck power |
| --- | --- |
| 1 | 4 |
| 2 | 6 |
| 3 | 8 |
| 4 | 10 |

Bull reward pool distributions and mint-theft recipient selection use buck power as the weighting factor. A Bull's reward share is:

```text
share = bull_buck_power * pool_contribution / total_active_bull_buck_power   // floor
```

## Mint theft probability

Mint theft is an additional randomness domain evaluated at reveal time.

| Outcome | Weight | Probability |
| --- | --- | --- |
| Stolen | 500_000 | 5.00% |
| Not stolen | 9_500_000 | 95.00% |

Theft activates only after at least `50` completed protocol-wide reveals and at least `3` eligible active Bulls. If no eligible external Bull exists (a Bull owned by the victim wallet), the theft resolves as "not stolen" even if the random draw would have selected theft.

## Unstake theft probability (normal Cowboys only)

When a normal Cowboy unstakes, an additional randomness draw determines whether pending ANSEM is diverted to the Bull pool.

| Outcome | Weight | Probability |
| --- | --- | --- |
| ANSEM stolen by Bull pool | 500_000 | 5.00% |
| ANSEM returned to owner | 9_500_000 | 95.00% |

Desperado is immune. Bulls skip this draw because they settle through the Bull reward pool instead.

## Probability tables in protocol-definition

The TypeScript protocol-definition package contains these tables as normalized `ProbabilityTable` values with denominator `10_000_000`. Implementation must not hardcode percentages; it must use these exact integer tables.

```typescript
const ROLE_TABLE = {
  denominator: 10_000_000n,
  entries: [
    { outcome: "cowboy", weight: 9_000_000n },
    { outcome: "bull", weight: 1_000_000n },
  ],
};

const COWBOY_RANK_TABLE = {
  denominator: 9_000_000n,
  entries: [
    { outcome: "rank4", weight: 4_047_750n },
    { outcome: "rank5", weight: 2_248_750n },
    { outcome: "rank6", weight: 1_169_350n },
    { outcome: "rank7", weight: 719_600n },
    { outcome: "rank8", weight: 449_750n },
    { outcome: "rank9", weight: 269_850n },
    { outcome: "rank10", weight: 89_950n },
    { outcome: "desperado", weight: 5_000n },
  ],
};

const BULL_TIER_TABLE = {
  denominator: 1_000_000n,
  entries: [
    { outcome: "tier1", weight: 600_000n },
    { outcome: "tier2", weight: 250_000n },
    { outcome: "tier3", weight: 100_000n },
    { outcome: "tier4", weight: 50_000n },
  ],
};

const SUIT_TABLE = {
  denominator: 10_000_000n,
  entries: [
    { outcome: "hearts", weight: 2_500_000n },
    { outcome: "diamonds", weight: 2_500_000n },
    { outcome: "clubs", weight: 2_500_000n },
    { outcome: "spades", weight: 2_500_000n },
  ],
};

const THEFT_FLAG_TABLE = {
  denominator: 10_000_000n,
  entries: [
    { outcome: "stolen", weight: 500_000n },
    { outcome: "safe", weight: 9_500_000n },
  ],
};

const UNSTAKE_THEFT_FLAG_TABLE = THEFT_FLAG_TABLE;
```

## No dynamic balancing

Probabilities are fixed at launch. There is no mechanism that adjusts Cowboy versus Bull odds based on population, total principal, or epoch performance. The protocol owner may schedule a future upgrade to add dynamic balancing, but such an upgrade is out of scope for Protocol v1 and would require a new spec version.
