# Rodeo Protocol v1 — Randomness Design

## Requirement

Production randomness must be reviewed, verifiable, and manipulation-resistant. The exact provider and integration are **BLOCKED: OWNER DECISION REQUIRED**. This document defines the interface, domain separation, and failure-handling rules that any provider must satisfy.

## Randomness domains

Every randomness output must be bound to exactly one of the following domains. A single output must never be reused across domains.

| Domain | Used for | Deterministic input |
| --- | --- | --- |
| `role` | Cowboy vs Bull assignment | `position`, `action_nonce`, epoch, `domain="rodeo-v1-role"` |
| `cowboy_rank` | Cowboy rank 4-10 or Desperado | `position`, `action_nonce`, epoch, `domain="rodeo-v1-cowboy-rank"` |
| `bull_tier` | Bull tier 1-4 | `position`, `action_nonce`, epoch, `domain="rodeo-v1-bull-tier"` |
| `suit` | Hearts, Diamonds, Clubs, Spades | `position`, `action_nonce`, epoch, `domain="rodeo-v1-suit"` |
| `mint_theft_flag` | Whether a reveal becomes a mint theft | `position`, `action_nonce`, epoch, `domain="rodeo-v1-mint-theft"` |
| `thief_selection` | Which eligible Bull receives a stolen position | `position`, `action_nonce`, epoch, eligible-recipient-set root, `domain="rodeo-v1-thief"` |
| `unstake_theft_flag` | Whether normal Cowboy loses pending ANSEM on unstake | `position`, `action_nonce`, epoch, `domain="rodeo-v1-unstake-theft"` |

Each domain produces a uniform integer in the range `[0, denominator - 1]` from the provider's verifiable random output. The protocol then applies the integer probability tables defined in [probabilities-and-rarities.md](./probabilities-and-rarities.md).

## Commit/settle pattern

Every randomness-consuming action uses a two-phase commit/settle pattern:

1. **Commit phase** (`request_*`): The user or protocol opens a `PendingRandomness` account for a specific `position`, `action_type`, and `action_nonce`. The account stores a commitment (hash of secret, provider-specific request metadata, or both) and the committed slot/epoch.
2. **Settle phase** (`settle_*`): A permissionless instruction supplies the randomness proof or oracle response. The instruction verifies the proof, resolves the outcome, and closes or marks the `PendingRandomness` account settled.

The `Position.pending_action_active` lock remains `true` between commit and settle. This blocks transfers and competing randomness actions.

## Action binding

`PendingRandomness` PDA seeds:

```text
[b"randomness", position.key().as_ref(), &[action_type as u8], &action_nonce.to_le_bytes()]
```

`action_type` is a stable, append-only enum (`Reveal = 0`, `Unstake = 1`). `action_nonce` is drawn from `Position.next_action_nonce`, which increments for every new action. This guarantees unique addresses and prevents replay.

The settling instruction re-derives the `PendingRandomness` from the live `Position` fields, so the wrong position, action type, or nonce fails PDA validation.

## No cancellation after commitment

Neither the user nor an admin may cancel a randomness request because the result is unfavorable. Cancellation is permitted only in timeout recovery scenarios defined below. This prevents selective revelation and griefing.

## Permissionless settlement

Settlement instructions must not require the original user's signature. Any party may pay the transaction fee to submit a valid randomness proof. Settlement is incentivized by the protocol outcome itself, not by an explicit reward in Protocol v1.

## Failed settlement handling

A settlement may fail for three reasons:

1. **Invalid proof or commitment mismatch**: The transaction aborts without state change. The randomness action remains pending; a correct proof may be resubmitted.
2. **Oracle outage or timeout**: If the oracle does not respond within a protocol-defined timeout, a timeout recovery instruction may close the `PendingRandomness` and unlock the position. Timeout recovery must not trap principal. The exact timeout duration and recovery action are **BLOCKED: OWNER DECISION REQUIRED**.
3. **Outcome cannot be applied** (e.g., no eligible Bull exists for a theft): The protocol resolves the action safely. For mint theft, if no eligible external Bull exists, the reveal proceeds as a normal Cowboy/Bull assignment without theft.

Failed settlement must never generate a new randomness request. The same `action_nonce` remains consumed; a new action requires a new nonce.

## Timeout recovery

Timeout recovery is a safety valve, not a retry loop. It must:

- require a minimum elapsed time since commitment;
- not depend on the oracle's randomness;
- return the position to a safe state where principal is not locked;
- be callable by the owner or a permissionless keeper;
- emit a distinct event (`RandomnessTimeoutRecovered`).

For a reveal timeout, the position may be closed and the full principal returned, or the reveal may be retried with a new action. The exact behavior is **BLOCKED: OWNER DECISION REQUIRED**.

## Local mock randomness

Phase 0 used `hashv([b"rodeo-local-mock-v1", &secret, position_key.as_ref()])` for local integration tests. This is not production randomness. Production must replace the mock with a reviewed provider. Local tests may continue to use a deterministic mock, but mainnet deployment must not.

## Provider requirements

Any production randomness provider must satisfy:

- Publicly verifiable output (signature, VRF proof, or on-chain oracle record).
- Unpredictable to users at commitment time.
- Resistant to miner/validator manipulation.
- Binding to a specific request identifier that includes `position`, `action_type`, `action_nonce`, and domain.
- Replay resistance across requests.

Candidate providers may include Switchboard VRF, Chainlink VRF (if available on Solana), or a Solana-native stake-weighted oracle. Selection is **BLOCKED: OWNER DECISION REQUIRED**.

## Open questions (BLOCKED)

- Production randomness provider and trust model: **BLOCKED: OWNER DECISION REQUIRED**.
- Exact timeout duration and timeout recovery behavior: **BLOCKED: OWNER DECISION REQUIRED**.
- Whether commit/reveal is retained as defense-in-depth or removed in favor of pure oracle callback: **BLOCKED: OWNER DECISION REQUIRED**.
