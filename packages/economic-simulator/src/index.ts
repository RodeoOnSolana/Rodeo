import {
  ACCRUAL_WEIGHT_SCALE,
  BULL_BUCK_POWER,
  BPS_DENOMINATOR,
  CLAIM_BULL_POOL_BPS,
  CLAIM_COOLDOWN_SECONDS,
  CLAIM_OWNER_BPS,
  CLOSE_EPOCH_BATCH_MAX,
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
  stakeAmountAtomic,
  UNSTAKE_ANSEM_THEFT_BPS,
  UNSTAKE_RETURN_BPS,
  UNSTAKE_TAX_BPS,
} from "@rodeo/protocol-definition";
import { checkedAdd, checkedSub, mulDivCeil, mulDivFloor } from "@rodeo/shared";

export type Role = "cowboy" | "bull" | "unassigned";
export type CowboyRank = "rank4" | "rank5" | "rank6" | "rank7" | "rank8" | "rank9" | "rank10" | "desperado";
export type BullTier = "tier1" | "tier2" | "tier3" | "tier4";
export type Suit = "hearts" | "diamonds" | "clubs" | "spades" | "unassigned";
export type PositionStatus = "revealPending" | "active";

export interface PositionState {
  readonly id: string;
  owner: string;
  principalAtomic: bigint;
  status: PositionStatus;
  role: Role;
  rankOrTier: CowboyRank | BullTier | null;
  isDesperado: boolean;
  suit: Suit;
  accrualWeight: bigint;
  buckPower: number;
  openedAt: bigint;
  activeSince: bigint;
  lastCowboyRewardIndex: bigint;
  lastBullRewardPerWeight: bigint;
  claimableAnsemAtomic: bigint;
  pendingActionActive: boolean;
  pendingActionType: "reveal" | "unstake" | null;
  pendingActionNonce: bigint;
  nextActionNonce: bigint;
  settlementNonce: bigint;
  stateVersion: bigint;
}

export interface WalletState {
  lastClaimedAt: bigint;
}

export interface SimulatorConfig {
  readonly rodeoDecimals: bigint;
  readonly epochDurationSeconds: bigint;
  readonly potFillSeconds: bigint;
  readonly emissionTargetByEpoch: readonly bigint[];
  readonly ansemPerSolNumerator: bigint;
  readonly ansemPerSolDenominator: bigint;
}

export interface SimulationState {
  now: bigint;
  epoch: bigint;
  epochStartedAt: bigint;
  launchTimestamp: bigint;
  principalVaultAtomic: bigint;
  rewardVaultAnsemAtomic: bigint;
  // Liabilities (all ANSEM atomic units)
  totalAnsemLiabilityAtomic: bigint;
  cowboyUnmaterializedLiabilityAtomic: bigint;
  positionClaimableLiabilityAtomic: bigint;
  bullPoolLiabilityAtomic: bigint;
  bullPoolUnallocatedLiabilityAtomic: bigint;
  suitVaultLiabilityAtomic: bigint;
  // Revenue accounting
  pendingSolRevenueAtomic: bigint;
  ansemEmittedAtomic: bigint;
  ansemClaimedAtomic: bigint;
  rodeoBurnedAtomic: bigint;
  marketplaceVolumeAtomic: bigint;
  teamRevenueAtomic: bigint;
  securityRevenueAtomic: bigint;
  buybackRevenueAtomic: bigint;
  // Reward accumulators
  cowboyRewardIndex: bigint;
  bullRewardPerWeightScaled: bigint;
  suitVaultAtomic: bigint;
  suitEpoch: bigint;
  // Game counters
  totalCompletedReveals: bigint;
  livePositionCount: bigint;
  activeCowboyCount: bigint;
  activeBullCount: bigint;
  totalActiveCowboyWeight: bigint;
  totalActiveBullPower: bigint;
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
  | { readonly type: "claimCowboy"; readonly settlementId: string; readonly positionId: string; readonly claimedAt: bigint }
  | { readonly type: "claimBull"; readonly settlementId: string; readonly positionId: string; readonly claimedAt: bigint }
  | { readonly type: "requestUnstake"; readonly settlementId: string; readonly positionId: string; readonly requestedAt: bigint }
  | { readonly type: "settleUnstake"; readonly settlementId: string; readonly positionId: string; readonly fate: UnstakeFate }
  | { readonly type: "transferPosition"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string }
  | { readonly type: "marketSale"; readonly settlementId: string; readonly positionId: string; readonly priceLamports: bigint; readonly claimedAt: bigint }
  | { readonly type: "gift"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string; readonly claimedAt: bigint }
  | { readonly type: "externalRevenue"; readonly settlementId: string; readonly revenueLamports: bigint }
  | { readonly type: "fundRewards"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "closeEpoch"; readonly settlementId: string; readonly now: bigint; readonly count?: bigint };

export interface RunwayReport {
  readonly requiredAnsemAtomic: bigint;
  readonly availableAnsemAtomic: bigint;
  readonly covered: boolean;
  readonly coveredEpochs: bigint;
}

export function createSimulatorConfig(config: SimulatorConfig): SimulatorConfig {
  if (config.epochDurationSeconds !== EPOCH_DURATION_SECONDS) throw new RangeError("Epochs must be six hours");
  if (config.potFillSeconds !== POT_FILL_SECONDS) throw new RangeError("Pot-fill period must be twelve hours");
  if (config.ansemPerSolNumerator <= 0n || config.ansemPerSolDenominator <= 0n) {
    throw new RangeError("An explicit positive SOL-to-ANSEM conversion ratio is required");
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
      launchTimestamp: 0n,
      principalVaultAtomic: 0n,
      rewardVaultAnsemAtomic: 0n,
      totalAnsemLiabilityAtomic: 0n,
      cowboyUnmaterializedLiabilityAtomic: 0n,
      positionClaimableLiabilityAtomic: 0n,
      bullPoolLiabilityAtomic: 0n,
      bullPoolUnallocatedLiabilityAtomic: 0n,
      suitVaultLiabilityAtomic: 0n,
      pendingSolRevenueAtomic: 0n,
      ansemEmittedAtomic: 0n,
      ansemClaimedAtomic: 0n,
      rodeoBurnedAtomic: 0n,
      marketplaceVolumeAtomic: 0n,
      teamRevenueAtomic: 0n,
      securityRevenueAtomic: 0n,
      buybackRevenueAtomic: 0n,
      cowboyRewardIndex: 0n,
      bullRewardPerWeightScaled: 0n,
      suitVaultAtomic: 0n,
      suitEpoch: 0n,
      totalCompletedReveals: 0n,
      livePositionCount: 0n,
      activeCowboyCount: 0n,
      activeBullCount: 0n,
      totalActiveCowboyWeight: 0n,
      totalActiveBullPower: 0n,
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
      case "claimCowboy":
        this.claimCowboy(event);
        break;
      case "claimBull":
        this.claimBull(event);
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
    const free = this.state.rewardVaultAnsemAtomic >= this.state.totalAnsemLiabilityAtomic
      ? checkedSub(this.state.rewardVaultAnsemAtomic, this.state.totalAnsemLiabilityAtomic)
      : 0n;
    const purchasable = mulDivFloor(this.state.pendingSolRevenueAtomic, this.config.ansemPerSolNumerator, this.config.ansemPerSolDenominator);
    const available = checkedAdd(free, purchasable, (1n << 128n) - 1n);
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
    const amount = stakeAmountAtomic(this.config.rodeoDecimals);
    if (this.state.positions.has(event.positionId)) throw new Error("Position already exists");
    this.state.positions.set(event.positionId, {
      id: event.positionId,
      owner: event.owner,
      principalAtomic: amount,
      status: "revealPending",
      role: "unassigned",
      rankOrTier: null,
      isDesperado: false,
      suit: "unassigned",
      accrualWeight: 0n,
      buckPower: 0,
      openedAt: event.openedAt,
      activeSince: 0n,
      lastCowboyRewardIndex: 0n,
      lastBullRewardPerWeight: 0n,
      claimableAnsemAtomic: 0n,
      pendingActionActive: true,
      pendingActionType: "reveal",
      pendingActionNonce: 0n,
      nextActionNonce: 1n,
      settlementNonce: 0n,
      stateVersion: 0n,
    });
    this.state.principalVaultAtomic = checkedAdd(this.state.principalVaultAtomic, amount);
    this.state.livePositionCount = checkedAdd(this.state.livePositionCount, 1n);
    if (this.state.launchTimestamp === 0n) {
      this.state.launchTimestamp = event.openedAt;
      this.state.epochStartedAt = event.openedAt;
    }
  }

  private reveal(event: Extract<SimulationEvent, { type: "reveal" }>): void {
    const position = this.position(event.positionId);
    if (!position.pendingActionActive || position.pendingActionType !== "reveal") throw new Error("No pending reveal action");
    if (position.settlementNonce !== 0n) throw new Error("Reveal can only settle the first action");
    if (event.outcomes.thiefPositionId !== null && !this.state.positions.has(event.outcomes.thiefPositionId)) {
      throw new Error("Invalid thief position");
    }

    // Finalize role, rank/tier, suit.
    position.role = event.outcomes.role;
    position.rankOrTier = event.outcomes.rankOrTier;
    position.isDesperado = event.outcomes.isDesperado;
    position.suit = event.outcomes.suit;
    position.status = "active";
    position.pendingActionActive = false;
    position.pendingActionType = null;
    position.settlementNonce = checkedAdd(position.settlementNonce, 1n);
    position.activeSince = this.state.now;
    this.state.totalCompletedReveals = checkedAdd(this.state.totalCompletedReveals, 1n);

    if (event.outcomes.role === "cowboy") {
      const rank = event.outcomes.rankOrTier as CowboyRank;
      position.accrualWeight = COWBOY_ACCRUAL_WEIGHTS[rank];
      this.state.activeCowboyCount = checkedAdd(this.state.activeCowboyCount, 1n);
      this.state.totalActiveCowboyWeight = checkedAdd(this.state.totalActiveCowboyWeight, position.accrualWeight);
    } else if (event.outcomes.role === "bull") {
      const tier = event.outcomes.rankOrTier as BullTier;
      position.buckPower = BULL_BUCK_POWER[tier];
      this.state.activeBullCount = checkedAdd(this.state.activeBullCount, 1n);
      this.state.totalActiveBullPower = checkedAdd(this.state.totalActiveBullPower, BigInt(position.buckPower));
      position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
      // If there is unallocated bull liability, distribute it now that there is bull power.
      this.allocateBullPoolUnallocated();
    }

    if (event.outcomes.mintTheft && event.outcomes.thiefPositionId !== null) {
      const thief = this.position(event.outcomes.thiefPositionId);
      if (thief.role !== "bull") throw new Error("Thief must be a Bull");
      this.transferOwnership(position, thief.owner);
      position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
      position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
    } else {
      position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    }
  }

  private claimCowboy(event: Extract<SimulationEvent, { type: "claimCowboy" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.role !== "cowboy") throw new Error("Not a Cowboy");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);

    const wallet = this.wallet(position.owner);
    if (wallet.lastClaimedAt > 0n && event.claimedAt < wallet.lastClaimedAt + CLAIM_COOLDOWN_SECONDS) {
      throw new Error("Claim cooldown not met");
    }

    const claimable = position.claimableAnsemAtomic;
    if (claimable <= 0n) throw new Error("No claimable rewards");

    const ownerBps = position.isDesperado ? DESPERADO_CLAIM_OWNER_BPS : CLAIM_OWNER_BPS;
    const bullBps = position.isDesperado ? DESPERADO_CLAIM_BULL_POOL_BPS : CLAIM_BULL_POOL_BPS;
    const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
    const bullAmount = checkedSub(claimable, ownerAmount);

    position.claimableAnsemAtomic = 0n;
    this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, ownerAmount);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);
    this.distributeToBullPool(bullAmount);
    wallet.lastClaimedAt = event.claimedAt;
  }

  private claimBull(event: Extract<SimulationEvent, { type: "claimBull" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.role !== "bull") throw new Error("Not a Bull");
    this.ensureEpochsCurrent();
    this.applyBullRewardDelta(position);

    const wallet = this.wallet(position.owner);
    if (wallet.lastClaimedAt > 0n && event.claimedAt < wallet.lastClaimedAt + CLAIM_COOLDOWN_SECONDS) {
      throw new Error("Claim cooldown not met");
    }

    const claimable = position.claimableAnsemAtomic;
    if (claimable <= 0n) throw new Error("No claimable rewards");

    position.claimableAnsemAtomic = 0n;
    // applyBullRewardDelta already moved the liability from the Bull pool to the position.
    this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, claimable);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, claimable);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, claimable);
    wallet.lastClaimedAt = event.claimedAt;
  }

  private requestUnstake(event: Extract<SimulationEvent, { type: "requestUnstake" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.pendingActionActive) throw new Error("Position already has a pending action");
    if (event.requestedAt < position.openedAt + MIN_STAKE_SECONDS) throw new Error("Minimum stake period not met");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);
    position.pendingActionActive = true;
    position.pendingActionType = "unstake";
    position.pendingActionNonce = position.nextActionNonce;
    position.nextActionNonce = checkedAdd(position.nextActionNonce, 1n);
  }

  private settleUnstake(event: Extract<SimulationEvent, { type: "settleUnstake" }>): void {
    const position = this.position(event.positionId);
    if (!position.pendingActionActive || position.pendingActionType !== "unstake") throw new Error("No pending unstake action");

    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    // Principal conservation: 5% burn, 95% return.
    const principal = position.principalAtomic;
    const tax = mulDivFloor(principal, UNSTAKE_TAX_BPS, BPS_DENOMINATOR);
    const returned = mulDivFloor(principal, UNSTAKE_RETURN_BPS, BPS_DENOMINATOR);
    const rounding = checkedSub(principal, checkedAdd(tax, returned));
    const totalBurned = checkedAdd(tax, rounding);

    this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, principal);
    this.state.rodeoBurnedAtomic = checkedAdd(this.state.rodeoBurnedAtomic, totalBurned);
    this.state.livePositionCount = checkedSub(this.state.livePositionCount, 1n);
    if (position.role === "cowboy") {
      this.state.activeCowboyCount = checkedSub(this.state.activeCowboyCount, 1n);
      this.state.totalActiveCowboyWeight = checkedSub(this.state.totalActiveCowboyWeight, position.accrualWeight);
    } else if (position.role === "bull") {
      this.state.activeBullCount = checkedSub(this.state.activeBullCount, 1n);
      this.state.totalActiveBullPower = checkedSub(this.state.totalActiveBullPower, BigInt(position.buckPower));
    }

    // Handle pending ANSEM for normal Cowboys.
    if (position.role === "cowboy" && !position.isDesperado) {
      const pending = position.claimableAnsemAtomic;
      if (pending > 0n) {
        this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, pending);
        if (event.fate.ansemToBullPool) {
          this.distributeToBullPool(pending);
        } else {
          this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, pending);
          this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, pending);
          this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, pending);
        }
        position.claimableAnsemAtomic = 0n;
      }
    }

    position.principalAtomic = 0n;
    this.state.positions.delete(position.id);
  }

  private transferPosition(event: Extract<SimulationEvent, { type: "transferPosition" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot transfer while a randomness action is pending");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);
    this.transferOwnership(position, event.newOwner);
  }

  private marketSale(event: Extract<SimulationEvent, { type: "marketSale" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.pendingActionActive) throw new Error("Cannot sell while a randomness action is pending");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    this.forceSettleCowboyRewards(position);
    const fee = mulDivFloor(event.priceLamports, MARKETPLACE_FEE_BPS, BPS_DENOMINATOR);
    this.state.marketplaceVolumeAtomic = checkedAdd(this.state.marketplaceVolumeAtomic, event.priceLamports);
    this.externalRevenue({ type: "externalRevenue", settlementId: `internal-market-${event.settlementId}`, revenueLamports: fee });

    this.transferOwnership(position, "buyer");
  }

  private gift(event: Extract<SimulationEvent, { type: "gift" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.pendingActionActive) throw new Error("Cannot gift while a randomness action is pending");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    this.forceSettleCowboyRewards(position);
    this.transferOwnership(position, event.newOwner);
  }

  private externalRevenue(event: Extract<SimulationEvent, { type: "externalRevenue" }>): void {
    // External revenue is SOL in v1. Split applied at the router pending account level.
    const ansemBudget = mulDivFloor(event.revenueLamports, REVENUE_ANSEM_BPS, BPS_DENOMINATOR);
    const ansem = mulDivFloor(ansemBudget, this.config.ansemPerSolNumerator, this.config.ansemPerSolDenominator);
    const team = mulDivFloor(event.revenueLamports, REVENUE_TEAM_BPS, BPS_DENOMINATOR);
    const security = mulDivFloor(event.revenueLamports, REVENUE_SECURITY_BPS, BPS_DENOMINATOR);
    const buyback = mulDivFloor(event.revenueLamports, REVENUE_BUYBACK_BPS, BPS_DENOMINATOR);
    const spent = checkedAdd(checkedAdd(checkedAdd(team, security), buyback), ansemBudget);
    const dust = event.revenueLamports >= spent ? checkedSub(event.revenueLamports, spent) : 0n;

    // SOL dust remains in pending SOL revenue to roll into the next batch; no auto sweep.
    this.state.pendingSolRevenueAtomic = checkedAdd(this.state.pendingSolRevenueAtomic, checkedAdd(ansemBudget, dust));
    this.state.teamRevenueAtomic = checkedAdd(this.state.teamRevenueAtomic, team);
    this.state.securityRevenueAtomic = checkedAdd(this.state.securityRevenueAtomic, security);
    this.state.buybackRevenueAtomic = checkedAdd(this.state.buybackRevenueAtomic, buyback);
  }

  private fundRewards(event: Extract<SimulationEvent, { type: "fundRewards" }>): void {
    if (event.ansemAtomic > this.state.pendingSolRevenueAtomic) throw new Error("Insufficient SOL revenue to fund rewards");
    const solSpent = mulDivCeil(event.ansemAtomic, this.config.ansemPerSolDenominator, this.config.ansemPerSolNumerator);
    this.state.pendingSolRevenueAtomic = checkedSub(this.state.pendingSolRevenueAtomic, solSpent);
    this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, event.ansemAtomic);
  }

  private closeEpoch(event: Extract<SimulationEvent, { type: "closeEpoch" }>): void {
    this.state.now = event.now;
    const maxEpochs = event.count ?? CLOSE_EPOCH_BATCH_MAX;
    const elapsed = this.elapsedEpochs();
    const toClose = elapsed < maxEpochs ? elapsed : maxEpochs;

    for (let i = 0n; i < toClose; i += 1n) {
      const target = this.config.emissionTargetByEpoch[Number(this.state.epoch)];
      if (target === undefined) throw new Error(`Missing emission target for epoch ${this.state.epoch}`);

      if (this.state.now < this.state.launchTimestamp + POT_FILL_SECONDS) {
        // No emission during pot-fill; still advance epoch boundaries.
      } else {
        const free = this.state.rewardVaultAnsemAtomic >= this.state.totalAnsemLiabilityAtomic
          ? checkedSub(this.state.rewardVaultAnsemAtomic, this.state.totalAnsemLiabilityAtomic)
          : 0n;
        const emission = target < free ? target : free;

        if (emission > 0n) {
          const cowboyEmission = mulDivFloor(emission, EMISSION_COWBOY_BPS, BPS_DENOMINATOR);
          const suitContribution = checkedSub(emission, cowboyEmission);

          if (this.state.totalActiveCowboyWeight > 0n) {
            // Reserve cowboy emission as a global unmaterialized liability.
            this.state.cowboyUnmaterializedLiabilityAtomic = checkedAdd(
              this.state.cowboyUnmaterializedLiabilityAtomic,
              cowboyEmission
            );
            this.state.totalAnsemLiabilityAtomic = checkedAdd(this.state.totalAnsemLiabilityAtomic, cowboyEmission);

            const indexIncrement = (cowboyEmission * ACCRUAL_WEIGHT_SCALE) / this.state.totalActiveCowboyWeight;
            if (indexIncrement > 0n) {
              // Scaled reward accumulators are modeled with arbitrary-precision BigInt in the simulator.
              this.state.cowboyRewardIndex += indexIncrement;
            }
          }

          // Suit allocation is always reserved.
          this.state.suitVaultAtomic = checkedAdd(this.state.suitVaultAtomic, suitContribution);
          this.state.suitVaultLiabilityAtomic = checkedAdd(this.state.suitVaultLiabilityAtomic, suitContribution);
          this.state.totalAnsemLiabilityAtomic = checkedAdd(this.state.totalAnsemLiabilityAtomic, suitContribution);

          this.state.ansemEmittedAtomic = checkedAdd(this.state.ansemEmittedAtomic, emission);
        }
      }

      this.state.epoch = checkedAdd(this.state.epoch, 1n);
      this.state.epochStartedAt = checkedAdd(this.state.epochStartedAt, EPOCH_DURATION_SECONDS);
    }
  }

  private applyCowboyRewardDelta(position: PositionState): void {
    if (position.role !== "cowboy" || position.accrualWeight === 0n) return;
    const deltaIndex = checkedSub(this.state.cowboyRewardIndex, position.lastCowboyRewardIndex);
    if (deltaIndex === 0n) return;
    const accrued = (deltaIndex * position.accrualWeight) / ACCRUAL_WEIGHT_SCALE;
    if (accrued === 0n) return;
    if (accrued > this.state.cowboyUnmaterializedLiabilityAtomic) {
      throw new Error("Cowboy accrual exceeds unmaterialized liability");
    }
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, accrued);
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    this.state.cowboyUnmaterializedLiabilityAtomic = checkedSub(this.state.cowboyUnmaterializedLiabilityAtomic, accrued);
    this.state.positionClaimableLiabilityAtomic = checkedAdd(this.state.positionClaimableLiabilityAtomic, accrued);
  }

  private applyBullRewardDelta(position: PositionState): void {
    if (position.role !== "bull" || position.buckPower === 0) return;
    const reward = this.computeBullReward(position);
    if (reward === 0n) return;
    if (reward > this.state.bullPoolLiabilityAtomic) {
      throw new Error("Bull accrual exceeds bull pool liability");
    }
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, reward);
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
    this.state.bullPoolLiabilityAtomic = checkedSub(this.state.bullPoolLiabilityAtomic, reward);
    this.state.positionClaimableLiabilityAtomic = checkedAdd(this.state.positionClaimableLiabilityAtomic, reward);
  }

  private computeBullReward(position: PositionState): bigint {
    const delta = checkedSub(this.state.bullRewardPerWeightScaled, position.lastBullRewardPerWeight);
    if (delta === 0n) return 0n;
    return (delta * BigInt(position.buckPower)) / REWARD_PER_WEIGHT_SCALE;
  }

  private distributeToBullPool(amount: bigint): void {
    if (amount === 0n) return;
    // This is a reclassification of already-owed ANSEM into the Bull pool.
    // totalAnsemLiabilityAtomic is unchanged; the caller manages the source bucket.
    if (this.state.totalActiveBullPower === 0n) {
      this.state.bullPoolUnallocatedLiabilityAtomic = checkedAdd(this.state.bullPoolUnallocatedLiabilityAtomic, amount);
      return;
    }
    this.state.bullPoolLiabilityAtomic = checkedAdd(this.state.bullPoolLiabilityAtomic, amount);
    const increment = (amount * REWARD_PER_WEIGHT_SCALE) / this.state.totalActiveBullPower;
    if (increment === 0n) return;
    this.state.bullRewardPerWeightScaled += increment;
  }

  private allocateBullPoolUnallocated(): void {
    const amount = this.state.bullPoolUnallocatedLiabilityAtomic;
    if (amount === 0n || this.state.totalActiveBullPower === 0n) return;
    this.state.bullPoolUnallocatedLiabilityAtomic = 0n;
    this.state.bullPoolLiabilityAtomic = checkedAdd(this.state.bullPoolLiabilityAtomic, amount);
    const increment = (amount * REWARD_PER_WEIGHT_SCALE) / this.state.totalActiveBullPower;
    if (increment === 0n) return;
    this.state.bullRewardPerWeightScaled += increment;
  }

  private forceSettleCowboyRewards(position: PositionState): void {
    if (position.role !== "cowboy" || position.claimableAnsemAtomic === 0n) return;
    const claimable = position.claimableAnsemAtomic;
    const ownerBps = position.isDesperado ? DESPERADO_CLAIM_OWNER_BPS : CLAIM_OWNER_BPS;
    const bullBps = position.isDesperado ? DESPERADO_CLAIM_BULL_POOL_BPS : CLAIM_BULL_POOL_BPS;
    const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
    const bullAmount = checkedSub(claimable, ownerAmount);
    position.claimableAnsemAtomic = 0n;
    this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, ownerAmount);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);
    this.distributeToBullPool(bullAmount);
  }

  private transferOwnership(position: PositionState, newOwner: string): void {
    position.owner = newOwner;
    position.stateVersion = checkedAdd(position.stateVersion, 1n);
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
  }

  private elapsedEpochs(): bigint {
    if (this.state.now <= this.state.epochStartedAt) return 0n;
    return (this.state.now - this.state.epochStartedAt) / EPOCH_DURATION_SECONDS;
  }

  private ensureEpochsCurrent(): void {
    if (this.elapsedEpochs() > 0n) {
      throw new Error("All elapsed epochs must be closed before this operation");
    }
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
    let reconciledClaimable = 0n;
    let cowboyWeight = 0n;
    let bullPower = 0n;
    for (const position of this.state.positions.values()) {
      reconciledPrincipal = checkedAdd(reconciledPrincipal, position.principalAtomic);
      reconciledClaimable = checkedAdd(reconciledClaimable, position.claimableAnsemAtomic);
      if (position.role === "cowboy") cowboyWeight = checkedAdd(cowboyWeight, position.accrualWeight);
      if (position.role === "bull") bullPower = checkedAdd(bullPower, BigInt(position.buckPower));
    }
    if (reconciledPrincipal !== this.state.principalVaultAtomic) throw new Error("RODEO principal does not reconcile");
    if (reconciledClaimable !== this.state.positionClaimableLiabilityAtomic) throw new Error("Position claimable liability does not reconcile");
    if (cowboyWeight !== this.state.totalActiveCowboyWeight) throw new Error("Active cowboy weight does not reconcile");
    if (bullPower !== this.state.totalActiveBullPower) throw new Error("Active bull power does not reconcile");

    const expectedLiability = checkedAdd(
      checkedAdd(checkedAdd(this.state.cowboyUnmaterializedLiabilityAtomic, this.state.positionClaimableLiabilityAtomic), this.state.bullPoolLiabilityAtomic),
      checkedAdd(this.state.bullPoolUnallocatedLiabilityAtomic, this.state.suitVaultLiabilityAtomic)
    );
    if (expectedLiability !== this.state.totalAnsemLiabilityAtomic) throw new Error("Total ANSEM liability does not reconcile");
    if (this.state.rewardVaultAnsemAtomic < this.state.totalAnsemLiabilityAtomic) throw new Error("ANSEM liabilities are not vault-backed");
  }
}
