# Rodeo Protocol v1 — Randomness Design

## Requirement

Production randomness must be reviewed, verifiable, and manipulation-resistant. Protocol v1 uses a provider-adapter architecture so the core randomness interface is independent of any single oracle. Switchboard is the proposed v1 provider; the adapter must be replaceable without changing the core commit/settle interface or the economic outcome mapping.

## Randomness domains

Every randomness output must be bound to exactly one of the following domains. A single output must never be reused across domains.

| Domain | Used for | Deterministic input |
| --- | --- | --- |
| `role` | Cowboy vs Bull assignment | `position`, `action_nonce`, epoch, `domain="rodeo-v1-role"` |
| `cowboy_rank` | Cowboy rank 4-10 or Desperado | `position`, `action_nonce`, epoch, `domain="rodeo-v1-cowboy-rank"` |
| `bull_tier` | Bull tier 1-4 | `position`, `action_nonce`, epoch, `domain="rodeo-v1-bull-tier"` |
| `suit` | Hearts, Diamonds, Clubs, Spades | `position`, `action_nonce`, epoch, `domain="rodeo-v1-suit"` |
| `mint_theft_flag` | Whether a reveal becomes a mint theft | `position`, `action_nonce`, epoch, `domain="rodeo-v1-mint-theft"` |
| `thief_selection` | Which eligible Bull receives a stolen position | `position`, `action_nonce`, epoch, `BullRegistry` root, `domain="rodeo-v1-thief"` |
| `unstake_theft_flag` | Whether normal Cowboy loses pending ANSEM on unstake | `position`, `action_nonce`, epoch, `domain="rodeo-v1-unstake-theft"` |

Each domain produces a uniform integer in the range `[0, denominator - 1]` from the provider's verifiable random output. The protocol then applies the integer probability tables defined in [probabilities-and-rarities.md](./probabilities-and-rarities.md).

## Commit/settle pattern

Every randomness-consuming action uses a two-phase commit/settle pattern:

1. **Commit phase** (`request_*`): The user or protocol opens a `PendingRandomness` account for a specific `position`, `action_type`, and `action_nonce`. The account stores a commitment and the provider-adapter request metadata (e.g., Switchboard oracle queue, task ID, or feed hash). The commitment binds `position`, `action_type`, `action_nonce`, and domain so the same oracle output cannot be reused for a different request.
2. **Settle phase** (`settle_*`): A permissionless instruction supplies the oracle proof or callback. The provider-adapter verifies the proof against the stored request metadata. The instruction then resolves the outcome and closes or marks the `PendingRandomness` account settled.

The core program calls a stable adapter interface; the adapter is responsible for oracle-specific proof validation.

The `Position.pending_action_active` lock remains `true` between commit and settle. This blocks transfers and competing randomness actions.

## Action binding

`PendingRandomness` PDA seeds:

```text
[b"randomness", position.key().as_ref(), &[action_type as u8], &action_nonce.to_le_bytes()]
```

`action_type` is a stable, append-only enum (`Reveal = 0`, `Unstake = 1`). `action_nonce` is drawn from `Position.next_action_nonce`, which increments for every new action. This guarantees unique addresses and prevents replay.

The settling instruction re-derives the `PendingRandomness` from the live `Position` fields, so the wrong position, action type, or nonce fails PDA validation.

## No cancellation after commitment (except unstake)

Neither the user nor an admin may cancel a randomness request because the result is unfavorable. Cancellation is permitted only in timeout recovery scenarios and for unstake requests:

- **Unstake request cancellation**: Before the unstake randomness settles, the owner may cancel the unstake request. This closes the `PendingRandomness` account and clears `Position.pending_action_active`, leaving the position staked and Active. This preserves the owner's option value if market conditions change.
- **Timeout recovery**: If the oracle does not respond within the timeout, a permissionless timeout-recovery instruction closes the pending action and returns the position to a safe state.

Selective cancellation after seeing an unfavorable result is prevented by the commit/settle design: the owner cannot observe the oracle output before settlement.

## Permissionless settlement

Settlement instructions must not require the original user's signature. Any party may pay the transaction fee to submit a valid oracle proof through the provider adapter. Settlement is incentivized by the protocol outcome itself, not by an explicit reward in Protocol v1.

## Failed settlement handling

A settlement may fail for three reasons:

1. **Invalid proof or commitment mismatch**: The transaction aborts without state change. The randomness action remains pending; a correct proof may be resubmitted.
2. **Oracle outage or timeout**: If Switchboard does not produce a valid proof within **30 minutes** of the commit, a timeout recovery instruction may close the `PendingRandomness` and unlock the position. Timeout recovery must not trap principal.
3. **Outcome cannot be applied** (e.g., no eligible Bull exists for a theft): The protocol resolves the action safely. For mint theft, if no eligible external Bull exists, the reveal proceeds as a normal Cowboy/Bull assignment without theft.

Failed settlement must never generate a new randomness request. The same `action_nonce` remains consumed; a new action requires a new nonce.

## Timeout recovery

Timeout recovery is a safety valve, not a retry loop. It must:

- require at least 30 minutes since commitment;
- not depend on the oracle's randomness;
- return the position to a safe state where principal is not locked;
- be callable by the owner or a permissionless keeper;
- emit a distinct event (`RandomnessTimeoutRecovered`).

For a **reveal timeout** before role assignment, the position is closed and the full principal is returned to the staker. This is "reveal principal recovery before assignment": if no role has been assigned, the staker is not yet committed to the game and may reclaim their deposit.

For an **unstake timeout**, the unstake action is cancelled and the position remains staked and Active (equivalent to unstake-request cancellation).

## Local mock randomness

Phase 0 used `hashv([b"rodeo-local-mock-v1", &secret, position_key.as_ref()])` for local integration tests. This is not production randomness. Production must replace the mock with a reviewed provider. Local tests may continue to use a deterministic mock, but mainnet deployment must not.

## Bull recipient selection (mint theft)

Mint theft requires selecting a Bull recipient weighted by active `buck_power` without scanning every Bull account. The protocol uses the two-level weighted sortition tree defined in [account-model.md](./account-model.md):

- **Level 1** — a global sum tree indexed by owner aggregate `buck_power`.
- **Level 2** — a per-owner sum tree indexed by that owner's Bull positions.

Selection algorithm:

1. Compute the effective draw range: `total_active_bull_power - victim_owner_buck_power`. The victim owner is excluded.
2. Draw `r` in `[0, effective_range)`.
3. Traverse Level 1 by cumulative owner power, skipping the victim owner node, to select a recipient owner in O(log o).
4. Within the selected owner, draw `r'` in `[0, owner_buck_power)` and traverse Level 2 to select a Bull position in O(log p).

The settlement transaction supplies the two page paths. The program verifies:

- the supplied pages are part of the `BullRegistry` tree;
- the cumulative sums match `total_active_bull_power`;
- the victim owner is not selected;
- the final selected position is an active Bull.

This design is trustless, verifiable, and bounded in compute. Exact account sizes, page capacity, maximum supported Bull population, and proof serialization are **BLOCKED: OWNER DECISION REQUIRED**.

## Reveal implementation status

Production implementation of the reveal instruction, including mint theft, is **BLOCKED: OWNER DECISION REQUIRED** until the `BullRegistry` design above is reviewed and the maximum supported population and compute costs are confirmed.

## Provider adapter interface

The provider adapter is an on-chain program (or a CPI-gated module) that:

- exposes a single `verify_and_emit(position, action_type, action_nonce, proof)` instruction;
- verifies the oracle proof against the request metadata stored in `PendingRandomness`;
- emits a normalized `RandomnessVerified` event containing the verifiable random output bytes.

The core `rodeo_core` program consumes the verified output, maps it to outcomes using the approved probability tables, and marks the `PendingRandomness` settled.

### Switchboard v1 adapter

Switchboard is the proposed v1 provider. The adapter must:

- use Switchboard VRF or stake-weighted oracle feeds;
- produce an on-chain verifiable proof;
- bind the output to `position`, `action_type`, `action_nonce`, and domain;
- expose the proof to permissionless settlement.

The adapter may be upgraded independently of `rodeo_core` to support future oracle providers, provided the core interface and domain separation remain unchanged.

## Open questions (BLOCKED)

- Exact Switchboard integration details (queue, task format, CPI vs. callback, proof serialization): **BLOCKED: OWNER DECISION REQUIRED**.
- Whether to retain commit/reveal hashing as defense-in-depth on top of Switchboard proofs: **BLOCKED: OWNER DECISION REQUIRED**.
- Incentive/reward for permissionless settler bot: **BLOCKED: OWNER DECISION REQUIRED**.
