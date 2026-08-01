import { EPOCH_DURATION_SECONDS, RUNWAY_EPOCHS, RUNWAY_WINDOW_SECONDS } from "@rodeo/protocol-definition";
import { checkedAdd, checkedSub, mulDivCeil, mulDivFloor } from "@rodeo/shared";

export type Role = "cowboy" | "bull";

export interface PositionState {
  readonly id: string;
  owner: string;
  principalAtomic: bigint;
  role: Role;
  claimableAnsemAtomic: bigint;
}

export interface SimulatorConfig {
  readonly epochDurationSeconds: bigint;
  readonly runwayWindowSeconds: bigint;
  readonly emissionTargetByEpoch: readonly bigint[];
  readonly ansemPerRevenueNumerator: bigint;
  readonly ansemPerRevenueDenominator: bigint;
}

export interface SimulationState {
  epoch: bigint;
  principalVaultAtomic: bigint;
  rewardVaultAnsemAtomic: bigint;
  ansemLiabilityAtomic: bigint;
  feeRevenueAtomic: bigint;
  protocolRevenueAtomic: bigint;
  marketplaceVolumeAtomic: bigint;
  ansemEmittedAtomic: bigint;
  ansemClaimedAtomic: bigint;
  rodeoBurnedAtomic: bigint;
  cowboyPopulation: bigint;
  bullPopulation: bigint;
  positions: Map<string, PositionState>;
  settledIds: Set<string>;
}

export type SimulationEvent =
  | { readonly type: "stake"; readonly settlementId: string; readonly positionId: string; readonly owner: string; readonly role: Role; readonly principalAtomic: bigint }
  | { readonly type: "claim"; readonly settlementId: string; readonly positionId: string; readonly amountAtomic: bigint }
  | { readonly type: "unstake"; readonly settlementId: string; readonly positionId: string; readonly principalAtomic: bigint }
  | { readonly type: "reroll"; readonly settlementId: string; readonly positionId: string; readonly feeRevenueAtomic: bigint; readonly burnedPrincipalAtomic: bigint }
  | { readonly type: "burn"; readonly settlementId: string; readonly positionId: string; readonly principalAtomic: bigint }
  | { readonly type: "theft"; readonly settlementId: string; readonly fromPositionId: string; readonly toPositionId: string; readonly principalAtomic: bigint }
  | { readonly type: "marketSale"; readonly settlementId: string; readonly volumeAtomic: bigint; readonly protocolRevenueAtomic: bigint }
  | { readonly type: "fundRewards"; readonly settlementId: string; readonly ansemAtomic: bigint }
  | { readonly type: "allocateReward"; readonly settlementId: string; readonly positionId: string; readonly ansemAtomic: bigint }
  | { readonly type: "transferPosition"; readonly settlementId: string; readonly positionId: string; readonly newOwner: string }
  | { readonly type: "closeEpoch"; readonly settlementId: string };

export interface RunwayReport {
  readonly requiredAnsemAtomic: bigint;
  readonly availableAnsemAtomic: bigint;
  readonly covered: boolean;
  readonly coveredEpochs: bigint;
}

export function createSimulatorConfig(config: SimulatorConfig): SimulatorConfig {
  if (config.epochDurationSeconds !== EPOCH_DURATION_SECONDS) throw new RangeError("Phase 0 epochs must be six hours");
  if (config.runwayWindowSeconds !== RUNWAY_WINDOW_SECONDS) throw new RangeError("Phase 0 runway must be ten days");
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
      epoch: 0n,
      principalVaultAtomic: 0n,
      rewardVaultAnsemAtomic: 0n,
      ansemLiabilityAtomic: 0n,
      feeRevenueAtomic: 0n,
      protocolRevenueAtomic: 0n,
      marketplaceVolumeAtomic: 0n,
      ansemEmittedAtomic: 0n,
      ansemClaimedAtomic: 0n,
      rodeoBurnedAtomic: 0n,
      cowboyPopulation: 0n,
      bullPopulation: 0n,
      positions: new Map(),
      settledIds: new Set(),
    };
  }

  apply(event: SimulationEvent): void {
    if (this.state.settledIds.has(event.settlementId)) throw new Error(`Duplicate settlement: ${event.settlementId}`);
    this.validateNonNegative(event);

    switch (event.type) {
      case "stake": {
        if (this.state.positions.has(event.positionId)) throw new Error(`Position already exists: ${event.positionId}`);
        this.state.positions.set(event.positionId, {
          id: event.positionId,
          owner: event.owner,
          principalAtomic: event.principalAtomic,
          role: event.role,
          claimableAnsemAtomic: 0n,
        });
        this.state.principalVaultAtomic = checkedAdd(this.state.principalVaultAtomic, event.principalAtomic);
        this.adjustPopulation(event.role, 1n);
        break;
      }
      case "claim": {
        const position = this.position(event.positionId);
        position.claimableAnsemAtomic = checkedSub(position.claimableAnsemAtomic, event.amountAtomic);
        this.state.ansemLiabilityAtomic = checkedSub(this.state.ansemLiabilityAtomic, event.amountAtomic);
        this.state.rewardVaultAnsemAtomic = checkedSub(this.state.rewardVaultAnsemAtomic, event.amountAtomic);
        this.state.ansemClaimedAtomic = checkedAdd(this.state.ansemClaimedAtomic, event.amountAtomic);
        break;
      }
      case "unstake": {
        const position = this.position(event.positionId);
        position.principalAtomic = checkedSub(position.principalAtomic, event.principalAtomic);
        this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, event.principalAtomic);
        if (position.principalAtomic === 0n) {
          this.state.positions.delete(position.id);
          this.adjustPopulation(position.role, -1n);
        }
        break;
      }
      case "reroll": {
        const position = this.position(event.positionId);
        position.principalAtomic = checkedSub(position.principalAtomic, event.burnedPrincipalAtomic);
        this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, event.burnedPrincipalAtomic);
        this.state.rodeoBurnedAtomic = checkedAdd(this.state.rodeoBurnedAtomic, event.burnedPrincipalAtomic);
        this.state.feeRevenueAtomic = checkedAdd(this.state.feeRevenueAtomic, event.feeRevenueAtomic);
        break;
      }
      case "burn": {
        const position = this.position(event.positionId);
        position.principalAtomic = checkedSub(position.principalAtomic, event.principalAtomic);
        this.state.principalVaultAtomic = checkedSub(this.state.principalVaultAtomic, event.principalAtomic);
        this.state.rodeoBurnedAtomic = checkedAdd(this.state.rodeoBurnedAtomic, event.principalAtomic);
        break;
      }
      case "theft": {
        const victim = this.position(event.fromPositionId);
        const recipient = this.position(event.toPositionId);
        victim.principalAtomic = checkedSub(victim.principalAtomic, event.principalAtomic);
        recipient.principalAtomic = checkedAdd(recipient.principalAtomic, event.principalAtomic);
        break;
      }
      case "marketSale":
        this.state.marketplaceVolumeAtomic = checkedAdd(this.state.marketplaceVolumeAtomic, event.volumeAtomic);
        this.state.protocolRevenueAtomic = checkedAdd(this.state.protocolRevenueAtomic, event.protocolRevenueAtomic);
        this.state.feeRevenueAtomic = checkedAdd(this.state.feeRevenueAtomic, event.protocolRevenueAtomic);
        break;
      case "fundRewards":
        this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, event.ansemAtomic);
        break;
      case "allocateReward": {
        const position = this.position(event.positionId);
        const unencumbered = checkedSub(this.state.rewardVaultAnsemAtomic, this.state.ansemLiabilityAtomic);
        if (event.ansemAtomic > unencumbered) throw new Error("ANSEM allocation is not vault-backed");
        position.claimableAnsemAtomic = checkedAdd(position.claimableAnsemAtomic, event.ansemAtomic);
        this.state.ansemLiabilityAtomic = checkedAdd(this.state.ansemLiabilityAtomic, event.ansemAtomic);
        break;
      }
      case "transferPosition":
        this.position(event.positionId).owner = event.newOwner;
        break;
      case "closeEpoch":
        this.closeEpoch();
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
    const purchasable = mulDivFloor(
      this.state.feeRevenueAtomic,
      this.config.ansemPerRevenueNumerator,
      this.config.ansemPerRevenueDenominator,
    );
    const available = unencumberedVault + purchasable;
    let cumulative = 0n;
    let coveredEpochs = 0n;
    for (const target of targets) {
      if (cumulative + target > available) break;
      cumulative += target;
      coveredEpochs += 1n;
    }
    return { requiredAnsemAtomic: required, availableAnsemAtomic: available, covered: available >= required, coveredEpochs };
  }

  assertInvariants(): void {
    const reconciledPrincipal = [...this.state.positions.values()].reduce((sum, position) => sum + position.principalAtomic, 0n);
    if (reconciledPrincipal !== this.state.principalVaultAtomic) throw new Error("RODEO principal does not reconcile");
    const reconciledLiability = [...this.state.positions.values()].reduce((sum, position) => sum + position.claimableAnsemAtomic, 0n);
    if (reconciledLiability !== this.state.ansemLiabilityAtomic) throw new Error("ANSEM liabilities do not reconcile");
    if (this.state.rewardVaultAnsemAtomic < this.state.ansemLiabilityAtomic) throw new Error("ANSEM liabilities are not vault-backed");
  }

  private closeEpoch(): void {
    const target = this.config.emissionTargetByEpoch[Number(this.state.epoch)];
    if (target === undefined) throw new Error(`Missing emission target for epoch ${this.state.epoch}`);
    const purchasable = mulDivFloor(
      this.state.feeRevenueAtomic,
      this.config.ansemPerRevenueNumerator,
      this.config.ansemPerRevenueDenominator,
    );
    const emitted = target < purchasable ? target : purchasable;
    const revenueSpent = mulDivCeil(
      emitted,
      this.config.ansemPerRevenueDenominator,
      this.config.ansemPerRevenueNumerator,
    );
    this.state.feeRevenueAtomic = checkedSub(this.state.feeRevenueAtomic, revenueSpent);
    this.state.rewardVaultAnsemAtomic = checkedAdd(this.state.rewardVaultAnsemAtomic, emitted);
    this.state.ansemEmittedAtomic = checkedAdd(this.state.ansemEmittedAtomic, emitted);
    this.state.epoch += 1n;
  }

  private position(id: string): PositionState {
    const position = this.state.positions.get(id);
    if (!position) throw new Error(`Unknown position: ${id}`);
    return position;
  }

  private adjustPopulation(role: Role, delta: bigint): void {
    if (role === "cowboy") this.state.cowboyPopulation += delta;
    else this.state.bullPopulation += delta;
  }

  private validateNonNegative(event: SimulationEvent): void {
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === "bigint" && value < 0n) throw new RangeError(`${key} cannot be negative`);
    }
  }
}
