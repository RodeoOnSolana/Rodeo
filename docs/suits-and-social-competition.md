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
- Its suit matches one of the winning suits (a bit set in `winning_suits_mask`).
- Its linked X account has at least one scored post in the competition epoch.

A wallet may link only one X account per competition epoch. An X account may be linked to only one wallet per competition epoch.

## Post eligibility

Posts are evaluated off-chain and attested on-chain by a multisignature oracle. Minimum eligibility rules:

- `$RODEO` is required in the post text.
- `$ANSEM` is optional.
- Only original posts qualify; reposts, quote posts, and replies are excluded.
- A maximum of three scored posts per linked X account per competition epoch are counted.
- Off-topic, spam, bot, or manipulated posts are excluded by the oracle scoring process.

### Logarithmic scoring model

For each eligible post, a logarithmic engagement score is computed:

```text
post_score = log10(1 + engagement_count)
```

where `engagement_count` is the verified public engagement metric (e.g., likes + retweets + replies, excluding the author's own interactions). The logarithm caps the advantage of raw engagement volume and rewards authentic, viral content over bought amplification.

An X account's total contribution score for the epoch is the sum of the top three eligible `post_score` values for that account:

```text
account_score = sum(top_3_post_scores)
```

A suit's total score is the sum of `account_score` for every linked X account that posted at least one eligible post in that suit during the epoch.

The winning suit(s) are the suit or suits with the highest total score. If exactly one suit has the highest score, it alone wins. If `N > 1` suits are exactly tied for the highest score, all `N` are winners; see "Tied suits" below. There is no other tie-breaker — Protocol v1 does not resolve ties by timestamp or any other secondary criterion.

## Funding

`10%` of every six-hour ANSEM epoch emission is moved into the suit-competition vault.

```text
suit_vault_contribution = epoch_emission * 1_000 / 10_000   // floor
```

The vault accumulates for 28 epochs. At the end of the competition epoch, the entire accumulated vault is distributed.

## Winning suit(s)

The winning suit or suits are determined by the off-chain scoring system and attested on-chain in a `SocialResult` account (see [account-model.md](./account-model.md)) and the `SuitCompetitionResultAttested` event. The attestation includes:

- competition epoch number (`competition_epoch`);
- `winning_suits_mask: u8` — a bitmask over `Suit`, with more than one bit set when suits are exactly tied (there is no other tie-breaker in Protocol v1);
- `total_amount` — the distributable suit vault for this competition epoch;
- total eligible score per suit;
- list of eligible X accounts and their verified contribution scores;
- Merkle root of the result file;
- content hash of the result file;
- multisignature oracle signatures.

## Tied suits

Let `N` be the number of bits set in `winning_suits_mask` (the number of tied suits, `N >= 1`):

```text
per_suit_vault = suit_vault / N        // floor; remainder rolls into the next competition epoch
```

The full 50/50 equal/proportional calculation described below is applied **independently inside each tied suit** using `per_suit_vault` as that suit's vault. A position's suit determines which single tied suit's calculation it participates in; positions are never double-counted across tied suits.

## Reward split

Within each winning suit (using that suit's `per_suit_vault` when there is a tie, or the full `suit_vault` when there is a single winner):

| Portion | Share | Rule |
| --- | --- | --- |
| Equal | 50% | Divided equally among eligible Active positions in that suit. |
| Proportional | 50% | Divided by verified contribution score per X account, then split among that account's eligible positions in that suit. |

```text
equal_half = per_suit_vault * 5_000 / 10_000   // floor
proportional_half = per_suit_vault - equal_half   // remainder

per_position_equal = equal_half / eligible_position_count   // floor; remainder carried
account_score = verified contribution score of linked X account
account_reward = proportional_half * account_score / total_eligible_score   // floor; remainder carried
per_position_proportional = account_reward / account_eligible_position_count   // floor; remainder carried

position_reward = per_position_equal + per_position_proportional
```

The proportional half prevents one X account's score from being multiplied by its number of positions. The X account's total proportional allocation is divided equally among its eligible positions in that suit. Each eligible position is rewarded independently.

All integer-division remainder produced anywhere in the tied-suit division or the equal/proportional split (`suit_vault % N`, `per_suit_vault % 5_000` complement dust, `equal_half % eligible_position_count`, `proportional_half % total_eligible_score`, `account_reward % account_eligible_position_count`) rolls into the next competition epoch's suit vault. None of it is burned.

## Undistributed suit rewards

If no positions are eligible, or total eligible score is zero, for a given (tied) suit, that suit's `per_suit_vault` rolls into the next social competition epoch. The suit-competition ANSEM is never burned.

## Merkle claims

Suit allocations are stored as Merkle leaves bound to `competition_epoch`, `position`, `owner_at_snapshot`, `amount`, and `leaf_nonce`, and are claimed against the attested `SocialResult` account. `owner_at_snapshot` claims by submitting a valid Merkle proof for a leaf. The program verifies:
- the leaf root matches the attested root;
- the leaf has not been claimed before, via the `SuitClaimReceipt` PDA (`[b"suit-claim", social_result, leaf_nonce]`, see [account-model.md](./account-model.md)), which is created on first successful claim and prevents replay of that `leaf_nonce`.

The reward belongs permanently to `owner_at_snapshot`. It does **not** require the `Position` to remain open/active, and it does **not** require the current `Position.owner` to match `owner_at_snapshot` — a position may have been unstaked, sold, or gifted since the snapshot without affecting the claim. Suit claims pay 100% of the leaf amount to `owner_at_snapshot` and are not subject to the Cowboy 80/20 claim tax. A successful claim emits `SuitRewardClaimed`.

## Oracle and attestation

The social oracle is a multisignature authority that attests competition results. It must:

- publish a complete result file off-chain;
- include the Merkle root and content hash of the result file in the on-chain attestation;
- require a threshold of signer signatures;
- emit a `SocialResultAttested` event.

The oracle does not custody tokens. It only authorizes the on-chain distribution of the already-allocated suit vault.

## Off-chain stack

The recommended v1 off-chain infrastructure is:

- **RPC / webhooks:** Helius
- **Database:** PostgreSQL
- **Indexer and keeper:** TypeScript services consuming on-chain events
- **Immutable result-file storage:** IPFS or Arweave copy, with a public canonical reference
- **On-chain attestation:** Merkle root and content hash published on-chain

The indexer records every X account link per epoch, exposes a public API for scoring inputs, verifies result files against on-chain Merkle roots, and publishes eligible-post leaderboards.

## Open questions (BLOCKED)

- Oracle signer set, threshold, and attestation format: **BLOCKED: OWNER DECISION REQUIRED**.
- Exact X API integration and post-verification pipeline: **BLOCKED: OWNER DECISION REQUIRED**.
