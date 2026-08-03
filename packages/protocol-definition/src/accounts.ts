export const ACCOUNT_VERSIONS = {
  globalConfig: 1,
  rewardState: 3,
  globalGameState: 3,
  bullAccumulator: 3,
  position: 3,
  walletClaimCooldown: 1,
  pendingRandomness: 3,
} as const;

export type AccountName = keyof typeof ACCOUNT_VERSIONS;

// Account schemas (not emitted events)

export interface GlobalConfig {
  readonly version: number;
  readonly rodeoMint: string;
  readonly ansemMint: string;
  readonly rodeoDecimals: number;
  readonly ansemDecimals: number;
  readonly stakeAmountAtomic: bigint;
  readonly expectedTotalSupplyAtomic: bigint;
  readonly launchTimestamp: bigint;
  readonly principalVault: string;
  readonly rewardVault: string;
  readonly pauseNewStakes: boolean;
  readonly pauseNewRevealRequests: boolean;
  readonly pauseNewMarketplaceListings: boolean;
  readonly pauseRouterSwaps: boolean;
  readonly upgradeCouncil: string;
  readonly treasuryCouncil: string;
  readonly emergencyGuardians: string;
  readonly bump: number;
  readonly principalVaultBump: number;
  readonly rewardVaultBump: number;
}

export interface RewardState {
  readonly version: number;
  readonly globalConfig: string;
  readonly currentEpoch: bigint;
  readonly epochStartedAt: bigint;
  readonly lastClosedEpochTimestamp: bigint;
  readonly totalAnsemLiabilityAtomic: bigint;
  readonly cowboyUnmaterializedLiabilityAtomic: bigint;
  readonly positionClaimableLiabilityAtomic: bigint;
  readonly bullPoolLiabilityAtomic: bigint;
  readonly bullPoolUnallocatedLiabilityAtomic: bigint;
  readonly suitVaultLiabilityAtomic: bigint;
  readonly recognizedRewardBalanceAtomic: bigint;
  readonly ansemEmittedAtomic: bigint;
  readonly ansemClaimedAtomic: bigint;
  readonly orphanedRewardReleasedAtomic: bigint;
  readonly cowboyRewardIndex: bigint;
  readonly cowboyIndexRemainderScaled: bigint;
  readonly cowboyOrphanedAccrualRemainderScaled: bigint;
  readonly suitEpoch: bigint;
  readonly bump: number;
}

export interface GlobalGameState {
  readonly version: number;
  readonly globalConfig: string;
  readonly totalCompletedReveals: bigint;
  readonly livePositionCount: bigint;
  readonly activeCowboyCount: bigint;
  readonly activeBullCount: bigint;
  readonly totalActiveCowboyWeight: bigint;
  readonly totalActiveBullPower: bigint;
  readonly accountedPrincipalAtomic: bigint;
  readonly bump: number;
}

export interface BullAccumulator {
  readonly version: number;
  readonly globalConfig: string;
  readonly rewardPerWeightScaled: bigint;
  readonly bullIndexRemainderScaled: bigint;
  readonly bullOrphanedAccrualRemainderScaled: bigint;
  readonly bump: number;
}

export type Role = "unassigned" | "cowboy" | "bull";
export type PositionStatus = "revealPending" | "active";
export type ActionType = "reveal" | "unstake";
export type Suit = "unassigned" | "hearts" | "diamonds" | "clubs" | "spades";
export type CowboyKind =
  | { readonly unassigned: Record<string, never> }
  | { readonly rank: number }
  | { readonly desperado: Record<string, never> };
export type PauseFlag =
  | "newStakes"
  | "newRevealRequests"
  | "newMarketplaceListings"
  | "routerSwaps";
export type OwnershipChangeReason = "sale" | "gift" | "mintTheft";

export interface Position {
  readonly version: number;
  readonly owner: string;
  readonly positionId: bigint;
  readonly principalAmount: bigint;
  readonly role: Role;
  readonly status: PositionStatus;
  readonly cowboyKind: CowboyKind;
  readonly bullTier: number;
  readonly suit: Suit;
  readonly openedAt: bigint;
  readonly activeSince: bigint;
  readonly unstakeEligibleAt: bigint;
  readonly accrualWeight: number;
  readonly buckPower: number;
  readonly lastCowboyRewardIndex: bigint;
  readonly lastBullRewardPerWeight: bigint;
  readonly cowboyAccrualRemainderScaled: bigint;
  readonly bullAccrualRemainderScaled: bigint;
  readonly claimableAnsemAtomic: bigint;
  readonly settlementNonce: bigint;
  readonly stateVersion: bigint;
  readonly listingNonce: bigint;
  readonly receiptAsset: string;
  readonly pendingActionActive: boolean;
  readonly pendingActionType: ActionType;
  readonly pendingActionNonce: bigint;
  readonly nextActionNonce: bigint;
  readonly bump: number;
}

export interface WalletClaimCooldown {
  readonly version: number;
  readonly globalConfig: string;
  readonly wallet: string;
  readonly lastClaimedAt: bigint;
  readonly bump: number;
}

export interface PendingRandomness {
  readonly version: number;
  readonly position: string;
  readonly actionType: ActionType;
  readonly actionNonce: bigint;
  readonly providerProgram: string;
  readonly providerRandomnessAccount: string;
  readonly commitment: Uint8Array;
  readonly committedSlot: bigint;
  readonly committedProtocolEpoch: bigint;
  readonly timeoutTimestamp: bigint;
  readonly registryRootSnapshot: Uint8Array;
  readonly registryVersionSnapshot: bigint;
  readonly settled: boolean;
  readonly bump: number;
}

/** SocialResult PDA: [b"social-result", global_config, competition_epoch] */
export interface SocialResult {
  readonly version: number;
  readonly globalConfig: string;
  readonly competitionEpoch: bigint;
  readonly winningSuitsMask: number;
  readonly totalAmount: bigint;
  readonly merkleRoot: Uint8Array;
  readonly contentHash: Uint8Array;
  readonly attestedAt: bigint;
  readonly bump: number;
}

/** SuitClaimReceipt PDA: [b"suit-claim", social_result, leaf_nonce] */
export interface SuitClaimReceipt {
  readonly version: number;
  readonly socialResult: string;
  readonly leafNonce: bigint;
  readonly claimed: boolean;
  readonly bump: number;
}
