# Phase 0 assumptions, dependencies, and open questions

## Explicit assumptions

1. The requested six-hour epoch is exactly 21,600 seconds.
2. The requested rolling 10-day runway is exactly 864,000 seconds, or 40 complete six-hour epochs.
3. All token quantities are non-negative atomic integers. Token decimals are deliberately unknown.
4. On-chain counters use `u64` unless accumulation may require `u128`; overflow must fail rather than wrap.
5. A position has exactly one owner pubkey at a time. Shared or fractional position ownership is out of scope.
6. Player RODEO principal is reconciled only against the dedicated principal vault, never a treasury balance.
7. ANSEM claims are valid only when aggregate liabilities do not exceed the reward vault balance.
8. Every settlement has a unique identifier or monotonic nonce and cannot be applied twice.
9. Phase 0 role labels (`Cowboy`, `Bull`, `Unassigned`) define state shape, not assignment odds or economics.
10. Fee revenue and ANSEM are distinct integer units. The simulator requires an explicit conversion ratio and does not infer market prices.
11. Program IDs are local bootstrap IDs. `anchor keys sync` replaces them with locally generated deployment identities on first deployment.
12. The program remains upgradeable under the deploying local wallet in Phase 0; production upgrade governance is unresolved.

## Precision and rounding rules

- No floating-point arithmetic is permitted in protocol definitions, the simulator, SDK amount handling, or programs.
- Probability tables have an explicit integer denominator. A table is normalized only when every weight is non-negative and the exact sum equals the denominator.
- Generic multiplication/division uses a widened conceptual product. TypeScript uses arbitrary-precision `bigint`; Rust transitions must use checked `u128` intermediates where needed.
- Fee-funded ANSEM purchasing floors output: `revenue * ANSEM numerator / revenue denominator`.
- Revenue consumed for a chosen ANSEM amount rounds up: `ceil(ANSEM * revenue denominator / ANSEM numerator)`. This prevents creating ANSEM for less than the configured conversion cost.
- A runway's required amount is the exact sum of the next 40 supplied epoch targets. Coverage is conservative and counts only fully covered epochs.
- `BullAccumulator.division_remainder_atomic` exists so future integer division remainders can be carried explicitly. Its scale and eventual distribution rule are unresolved.
- Token display conversion, decimal parsing, and user-facing rounding are unresolved until token decimals are specified.

## Dependencies

| Dependency | Version | Purpose |
| --- | --- | --- |
| Anchor CLI / `anchor-lang` / `anchor-spl` | 0.31.1 | Workspace, programs, token CPI, IDLs. |
| Solana CLI | compatible with Anchor 0.31.1 | Local validator, program build/deploy. |
| Rust/Cargo | compatible with the selected Solana/Anchor release | BPF/SBF and host builds. |
| Node.js | 22+ | TypeScript workspace and SDK generation. |
| pnpm | 10.30.3 | Monorepo package manager. |
| TypeScript | 5.8.3 | Strict SDK/simulator/application typing. |
| Vitest | 3.2.4 | TypeScript tests. |
| fast-check | 4.2.0 | Property-test generation. |
| `@coral-xyz/anchor` | 0.31.1 | Generated IDL types and local integration tests. |

No swap venue, price oracle, production randomness provider, database, queue, web framework, or indexing service has been selected.

## Unresolved protocol questions

### Assets and units

- What are the canonical RODEO and ANSEM mint addresses, token programs, and decimals?
- Are Token-2022 extensions involved, and if so which extensions are accepted?
- What maximum supply/balance bounds must account sizing and arithmetic support?
- In what asset are marketplace prices and protocol fees denominated?

### Roles, positions, and lifecycle

- What determines Cowboy versus Bull assignment, and what is the exact probability denominator/table?
- Can one wallet hold multiple positions, merge/split them, or partially unstake?
- When does a stake become active, and how are epoch boundaries handled?
- What are the complete position states and legal transitions?
- Are positions transferable directly, represented by NFTs, or transferable only through the market program?
- What happens to accrued rewards and pending randomness on transfer?

### Emissions and runway

- What fee sources fund ANSEM and how are fees converted into ANSEM?
- What is the exact epoch emission formula, cap, and behavior when funding is insufficient?
- Does “10-day runway” refer to gross target emissions, net unclaimed liabilities, or another reserve test?
- What actions occur when runway falls below 10 days?
- Who closes epochs, what makes closure permissionless, and how are delayed/missed epochs caught up?
- What is the exact Bull accumulator scale, weighting formula, and remainder policy?

### Claims, unstaking, rerolls, burns, and thefts

- What eligibility, cooldown, fee, probability, and rounding rules govern each action?
- Which quantities are transferred versus burned, and from which vault/account?
- Can theft alter principal, rewards, role, or all three?
- What are action ordering rules when multiple instructions target the same position in one slot?
- Which state transition increments the settlement nonce, and what defines settlement identity?

### Marketplace and revenue

- What can be listed, who escrows it, and when does ownership move atomically?
- What are listing, sale, royalty, referral, and cancellation fees?
- Which revenue is protocol revenue, and which portion funds ANSEM?
- Are private sales, bids, partial fills, and expirations supported?
- Which checks prevent stale listings and double settlement?

### Randomness and liveness

- Which production randomness provider and trust model are required?
- What binds randomness to a position/action/epoch, and what is the replay domain?
- What are timeout, retry, cancellation, refund, and slashing rules?
- How are oracle outages and callback failures handled without trapping principal?
- Is commit/reveal retained as defense-in-depth or removed entirely?

### Security and governance

- Is the production deployment immutable or upgradeable, and under what governance/timelock?
- Which non-economic emergency controls are allowed, and can they ever move principal?
- How are vault authority, treasury authority, keeper permissions, and market authority separated?
- What pause behavior preserves claims/unstaking while blocking risky operations?
- What audit, formal verification, and deployment reproducibility requirements apply?

### Off-chain architecture

- Which events and account snapshots are canonical for the indexer?
- What finality, reorg, idempotency, and backfill behavior is required?
- Which keeper operations exist and what incentives/liveness assumptions apply?
- What wallet, transaction version, RPC, observability, and data retention requirements apply?
