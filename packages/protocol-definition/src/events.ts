export interface ProtocolEventEnvelope<Name extends string, Data> {
  readonly id: string;
  readonly epoch: bigint;
  readonly name: Name;
  readonly data: Data;
}

export type ProtocolInitializedEvent = {
  readonly name: "protocolInitialized";
  readonly globalConfig: string;
  readonly rewardState: string;
  readonly globalGameState: string;
  readonly bullAccumulator: string;
  readonly rodeoMint: string;
  readonly ansemMint: string;
  readonly rodeoDecimals: number;
  readonly ansemDecimals: number;
  readonly stakeAmountAtomic: bigint;
  readonly expectedTotalSupplyAtomic: bigint;
  readonly launchTimestamp: bigint;
  readonly principalVault: string;
  readonly rewardVault: string;
  readonly upgradeCouncil: string;
  readonly treasuryCouncil: string;
  readonly emergencyGuardians: string;
};

export type PositionStakedEvent = ProtocolEventEnvelope<"positionStaked", {
  readonly position: string;
  readonly owner: string;
  readonly principalAtomic: bigint;
  readonly commitment: Uint8Array;
}>;

export type MockRandomnessRevealedEvent = ProtocolEventEnvelope<"mockRandomnessRevealed", {
  readonly position: string;
  readonly owner: string;
  readonly randomness: Uint8Array;
  readonly settlementNonce: bigint;
}>;

export type PositionRevealedEvent = ProtocolEventEnvelope<"positionRevealed", {
  readonly position: string;
  readonly role: "cowboy" | "bull";
  readonly cowboyKind: string;
  readonly bullTier: number;
  readonly suit: string;
  readonly finalOwner: string;
  readonly previousOwner: string | null;
  readonly stolen: boolean;
  readonly receiptAsset: string;
  readonly activeSince: bigint;
  readonly unstakeEligibleAt: bigint;
  readonly settlementNonce: bigint;
}>;

export type PositionSoldEvent = ProtocolEventEnvelope<"positionSold", {
  readonly position: string;
  readonly seller: string;
  readonly buyer: string;
  readonly priceLamports: bigint;
  readonly feeLamports: bigint;
}>;

export type PositionGiftedEvent = ProtocolEventEnvelope<"positionGifted", {
  readonly position: string;
  readonly from: string;
  readonly to: string;
}>;

export type RewardFundingRecognizedEvent = ProtocolEventEnvelope<"rewardFundingRecognized", {
  readonly amountAtomic: bigint;
  readonly recognizedRewardBalanceAtomic: bigint;
  readonly actualRewardVaultBalance: bigint;
}>;

export type RewardPaidReason =
  | "cowboyClaim"
  | "desperadoClaim"
  | "bullClaim"
  | "unstakeSettlement"
  | "suitReward";

export type RewardPaidEvent = ProtocolEventEnvelope<"rewardPaid", {
  readonly position: string;
  readonly owner: string;
  readonly amountAtomic: bigint;
  readonly recognizedRewardBalanceAtomic: bigint;
  readonly reason: RewardPaidReason;
}>;

export type SuitRewardClaimedEvent = ProtocolEventEnvelope<"suitRewardClaimed", {
  readonly competitionEpoch: bigint;
  readonly position: string;
  readonly ownerAtSnapshot: string;
  readonly amountAtomic: bigint;
  readonly leafNonce: bigint;
}>;

export type ReceiptCreatedEvent = ProtocolEventEnvelope<"receiptCreated", {
  readonly asset: string;
  readonly position: string;
  readonly owner: string;
}>;

export type ReceiptBurnedEvent = ProtocolEventEnvelope<"receiptBurned", {
  readonly asset: string;
  readonly position: string;
  readonly owner: string;
}>;

export type EpochClosedEvent = ProtocolEventEnvelope<"epochClosed", {
  readonly epoch: bigint;
  readonly cowboyEmission: bigint;
  readonly suitVaultContribution: bigint;
  readonly freeAnsem: bigint;
  readonly totalCowboyWeight: bigint;
  readonly totalBullPower: bigint;
  readonly recognizedRewardBalanceAtomic: bigint;
  readonly totalAnsemLiabilityAtomic: bigint;
  readonly snapshotTimestamp: bigint;
}>;

export type EpochsClosedEvent = ProtocolEventEnvelope<"epochsClosed", {
  readonly startEpoch: bigint;
  readonly endEpoch: bigint;
  readonly epochsProcessed: bigint;
  readonly lastClosedTimestamp: bigint;
}>;

export type PositionClaimedEvent = ProtocolEventEnvelope<"positionClaimed", {
  readonly position: string;
  readonly owner: string;
  readonly ownerAmount: bigint;
  readonly bullPoolAmount: bigint;
}>;

export type BullPoolSource =
  | "cowboyClaimTax"
  | "desperadoClaimTax"
  | "unstakeTheft";

export type BullPoolContributionEvent = ProtocolEventEnvelope<"bullPoolContribution", {
  readonly epoch: bigint;
  readonly amountAtomic: bigint;
  readonly source: BullPoolSource;
}>;

export type ListingCreatedEvent = ProtocolEventEnvelope<"listingCreated", {
  readonly position: string;
  readonly seller: string;
  readonly priceLamports: bigint;
}>;

export type ListingCancelledEvent = ProtocolEventEnvelope<"listingCancelled", {
  readonly position: string;
  readonly seller: string;
}>;

export type RandomnessRequestedEvent = ProtocolEventEnvelope<"randomnessRequested", {
  readonly position: string;
  readonly actionType: "reveal" | "unstake";
  readonly actionNonce: bigint;
  readonly committedProtocolEpoch: bigint;
  readonly timeoutTimestamp: bigint;
  readonly providerProgram: string;
  readonly providerRandomnessAccount: string;
  readonly vrfKey: string | null;
  readonly callbackId: Uint8Array | null;
  readonly registryRootSnapshot: Uint8Array;
  readonly registryVersionSnapshot: bigint;
  readonly commitment: Uint8Array;
}>;

export type OrphanedRewardReleasedEvent = ProtocolEventEnvelope<"orphanedRewardReleased", {
  readonly rewardSource: "cowboy" | "bull";
  readonly amountAtomic: bigint;
  readonly remainingRemainderScaled: bigint;
  readonly totalAnsemLiabilityAtomicAfter: bigint;
}>;

export type RodeoProtocolEvent =
  | ProtocolInitializedEvent
  | PositionStakedEvent
  | MockRandomnessRevealedEvent
  | PositionRevealedEvent
  | PositionSoldEvent
  | PositionGiftedEvent
  | RewardFundingRecognizedEvent
  | RewardPaidEvent
  | SuitRewardClaimedEvent
  | ReceiptCreatedEvent
  | ReceiptBurnedEvent
  | EpochClosedEvent
  | EpochsClosedEvent
  | PositionClaimedEvent
  | BullPoolContributionEvent
  | ListingCreatedEvent
  | ListingCancelledEvent
  | RandomnessRequestedEvent
  | OrphanedRewardReleasedEvent;
