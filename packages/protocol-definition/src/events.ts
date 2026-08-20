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
  readonly protocolConfig: string;
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
  readonly currentConfigVersion: bigint;
};

export type PositionStakedEvent = ProtocolEventEnvelope<"positionStaked", {
  readonly position: string;
  readonly owner: string;
  readonly positionId: bigint;
  readonly principalAtomic: bigint;
  readonly commitment: Uint8Array;
  readonly globalGameState: string;
}>;

export type PositionOwnerChangedEvent = ProtocolEventEnvelope<"positionOwnerChanged", {
  readonly position: string;
  readonly previousOwner: string;
  readonly newOwner: string;
  readonly reason: "sale" | "gift" | "mintTheft";
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
  readonly configVersion: bigint;
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

export type PositionOwnershipTransferredEvent = ProtocolEventEnvelope<"positionOwnershipTransferred", {
  readonly position: string;
  readonly seller: string;
  readonly buyer: string;
  readonly claimPolicyVersion: bigint;
  readonly claimClass: string;
}>;

export type PositionTransferPreparedEvent = ProtocolEventEnvelope<"positionTransferPrepared", {
  readonly position: string;
  readonly owner: string;
  readonly claimPolicyVersion: bigint;
  readonly claimClass: string;
  readonly creditAmount: bigint;
}>;

export type PositionActivatedEvent = ProtocolEventEnvelope<"positionActivated", {
  readonly position: string;
  readonly owner: string;
  readonly claimPolicyVersion: bigint;
  readonly claimClass: string;
}>;

export type ClaimCreditCheckpointedEvent = ProtocolEventEnvelope<"claimCreditCheckpointed", {
  readonly position: string;
  readonly wallet: string;
  readonly claimPolicyVersion: bigint;
  readonly claimClass: string;
  readonly amountAtomic: bigint;
}>;

export type ClaimCreditClaimedEvent = ProtocolEventEnvelope<"claimCreditClaimed", {
  readonly wallet: string;
  readonly claimPolicyVersion: bigint;
  readonly claimClass: string;
  readonly grossAmount: bigint;
  readonly ownerAmount: bigint;
  readonly bullPoolAmount: bigint;
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

export type BullRewardDistributedEvent = ProtocolEventEnvelope<"bullRewardDistributed", {
  readonly position: string;
  readonly owner: string;
  readonly amountAtomic: bigint;
  readonly rewardPerWeightScaled: bigint;
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
  readonly committedSlot: bigint;
  readonly committedProtocolEpoch: bigint;
  readonly timeoutTimestamp: bigint;
  readonly providerProgram: string;
  readonly providerRandomnessAccount: string;
  readonly vrfKey: string | null;
  readonly callbackId: Uint8Array | null;
  readonly registryRootSnapshot: Uint8Array;
  readonly registryVersionSnapshot: bigint;
  readonly configVersionSnapshot: bigint;
  readonly commitment: Uint8Array;
}>;

export type RandomnessSettledEvent = ProtocolEventEnvelope<"randomnessSettled", {
  readonly position: string;
  readonly actionType: "reveal" | "unstake";
  readonly actionNonce: bigint;
  readonly settlementNonce: bigint;
  readonly committedSlot: bigint;
  readonly committedProtocolEpoch: bigint;
  readonly settledAt: bigint;
  readonly configVersionSnapshot: bigint;
}>;

export type RandomnessTimeoutRecoveredEvent = ProtocolEventEnvelope<"randomnessTimeoutRecovered", {
  readonly position: string;
  readonly actionType: "reveal" | "unstake";
  readonly actionNonce: bigint;
  readonly recoveryAction: "closeAndRefundPrincipal" | "cancelUnstake";
}>;

export type UnstakeRequestedEvent = ProtocolEventEnvelope<"unstakeRequested", {
  readonly position: string;
  readonly owner: string;
  readonly actionNonce: bigint;
  readonly requestedAt: bigint;
  readonly configVersion: bigint;
}>;

export type AnsemUnstakeFate = "toOwner" | "toBullPool" | "immune";

export type PositionUnstakedEvent = ProtocolEventEnvelope<"positionUnstaked", {
  readonly position: string;
  readonly owner: string;
  readonly principalAmount: bigint;
  readonly principalReturned: bigint;
  readonly principalBurned: bigint;
  readonly ansemFate: AnsemUnstakeFate;
  readonly synchronizedAnsem: bigint;
  readonly ansemPaidToOwner: bigint;
  readonly ansemRoutedToBullPool: bigint;
  readonly settlementNonce: bigint;
  readonly configVersion: bigint;
}>;

export type OrphanedRewardReleasedEvent = ProtocolEventEnvelope<"orphanedRewardReleased", {
  readonly rewardSource: "cowboy" | "bull";
  readonly amountAtomic: bigint;
  readonly remainingRemainderScaled: bigint;
  readonly totalAnsemLiabilityAtomicAfter: bigint;
}>;

export type BullRegistryOperation = "add" | "remove";

export type BullRegistryTransitionEvent = ProtocolEventEnvelope<"bullRegistryTransition", {
  readonly oldRoot: Uint8Array;
  readonly newRoot: Uint8Array;
  readonly oldVersion: bigint;
  readonly newVersion: bigint;
  readonly operation: BullRegistryOperation;
  readonly bullPosition: string;
  readonly positionId: bigint;
  readonly owner: string;
  readonly buckPower: number;
}>;

export type MintTheftEvent = ProtocolEventEnvelope<"mintTheft", {
  readonly position: string;
  readonly positionId: bigint;
  readonly prospectiveOwner: string;
  readonly finalOwner: string;
  readonly winningBullPosition: string;
  readonly winningBullOwner: string;
  readonly registrySnapshotVersion: bigint;
  readonly configVersion: bigint;
}>;


export type ReceiptPluginAuthority =
  | { readonly kind: "none" }
  | { readonly kind: "owner" }
  | { readonly kind: "updateAuthority" }
  | { readonly kind: "address"; readonly address: string };

export type SparseTreeBenchmarkedEvent = ProtocolEventEnvelope<"sparseTreeBenchmarked", {
  readonly ownerTreeRoot: Uint8Array;
  readonly totalBullCount: bigint;
  readonly totalBuckPower: bigint;
  readonly registryVersion: bigint;
}>;

export type PositionReceiptParsedEvent = ProtocolEventEnvelope<"positionReceiptParsed", {
  readonly receiptAsset: string;
  readonly owner: string;
  readonly hasPermanentTransferDelegate: boolean;
  readonly hasPermanentBurnDelegate: boolean;
  readonly hasPermanentFreezeDelegate: boolean;
  readonly frozen: boolean;
  readonly permanentTransferAuthority: ReceiptPluginAuthority | null;
  readonly permanentBurnAuthority: ReceiptPluginAuthority | null;
  readonly permanentFreezeAuthority: ReceiptPluginAuthority | null;
}>;

export type RodeoProtocolEvent =
  | ProtocolInitializedEvent
  | PositionStakedEvent
  | PositionOwnerChangedEvent
  | PositionRevealedEvent
  | PositionSoldEvent
  | PositionGiftedEvent
  | PositionOwnershipTransferredEvent
  | PositionTransferPreparedEvent
  | PositionActivatedEvent
  | ClaimCreditCheckpointedEvent
  | ClaimCreditClaimedEvent
  | RewardFundingRecognizedEvent
  | RewardPaidEvent
  | SuitRewardClaimedEvent
  | ReceiptCreatedEvent
  | ReceiptBurnedEvent
  | EpochClosedEvent
  | EpochsClosedEvent
  | PositionClaimedEvent
  | BullPoolContributionEvent
  | BullRewardDistributedEvent
  | ListingCreatedEvent
  | ListingCancelledEvent
  | RandomnessRequestedEvent
  | RandomnessSettledEvent
  | RandomnessTimeoutRecoveredEvent
  | UnstakeRequestedEvent
  | PositionUnstakedEvent
  | OrphanedRewardReleasedEvent
  | BullRegistryTransitionEvent
  | MintTheftEvent
  | PositionReceiptParsedEvent
  | SparseTreeBenchmarkedEvent;
