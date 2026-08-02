# Rodeo Protocol v1 — Treasury, Router, and Governance

## Treasury overview

The treasury system receives external protocol revenue, converts it according to fixed rules, and routes the proceeds to approved destinations. It has no authority over player principal or accrued ANSEM liabilities.

## External revenue sources

Protocol revenue is realized fee receipts from approved protocol-owned flows. Specifically included:

- RODEO pump.fun creator fees.
- Rodeo marketplace fees.
- Protocol-controlled fee receipts from approved sponsorships or partnerships.

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
| Buy ANSEM for reward vault | 70% | Swap source token for ANSEM and deposit into `reward_vault` | Floor atomic units of source token |
| Team and marketing | 15% | Transfer source token to team treasury | Floor atomic units of source token |
| Buy and permanently burn RODEO | 10% | Swap source token for RODEO and burn it | Floor atomic units of source token |
| Security and operations | 5% | Transfer source token to security treasury | Floor atomic units of source token |

The sum of floor allocations may leave source-token dust in the corresponding `PendingBatch` account. All source-token dust remains in that `PendingBatch` and rolls into the next routing batch. There is no automatic sweep that redirects split-rounding dust into the ANSEM allocation or to an arbitrary address.

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
- `PendingBatch` (one per source mint): accumulated revenue awaiting execution, source token balance, last routed epoch.

The exact `PendingBatch` schema is Phase 2 implementation work and is documented as blocked below.

## Governance model

### Upgrade Council

Program upgrade authority is controlled by a **3-of-5 Squads multisig**. All upgrades pass through a **72-hour timelock** before execution. The Council may propose upgrades to `rodeo_core`, `rodeo_market`, `rodeo_router`, and the randomness provider adapter.

### Treasury Council

Treasury authority is controlled by a separate **3-of-5 Squads multisig**. Treasury actions pass through a **48-hour timelock**. The Treasury Council may:

- trigger approved Jupiter swaps;
- update approved Jupiter route parameters (slippage, price-impact ceiling, minimum batch) within fixed bounds set at deployment;
- update the destination addresses for team, security, and burn operations through a Treasury Council action.

Treasury Council may not:

- move player principal from the principal vault;
- reduce, cancel, or redirect accrued ANSEM liabilities;
- change the 70/15/10/5 revenue split;
- add arbitrary dust-sweep recipients.

### Emergency Guardians

A separate **2-of-3** emergency guardian multisig may toggle action-specific pause flags. Pause is **immediate** upon threshold signature. Unpause requires a **12-hour delay** after threshold signature, giving users a window to exit.

Pause flags stored in `GlobalConfig`:

- `pause_new_stakes`
- `pause_new_reveal_requests`
- `pause_new_marketplace_listings`
- `pause_router_swaps`

The following remain available whenever technically safe:

- claims;
- randomness settlements;
- unstake requests (unless `pause_new_reveal_requests` is repurposed for unstake requests by a future decision);
- unstake settlements;
- timeout recovery.

Emergency authorities cannot withdraw player principal or liabilities and cannot modify economic constants.

### Governance-protected core parameters

Because the program remains upgradeable, economic rules are governance-protected and publicly timelocked, not technically immutable. After launch, the intent is that no governance process may modify the following without a new program deployment:

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

All upgrade proposals must publish the source diff, reproducible build, program-data hash, and activation time before the 72-hour timelock begins.

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
