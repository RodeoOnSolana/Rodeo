# Rodeo Protocol v1 — Marketplace Design

## Position representation

A position must be represented by a program-controlled, transferable receipt asset. The receipt is the only valid proof of ownership and must be atomically linked to the `Position` PDA.

The exact receipt type is **BLOCKED: OWNER DECISION REQUIRED**. Candidates:

1. A Metaplex NFT mint where the position PDA is the mint authority or freeze authority.
2. A Rodeo-specific program token mint managed entirely by `rodeo_core`.
3. A program-only ownership record with no separate token.

Until the decision is made, the protocol references a generic `MarketReceipt` account. Implementations must enforce that `MarketReceipt` transfers only through approved Rodeo flows and that `Position.owner` updates atomically with receipt movement.

## Ownership transfer rules

- `Position.owner` changes only through approved protocol flows.
- `Position` PDA never changes address when ownership changes.
- Generic `transfer_position` requires the current owner's signature.
- Marketplace sale, gift, and mint theft each call the same underlying ownership-transfer primitive after applying their own preconditions.
- A transfer is rejected while `Position.pending_action_active == true`.
- A transfer outside approved Rodeo flows is rejected.

## Marketplace sale

### Listing

A seller creates a listing that references a `Position` and a sale price. The exact listing mechanism (escrow, direct listing, order book) is **BLOCKED: OWNER DECISION REQUIRED**. Minimum requirements:

- Only the `Position` owner may list.
- The position must be `Active` and have no pending randomness action.
- The receipt asset must remain under program control while listed (escrowed or locked).
- The listing records: `position`, `seller`, `price_atomic`, `denomination`, `created_at`, optional expiration.

### Atomic settlement

A buyer settles by providing the sale price. The transaction must:

1. Verify the listing is still valid (not expired, not cancelled, position still owned by seller).
2. Force-settle the seller's pending ANSEM through the normal claim split (80/20 normal, 98/2 Desperado).
3. Atomically transfer the receipt asset from seller to buyer and update `Position.owner` to buyer.
4. Deduct the marketplace fee (`5%` of sale price, floor) from the seller's proceeds.
5. Route the fee into the external revenue split.
6. Credit the remainder to the seller.
7. Emit `PositionSold`.

If any step fails, the entire transaction aborts and no ownership changes.

### Denomination

The asset in which the sale price and marketplace fee are denominated is **BLOCKED: OWNER DECISION REQUIRED**. Candidates include SOL, USDC, or RODEO. The choice affects escrow design and revenue accounting.

## Direct gift

A gift is a zero-price transfer initiated by the owner.

1. Force-settle pending ANSEM through the normal claim split.
2. Atomically transfer the receipt asset and update `Position.owner`.
3. No marketplace fee is charged.
4. Emit `PositionGifted`.

Gifts must also be rejected while a randomness action is pending.

## Mint theft

Mint theft is described in detail in [state-machine.md](./state-machine.md) and [probabilities-and-rarities.md](./probabilities-and-rarities.md). It is a reveal-time ownership change, not a marketplace sale, but it uses the same atomic receipt+position transfer primitive.

## Forced settlement

Before any ownership change, the seller/giver's pending ANSEM is claimed according to their role:

- Normal Cowboy: 80% to owner, 20% to Bull pool.
- Desperado: 98% to owner, 2% to Bull pool.
- Bull: 100% of Bull pool rewards to owner (Bull claims are not taxed).

The owner receives their share; the protocol share is added to the Bull reward pool liability. The position's `claimable_ansem_atomic` becomes `0` after settlement.

## Fees

| Fee | Value | Destination |
| --- | --- | --- |
| Marketplace fee | `5%` of sale price (floor) | External revenue split |
| Gift fee | `0%` | N/A |

No listing fee, no royalty on secondary sales, and no cancellation fee are defined in Protocol v1. Whether to add them is **BLOCKED: OWNER DECISION REQUIRED**.

## Stale listing prevention

Listings must be invalidated on:

- position transfer;
- position unstake (position closed);
- position entering `RandomnessPending` status;
- listing cancellation by seller.

The exact validation mechanism (oracle check, listing nonce tied to position settlement_nonce, explicit cancellation instruction) is **BLOCKED: OWNER DECISION REQUIRED**.

## Open questions (BLOCKED)

- `MarketReceipt` asset type and PDA seeds: **BLOCKED: OWNER DECISION REQUIRED**.
- Marketplace price/fee denomination: **BLOCKED: OWNER DECISION REQUIRED**.
- Listing/escrow architecture: **BLOCKED: OWNER DECISION REQUIRED**.
- Secondary royalties, listing fees, cancellation fees: **BLOCKED: OWNER DECISION REQUIRED**.
- Stale-listing invalidation mechanism: **BLOCKED: OWNER DECISION REQUIRED**.
