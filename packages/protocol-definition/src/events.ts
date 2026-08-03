export interface ProtocolEventEnvelope<Name extends string, Data> {
  readonly id: string;
  readonly epoch: bigint;
  readonly name: Name;
  readonly data: Data;
}

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
  readonly newRecognizedBalanceAtomic: bigint;
}>;

export type RewardPaidEvent = ProtocolEventEnvelope<"rewardPaid", {
  readonly position: string | null;
  readonly recipient: string;
  readonly amountAtomic: bigint;
  readonly remainingRecognizedBalanceAtomic: bigint;
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
  readonly recognizedRewardBalanceAtomic: bigint;
  readonly totalAnsemLiabilityAtomic: bigint;
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
  | ListingCreatedEvent
  | ListingCancelledEvent
  | RandomnessRequestedEvent
  | OrphanedRewardReleasedEvent;
