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

Protocol v1 routes swaps through **Jupiter** as the approved swap aggregator. The Treasury Council may trigger swaps only when the following safety conditions are met:

| Parameter | Value |
| --- | --- |
| Minimum batch | $100-equivalent in SOL (computed off-chain from a reliable oracle/price source) |
| Maximum slippage | 1% |
| Maximum estimated price impact | 0.5% |
| Dust handling | Dust remains in the router pending account; there is no arbitrary dust-sweep recipient. |

- Failed or unsafe swaps leave funds in the router pending state rather than forcing execution.
- The router must not hold player principal or accrued ANSEM.
- No admin may redirect the 70/15/10/5 split or sweep dust to an unapproved address.

## Treasury router account model

The router is expected to be implemented in `programs/rodeo_router`. Recommended accounts:

- `RouterConfig`: approved swap aggregator (Jupiter v1), destination addresses, safety parameters, timelock config.
- `PendingBatch`: accumulated revenue awaiting execution, source token balance, epoch marker.

The exact account schema is Phase 2 implementation work and is not designed here.

## Governance model

### Upgrade Council

Program upgrade authority is controlled by a **3-of-5 Squads multisig**. All upgrades pass through a **72-hour timelock** before execution. The Council may propose upgrades to `rodeo_core`, `rodeo_market`, `rodeo_router`, and the randomness provider adapter.

### Treasury Council

Treasury authority is controlled by a separate **3-of-5 Squads multisig**. Treasury actions pass through a **48-hour timelock**. The Treasury Council may:

- trigger approved Jupiter swaps;
- claim router dust or leftover funds into the ANSEM reward vault (only if the dust policy permits);
- update approved Jupiter route parameters (slippage, price-impact ceiling, minimum batch) within fixed bounds set at deployment;
- update the destination addresses for team, security, and burn operations through a Treasury Council action.

Treasury Council may not:

- move player principal from the principal vault;
- reduce, cancel, or redirect accrued ANSEM liabilities;
- change the 70/15/10/5 revenue split;
- change core economic parameters listed below;
- add arbitrary dust-sweep recipients.

### Emergency Guardians

A separate **2-of-3** emergency guardian multisig may pause specific risky actions. Pause is **immediate** upon threshold signature. Unpause requires a **12-hour delay** after threshold signature, giving users a window to exit.

Emergency controls may pause:

- new stakes;
- new marketplace listings;
- new randomness commitments and unstake requests.

Emergency controls should preserve safe claims and exits whenever possible. They must not:

- withdraw player principal;
- block completed claims or unstakes that require no new randomness commitment;
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

- Exact Squads program addresses, member pubkeys, and timelock program instances: **BLOCKED: OWNER DECISION REQUIRED**.
- Off-chain price oracle used to compute the $100-equivalent minimum batch: **BLOCKED: OWNER DECISION REQUIRED**.
- Whether Jupiter v6 API, on-chain Jupiter program, or a custom keeper integration is used: **BLOCKED: OWNER DECISION REQUIRED**.
