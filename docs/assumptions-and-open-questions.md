# Phase 0 assumptions, dependencies, and open questions

## Status

This file has been superseded by the Rodeo Protocol Specification v1. All items below are now either resolved by the approved protocol decisions or explicitly marked `BLOCKED: OWNER DECISION REQUIRED` in the v1 sub-documents. The v1 documents (`docs/protocol-v1.md` and the files it references) are the sole source of truth for implementation.

## Explicit assumptions (retained from Phase 0)

1. The requested six-hour epoch is exactly 21,600 seconds.
2. The requested rolling 10-day runway is exactly 864,000 seconds, or 40 complete six-hour epochs.
3. All token quantities are non-negative atomic integers. Token decimals are supplied at production initialization; whole-token amounts are converted to atomic units via `whole * 10^decimals`.
4. On-chain counters use `u64` unless accumulation may require `u128`; overflow must fail rather than wrap.
5. A position has exactly one owner pubkey at a time. Shared or fractional position ownership is out of scope. `Position.owner` is a mutable field, not part of the PDA, so ownership can move (marketplace sale, gift, mint theft) without the account changing address; sale, gift, and mint theft each call the same internal ownership-mutation helper, which is not exposed as a public, generic instruction. Sale and gift require the current owner's signature; mint theft is resolved by the protocol at reveal settlement.
5a. `position_id` is caller-chosen and, combined with `global_config`, is the Position PDA's entire, immutable identity. It no longer includes the owner, so the ID space is shared across all owners under one `GlobalConfig`; a colliding ID simply fails account creation (`init` cannot reuse an address) rather than causing any state corruption.
5b. A position's randomness actions (currently `Reveal` and the reserved `Unstake`) are individually addressed PDAs keyed by `[position, action_type, action_nonce]`, with `action_nonce` drawn from a per-position monotonic counter. `ActionType` is a stable, append-only integer enum; existing discriminants must never be renumbered or removed. A position cannot be transferred while it has an unresolved randomness action.
6. Player RODEO principal is reconciled only against the dedicated principal vault, never a treasury balance.
7. ANSEM claims are valid only when aggregate liabilities do not exceed the reward vault balance.
8. Every settlement has a unique identifier or monotonic nonce and cannot be applied twice.
9. Phase 0 role labels (`Cowboy`, `Bull`, `Unassigned`) define state shape, not assignment odds or economics.
10. Fee revenue and ANSEM are distinct integer units. The simulator requires an explicit conversion ratio and does not infer market prices.
11. Program IDs are deterministic localnet-only identities generated from public repository labels into ignored `target/deploy` output. They are not secret and must never be used for a production deployment.
12. Production upgrade governance is a Protocol v1 concern; see [treasury-and-governance.md](./treasury-and-governance.md).
13. The reproducible verification environment is Ubuntu 24.04, Rust 1.85.1, Solana/Agave CLI 2.1.0, Anchor CLI 0.31.1, Node.js 22, and pnpm 10.30.3.
14. Agave 2.1.0's SBF platform tools use Rust/Cargo 1.79. `Cargo.lock` is seeded directly from Anchor v0.31.1 commit `47284f8f0b9844c6b83234aa90f556bad00e12ed` and adapted only for Rodeo workspace roots, preserving the upstream SBF-compatible dependency graph.
15. `anchor-spl` enables classic token plus `token_2022` module support because Anchor 0.31.1 account-constraint macros reference its token interface during expansion; Token-2022 extensions are not enabled or used by Phase 0. Exact direct constraints on `solana-program` and `solana-zk-sdk` force the mutually dependent Solana crate family to resolve atomically at 2.1.0.

## Precision and rounding rules (retained)

- No floating-point arithmetic is permitted in protocol definitions, the simulator, SDK amount handling, or programs.
- Probability tables have an explicit integer denominator. A table is normalized only when every weight is non-negative and the exact sum equals the denominator.
- Generic multiplication/division uses a widened conceptual product. TypeScript uses arbitrary-precision `bigint`; Rust transitions must use checked `u128` intermediates where needed.
- Fee-funded ANSEM purchasing floors output: `revenue * ANSEM numerator / revenue denominator`.
- Revenue consumed for a chosen ANSEM amount rounds up: `ceil(ANSEM * revenue denominator / ANSEM numerator)`. This prevents creating ANSEM for less than the configured conversion cost.
- A runway's required amount is the exact sum of the next 40 supplied epoch targets. Coverage is conservative and counts only fully covered epochs.
- Token display conversion, decimal parsing, and user-facing rounding are unresolved until token decimals are specified.

## Dependencies (retained)

| Dependency | Version | Purpose |
| --- | --- | --- |
| Anchor CLI / `anchor-lang` / `anchor-spl` | 0.31.1 | Workspace, programs, token CPI, IDLs. |
| Solana/Agave CLI | 2.1.0 | Local validator, program build/deploy. |
| Rust/Cargo | 1.85.1 | Anchor CLI compilation, formatting, and host checks. |
| Node.js | 22+ | TypeScript workspace and SDK generation. |
| pnpm | 10.30.3 | Monorepo package manager. |
| TypeScript | 5.8.3 | Strict SDK/simulator/application typing. |
| Vitest | 3.2.4 | TypeScript tests. |
| fast-check | 4.2.0 | Property-test generation. |
| `@coral-xyz/anchor` | 0.31.1 | Generated IDL types and local integration tests. |
| `@solana/spl-token` | 0.4.13 | Localnet mint, token-account, and principal-vault integration setup. |

Selected v1 off-chain stack: Helius RPC/webhooks, PostgreSQL, TypeScript indexer/keeper, IPFS/Arweave immutable storage. Jupiter is the approved v1 swap aggregator; Switchboard is the proposed v1 randomness provider.

## Resolved protocol questions

All questions formerly listed here are now resolved by Protocol Specification v1. See the referenced sub-documents.

### Assets and units

- **Token mints and decimals:** resolved — mints are supplied at production initialization; decimals are read from the mint accounts and stored in `GlobalConfig`; `stake_amount_atomic` and `expected_total_supply_atomic` are computed from whole-token values.
- **Maximum supply/balance bounds:** unresolved; now `BLOCKED: OWNER DECISION REQUIRED` in [account-model.md](./account-model.md).
- **Marketplace price/fee denomination:** resolved — SOL only for v1.
- **ANSEM fungibility:** resolved — ANSEM is a single SPL token mint; all reward flows are denominated in atomic ANSEM.

### Roles, positions, and lifecycle

- **Cowboy vs Bull assignment and exact probability table:** resolved in [probabilities-and-rarities.md](./probabilities-and-rarities.md).
- **Multiple positions, merging/splitting, partial unstake:** resolved — multiple positions allowed per wallet; merging, splitting, and partial unstake are not supported in v1.
- **Stake activation and epoch boundaries:** resolved in [economic-model.md](./economic-model.md) and [emissions-and-rewards.md](./emissions-and-rewards.md).
- **Complete position states and transitions:** resolved in [state-machine.md](./state-machine.md).
- **Transfer mechanics:** positions are transferable through Metaplex Core Asset receipt flows (marketplace, gift, mint theft); Rodeo controls permanent transfer and freeze delegates; sale, gift, and mint theft each call the same internal ownership-mutation helper rather than a public, generic instruction. See [marketplace-design.md](./marketplace-design.md).
- **Pending randomness on transfer:** positions with a pending randomness action cannot be transferred. Whether any future action type should be transferable with the pending action following the new owner is `BLOCKED: OWNER DECISION REQUIRED` in [marketplace-design.md](./marketplace-design.md).
- **Other action types:** `ActionType::Unstake = 1` is reserved; no other action types are defined in v1.
- **Wallet claim-cooldown account:** resolved — `[b"claim_cooldown", global_config, wallet]` PDA.

### Emissions and runway

- **Fee sources and ANSEM conversion:** resolved in [treasury-and-governance.md](./treasury-and-governance.md) and [economic-model.md](./economic-model.md).
- **Epoch emission formula:** resolved in [emissions-and-rewards.md](./emissions-and-rewards.md).
- **10-day runway definition:** resolved — `epoch_emission = floor(free_ansem / 40)`; required runway = `epoch_emission * 40`; available is free ANSEM plus purchasable ANSEM from pending revenue.
- **Runway below 10 days:** emissions continue as long as free ANSEM is positive; runway is a reporting/keeper signal, not an automatic cap.
- **Epoch closure:** permissionless `close_epochs(max_epochs)` instruction, keeper-assisted, catch-up by sequential closure, maximum `8` epochs per transaction, per-epoch snapshots.
- **Accumulator scales:** resolved — `COWBOY_REWARD_INDEX_SCALE = 1_000_000_000_000_000_000` for Cowboy production index; `REWARD_PER_WEIGHT_SCALE = 1_000_000_000_000_000_000` for Bull reward per weight; `ACCRUAL_WEIGHT_SCALE = 10_000` for rank weights only.
- **Undistributed Cowboy production emission:** resolved — remains free ANSEM in the reward vault, never reserved or burned.
- **Undistributed suit-competition rewards:** resolved — roll into the next social epoch, never burned.

### Claims, unstaking, rerolls, burns, and thefts

- **Eligibility, cooldown, fee, probability, and rounding rules:** resolved in [economic-model.md](./economic-model.md), [probabilities-and-rarities.md](./probabilities-and-rarities.md), [state-machine.md](./state-machine.md), and [emissions-and-rewards.md](./emissions-and-rewards.md).
- **Transfers versus burns and source vaults:** resolved in [state-machine.md](./state-machine.md) and [economic-model.md](./economic-model.md).
- **Theft scope:** mint theft transfers the entire position (receipt, role, rank/tier, suit, principal). Unstake theft only diverts pending ANSEM to the Bull pool.
- **Action ordering:** resolved in [state-machine.md](./state-machine.md).
- **Reroll semantics:** resolved — a "reroll" is performed by fully unstaking and staking again with a new `position_id` and randomness nonce; no in-place reroll instruction exists.
- **Unstake cancellation:** resolved — no voluntary `cancel_unstake_request`; after commitment an unstake settles or timeout-recovers when no oracle value is available.
- **Settlement identity:** resolved — `(position, action_type, action_nonce)` plus unique transaction/settlement ID.

### Marketplace and revenue

- **Listing, escrow, and atomic ownership transfer:** resolved — non-custodial `Listing` PDA from `[b"listing", position, listing_nonce]`; stale listings prevented by `Position.state_version` and `listing_nonce`.
- **Fees:** marketplace fee is 5% of sale price in SOL; gift fee is 0%. Secondary royalties, listing fees, and cancellation fees are `BLOCKED: OWNER DECISION REQUIRED`.
- **Protocol revenue definition:** resolved in [treasury-and-governance.md](./treasury-and-governance.md).
- **Private sales, bids, partial fills, expirations:** resolved — Marketplace v1 supports only fixed-price direct listings with no automatic expiration; bids, auctions, and private offers are out of scope for v1. Whether to add them in a future version remains `BLOCKED: OWNER DECISION REQUIRED`.
- **Stale listing and double settlement prevention:** resolved by `state_version`/`listing_nonce` checks and atomic receipt+position transfer.
- **Swap aggregator and routing:** resolved — Jupiter v1 with $100-equivalent minimum batch, 1% max slippage, 0.5% max price impact, no arbitrary dust-sweep recipient.

### Randomness and liveness

- **Production randomness provider:** resolved — provider-adapter architecture; Switchboard proposed v1 provider.
- **Randomness binding and replay domain:** resolved in [randomness-design.md](./randomness-design.md).
- **Timeout, retry, cancellation, refund, slashing:** resolved — 30-minute timeout; reveal timeout recovers principal before assignment; unstake timeout cancels and leaves position staked; unstake-request cancellation leaves position staked.
- **Oracle outage handling:** resolved — timeout recovery does not trap principal.
- **Commit/reveal:** retained as defense-in-depth; whether it is kept for production is `BLOCKED: OWNER DECISION REQUIRED`.
- **Permissionless settlement:** resolved.

### Security and governance

- **Upgradeability and governance:** resolved — 3-of-5 Squads Upgrade Council (72-hour timelock), 3-of-5 Squads Treasury Council (48-hour timelock), 2-of-3 Emergency Guardians (immediate pause, 12-hour unpause delay).
- **Immutability vs. governance-protected:** resolved — core parameters are governance-protected and timelocked, not technically immutable, because the program remains upgradeable. All upgrade proposals must publish source diff, reproducible build, program-data hash, and activation time.
- **Emergency controls:** resolved — action-specific pause flags; cannot withdraw principal or liabilities; safe claims/exits preserved whenever technically possible.
- **Authority separation:** resolved in [account-model.md](./account-model.md) and [treasury-and-governance.md](./treasury-and-governance.md).
- **Pause behavior:** resolved — preserve safe claims and exits.
- **Audit and formal verification:** deferred to Phase 5; recommended in [implementation-plan.md](./implementation-plan.md).

## Remaining BLOCKED decisions

For the complete list of unresolved owner decisions, see the "Open questions (BLOCKED)" sections in:

- [account-model.md](./account-model.md)
- [economic-model.md](./economic-model.md)
- [marketplace-design.md](./marketplace-design.md)
- [randomness-design.md](./randomness-design.md)
- [treasury-and-governance.md](./treasury-and-governance.md)
- [suits-and-social-competition.md](./suits-and-social-competition.md)
- [public-metrics-and-indexing.md](./public-metrics-and-indexing.md)
- [protocol-v1.md](./protocol-v1.md)

The most urgent remaining Phase 2 blockers are:

1. Final `BullRegistry` design, account sizes, page capacity, maximum supported live positions/Bulls/owners, Merkle-sum proof format, historical snapshot availability, and compute benchmarks (mint-theft reveal implementation blocked until reviewed).
2. Exact per-source-mint `PendingBatch` account schema.
3. Exact Metaplex Core plugin configuration and receipt-authority PDA.
4. Exact Switchboard integration (queue, task format, CPI vs. callback, proof serialization) and whether commit/reveal hashing is retained.
5. Future support for bids/auctions/private offers (v1 listings have no automatic expiration and support only fixed-price direct sale).
6. Exact Squads program addresses, member pubkeys, and timelock program instances.
7. Off-chain price oracle for the $100-equivalent minimum batch and Jupiter integration mode.
8. Incentive/reward for permissionless randomness settler bot.
8. Exact X API integration and post-verification pipeline.
