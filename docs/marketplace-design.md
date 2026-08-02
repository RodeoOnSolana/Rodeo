# Rodeo Protocol v1 — Marketplace Design

## Position representation

A position is represented by a Metaplex Core Asset (`PositionReceipt`) under the Rodeo program's authority. The asset is the sole valid proof of ownership and is atomically linked to the `Position` PDA.

```
PositionReceipt PDA: [b"receipt", position.key().as_ref()]
```

Rodeo holds the permanent transfer delegate and freeze delegate on every Core Asset. The asset can only be transferred through approved Rodeo instructions (sale, gift, mint theft). The asset's owner must always match `Position.owner`; instructions update both atomically.

The `PositionReceipt` is created at reveal settlement directly for the final owner. A successful mint theft does not mint the asset to the victim and then transfer it; the selected Bull owner receives the asset directly.

## Ownership transfer rules

- `Position.owner` changes only through approved protocol flows.
- `Position` PDA never changes address when ownership changes.
- Generic `transfer_position` requires the current owner's signature.
- Marketplace sale, gift, and mint theft each call the same underlying ownership-transfer primitive after applying their own preconditions.
- A transfer is rejected while `Position.pending_action_active == true`.
- A transfer outside approved Rodeo flows is rejected.

## Marketplace sale

### Listing

A seller creates a non-custodial `Listing` PDA that references a `Position` and a sale price in SOL.

```
Listing PDA: [b"listing", position.key().as_ref(), &listing_nonce.to_le_bytes()]
```

Listing requirements:

- Only the `Position` owner may list.
- The position must be `Active` and have no pending randomness action.
- The `PositionReceipt` Core Asset remains under Rodeo's freeze authority while listed.
- The `Listing` records: `position`, `seller`, `price_lamports`, `created_at`, `state_version_at_listing`, `listing_nonce`.

`state_version_at_listing` is the `Position.state_version` at listing time. A settlement instruction rejects the sale if `Position.state_version` has changed since listing, which invalidates listings after any ownership-changing event, unstake, or explicit cancellation.

### Atomic settlement

A buyer settles by providing the sale price. The transaction must:

1. Ensure all elapsed epochs are closed or invoke the permissionless `close_epochs` catch-up path.
2. Synchronize the seller's Cowboy and Bull reward indices.
3. Verify the listing is still valid (not expired, not cancelled, position still owned by seller, `state_version` matches).
4. Force-settle the seller's pending ANSEM through the normal claim split (80/20 normal, 98/2 Desperado) or Bull claim.
5. Atomically transfer the receipt asset from seller to buyer and update `Position.owner` to buyer.
6. Deduct the marketplace fee (`5%` of sale price, floor) from the seller's proceeds.
7. Route the fee into the external revenue split.
8. Credit the remainder to the seller.
9. Emit `PositionSold`.

If any step fails, the entire transaction aborts and no ownership changes.

### Denomination

Marketplace v1 sales are denominated in **SOL only**. The sale price, marketplace fee, and seller proceeds are all in SOL lamports. The marketplace fee enters the external revenue split in SOL.

## Direct gift

A gift is a zero-price transfer initiated by the owner.

1. Ensure all elapsed epochs are closed or invoke the permissionless `close_epochs` catch-up path.
2. Synchronize the owner's Cowboy and Bull reward indices.
3. Force-settle pending ANSEM through the normal claim split or Bull claim.
4. Atomically transfer the receipt asset and update `Position.owner`.
5. No marketplace fee is charged.
6. Emit `PositionGifted`.

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

A `Listing` is stale and must not settle when any of the following is true:

- `Position.owner` no longer equals `Listing.seller`;
- `Position.state_version` differs from `Listing.state_version_at_listing`;
- `Position.pending_action_active` is `true`;
- `Listing` has been explicitly cancelled;
- the `PositionReceipt` is no longer under Rodeo's authority.

Stale listings can be closed by anyone to reclaim rent.

## Open questions (BLOCKED)

- Secondary royalties, listing fees, and cancellation fees: **BLOCKED: OWNER DECISION REQUIRED** (Protocol v1 has no royalty, listing fee, or cancellation fee).
- Listing expiration policy (e.g., fixed TTL, epoch-based, or none): **BLOCKED: OWNER DECISION REQUIRED**.
- Whether bids, auctions, or private offers are supported in future versions: **BLOCKED: OWNER DECISION REQUIRED**.
