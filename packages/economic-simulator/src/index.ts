import {
  ACCRUAL_WEIGHT_SCALE,
  BULL_BUCK_POWER,
  BPS_DENOMINATOR,
  CLAIM_BULL_POOL_BPS,
  CLAIM_COOLDOWN_SECONDS,
  CLAIM_OWNER_BPS,
  CLOSE_EPOCH_BATCH_MAX,
  COWBOY_ACCRUAL_WEIGHTS,
  COWBOY_REWARD_INDEX_SCALE,
  DESPERADO_ACCRUAL_WEIGHT,
  DESPERADO_CLAIM_BULL_POOL_BPS,
  DESPERADO_CLAIM_OWNER_BPS,
  EMISSION_COWBOY_BPS,
  EMISSION_SUITS_BPS,
  SUIT_EPOCHS,
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
export type CowboyRank = "rank4" | "rank5" | "rank6" | "rank7" | "rank8" | "rank9" | "rank10";
export type CowboyKind = { readonly kind: "unassigned" } | { readonly kind: "rank"; readonly rank: CowboyRank } | { readonly kind: "desperado" };
export type BullTier = "tier1" | "tier2" | "tier3" | "tier4";
export type Suit = "hearts" | "diamonds" | "clubs" | "spades" | "unassigned";
export type PositionStatus = "revealPending" | "active";

export interface PositionState {
  readonly id: string;
  owner: string;
  principalAtomic: bigint;
  status: PositionStatus;
  role: Role;
  cowboyKind: CowboyKind;
  bullTier: number; // 0 for Cowboys, 1-4 for Bulls
  suit: Suit;
  accrualWeight: bigint;
  buckPower: number;
  openedAt: bigint;
  activeSince: bigint;
  unstakeEligibleAt: bigint;
  lastCowboyRewardIndex: bigint;
  lastBullRewardPerWeight: bigint;
  cowboyAccrualRemainderScaled: bigint;
  bullAccrualRemainderScaled: bigint;
  claimableAnsemAtomic: bigint;
  pendingActionActive: boolean;
  pendingActionType: "reveal" | "unstake" | null;
  pendingActionNonce: bigint;
  nextActionNonce: bigint;
  settlementNonce: bigint;
  stateVersion: bigint;
}

export function isDesperado(position: PositionState): boolean {
  return position.cowboyKind.kind === "desperado";
}

export interface WalletState {
  lastClaimedAt: bigint;
}

export interface SimulatorConfig {
  readonly rodeoDecimals: bigint;
  readonly epochDurationSeconds: bigint;
  readonly potFillSeconds: bigint;
  readonly ansemPerSolNumerator: bigint;
  readonly ansemPerSolDenominator: bigint;
}

export interface SimulationState {
  now: bigint;
  epoch: bigint;
  epochStartedAt: bigint;
  launchTimestamp: bigint;
  // Principal accounting
  principalVaultAtomic: bigint;
  accountedPrincipalAtomic: bigint;
  principalVaultSurplusAtomic: bigint;
  // Reward vault accounting
  rewardVaultAnsemAtomic: bigint;
  recognizedRewardBalanceAtomic: bigint;
  // Liabilities (all ANSEM atomic units)
  totalAnsemLiabilityAtomic: bigint;
  cowboyUnmaterializedLiabilityAtomic: bigint;
  positionClaimableLiabilityAtomic: bigint;
  bullPoolLiabilityAtomic: bigint;
  bullPoolUnallocatedLiabilityAtomic: bigint;
  suitVaultLiabilityAtomic: bigint;
  suitClaimLiabilityAtomic: bigint;
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
  cowboyIndexRemainderScaled: bigint;
  cowboyOrphanedAccrualRemainderScaled: bigint;
  bullRewardPerWeightScaled: bigint;
  bullIndexRemainderScaled: bigint;
  bullOrphanedAccrualRemainderScaled: bigint;
  orphanedRewardReleasedAtomic: bigint;
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
  suitClaimsByLeaf: Map<string, bigint>;
  suitClaimedLeaves: Set<string>;
  settledIds: Set<string>;
}

export interface RevealOutcomes {
  role: Role;
  cowboyRank?: CowboyRank;
  bullTier?: BullTier;
  isDesperado: boolean;
  suit: Suit;
  mintTheft: boolean;
  thiefPositionId: string | null;
}

export interface UnstakeFate {
  ansemToBullPool: boolean;
}

export interface SuitClaimLeaf {
  readonly positionId: string;
  readonly ownerAtSnapshot: string;
  readonly suit: Suit;
  readonly amount: bigint;
  readonly leafNonce: bigint;
}

export type SimulationEvent =
  | { readonly type: "stake"; readonly settlementId: string; readonly positionId: string; readonly owner: string; readonly openedAt: bigint }
  | { readonly type: "reveal"; readonly settlementId: string; readonly positionId: string; readonly outcomes: RevealOutcomes }
  | { readonly type: "claimCowboy"; readonly settlementId: string; readonly positionId: string; readonly claimedAt: bigint }
  | { readonly type: "claimBull"; readonly settlementId: string; readonly positionId: string; readonly claimedAt: bigint }
  | { readonly type: "requestUnstake"; readonly settlementId: string; readonly positionId: string; readonly requestedAt: bigint }
  | { readonly type: "settleUnstake"; readonly settlementId: string; readonly positionId: string; readonly fate: UnstakeFate }
  | { readonly type: "marketSale"; readonly settlementId: string; readonly positionId: string; readonly priceLamports: bigint; readonly claimedAt: bigint }
  | { readonly type: "gift"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string; readonly claimedAt: bigint }
  | { readonly type: "externalRevenue"; readonly settlementId: string; readonly revenueLamports: bigint }
  | { readonly type: "buyAnsemRewards"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "recognizeRewards"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "directRewardTransfer"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "socialResult"; readonly settlementId: string; readonly competitionEpoch: bigint; readonly winningSuitsMask: number; readonly claims: readonly SuitClaimLeaf[] }
  | { readonly type: "suitClaim"; readonly settlementId: string; readonly competitionEpoch: bigint; readonly leaf: SuitClaimLeaf }
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
      accountedPrincipalAtomic: 0n,
      principalVaultSurplusAtomic: 0n,
      rewardVaultAnsemAtomic: 0n,
      recognizedRewardBalanceAtomic: 0n,
      totalAnsemLiabilityAtomic: 0n,
      cowboyUnmaterializedLiabilityAtomic: 0n,
      positionClaimableLiabilityAtomic: 0n,
      bullPoolLiabilityAtomic: 0n,
      bullPoolUnallocatedLiabilityAtomic: 0n,
      suitVaultLiabilityAtomic: 0n,
      suitClaimLiabilityAtomic: 0n,
      pendingSolRevenueAtomic: 0n,
      ansemEmittedAtomic: 0n,
      ansemClaimedAtomic: 0n,
      rodeoBurnedAtomic: 0n,
      marketplaceVolumeAtomic: 0n,
      teamRevenueAtomic: 0n,
      securityRevenueAtomic: 0n,
      buybackRevenueAtomic: 0n,
      cowboyRewardIndex: 0n,
      cowboyIndexRemainderScaled: 0n,
      cowboyOrphanedAccrualRemainderScaled: 0n,
      bullRewardPerWeightScaled: 0n,
      bullIndexRemainderScaled: 0n,
      bullOrphanedAccrualRemainderScaled: 0n,
      orphanedRewardReleasedAtomic: 0n,
      suitEpoch: 0n,
      totalCompletedReveals: 0n,
      livePositionCount: 0n,
      activeCowboyCount: 0n,
      activeBullCount: 0n,
      totalActiveCowboyWeight: 0n,
      totalActiveBullPower: 0n,
      positions: new Map(),
      wallets: new Map(),
      suitClaimsByLeaf: new Map(),
      suitClaimedLeaves: new Set(),
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
      case "marketSale":
        this.marketSale(event);
        break;
      case "gift":
        this.gift(event);
        break;
      case "externalRevenue":
        this.externalRevenue(event);
        break;
      case "buyAnsemRewards":
        this.buyAnsemRewards(event);
        break;
      case "recognizeRewards":
        this.recognizeRewards(event);
        break;
      case "directRewardTransfer":
        this.directRewardTransfer(event);
        break;
      case "socialResult":
        this.socialResult(event);
        break;
      case "suitClaim":
        this.suitClaim(event);
        break;
      case "closeEpoch":
        this.closeEpoch(event);
        break;
    }

    this.convertOrphanedRemainders();
    this.state.settledIds.add(event.settlementId);
    this.assertInvariants();
  }

  runway(): RunwayReport {
    const required = this.state.rewardVaultAnsemAtomic / RUNWAY_EPOCHS * RUNWAY_EPOCHS; // placeholder per RUNWAY_EPOCHS
    const free = this.freeAnsem();
    const purchasable = mulDivFloor(this.state.pendingSolRevenueAtomic, this.config.ansemPerSolNumerator, this.config.ansemPerSolDenominator);
    const available = free + purchasable;
    // Simplified runway: count how many consecutive epochs of required average can be covered.
    const avgRequired = this.state.ansemEmittedAtomic > 0n ? this.state.ansemEmittedAtomic / (this.state.epoch > 0n ? this.state.epoch : 1n) : 0n;
    let coveredEpochs = 0n;
    let cumulative = 0n;
    for (let i = 0n; i < RUNWAY_EPOCHS; i += 1n) {
      if (avgRequired === 0n) break;
      if (cumulative + avgRequired > available) break;
      cumulative += avgRequired;
      coveredEpochs += 1n;
    }
    return { requiredAnsemAtomic: avgRequired * RUNWAY_EPOCHS, availableAnsemAtomic: available, covered: available >= avgRequired * RUNWAY_EPOCHS, coveredEpochs };
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
      cowboyKind: { kind: "unassigned" },
      bullTier: 0,
      suit: "unassigned",
      accrualWeight: 0n,
      buckPower: 0,
      openedAt: event.openedAt,
      activeSince: 0n,
      unstakeEligibleAt: 0n,
      lastCowboyRewardIndex: 0n,
      lastBullRewardPerWeight: 0n,
      cowboyAccrualRemainderScaled: 0n,
      bullAccrualRemainderScaled: 0n,
      claimableAnsemAtomic: 0n,
      pendingActionActive: true,
      pendingActionType: "reveal",
      pendingActionNonce: 0n,
      nextActionNonce: 1n,
      settlementNonce: 0n,
      stateVersion: 0n,
    });
    this.state.principalVaultAtomic = checkedAdd(this.state.principalVaultAtomic, amount);
    this.state.accountedPrincipalAtomic = checkedAdd(this.state.accountedPrincipalAtomic, amount);
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

    position.role = event.outcomes.role;
    position.suit = event.outcomes.suit;
    position.status = "active";
    position.pendingActionActive = false;
    position.pendingActionType = null;
    position.settlementNonce = checkedAdd(position.settlementNonce, 1n);
    position.activeSince = this.state.now;
    position.unstakeEligibleAt = checkedAdd(position.activeSince, MIN_STAKE_SECONDS);
    this.state.totalCompletedReveals = checkedAdd(this.state.totalCompletedReveals, 1n);

    // Mint-theft uses a separate reveal-time initial-owner path: it sets the
    // final owner, initializes checkpoints, and would create the receipt
    // directly for that owner. It must not force-settle rewards or transfer a
    // nonexistent receipt.
    if (event.outcomes.mintTheft && event.outcomes.thiefPositionId !== null) {
      const thief = this.position(event.outcomes.thiefPositionId);
      if (thief.role !== "bull") throw new Error("Thief must be a Bull");
      position.owner = thief.owner;
    }

    if (event.outcomes.role === "cowboy") {
      if (event.outcomes.isDesperado) {
        position.cowboyKind = { kind: "desperado" };
        position.accrualWeight = DESPERADO_ACCRUAL_WEIGHT;
      } else {
        const rank = event.outcomes.cowboyRank as CowboyRank;
        position.cowboyKind = { kind: "rank", rank };
        position.accrualWeight = COWBOY_ACCRUAL_WEIGHTS[rank];
      }
      this.state.activeCowboyCount = checkedAdd(this.state.activeCowboyCount, 1n);
      this.state.totalActiveCowboyWeight = checkedAdd(this.state.totalActiveCowboyWeight, position.accrualWeight);
      position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
      position.cowboyAccrualRemainderScaled = 0n;
      position.lastBullRewardPerWeight = 0n;
      position.bullAccrualRemainderScaled = 0n;
    } else if (event.outcomes.role === "bull") {
      const tier = event.outcomes.bullTier as BullTier;
      position.bullTier = BULL_BUCK_POWER[tier];
      position.buckPower = BULL_BUCK_POWER[tier];
      this.state.activeBullCount = checkedAdd(this.state.activeBullCount, 1n);
      this.state.totalActiveBullPower = checkedAdd(this.state.totalActiveBullPower, BigInt(position.buckPower));
      position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
      position.bullAccrualRemainderScaled = 0n;
      position.lastCowboyRewardIndex = 0n;
      position.cowboyAccrualRemainderScaled = 0n;
      this.allocateBullPoolUnallocated();
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

    const ownerBps = isDesperado(position) ? DESPERADO_CLAIM_OWNER_BPS : CLAIM_OWNER_BPS;
    const bullBps = isDesperado(position) ? DESPERADO_CLAIM_BULL_POOL_BPS : CLAIM_BULL_POOL_BPS;
    const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
    const bullAmount = checkedSub(claimable, ownerAmount);

    position.claimableAnsemAtomic = 0n;
    this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, ownerAmount);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
    this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, ownerAmount);
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
    this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, claimable);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, claimable);
    this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, claimable);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, claimable);
    wallet.lastClaimedAt = event.claimedAt;
  }

  private requestUnstake(event: Extract<SimulationEvent, { type: "requestUnstake" }>): void {
    const position = this.position(event.positionId);
    if (position.status !== "active") throw new Error("Position is not active");
    if (position.pendingActionActive) throw new Error("Position already has a pending action");
    if (event.requestedAt < position.unstakeEligibleAt) throw new Error("Minimum stake period not met");
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

    const principal = position.principalAtomic;
    const returned = mulDivFloor(principal, UNSTAKE_RETURN_BPS, BPS_DENOMINATOR);
    const burned = checkedSub(principal, returned);

    this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, principal);
    this.state.accountedPrincipalAtomic = checkedSub(this.state.accountedPrincipalAtomic, principal);
    this.state.rodeoBurnedAtomic = checkedAdd(this.state.rodeoBurnedAtomic, burned);
    this.state.livePositionCount = checkedSub(this.state.livePositionCount, 1n);
    if (position.role === "cowboy") {
      this.state.activeCowboyCount = checkedSub(this.state.activeCowboyCount, 1n);
      this.state.totalActiveCowboyWeight = checkedSub(this.state.totalActiveCowboyWeight, position.accrualWeight);
    } else if (position.role === "bull") {
      this.state.activeBullCount = checkedSub(this.state.activeBullCount, 1n);
      this.state.totalActiveBullPower = checkedSub(this.state.totalActiveBullPower, BigInt(position.buckPower));
    }

    if (position.role === "cowboy" && !isDesperado(position)) {
      const pending = position.claimableAnsemAtomic;
      if (pending > 0n) {
        this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, pending);
        if (event.fate.ansemToBullPool) {
          this.distributeToBullPool(pending);
        } else {
          this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, pending);
          this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, pending);
          this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, pending);
          this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, pending);
        }
        position.claimableAnsemAtomic = 0n;
      }
    } else if (position.role === "bull" || isDesperado(position)) {
      const pending = position.claimableAnsemAtomic;
      if (pending > 0n) {
        this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, pending);
        this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, pending);
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, pending);
        this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, pending);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, pending);
        position.claimableAnsemAtomic = 0n;
      }
    }

    // Move any sub-atomic per-position carry into the global orphaned remainder
    // before the Position account is closed.
    if (position.role === "cowboy") {
      this.state.cowboyOrphanedAccrualRemainderScaled = checkedAdd(
        this.state.cowboyOrphanedAccrualRemainderScaled,
        position.cowboyAccrualRemainderScaled
      );
    } else if (position.role === "bull") {
      this.state.bullOrphanedAccrualRemainderScaled = checkedAdd(
        this.state.bullOrphanedAccrualRemainderScaled,
        position.bullAccrualRemainderScaled
      );
    }

    position.principalAtomic = 0n;
    this.state.positions.delete(position.id);
  }

  private marketSale(event: Extract<SimulationEvent, { type: "marketSale" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot sell while a randomness action is pending");
    if (position.status !== "active") throw new Error("Position is not active");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    this.forceSettleRewards(position, event.claimedAt);
    const fee = mulDivFloor(event.priceLamports, MARKETPLACE_FEE_BPS, BPS_DENOMINATOR);
    this.state.marketplaceVolumeAtomic = checkedAdd(this.state.marketplaceVolumeAtomic, event.priceLamports);
    this.externalRevenue({ type: "externalRevenue", settlementId: `internal-market-${event.settlementId}`, revenueLamports: fee });

    this.transferOwnership(position, "buyer");
    position.unstakeEligibleAt = checkedAdd(this.state.now, MIN_STAKE_SECONDS);
  }

  private gift(event: Extract<SimulationEvent, { type: "gift" }>): void {
    const position = this.position(event.positionId);
    if (position.pendingActionActive) throw new Error("Cannot gift while a randomness action is pending");
    if (position.status !== "active") throw new Error("Position is not active");
    this.ensureEpochsCurrent();
    this.applyCowboyRewardDelta(position);
    this.applyBullRewardDelta(position);

    this.forceSettleRewards(position, event.claimedAt);
    this.transferOwnership(position, event.newOwner);
    position.unstakeEligibleAt = checkedAdd(this.state.now, MIN_STAKE_SECONDS);
  }

  private externalRevenue(event: Extract<SimulationEvent, { type: "externalRevenue" }>): void {
    const ansemBudget = mulDivFloor(event.revenueLamports, REVENUE_ANSEM_BPS, BPS_DENOMINATOR);
    const team = mulDivFloor(event.revenueLamports, REVENUE_TEAM_BPS, BPS_DENOMINATOR);
    const security = mulDivFloor(event.revenueLamports, REVENUE_SECURITY_BPS, BPS_DENOMINATOR);
    const buyback = mulDivFloor(event.revenueLamports, REVENUE_BUYBACK_BPS, BPS_DENOMINATOR);
    const spent = checkedAdd(checkedAdd(checkedAdd(team, security), buyback), ansemBudget);
    const dust = event.revenueLamports >= spent ? checkedSub(event.revenueLamports, spent) : 0n;

    this.state.pendingSolRevenueAtomic = checkedAdd(this.state.pendingSolRevenueAtomic, checkedAdd(ansemBudget, dust));
    this.state.teamRevenueAtomic = checkedAdd(this.state.teamRevenueAtomic, team);
    this.state.securityRevenueAtomic = checkedAdd(this.state.securityRevenueAtomic, security);
    this.state.buybackRevenueAtomic = checkedAdd(this.state.buybackRevenueAtomic, buyback);
  }

  private buyAnsemRewards(event: Extract<SimulationEvent, { type: "buyAnsemRewards" }>): void {
    const solCost = mulDivCeil(event.ansemAtomic, this.config.ansemPerSolDenominator, this.config.ansemPerSolNumerator);
    if (solCost > this.state.pendingSolRevenueAtomic) throw new Error("Insufficient SOL revenue to buy ANSEM");
    this.state.pendingSolRevenueAtomic = checkedSub(this.state.pendingSolRevenueAtomic, solCost);
    this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, event.ansemAtomic);
  }

  private unrecognizedRewardSurplus(): bigint {
    return this.state.rewardVaultAnsemAtomic >= this.state.recognizedRewardBalanceAtomic
      ? checkedSub(this.state.rewardVaultAnsemAtomic, this.state.recognizedRewardBalanceAtomic)
      : 0n;
  }

  private recognizeRewards(event: Extract<SimulationEvent, { type: "recognizeRewards" }>): void {
    this.ensureEpochsCurrent();
    const surplus = this.unrecognizedRewardSurplus();
    const amount = event.ansemAtomic > surplus ? surplus : event.ansemAtomic;
    if (amount <= 0n) throw new Error("No unrecognized rewards to recognize");
    const newRecognized = checkedAdd(this.state.recognizedRewardBalanceAtomic, amount);
    if (newRecognized > this.state.rewardVaultAnsemAtomic) throw new Error("Recognized balance cannot exceed vault");
    this.state.recognizedRewardBalanceAtomic = newRecognized;
  }

  private directRewardTransfer(event: Extract<SimulationEvent, { type: "directRewardTransfer" }>): void {
    this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, event.ansemAtomic);
  }

  private socialResult(event: Extract<SimulationEvent, { type: "socialResult" }>): void {
    this.ensureEpochsCurrent();
    if (event.competitionEpoch !== this.state.suitEpoch) {
      throw new Error("Social result competition epoch does not match current suit epoch");
    }
    let total = 0n;
    for (const leaf of event.claims) {
      if (leaf.amount <= 0n) throw new Error("Suit claim leaf amount must be positive");
      const key = `${event.competitionEpoch}-${leaf.leafNonce}`;
      if (this.state.suitClaimsByLeaf.has(key)) throw new Error("Duplicate suit claim leaf nonce in result");
      this.state.suitClaimsByLeaf.set(key, leaf.amount);
      total = checkedAdd(total, leaf.amount);
    }
    if (total > this.state.suitVaultLiabilityAtomic) {
      throw new Error("Social result claims exceed suit vault liability");
    }
    this.state.suitVaultLiabilityAtomic = checkedSub(this.state.suitVaultLiabilityAtomic, total);
    this.state.suitClaimLiabilityAtomic = checkedAdd(this.state.suitClaimLiabilityAtomic, total);
  }

  private suitClaim(event: Extract<SimulationEvent, { type: "suitClaim" }>): void {
    this.ensureEpochsCurrent();
    const key = `${event.competitionEpoch}-${event.leaf.leafNonce}`;
    if (this.state.suitClaimedLeaves.has(key)) throw new Error("Suit claim already used");
    const amount = this.state.suitClaimsByLeaf.get(key);
    if (amount === undefined) throw new Error("Suit claim leaf not found");
    if (amount !== event.leaf.amount) throw new Error("Suit claim amount mismatch");
    this.state.suitClaimedLeaves.add(key);
    this.state.suitClaimLiabilityAtomic = checkedSub(this.state.suitClaimLiabilityAtomic, amount);
    this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, amount);
    this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, amount);
    this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, amount);
    this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, amount);
  }

  private closeEpoch(event: Extract<SimulationEvent, { type: "closeEpoch" }>): void {
    this.state.now = event.now;
    const maxEpochs = event.count ?? CLOSE_EPOCH_BATCH_MAX;
    const elapsed = this.elapsedEpochs();
    const toClose = elapsed < maxEpochs ? elapsed : maxEpochs;

    for (let i = 0n; i < toClose; i += 1n) {
      if (this.state.now < this.state.launchTimestamp + POT_FILL_SECONDS) {
        // No emission during pot-fill; still advance epoch boundaries.
      } else {
        const free = this.freeAnsem();
        const emission = free / RUNWAY_EPOCHS;

        if (emission > 0n) {
          const cowboyEmission = mulDivFloor(emission, EMISSION_COWBOY_BPS, BPS_DENOMINATOR);
          const suitContribution = checkedSub(emission, cowboyEmission);

          if (this.state.totalActiveCowboyWeight > 0n) {
            this.state.cowboyUnmaterializedLiabilityAtomic = checkedAdd(
              this.state.cowboyUnmaterializedLiabilityAtomic,
              cowboyEmission
            );
            this.state.totalAnsemLiabilityAtomic = checkedAdd(this.state.totalAnsemLiabilityAtomic, cowboyEmission);

            const numerator = cowboyEmission * COWBOY_REWARD_INDEX_SCALE + this.state.cowboyIndexRemainderScaled;
            const indexIncrement = numerator / this.state.totalActiveCowboyWeight;
            this.state.cowboyIndexRemainderScaled = numerator % this.state.totalActiveCowboyWeight;
            this.state.cowboyRewardIndex += indexIncrement;
          }

          this.state.suitVaultLiabilityAtomic = checkedAdd(this.state.suitVaultLiabilityAtomic, suitContribution);
          this.state.totalAnsemLiabilityAtomic = checkedAdd(this.state.totalAnsemLiabilityAtomic, suitContribution);

          this.state.ansemEmittedAtomic = checkedAdd(this.state.ansemEmittedAtomic, emission);
        }
      }

      this.state.epoch = checkedAdd(this.state.epoch, 1n);
      this.state.epochStartedAt = checkedAdd(this.state.epochStartedAt, EPOCH_DURATION_SECONDS);
      if (this.state.epoch % SUIT_EPOCHS === 0n) {
        this.state.suitEpoch = checkedAdd(this.state.suitEpoch, 1n);
      }
    }
  }

  private applyCowboyRewardDelta(position: PositionState): void {
    if (position.role !== "cowboy" || position.accrualWeight === 0n) return;
    const deltaIndex = checkedSub(this.state.cowboyRewardIndex, position.lastCowboyRewardIndex);
    if (deltaIndex === 0n) return;
    const numerator = deltaIndex * position.accrualWeight + position.cowboyAccrualRemainderScaled;
    const accrued = numerator / COWBOY_REWARD_INDEX_SCALE;
    position.cowboyAccrualRemainderScaled = numerator % COWBOY_REWARD_INDEX_SCALE;
    // Advance the checkpoint even when the sync yields zero whole atoms so the
    // sub-atomic carry is not double-counted by a later sync.
    position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
    if (accrued === 0n) return;
    if (accrued > this.state.cowboyUnmaterializedLiabilityAtomic) {
      throw new Error("Cowboy accrual exceeds unmaterialized liability");
    }
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, accrued);
    this.state.cowboyUnmaterializedLiabilityAtomic = checkedSub(this.state.cowboyUnmaterializedLiabilityAtomic, accrued);
    this.state.positionClaimableLiabilityAtomic = checkedAdd(this.state.positionClaimableLiabilityAtomic, accrued);
  }

  private applyBullRewardDelta(position: PositionState): void {
    if (position.role !== "bull" || position.buckPower === 0) return;
    const delta = checkedSub(this.state.bullRewardPerWeightScaled, position.lastBullRewardPerWeight);
    if (delta === 0n) return;
    const numerator = delta * BigInt(position.buckPower) + position.bullAccrualRemainderScaled;
    const reward = numerator / REWARD_PER_WEIGHT_SCALE;
    position.bullAccrualRemainderScaled = numerator % REWARD_PER_WEIGHT_SCALE;
    position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
    if (reward === 0n) return;
    if (reward > this.state.bullPoolLiabilityAtomic) {
      throw new Error("Bull accrual exceeds bull pool liability");
    }
    position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, reward);
    this.state.bullPoolLiabilityAtomic = checkedSub(this.state.bullPoolLiabilityAtomic, reward);
    this.state.positionClaimableLiabilityAtomic = checkedAdd(this.state.positionClaimableLiabilityAtomic, reward);
  }

  private distributeToBullPool(amount: bigint): void {
    if (amount === 0n) return;
    if (this.state.totalActiveBullPower === 0n) {
      this.state.bullPoolUnallocatedLiabilityAtomic = checkedAdd(this.state.bullPoolUnallocatedLiabilityAtomic, amount);
      return;
    }
    this.state.bullPoolLiabilityAtomic = checkedAdd(this.state.bullPoolLiabilityAtomic, amount);
    const numerator = amount * REWARD_PER_WEIGHT_SCALE + this.state.bullIndexRemainderScaled;
    const increment = numerator / this.state.totalActiveBullPower;
    this.state.bullIndexRemainderScaled = numerator % this.state.totalActiveBullPower;
    this.state.bullRewardPerWeightScaled += increment;
  }

  private allocateBullPoolUnallocated(): void {
    const amount = this.state.bullPoolUnallocatedLiabilityAtomic;
    if (amount === 0n || this.state.totalActiveBullPower === 0n) return;
    this.state.bullPoolUnallocatedLiabilityAtomic = 0n;
    this.state.bullPoolLiabilityAtomic = checkedAdd(this.state.bullPoolLiabilityAtomic, amount);
    const numerator = amount * REWARD_PER_WEIGHT_SCALE + this.state.bullIndexRemainderScaled;
    const increment = numerator / this.state.totalActiveBullPower;
    this.state.bullIndexRemainderScaled = numerator % this.state.totalActiveBullPower;
    this.state.bullRewardPerWeightScaled += increment;
  }

  private forceSettleRewards(position: PositionState, claimedAt: bigint): void {
    const claimable = position.claimableAnsemAtomic;
    if (claimable > 0n) {
      this.state.positionClaimableLiabilityAtomic = checkedSub(this.state.positionClaimableLiabilityAtomic, claimable);
      if (position.role === "bull") {
        this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, claimable);
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, claimable);
        this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, claimable);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, claimable);
      } else if (position.role === "cowboy") {
        const ownerBps = isDesperado(position) ? DESPERADO_CLAIM_OWNER_BPS : CLAIM_OWNER_BPS;
        const bullBps = isDesperado(position) ? DESPERADO_CLAIM_BULL_POOL_BPS : CLAIM_BULL_POOL_BPS;
        const ownerAmount = mulDivFloor(claimable, ownerBps, BPS_DENOMINATOR);
        const bullAmount = checkedSub(claimable, ownerAmount);
        this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, ownerAmount);
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, ownerAmount);
        this.state.recognizedRewardBalanceAtomic = checkedSub(this.state.recognizedRewardBalanceAtomic, ownerAmount);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, ownerAmount);
        this.distributeToBullPool(bullAmount);
      }
      position.claimableAnsemAtomic = 0n;
    }
    const wallet = this.wallet(position.owner);
    wallet.lastClaimedAt = claimedAt;
  }

  private transferOwnership(position: PositionState, newOwner: string): void {
    position.owner = newOwner;
    position.stateVersion = checkedAdd(position.stateVersion, 1n);
    // Reset the new owner's global checkpoints to the current indices while
    // preserving the role-appropriate sub-atomic carry that follows the Position.
    if (position.role === "cowboy") {
      position.lastCowboyRewardIndex = this.state.cowboyRewardIndex;
      position.cowboyAccrualRemainderScaled = position.cowboyAccrualRemainderScaled;
      position.lastBullRewardPerWeight = 0n;
      position.bullAccrualRemainderScaled = 0n;
    } else if (position.role === "bull") {
      position.lastBullRewardPerWeight = this.state.bullRewardPerWeightScaled;
      position.bullAccrualRemainderScaled = position.bullAccrualRemainderScaled;
      position.lastCowboyRewardIndex = 0n;
      position.cowboyAccrualRemainderScaled = 0n;
    }
  }

  private convertOrphanedRemainders(): void {
    const cowboyScale = COWBOY_REWARD_INDEX_SCALE;
    const cowboyWhole = this.state.cowboyOrphanedAccrualRemainderScaled / cowboyScale;
    if (cowboyWhole > 0n) {
      if (cowboyWhole > this.state.cowboyUnmaterializedLiabilityAtomic) {
        throw new Error("Cowboy orphaned conversion would underflow unmaterialized liability");
      }
      this.state.cowboyUnmaterializedLiabilityAtomic = checkedSub(
        this.state.cowboyUnmaterializedLiabilityAtomic,
        cowboyWhole
      );
      this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, cowboyWhole);
      this.state.cowboyOrphanedAccrualRemainderScaled -= cowboyWhole * cowboyScale;
      this.state.orphanedRewardReleasedAtomic = checkedAdd(this.state.orphanedRewardReleasedAtomic, cowboyWhole);
    }

    const bullScale = REWARD_PER_WEIGHT_SCALE;
    const bullWhole = this.state.bullOrphanedAccrualRemainderScaled / bullScale;
    if (bullWhole > 0n) {
      if (bullWhole > this.state.bullPoolLiabilityAtomic) {
        throw new Error("Bull orphaned conversion would underflow bull pool liability");
      }
      this.state.bullPoolLiabilityAtomic = checkedSub(this.state.bullPoolLiabilityAtomic, bullWhole);
      this.state.totalAnsemLiabilityAtomic = checkedSub(this.state.totalAnsemLiabilityAtomic, bullWhole);
      this.state.bullOrphanedAccrualRemainderScaled -= bullWhole * bullScale;
      this.state.orphanedRewardReleasedAtomic = checkedAdd(this.state.orphanedRewardReleasedAtomic, bullWhole);
    }
  }

  private freeAnsem(): bigint {
    const recognized = this.state.recognizedRewardBalanceAtomic < this.state.rewardVaultAnsemAtomic
      ? this.state.recognizedRewardBalanceAtomic
      : this.state.rewardVaultAnsemAtomic;
    const free = this.state.totalAnsemLiabilityAtomic < recognized
      ? checkedSub(recognized, this.state.totalAnsemLiabilityAtomic)
      : 0n;
    return free;
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
    if (reconciledPrincipal !== this.state.accountedPrincipalAtomic) throw new Error("Accounted principal does not reconcile");
    if (this.state.principalVaultAtomic < this.state.accountedPrincipalAtomic) throw new Error("Actual principal vault below accounted principal");
    if (reconciledClaimable !== this.state.positionClaimableLiabilityAtomic) throw new Error("Position claimable liability does not reconcile");
    if (cowboyWeight !== this.state.totalActiveCowboyWeight) throw new Error("Active cowboy weight does not reconcile");
    if (bullPower !== this.state.totalActiveBullPower) throw new Error("Active bull power does not reconcile");

    const expectedSurplus = this.state.principalVaultAtomic >= this.state.accountedPrincipalAtomic
      ? checkedSub(this.state.principalVaultAtomic, this.state.accountedPrincipalAtomic)
      : 0n;
    if (expectedSurplus !== this.state.principalVaultSurplusAtomic) {
      // Re-derive surplus lazily for compatibility.
      this.state.principalVaultSurplusAtomic = expectedSurplus;
    }

    const expectedLiability = checkedAdd(
      checkedAdd(
        checkedAdd(this.state.cowboyUnmaterializedLiabilityAtomic, this.state.positionClaimableLiabilityAtomic),
        this.state.bullPoolLiabilityAtomic
      ),
      checkedAdd(
        checkedAdd(this.state.bullPoolUnallocatedLiabilityAtomic, this.state.suitVaultLiabilityAtomic),
        this.state.suitClaimLiabilityAtomic
      )
    );
    if (expectedLiability !== this.state.totalAnsemLiabilityAtomic) throw new Error("Total ANSEM liability does not reconcile");

    if (this.state.recognizedRewardBalanceAtomic > this.state.rewardVaultAnsemAtomic) {
      throw new Error("Recognized reward balance exceeds actual vault");
    }
    const recognized = this.state.recognizedRewardBalanceAtomic < this.state.rewardVaultAnsemAtomic
      ? this.state.recognizedRewardBalanceAtomic
      : this.state.rewardVaultAnsemAtomic;
    if (this.state.totalAnsemLiabilityAtomic > recognized) throw new Error("ANSEM liabilities exceed recognized reward balance");
  }
}
