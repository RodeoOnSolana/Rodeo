# Rodeo Protocol v1 — Suits and Social Competition

## Suit assignment

Every position receives one of four suits at reveal time, independent of role, rank, and tier.

| Suit | Weight | Probability |
| --- | --- | --- |
| Hearts | 2_500_000 | 25% |
| Diamonds | 2_500_000 | 25% |
| Clubs | 2_500_000 | 25% |
| Spades | 2_500_000 | 25% |

Suit assignment uses its own randomness domain (`rodeo-v1-suit`) so that suit cannot be predicted or manipulated from role outcome.

## Social competition epochs

- Duration: `7 days` = `28 six-hour` protocol epochs.
- Start time: aligned to the protocol launch time, not the blockchain genesis.
- The first competition begins after the pot-fill period.

## Eligibility

A position is eligible for suit rewards if and only if:

- It is `Active` at the competition boundary.
- Its suit matches the winning suit.
- Its linked X account has at least one scored post in the competition epoch.

A wallet may link only one X account per competition epoch. An X account may be linked to only one wallet per competition epoch.

## Post eligibility

Posts are evaluated off-chain and attested on-chain by a multisignature oracle. Minimum eligibility rules:

- `$RODEO` is required in the post text.
- `$ANSEM` is optional.
- Only original posts qualify; reposts, quote posts, and replies are excluded.
- A maximum of three scored posts per linked X account per competition epoch are counted.
- Off-topic, spam, bot, or manipulated posts are excluded by the oracle scoring process.

The exact scoring algorithm (keyword weights, engagement formula, anti-gaming) is **BLOCKED: OWNER DECISION REQUIRED**.

## Funding

`10%` of every six-hour ANSEM epoch emission is moved into the suit-competition vault.

```text
suit_vault_contribution = epoch_emission * 1_000 / 10_000   // floor
```

The vault accumulates for 28 epochs. At the end of the competition epoch, the entire accumulated vault is distributed.

## Winning suit

The winning suit is determined by the off-chain scoring system and attested on-chain. The attestation includes:

- competition epoch number;
- winning suit;
- total eligible score per suit;
- list of eligible X accounts and their verified contribution scores;
- Merkle root of the result file;
- multisignature oracle signatures.

The exact winning criterion (highest total score, highest average score, highest number of eligible posts, or a hybrid) is **BLOCKED: OWNER DECISION REQUIRED**. The default is highest total verified contribution score among eligible posts.

## Reward split

For the winning suit:

| Portion | Share | Rule |
| --- | --- | --- |
| Equal | 50% | Divided equally among eligible Active positions in the winning suit. |
| Proportional | 50% | Divided by verified contribution score of the linked X account. |

```text
equal_half = suit_vault * 5_000 / 10_000   // floor
proportional_half = suit_vault - equal_half   // remainder

per_position_equal = equal_half / eligible_position_count   // floor; remainder carried
account_score = verified contribution score of linked X account
proportional_share = proportional_half * account_score / total_eligible_score   // floor; remainder carried

position_reward = per_position_equal + proportional_share
```

If multiple positions share the same linked X account, each position receives its own `per_position_equal` plus a proportional share computed from the account's total score. The exact handling of multiple positions per wallet is **BLOCKED: OWNER DECISION REQUIRED** (default: same account score applied to each eligible position).

## Undistributed suit rewards

If no positions are eligible, or total eligible score is zero, the suit vault remains undistributed. The policy for leftover vaults (rollover to next competition, burn, or redistribute to reward vault) is **BLOCKED: OWNER DECISION REQUIRED**.

## Oracle and attestation

The social oracle is a multisignature authority that attests competition results. It must:

- publish a complete result file off-chain (e.g., IPFS/Arweave or a public repository);
- include a Merkle root of the result file in the on-chain attestation;
- require a threshold of signer signatures;
- emit a `SocialResultAttested` event.

The oracle does not custody tokens. It only authorizes the on-chain distribution of the already-allocated suit vault.

## Indexer responsibilities

The off-chain indexer:

- records every X account link per epoch;
- exposes a public API for scoring inputs;
- verifies the result file against the on-chain Merkle root;
- publishes eligible-post leaderboards.

## Open questions (BLOCKED)

- Exact social scoring algorithm and anti-gaming rules: **BLOCKED: OWNER DECISION REQUIRED**.
- Winning-suit criterion: **BLOCKED: OWNER DECISION REQUIRED**.
- Oracle signer set, threshold, and attestation format: **BLOCKED: OWNER DECISION REQUIRED**.
- Handling of multiple positions linked to the same X account: **BLOCKED: OWNER DECISION REQUIRED**.
- Policy for undistributed suit rewards: **BLOCKED: OWNER DECISION REQUIRED**.
