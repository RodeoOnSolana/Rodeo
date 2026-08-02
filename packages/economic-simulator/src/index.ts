import {
  ACCRUAL_WEIGHT_SCALE,
  BULL_BUCK_POWER,
  BPS_DENOMINATOR,
  CLAIM_BULL_POOL_BPS,
  CLAIM_COOLDOWN_SECONDS,
  CLAIM_OWNER_BPS,
  COWBOY_ACCRUAL_WEIGHTS,
  DESPERADO_CLAIM_BULL_POOL_BPS,
  DESPERADO_CLAIM_OWNER_BPS,
  EMISSION_COWBOY_BPS,
  EMISSION_SUITS_BPS,
  EPOCH_DURATION_SECONDS,
  MARKETPLACE_FEE_BPS,
  MIN_BULLS_FOR_THEFT,
  MIN_REVEALS_FOR_THEFT,
  MIN_STAKE_SECONDS,
  MINT_THEFT_BPS,
  POT_FILL_SECONDS,
  REWARD_PER_WEIGHT_SCALE,
  REVENUE_ANSEM_BPS,
  REVENUE_BUYBACK_BPS,
  REVENUE_SECURITY_BPS,
  REVENUE_TEAM_BPS,
  RUNWAY_EPOCHS,
  RUNWAY_WINDOW_SECONDS,
  STAKE_AMOUNT_ATOMIC,
  UNSTAKE_ANSEM_THEFT_BPS,
  UNSTAKE_RETURN_BPS,
  UNSTAKE_TAX_BPS,
} from "@rodeo/protocol-definition";
import { checkedAdd, checkedSub, mulDivCeil, mulDivFloor } from "@rodeo/shared";

export type Role = "cowboy" | "bull" | "unassigned";
export type CowboyRank = "rank4" | "rank5" | "rank6" | "rank7" | "rank8" | "rank9" | "rank10" | "desperado";
export type BullTier = "tier1" | "tier2" | "tier3" | "tier4";
export type Suit = "hearts" | "diamonds" | "clubs" | "spades" | "unassigned";

export interface PositionState {
  readonly id: string;
  owner: string;
  principalAtomic: bigint;
  role: Role;
  rankOrTier: CowboyRank | BullTier | null;
  isDesperado: boolean;
  suit: Suit;
  claimableAnsemAtomic: bigint;
  accrualWeight: bigint;
  buckPower: number;
  lastCowboyRewardIndex: bigint;
  lastBullRewardPerWeight: bigint;
  openedAt: bigint;
  lastClaimedAt: bigint;
  pendingActionActive: boolean;
  pendingActionType: string | null;
  pendingActionNonce: bigint;
  nextActionNonce: bigint;
  settlementNonce: bigint;
}

export interface WalletState {
  lastClaimedAt: bigint;
}

export interface SimulatorConfig {
  readonly epochDurationSeconds: bigint;
  readonly runwayWindowSeconds: bigint;
  readonly potFillSeconds: bigint;
  readonly emissionTargetByEpoch: readonly bigint[];
  readonly ansemPerRevenueNumerator: bigint;
  readonly ansemPerRevenueDenominator: bigint;
}

export interface SimulationState {
  now: bigint;
  epoch: bigint;
  epochStartedAt: bigint;
  principalVaultAtomic: bigint;
  rewardVaultAnsemAtomic: bigint;
  ansemLiabilityAtomic: bigint;
  feeRevenueAtomic: bigint;
  ansemEmittedAtomic: bigint;
  ansemClaimedAtomic: bigint;
  rodeoBurnedAtomic: bigint;
  marketplaceVolumeAtomic: bigint;
  protocolRevenueAtomic: bigint;
  teamRevenueAtomic: bigint;
  securityRevenueAtomic: bigint;
  buybackRevenueAtomic: bigint;
  cowboyRewardIndex: bigint;
  bullRewardPerWeightScaled: bigint;
  suitVaultAtomic: bigint;
  suitEpoch: bigint;
  completedReveals: bigint;
  positions: Map<string, PositionState>;
  wallets: Map<string, WalletState>;
  settledIds: Set<string>;
}

export interface RevealOutcomes {
  role: Role;
  rankOrTier: CowboyRank | BullTier;
  isDesperado: boolean;
  suit: Suit;
  mintTheft: boolean;
  thiefPositionId: string | null;
}

export interface UnstakeFate {
  ansemToBullPool: boolean;
}

export type SimulationEvent =
  | { readonly type: "stake"; readonly settlementId: string; readonly positionId: string; readonly owner: string; readonly openedAt: bigint }
  | { readonly type: "reveal"; readonly settlementId: string; readonly positionId: string; readonly outcomes: RevealOutcomes }
  | { readonly type: "claim"; readonly settlementId: string; readonly positionId: string; readonly claimedAt: bigint }
  | { readonly type: "requestUnstake"; readonly settlementId: string; readonly positionId: string; readonly requestedAt: bigint }
  | { readonly type: "settleUnstake"; readonly settlementId: string; readonly positionId: string; readonly fate: UnstakeFate }
  | { readonly type: "transferPosition"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string }
  | { readonly type: "marketSale"; readonly settlementId: string; readonly positionId: string; readonly priceAtomic: bigint; readonly claimedAt: bigint }
  | { readonly type: "gift"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string; readonly claimedAt: bigint }
  | { readonly type: "externalRevenue"; readonly settlementId: string; readonly revenueAtomic: bigint }
  | { readonly type: "fundRewards"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "closeEpoch"; readonly settlementId: string; readonly now: bigint };

export interface RunwayReport {
  readonly requiredAnsemAtomic: bigint;
  readonly availableAnsemAtomic: bigint;
  readonly covered: boolean;
  readonly coveredEpochs: bigint;
}

export function createSimulatorConfig(config: SimulatorConfig): SimulatorConfig {
  if (config.epochDurationSeconds !== EPOCH_DURATION_SECONDS) throw new RangeError("Epochs must be six hours");
  if (config.runwayWindowSeconds !== RUNWAY_WINDOW_SECONDS) throw new RangeError("Runway must be ten days");
  if (config.potFillSeconds !== POT_FILL_SECONDS) throw new RangeError("Pot-fill period must be twelve hours");
  if (config.ansemPerRevenueNumerator <= 0n || config.ansemPerRevenueDenominator <= 0n) {
    throw new RangeError("An explicit positive revenue-to-ANSEM conversion ratio is required");
  }
  if (config.emissionTargetByEpoch.some((amount) => amount < 0n)) throw new RangeError("Emission targets cannot be negative");
  return config;
}

export class EconomicSimulator {
  readonly state: SimulationState;

  constructor(readonly config: SimulatorConfig) {
    createSimulatorConfig(config);
    this.state = {
      now: 0n,
      epoch: 0n,
      epochStartedAt: 0n,
      principalVaultAtomic: 0n,
      rewardVaultAnsemAtomic: 0n,
      ansemLiabilityAtomic: 0n,
      feeRevenueAtomic: 0n,
      ansemEmittedAtomic: 0n,
      ansemClaimedAtomic: 0n,
      rodeoBurnedAtomic: 0n,
      marketplaceVolumeAtomic: 0n,
      protocolRevenueAtomic: 0n,
      teamRevenueAtomic: 0n,
      securityRevenueAtomic: 0n,
      buybackRevenueAtomic: 0n,
      cowboyRewardIndex: 0n,
      bullRewardPerWeightScaled: 0n,
      suitVaultAtomic: 0n,
      suitEpoch: 0n,
      completedReveals: 0n,
      positions: new Map(),
      wallets: new Map(),
      settledIds: new Set(),
    };
  }

  apply(event: SimulationEvent): void {
    if (this.state.settledIds.has(event.settlementId)) throw new Error(`Duplicate settlement: ${event.settlementId}`);
    this.validateNonNegative(event);

    switch (event.type) {
      case "stake":
        this.stake(event);
        break;
      case "reveal":
        this.reveal(event);
        break;
      case "claim":
        this.claim(event);
        break;
      case "requestUnstake":
        this.requestUnstake(event);
        break;
      case "settleUnstake":
        this.settleUnstake(event);
        break;
      case "transferPosition":
        this.transferPosition(event);
        break;
      case "marketSale":
        this.marketSale(event);
        break;
      case "gift":
        this.gift(event);
        break;
      case "externalRevenue":
        this.externalRevenue(event);
        break;
      case "fundRewards":
        this.fundRewards(event);
        break;
      case "closeEpoch":
        this.closeEpoch(event);
        break;
    }

    this.state.settledIds.add(event.settlementId);
    this.assertInvariants();
  }

  runway(): RunwayReport {
    const start = Number(this.state.epoch);
    const end = start + Number(RUNWAY_EPOCHS);
    const targets = this.config.emissionTargetByEpoch.slice(start, end);
    const required = targets.reduce((sum, amount) => sum + amount, 0n);
    const unencumberedVault = checkedSub(this.state.rewardVaultAnsemAtomic, this.state.ansemLiabilityAtomic);
    const purchasable = mulDivFloor(this.state.feeRevenueAtomic, this.config.ansemPerRevenueNumerator, this.config.ansemPerRevenueDenominator);
    const available = checkedAdd(unencumberedVault, purchasable, (1n << 128n) - 1n);
    let cumulative = 0n;
    let coveredEpochs = 0n;
    for (const target of targets) {
      if (cumulative + target > available) break;
      cumulative += target;
      coveredEpochs += 1n;
    }
    return { requiredAnsemAtomic: required, availableAnsemAtomic: available, covered: available >= required, coveredEpochs };
  }

  private stake(event: Extract<SimulationEvent, { type: "stake" }>): void {
    if (this.state.positions.has(event.positionId)) throw new Error(`Position already exists: ${event.positionId}`);
    if (STAKE_AMOUNT_ATOMIC <= 0n) throw new Error("Stake amount must be positive");

    this.state.positions.set(event.positionId, {
      id: event.positionId,
      owner: event.owner,
      principalAtomic: STAKE_AMOUNT_ATOMIC,
      role: "unassigned",
      rankOrTier: null,
      isDesperado: false,
      suit: "unassigned",
      claimableAnsemAtomic: 0n,
      accrualWeight: 0n,
      buckPower: 0,
      lastCowboyRewardIndex: 0n,
      lastBullRewardPerWeight: 0n,
      openedAt: event.openedAt,
      lastClaimedAt: 0n,
      pendingActionActive: true,
      pendingActionType: "reveal",
      pendingActionNonce: 0n,
      nextActionNonce: 1n,
      settlementNonce: 0n,
    });
    this.state.principalVaultAtomic = checkedAdd(this.state.principalVaultAtomic, STAKE_AMOUNT_ATOMIC);
  }

  private reveal(event: Extract<SimulationEvent, { type: "reveal" }>): void {
    const position = this.position(event.positionId);
    if (!position.pendingActionActive || position.pendingActionType !== "reveal") {
      throw new Error("No pending reveal action");
    }
    if (position.settlementNonce !== 0n) throw new Error("Reveal can only settle the first action");
    if (event.outcomes.thiefPositionId !== null && !this.state.positions.has(event.outcomes.thiefPositionId)) {
      throw new Error("Invalid thief position");
    }

    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    position.role = event.outcomes.role;
    position.rankOrTier = event.outcomes.rankOrTier;
    position.isDesperado = event.outcomes.isDesperado;
    position.suit = event.outcomes.suit;
    position.pendingActionActive = false;
    position.pendingActionType = null;
    position.settlementNonce = checkedAdd(position.settlementNonce, 1n);
    this.state.completedReveals = checkedAdd(this.state.completedReveals, 1n);

    if (event.outcomes.role === "cowboy") {
      const rank = event.outcomes.rankOrTier as CowboyRank;
      position.accrualWeight = COWBOY_ACCRUAL_WEIGHTS[rank];
    } else if (event.outcomes.role === "bull") {
      const tier = event.outcomes.rankOrTier as BullTier;
      position.buckPower = BULL_BUCK_POWER[tier];
      position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
    }

    if (event.outcomes.mintTheft && event.outcomes.thiefPositionId !== null) {
      const thief = this.position(event.outcomes.thiefPositionId);
      position.owner = thief.owner;
    }
  }

  private claim(event: Extract<SimulationEvent, { type: "claim" }>): void {
    const position = this.position(event.positionId);
    if (position.role === "unassigned") throw new Error("Cannot claim for unassigned position");
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    const wallet = this.wallet(position.owner);
    if (wallet.lastClaimedAt > 0n && event.claimedAt < wallet.lastClaimedAt + CLAIM_COOLDOWN_SECONDS) {
      throw new Error("Claim cooldown not met");
    }

    const claimable = position.claimableAnsemAtomic;
    if (claimable <= 0n) throw new Error("No claimable rewards");

    let ownerBps = CLAIM_OWNER_BPS;
    let bullBps = CLAIM_BULL_POOL_BPS;
    if (position.isDesperado) {
      ownerBps = DESPERADO_CLAIM_OWNER_BPS;
      bullBps = DESPERADO_CLAIM_BULL_POOL_BPS;
    }

    const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
    const bullAmount = checkedSub(claimable, ownerAmount);

    position.claimableAnsemAtomic = 0n;
    this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, claimable);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);

    this.distributeToBullPool(bullAmount);
    wallet.lastClaimedAt = event.claimedAt;
  }

  private requestUnstake(event: Extract<SimulationEvent, { type: "requestUnstake" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Position already has a pending action");
    if (event.requestedAt < position.openedAt + MIN_STAKE_SECONDS) {
      throw new Error("Minimum stake period not met");
    }
    position.pendingActionActive = true;
    position.pendingActionType = "unstake";
    position.pendingActionNonce = position.nextActionNonce;
    position.nextActionNonce = checkedAdd(position.nextActionNonce, 1n);
  }

  private settleUnstake(event: Extract<SimulationEvent, { type: "settleUnstake" }>): void {
    const position = this.position(event.positionId);
    if (!position.pendingActionActive || position.pendingActionType !== "unstake") {
      throw new Error("No pending unstake action");
    }

    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    const principal = position.principalAtomic;
    const tax = mulDivFloor(principal, UNSTAKE_TAX_BPS, BPS_DENOMINATOR);
    const returned = mulDivFloor(principal, UNSTAKE_RETURN_BPS, BPS_DENOMINATOR);
    const remainder = checkedSub(principal, checkedAdd(tax, returned));
    const totalBurned = checkedAdd(tax, remainder);

    this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, principal);
    this.state.rodeoBurnedAtomic = checkedAdd(this.state.rodeoBurnedAtomic, totalBurned);

    if (position.role === "cowboy" && !position.isDesperado) {
      const pending = position.claimableAnsemAtomic;
      if (event.fate.ansemToBullPool) {
        this.distributeToBullPool(pending);
      } else {
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, pending);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, pending);
      }
      position.claimableAnsemAtomic = 0n;
      this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, pending);
    } else if (position.role === "bull") {
      // Bull claims its bull-pool rewards directly before closing.
      const bullReward = this.computeBullReward(position);
      if (bullReward > 0n) {
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, bullReward);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, bullReward);
      }
      position.claimableAnsemAtomic = 0n;
      this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, bullReward);
    }

    position.principalAtomic = 0n;
    position.pendingActionActive = false;
    position.pendingActionType = null;
    position.settlementNonce = checkedAdd(position.settlementNonce, 1n);
    this.state.positions.delete(position.id);
  }

  private transferPosition(event: Extract<SimulationEvent, { type: "transferPosition" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot transfer while a randomness action is pending");
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);
    position.owner = event.newOwner;
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
  }

  private marketSale(event: Extract<SimulationEvent, { type: "marketSale" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot sell while a randomness action is pending");
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    // Force-settle seller rewards using normal claim split.
    const claimable = position.claimableAnsemAtomic;
    if (claimable > 0n) {
      let ownerBps = CLAIM_OWNER_BPS;
      let bullBps = CLAIM_BULL_POOL_BPS;
      if (position.isDesperado) {
        ownerBps = DESPERADO_CLAIM_OWNER_BPS;
        bullBps = DESPERADO_CLAIM_BULL_POOL_BPS;
      }
      const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
      const bullAmount = checkedSub(claimable, ownerAmount);
      position.claimableAnsemAtomic = 0n;
      this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, claimable);
      this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
      this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);
      this.distributeToBullPool(bullAmount);
    }

    const fee = mulDivFloor(event.priceAtomic, MARKETPLACE_FEE_BPS, BPS_DENOMINATOR);
    const sellerProceeds = checkedSub(event.priceAtomic, fee);
    this.state.marketplaceVolumeAtomic = checkedAdd(this.state.marketplaceVolumeAtomic, event.priceAtomic);
    this.state.protocolRevenueAtomic = checkedAdd(this.state.protocolRevenueAtomic, fee);
    this.externalRevenue({ type: "externalRevenue", settlementId: `internal-market-${event.settlementId}`, revenueAtomic: fee });

    position.owner = "buyer";
    position.claimableAnsemAtomic = 0n;
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
  }

  private gift(event: Extract<SimulationEvent, { type: "gift" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot gift while a randomness action is pending");
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    const claimable = position.claimableAnsemAtomic;
    if (claimable > 0n) {
      let ownerBps = CLAIM_OWNER_BPS;
      let bullBps = CLAIM_BULL_POOL_BPS;
      if (position.isDesperado) {
        ownerBps = DESPERADO_CLAIM_OWNER_BPS;
        bullBps = DESPERADO_CLAIM_BULL_POOL_BPS;
      }
      const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
      const bullAmount = checkedSub(claimable, ownerAmount);
      position.claimableAnsemAtomic = 0n;
      this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, claimable);
      this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
      this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);
      this.distributeToBullPool(bullAmount);
    }

    position.owner = event.newOwner;
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
  }

  private externalRevenue(event: Extract<SimulationEvent, { type: "externalRevenue" }>): void {
    // 70% of external revenue is budgeted to purchase ANSEM for the reward vault.
    const ansemBudget = mulDivFloor(event.revenueAtomic, REVENUE_ANSEM_BPS, BPS_DENOMINATOR);
    const ansem = mulDivFloor(ansemBudget, this.config.ansemPerRevenueNumerator, this.config.ansemPerRevenueDenominator);
    const team = mulDivFloor(event.revenueAtomic, REVENUE_TEAM_BPS, BPS_DENOMINATOR);
    const security = mulDivFloor(event.revenueAtomic, REVENUE_SECURITY_BPS, BPS_DENOMINATOR);
    const buyback = mulDivFloor(event.revenueAtomic, REVENUE_BUYBACK_BPS, BPS_DENOMINATOR);
    const spent = checkedAdd(checkedAdd(checkedAdd(team, security), buyback), ansem);
    const dust = event.revenueAtomic >= spent ? checkedSub(event.revenueAtomic, spent) : 0n;

    // ANSEM is not deposited until the keeper executes a fundRewards event.
    this.state.feeRevenueAtomic = checkedAdd(this.state.feeRevenueAtomic, checkedAdd(ansem, dust));
    this.state.teamRevenueAtomic = checkedAdd(this.state.teamRevenueAtomic, team);
    this.state.securityRevenueAtomic = checkedAdd(this.state.securityRevenueAtomic, security);
    this.state.buybackRevenueAtomic = checkedAdd(this.state.buybackRevenueAtomic, buyback);
  }

  private fundRewards(event: Extract<SimulationEvent, { type: "fundRewards" }>): void {
    if (event.ansemAtomic > this.state.feeRevenueAtomic) throw new Error("Insufficient fee revenue to fund rewards");
    this.state.feeRevenueAtomic = checkedSub(this.state.feeRevenueAtomic, event.ansemAtomic);
    this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, event.ansemAtomic);
  }

  private closeEpoch(event: Extract<SimulationEvent, { type: "closeEpoch" }>): void {
    this.state.now = event.now;
    const target = this.config.emissionTargetByEpoch[Number(this.state.epoch)];
    if (target === undefined) throw new Error(`Missing emission target for epoch ${this.state.epoch}`);

    if (this.state.now < POT_FILL_SECONDS) {
      // No emission during pot-fill period; still advance epoch.
      this.state.epoch = checkedAdd(this.state.epoch, 1n);
      this.state.epochStartedAt = checkedAdd(this.state.epochStartedAt, EPOCH_DURATION_SECONDS);
      return;
    }

    const free = checkedSub(this.state.rewardVaultAnsemAtomic, this.state.ansemLiabilityAtomic);
    const emission = free > 0n ? free / RUNWAY_EPOCHS : 0n;
    if (emission > 0n) {
      const cowboyEmission = mulDivFloor(emission, EMISSION_COWBOY_BPS, BPS_DENOMINATOR);
      const suitContribution = checkedSub(emission, cowboyEmission);
      this.distributeCowboyProduction(cowboyEmission);
      this.state.suitVaultAtomic = checkedAdd(this.state.suitVaultAtomic, suitContribution);
      this.state.ansemEmittedAtomic = checkedAdd(this.state.ansemEmittedAtomic, emission);
    }

    this.state.epoch = checkedAdd(this.state.epoch, 1n);
    this.state.epochStartedAt = checkedAdd(this.state.epochStartedAt, EPOCH_DURATION_SECONDS);
  }

  private distributeCowboyProduction(cowboyEmission: bigint): void {
    let totalWeight = 0n;
    for (const position of this.state.positions.values()) {
      if (position.role === "cowboy") {
        totalWeight = checkedAdd(totalWeight, position.accrualWeight, (1n << 128n) - 1n);
      }
    }
    if (totalWeight === 0n) return;

    const indexIncrement = (cowboyEmission * ACCRUAL_WEIGHT_SCALE) / totalWeight;
    if (indexIncrement === 0n) return;

    this.state.cowboyRewardIndex = checkedAdd(this.state.cowboyRewardIndex, indexIncrement, (1n << 128n) - 1n);
  }

  private applyCowboyRewardDelta(position: PositionState): void {
    if (position.role !== "cowboy" || position.accrualWeight === 0n) return;
    const deltaIndex = checkedSub(this.state.cowboyRewardIndex, position.lastCowboyRewardIndex);
    if (deltaIndex === 0n) return;
    const accrued = (deltaIndex * position.accrualWeight) / ACCRUAL_WEIGHT_SCALE;
    if (accrued === 0n) return;
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, accrued);
    this.state.ansemLiabilityAtomic = checkedAdd(this.state.ansemLiabilityAtomic, accrued);
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
  }

  private distributeToBullPool(amount: bigint): void {
    if (amount === 0n) return;
    let totalPower = 0;
    for (const position of this.state.positions.values()) {
      if (position.role === "bull") {
        totalPower += position.buckPower;
      }
    }
    if (totalPower === 0) {
      // No active bulls to distribute to; conceptually the pool remains unallocated.
      // In a production implementation this surplus would be tracked explicitly.
      return;
    }
    const increment = (amount * REWARD_PER_WEIGHT_SCALE) / BigInt(totalPower);
    if (increment === 0n) return;
    this.state.bullRewardPerWeightScaled = checkedAdd(this.state.bullRewardPerWeightScaled, increment, (1n << 128n) - 1n);
  }

  private applyBullRewardDelta(position: PositionState): void {
    if (position.role !== "bull" || position.buckPower === 0) return;
    const reward = this.computeBullReward(position);
    if (reward === 0n) return;
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, reward);
    this.state.ansemLiabilityAtomic = checkedAdd(this.state.ansemLiabilityAtomic, reward);
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
  }

  private computeBullReward(position: PositionState): bigint {
    const delta = checkedSub(this.state.bullRewardPerWeightScaled, position.lastBullRewardPerWeight);
    if (delta === 0n) return 0n;
    return (delta * BigInt(position.buckPower)) / REWARD_PER_WEIGHT_SCALE;
  }

  private wallet(owner: string): WalletState {
    let wallet = this.state.wallets.get(owner);
    if (!wallet) {
      wallet = { lastClaimedAt: 0n };
      this.state.wallets.set(owner, wallet);
    }
    return wallet;
  }

  private position(id: string): PositionState {
    const position = this.state.positions.get(id);
    if (!position) throw new Error(`Unknown position: ${id}`);
    return position;
  }

  private validateNonNegative(event: SimulationEvent): void {
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === "bigint" && value < 0n) throw new RangeError(`${key} cannot be negative`);
    }
  }

  assertInvariants(): void {
    let reconciledPrincipal = 0n;
    let reconciledLiability = 0n;
    for (const position of this.state.positions.values()) {
      reconciledPrincipal = checkedAdd(reconciledPrincipal, position.principalAtomic, (1n << 128n) - 1n);
      reconciledLiability = checkedAdd(reconciledLiability, position.claimableAnsemAtomic, (1n << 128n) - 1n);
    }
    if (reconciledPrincipal !== this.state.principalVaultAtomic) throw new Error("RODEO principal does not reconcile");
    if (reconciledLiability !== this.state.ansemLiabilityAtomic) throw new Error("ANSEM position liabilities do not reconcile");
    if (this.state.rewardVaultAnsemAtomic < this.state.ansemLiabilityAtomic) throw new Error("ANSEM liabilities are not vault-backed");
  }
}
