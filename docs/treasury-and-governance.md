# Rodeo Protocol v1 — Treasury, Router, and Governance

## Treasury overview

The treasury system receives external protocol revenue, converts it according to fixed rules, and routes the proceeds to approved destinations. It has no authority over player principal or accrued ANSEM liabilities.

## External revenue sources

Protocol revenue is realized fee receipts from approved protocol-owned flows. Specifically included:

- Marketplace sale fees.
- Future protocol-approved fee sources added by governance upgrade.

Explicitly excluded from protocol revenue:

- Player claim taxes.
- Theft distributions (mint theft or unstake theft).
- Unstake taxes.
- Any player-to-player transfers.

All routing uses actual realized fee receipts, not a hardcoded pump.fun fee rate.

## Revenue split

For each batch of external revenue receipts denominated in a source token, the keeper/router applies the following split before conversion where applicable:

| Destination | Share | Action | Rounding |
| --- | --- | --- | --- |
| Buy ANSEM for reward vault | 70% | Swap source token for ANSEM and deposit into `reward_vault` | Floor atomic units |
| Team and marketing | 15% | Transfer source token to team treasury | Floor atomic units |
| Buy and permanently burn RODEO | 10% | Swap source token for RODEO and burn it | Floor atomic units |
| Security and operations | 5% | Transfer source token to security treasury | Floor atomic units |

Floor allocation may leave dust in the router pending account. The dust sweep rule is **BLOCKED: OWNER DECISION REQUIRED**; the default is to carry dust and add it to the next routing batch's ANSEM purchase.

## Swap safety rules

- Only approved swap venues may be used. The approved list is **BLOCKED: OWNER DECISION REQUIRED**.
- Each swap must enforce a minimum output amount (slippage protection).
- Failed or unsafe swaps leave funds in the router pending state rather than forcing execution.
- The router must not hold player principal or accrued ANSEM.
- No admin may redirect the 70/15/10/5 split.

## Treasury router account model

The router is expected to be implemented in `programs/rodeo_router`. Recommended accounts:

- `RouterConfig`: approved venues, minimum output parameters, destination addresses.
- `PendingBatch`: accumulated revenue awaiting execution, source token balance, epoch marker.

The exact account schema is Phase 2 implementation work and is not designed here.

## Governance model

### Upgrade authority

Program upgrade authority is controlled by a multisig plus timelock. The timelock duration is **BLOCKED: OWNER DECISION REQUIRED** (recommended minimum 48 hours for material upgrades).

### Treasury authority

Treasury authority is separate from program upgrade authority. Treasury authority may:

- trigger approved swaps;
- claim dust or leftover router funds into the ANSEM reward vault (if the dust-sweep rule so specifies);
- update the approved swap venue list if and only if such updates are allowed by a governance decision.

Treasury authority may not:

- move player principal from the principal vault;
- reduce, cancel, or redirect accrued ANSEM liabilities;
- change the 70/15/10/5 revenue split;
- change core economic parameters listed below.

### Emergency guardians

A separate emergency guardian multisig may pause specific risky actions. Emergency controls may pause:

- new stakes;
- new marketplace listings;
- new randomness commitments.

Emergency controls should preserve safe claims and exits whenever possible. They must not:

- withdraw player principal;
- block completed claims or unstakes that require no new randomness;
- modify economic constants.

### Immutable core economic parameters

After launch, no admin, multisig, or governance process may modify:

- role odds (Cowboy/Bull probabilities);
- unstake tax percentage;
- mint theft percentage;
- unstake ANSEM theft percentage;
- stake amount per position;
- buck power per Bull tier;
- external revenue percentages (70/15/10/5);
- runway length (40 epochs);
- emission allocation (90% Cowboy production, 10% suit competition);
- marketplace fee (5%).

Changing any of these requires a new program deployment and a user-migration event, not an in-place parameter update.

## Launch parameters

- RODEO launches through pump.fun.
- Total supply: `1,000,000,000` RODEO.
- Initial team-funded ANSEM reward balance: `0`.
- Pot-fill period: `12 hours`.

## Security operations fund

The 5% security and operations allocation funds audits, bug bounties, infrastructure, and keeper bots. It is not used to backstop player losses.

## Open questions (BLOCKED)

- Approved swap venues and routing parameters: **BLOCKED: OWNER DECISION REQUIRED**.
- Multisig members, thresholds, and timelock duration: **BLOCKED: OWNER DECISION REQUIRED**.
- Emergency guardian members and pause scope: **BLOCKED: OWNER DECISION REQUIRED**.
- Exact dust-sweep rule for router remainders: **BLOCKED: OWNER DECISION REQUIRED**.
- Whether treasury authority may update the approved venue list: **BLOCKED: OWNER DECISION REQUIRED**.
