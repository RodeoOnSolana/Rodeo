import fc from "fast-check";
import {
  BPS_DENOMINATOR,
  CLAIM_BULL_POOL_BPS,
  CLAIM_OWNER_BPS,
  CLOSE_EPOCH_BATCH_MAX,
  COWBOY_ACCRUAL_WEIGHTS,
  COWBOY_RANK_TABLE,
  COWBOY_REWARD_INDEX_SCALE,
  DESPERADO_ACCRUAL_WEIGHT,
  REWARD_PER_WEIGHT_SCALE,
  DESPERADO_CLAIM_BULL_POOL_BPS,
  DESPERADO_CLAIM_OWNER_BPS,
  EMISSION_COWBOY_BPS,
  EMISSION_SUITS_BPS,
  EPOCH_DURATION_SECONDS,
  MIN_STAKE_SECONDS,
  POT_FILL_SECONDS,
  PROBABILITY_DENOMINATOR,
  PROTOCOL_CONFIG_V2,
  RUNWAY_EPOCHS,
  SUIT_EQUAL_SPLIT_BPS,
  SUIT_PROPORTIONAL_SPLIT_BPS,
  SUIT_TABLE,
  STAKE_AMOUNT_WHOLE_RODEO,
  UNSTAKE_RETURN_BPS,
  UNSTAKE_TAX_BPS,
  RandomnessDomain,
  isNormalized,
  rejectionSampleDraw,
  sampleOutcome,
  stakeAmountAtomic,
} from "@rodeo/protocol-definition";
import { describe, expect, it } from "vitest";
import { checkedSub, mulDivFloor } from "@rodeo/shared";
import { EconomicSimulator } from "../src/index.js";
import type { RevealOutcomes, SuitClaimLeaf } from "../src/index.js";

const config = {
  rodeoDecimals: 0n,
  epochDurationSeconds: EPOCH_DURATION_SECONDS,
  potFillSeconds: POT_FILL_SECONDS,
  ansemPerSolNumerator: 1n,
  ansemPerSolDenominator: 1n,
} as const;

const now = 0n;
const stakeAmount = stakeAmountAtomic(config.rodeoDecimals);

function revealCowboy(rank: NonNullable<RevealOutcomes["cowboyRank"]>, suit: RevealOutcomes["suit"], isDesperado = false): RevealOutcomes {
  return {
    role: "cowboy",
    cowboyRank: rank,
    isDesperado,
    suit,
    mintTheft: false,
    thiefPositionId: null,
  };
}

function revealBull(tier: NonNullable<RevealOutcomes["bullTier"]>, suit: RevealOutcomes["suit"]): RevealOutcomes {
  return {
    role: "bull",
    bullTier: tier,
    isDesperado: false,
    suit,
    mintTheft: false,
    thiefPositionId: null,
  };
}

function fundRewards(simulator: EconomicSimulator, ansem: bigint, nowTs: bigint): void {
  // Catch up epochs, buy ANSEM from pending SOL revenue, recognize it, then
  // advance one more epoch so emission happens.
  simulator.apply({ type: "closeEpoch", settlementId: `catchup-${ansem}-${nowTs}`, now: nowTs });
  simulator.apply({ type: "buyAnsemRewards", settlementId: `buy-${ansem}-${nowTs}`, ansemAtomic: ansem });
  simulator.apply({ type: "recognizeRewards", settlementId: `rec-${ansem}-${nowTs}`, ansemAtomic: ansem });
  simulator.apply({ type: "closeEpoch", settlementId: `emit-${ansem}-${nowTs}`, now: nowTs + EPOCH_DURATION_SECONDS });
}

describe("Protocol v1.3 simulator invariants", () => {
  it("normalizes every approved probability table exactly", () => {
    const tables = [
      { name: "role", table: { denominator: PROBABILITY_DENOMINATOR, entries: [{ outcome: "cowboy", weight: 9_000_000n }, { outcome: "bull", weight: 1_000_000n }] } },
      { name: "cowboy rank", table: { denominator: 9_000_000n, entries: [{ outcome: "rank4", weight: 4_047_750n }, { outcome: "rank5", weight: 2_248_750n }, { outcome: "rank6", weight: 1_169_350n }, { outcome: "rank7", weight: 719_600n }, { outcome: "rank8", weight: 449_750n }, { outcome: "rank9", weight: 269_850n }, { outcome: "rank10", weight: 89_950n }, { outcome: "desperado", weight: 5_000n }] } },
      { name: "bull tier", table: { denominator: 1_000_000n, entries: [{ outcome: "tier1", weight: 600_000n }, { outcome: "tier2", weight: 250_000n }, { outcome: "tier3", weight: 100_000n }, { outcome: "tier4", weight: 50_000n }] } },
      { name: "suit", table: { denominator: PROBABILITY_DENOMINATOR, entries: [{ outcome: "hearts", weight: 2_500_000n }, { outcome: "diamonds", weight: 2_500_000n }, { outcome: "clubs", weight: 2_500_000n }, { outcome: "spades", weight: 2_500_000n }] } },
      { name: "theft", table: { denominator: PROBABILITY_DENOMINATOR, entries: [{ outcome: "stolen", weight: 500_000n }, { outcome: "safe", weight: 9_500_000n }] } },
    ];
    for (const { table } of tables) {
      expect(isNormalized(table)).toBe(true);
    }
  });

  it("sampleOutcome selects the correct interval for every boundary", () => {
    const table = {
      denominator: 100n,
      entries: [
        { outcome: "a", weight: 30n },
        { outcome: "b", weight: 40n },
        { outcome: "c", weight: 30n },
      ],
    };
    expect(sampleOutcome(table, 0n)).toBe("a");
    expect(sampleOutcome(table, 29n)).toBe("a");
    expect(sampleOutcome(table, 30n)).toBe("b");
    expect(sampleOutcome(table, 69n)).toBe("b");
    expect(sampleOutcome(table, 70n)).toBe("c");
    expect(sampleOutcome(table, 99n)).toBe("c");
    expect(() => sampleOutcome(table, 100n)).toThrow();
  });

  it("rejects stake with wrong amount", () => {
    const simulator = new EconomicSimulator(config);
    expect(() => simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now })).not.toThrow();
    expect(simulator.state.principalVaultAtomic).toBe(stakeAmount);
    expect(simulator.state.accountedPrincipalAtomic).toBe(stakeAmount);

    expect(() => simulator.apply({ type: "stake", settlementId: "s2", positionId: "p1", owner: "bob", openedAt: now })).toThrow("already exists");
  });

  it("reveals a cowboy, applies accrual weight, and tracks population", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    const p = simulator.state.positions.get("p1")!;
    expect(p.status).toBe("active");
    expect(p.role).toBe("cowboy");
    expect(p.cowboyKind).toEqual({ kind: "rank", rank: "rank4" });
    expect(p.bullTier).toBe(0);
    expect(p.accrualWeight).toBe(COWBOY_ACCRUAL_WEIGHTS.rank4);
    expect(p.pendingActionActive).toBe(false);
    expect(p.settlementNonce).toBe(1n);
    expect(p.unstakeEligibleAt).toBe(MIN_STAKE_SECONDS);
    expect(simulator.state.activeCowboyCount).toBe(1n);
    expect(simulator.state.totalActiveCowboyWeight).toBe(COWBOY_ACCRUAL_WEIGHTS.rank4);
  });

  it("reveals a bull, applies buck power, and tracks population", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealBull("tier4", "spades") });
    const p = simulator.state.positions.get("p1")!;
    expect(p.status).toBe("active");
    expect(p.role).toBe("bull");
    expect(p.bullTier).toBe(10);
    expect(p.buckPower).toBe(10);
    expect(simulator.state.activeBullCount).toBe(1n);
    expect(simulator.state.totalActiveBullPower).toBe(10n);
  });

  it("rejects reveal without pending action", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    expect(() => simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") })).toThrow("No pending reveal action");
  });

  it("blocks gift while reveal is pending", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    expect(() => simulator.apply({ type: "gift", settlementId: "t1", positionId: "p1", newOwner: "bob", claimedAt: 1n })).toThrow("pending");
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "gift", settlementId: "t1", positionId: "p1", newOwner: "bob", claimedAt: MIN_STAKE_SECONDS + 1n });
    expect(simulator.state.positions.get("p1")?.owner).toBe("bob");
    expect(simulator.state.positions.get("p1")?.stateVersion).toBe(1n);
    expect(simulator.state.positions.get("p1")?.unstakeEligibleAt).toBe(MIN_STAKE_SECONDS);
  });

  it("distributes claim 80/20 for normal cowboy and 98/2 for desperado", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeClaim = simulator.state.ansemClaimedAtomic;
    const beforeBullPool = simulator.state.bullPoolLiabilityAtomic + simulator.state.bullPoolUnallocatedLiabilityAtomic;
    const beforeTotalLiability = simulator.state.totalAnsemLiabilityAtomic;
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const p = simulator.state.positions.get("p1")!;
    expect(p.claimableAnsemAtomic).toBe(0n);
    expect(simulator.state.positionClaimableLiabilityAtomic).toBe(0n);
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaim);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBeLessThan(beforeTotalLiability);
    expect(simulator.state.bullPoolLiabilityAtomic + simulator.state.bullPoolUnallocatedLiabilityAtomic).toBeGreaterThanOrEqual(beforeBullPool);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBeLessThanOrEqual(simulator.state.recognizedRewardBalanceAtomic);
  });

  it("returns 95% of principal and burns 5% on unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    const beforeVault = simulator.state.principalVaultAtomic;
    const beforeAccounted = simulator.state.accountedPrincipalAtomic;
    expect(() => simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS - 1n })).toThrow("Minimum stake period");
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    expect(simulator.state.positions.get("p1")?.pendingActionType).toBe("unstake");
    expect(simulator.state.positions.get("p1")?.status).toBe("active");
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: false } });
    expect(simulator.state.positions.has("p1")).toBe(false);
    expect(simulator.state.livePositionCount).toBe(0n);
    expect(simulator.state.principalVaultAtomic).toBe(beforeVault - stakeAmount);
    expect(simulator.state.accountedPrincipalAtomic).toBe(beforeAccounted - stakeAmount);
    expect(simulator.state.rodeoBurnedAtomic).toBe((stakeAmount * UNSTAKE_TAX_BPS) / BPS_DENOMINATOR);
    expect(simulator.state.rodeoBurnedAtomic + (stakeAmount * UNSTAKE_RETURN_BPS) / BPS_DENOMINATOR).toBe(stakeAmount);
  });

  it("steals normal cowboy pending ANSEM on unstake 5% of the time", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealBull("tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforePool = simulator.state.bullRewardPerWeightScaled;
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: true } });
    expect(simulator.state.bullRewardPerWeightScaled).toBeGreaterThan(beforePool);
    // No 80/20 claim tax applied during unstake: the entire pending amount moves to the Bull pool.
    expect(simulator.state.ansemClaimedAtomic).toBe(0n);
  });

  it("bull claim reduces bull pool liability", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealBull("tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    expect(simulator.state.bullPoolLiabilityAtomic).toBeGreaterThan(0n);

    const beforeClaim = simulator.state.ansemClaimedAtomic;
    simulator.apply({ type: "claimBull", settlementId: "b1", positionId: "p2", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 2n });
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaim);
    expect(simulator.state.bullPoolLiabilityAtomic).toBe(0n);
    expect(simulator.state.positionClaimableLiabilityAtomic).toBe(0n);
  });

  it("maintains principal conservation across arbitrary stake/unstake/transfer sequences", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            open: fc.boolean(),
            revealCowboy: fc.boolean(),
            transfer: fc.boolean(),
            unstake: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (ops) => {
          const simulator = new EconomicSimulator(config);
          let expectedPrincipal = 0n;
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const pid = `p${i}`;
            if (op.open) {
              simulator.apply({ type: "stake", settlementId: `s${i}`, positionId: pid, owner: "alice", openedAt: now });
              expectedPrincipal += stakeAmount;
            }
            if (op.revealCowboy) {
              try {
                simulator.apply({ type: "reveal", settlementId: `r${i}`, positionId: pid, outcomes: revealCowboy("rank4", "hearts") });
              } catch {
                // ignore invalid transitions
              }
            }
            if (op.transfer) {
              try {
                simulator.apply({ type: "gift", settlementId: `t${i}`, positionId: pid, newOwner: "bob", claimedAt: MIN_STAKE_SECONDS + 1n });
              } catch {
                // ignore invalid transitions
              }
            }
            if (op.unstake) {
              try {
                simulator.apply({ type: "requestUnstake", settlementId: `u${i}a`, positionId: pid, requestedAt: MIN_STAKE_SECONDS + 1n });
                simulator.apply({ type: "settleUnstake", settlementId: `u${i}b`, positionId: pid, fate: { ansemToBullPool: false } });
                expectedPrincipal -= stakeAmount;
              } catch {
                // ignore invalid transitions
              }
            }
          }
          expect(simulator.state.accountedPrincipalAtomic).toBe(expectedPrincipal);
          expect(simulator.state.principalVaultAtomic).toBeGreaterThanOrEqual(simulator.state.accountedPrincipalAtomic);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("preserves position identity across ownership transfers", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "gift", settlementId: "t1", positionId: "p1", newOwner: "bob", claimedAt: MIN_STAKE_SECONDS + 1n });
    expect(simulator.state.positions.get("p1")!.owner).toBe("bob");
    expect(simulator.state.positions.get("p1")!.stateVersion).toBe(1n);
    expect(simulator.state.positions.get("p1")!.unstakeEligibleAt).toBe(MIN_STAKE_SECONDS);
  });

  it("prevents duplicate settlement", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    expect(() => simulator.apply({ type: "stake", settlementId: "s1", positionId: "p2", owner: "bob", openedAt: now })).toThrow("Duplicate settlement");
  });

  it("caps ANSEM liability by recognized reward balance", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 100n });
    fundRewards(simulator, 70n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    expect(simulator.state.totalAnsemLiabilityAtomic).toBeLessThanOrEqual(simulator.state.recognizedRewardBalanceAtomic);
  });

  it("skips emission during pot-fill period", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 1_000n });
    // Close one epoch before the pot-fill ends: no emission yet.
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS - 1n });
    expect(simulator.state.ansemEmittedAtomic).toBe(0n);
    // Buy ANSEM while still before pot-fill end, then recognize after catching up.
    simulator.apply({ type: "buyAnsemRewards", settlementId: "buy1", ansemAtomic: 700n });
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 700n });
    // Close an epoch after pot-fill: emission begins.
    simulator.apply({ type: "closeEpoch", settlementId: "e2", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    expect(simulator.state.ansemEmittedAtomic).toBeGreaterThan(0n);
  });

  it("does not apply 80/20 claim tax during normal cowboy unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealBull("tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeClaimed = simulator.state.ansemClaimedAtomic;
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: false } });
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaimed);
    expect(simulator.state.ansemClaimedAtomic).toBe(simulator.state.positionClaimableLiabilityAtomic + simulator.state.cowboyUnmaterializedLiabilityAtomic ? 0n : simulator.state.ansemClaimedAtomic);
  });

  it("delays recognition of ANSEM purchased after an elapsed epoch boundary", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    // Buy ANSEM while an epoch is elapsed but not closed.
    simulator.apply({ type: "buyAnsemRewards", settlementId: "buy1", ansemAtomic: 140n });
    expect(simulator.state.rewardVaultAnsemAtomic).toBe(140n);
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(0n);
    expect(simulator.state.rewardVaultAnsemAtomic - simulator.state.recognizedRewardBalanceAtomic).toBe(140n);
    // Close the elapsed epoch first.
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    // Now recognition succeeds.
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 140n });
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(140n);
    expect(simulator.state.rewardVaultAnsemAtomic - simulator.state.recognizedRewardBalanceAtomic).toBe(0n);
  });

  it("treats direct reward vault transfers as unrecognized surplus", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "drop1", ansemAtomic: 1_000n });
    expect(simulator.state.rewardVaultAnsemAtomic).toBe(1_000n);
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(0n);
    expect(simulator.state.rewardVaultAnsemAtomic - simulator.state.recognizedRewardBalanceAtomic).toBe(1_000n);
    // Unrecognized surplus does not fund emissions until recognized.
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    expect(simulator.state.ansemEmittedAtomic).toBe(0n);
  });

  it("uses deterministic rejection sampling for exact probability mapping", () => {
    const output = new Uint8Array(32);
    for (let i = 0; i < 32; i++) output[i] = i;
    const position = new Uint8Array(32);
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode("p1");
    position.set(nameBytes, 0);

    const ctx = {
      randomOutput: output,
      domain: RandomnessDomain.CowboyKind,
      position,
      actionNonce: 1n,
    };
    const result = rejectionSampleDraw(COWBOY_RANK_TABLE, ctx);
    // Same inputs must always map to the same draw.
    expect(rejectionSampleDraw(COWBOY_RANK_TABLE, ctx)).toBe(result);
    // A different domain must not be assumed equal.
    const ctx2 = {
      randomOutput: output,
      domain: RandomnessDomain.Suit,
      position,
      actionNonce: 1n,
    };
    // Just verify it runs without error and is deterministic.
    expect(rejectionSampleDraw(SUIT_TABLE, ctx2)).toBe(rejectionSampleDraw(SUIT_TABLE, ctx2));
  });

  it("carries accumulator remainder to preserve small accrual units", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealCowboy("rank5", "diamonds") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 1_000_000n });
    fundRewards(simulator, 700_000n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    // Remainder is bounded by the active weight denominator.
    expect(simulator.state.cowboyIndexRemainderScaled).toBeLessThan(simulator.state.totalActiveCowboyWeight);

    // Synchronizing a position updates its per-position remainder, not the global remainder.
    const beforeGlobal = simulator.state.cowboyIndexRemainderScaled;
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const p = simulator.state.positions.get("p1")!;
    expect(p.cowboyAccrualRemainderScaled).toBeLessThan(COWBOY_REWARD_INDEX_SCALE);
    expect(simulator.state.cowboyIndexRemainderScaled).toBe(beforeGlobal);
  });

  it("pays claimable that is zero before synchronization but positive after", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const p = simulator.state.positions.get("p1")!;
    expect(p.claimableAnsemAtomic).toBe(0n);
    const beforeClaimed = simulator.state.ansemClaimedAtomic;
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaimed);
  });

  it("decreases recognized balance by every vault payout", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealBull("tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeRecognized = simulator.state.recognizedRewardBalanceAtomic;
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    expect(simulator.state.recognizedRewardBalanceAtomic).toBeLessThan(beforeRecognized);

    const beforeBull = simulator.state.recognizedRewardBalanceAtomic;
    simulator.apply({ type: "claimBull", settlementId: "b1", positionId: "p2", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 2n });
    expect(simulator.state.recognizedRewardBalanceAtomic).toBeLessThan(beforeBull);
  });

  it("routes bull contributions to unallocated when no Bull is active", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    expect(simulator.state.bullPoolUnallocatedLiabilityAtomic).toBeGreaterThan(0n);
    expect(simulator.state.bullPoolLiabilityAtomic).toBe(0n);

    // Activating a Bull moves unallocated into the Bull accumulator.
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    const beforeUnallocated = simulator.state.bullPoolUnallocatedLiabilityAtomic;
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealBull("tier1", "spades") });
    expect(simulator.state.bullPoolUnallocatedLiabilityAtomic).toBeLessThan(beforeUnallocated);
    expect(simulator.state.bullPoolLiabilityAtomic).toBeGreaterThan(0n);
  });

  it("resets buyer reward checkpoints after a gift", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeIndex = simulator.state.cowboyRewardIndex;
    simulator.apply({ type: "gift", settlementId: "g1", positionId: "p1", newOwner: "bob", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const p = simulator.state.positions.get("p1")!;
    expect(p.lastCowboyRewardIndex).toBe(beforeIndex);
    expect(p.cowboyAccrualRemainderScaled).toBe(0n);
    expect(p.claimableAnsemAtomic).toBe(0n);
  });

  it("pays suit rewards to snapshot owner after a gift or unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    fundRewards(simulator, 140n, POT_FILL_SECONDS + EPOCH_DURATION_SECONDS);
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    // Attest a social result with one eligible leaf for alice.
    const leaf: SuitClaimLeaf = {
      positionId: "p1",
      ownerAtSnapshot: "alice",
      suit: "hearts",
      amount: simulator.state.suitVaultLiabilityAtomic,
      leafNonce: 1n,
    };
    simulator.apply({ type: "socialResult", settlementId: "soc1", competitionEpoch: simulator.state.suitEpoch, winningSuitsMask: 0b0001, claims: [leaf] });

    // Gift the position away; the snapshot owner can still claim.
    simulator.apply({ type: "gift", settlementId: "g1", positionId: "p1", newOwner: "bob", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const beforeClaimed = simulator.state.ansemClaimedAtomic;
    simulator.apply({ type: "suitClaim", settlementId: "sc1", competitionEpoch: simulator.state.suitEpoch, leaf });
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaimed);

    // Unstake the (now bob-owned) position; the snapshot owner claim is unaffected.
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: simulator.state.positions.get("p1")!.unstakeEligibleAt + 1n });
    expect(() => simulator.apply({ type: "suitClaim", settlementId: "sc2", competitionEpoch: simulator.state.suitEpoch, leaf })).toThrow("already used");
  });

  it("conserves total ANSEM across tied-suit allocation", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1_000_000n });
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 1_000_000n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const vault = simulator.state.suitVaultLiabilityAtomic;
    expect(vault).toBeGreaterThan(1n);
    const half = vault / 2n;
    const leafHearts: SuitClaimLeaf = {
      positionId: "p1",
      ownerAtSnapshot: "alice",
      suit: "hearts",
      amount: half,
      leafNonce: 1n,
    };
    const leafDiamonds: SuitClaimLeaf = {
      positionId: "p2",
      ownerAtSnapshot: "bob",
      suit: "diamonds",
      amount: vault - half,
      leafNonce: 2n,
    };
    simulator.apply({ type: "socialResult", settlementId: "soc1", competitionEpoch: simulator.state.suitEpoch, winningSuitsMask: 0b0011, claims: [leafHearts, leafDiamonds] });
    expect(simulator.state.suitClaimLiabilityAtomic).toBe(vault);
    expect(simulator.state.suitVaultLiabilityAtomic).toBe(0n);
  });

  it("allows sale and gift when claimable rewards are zero after sync", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    // No rewards have been emitted, so claimable is zero after synchronization.
    simulator.apply({ type: "gift", settlementId: "g1", positionId: "p1", newOwner: "bob", claimedAt: 1n });
    expect(simulator.state.positions.get("p1")?.owner).toBe("bob");
    expect(simulator.state.positions.get("p1")?.claimableAnsemAtomic).toBe(0n);
  });

  it("preserves per-position carry across a gift", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealCowboy("rank5", "diamonds") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 80n });
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 80n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeTotalLiability = simulator.state.totalAnsemLiabilityAtomic;

    simulator.apply({ type: "gift", settlementId: "g1", positionId: "p1", newOwner: "carol", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const pAfter = simulator.state.positions.get("p1")!;
    expect(pAfter.owner).toBe("carol");
    // The gift synchronizes rewards, so the role-appropriate sub-atomic carry
    // is preserved on the Position while the global checkpoint resets.
    expect(pAfter.cowboyAccrualRemainderScaled).toBeGreaterThan(0n);
    expect(pAfter.cowboyAccrualRemainderScaled).toBeLessThan(COWBOY_REWARD_INDEX_SCALE);
    expect(pAfter.lastCowboyRewardIndex).toBe(simulator.state.cowboyRewardIndex);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBe(beforeTotalLiability);
  });

  it("moves per-position carry into orphaned remainder on unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealCowboy("rank5", "diamonds") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 80n });
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 80n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeTotalLiability = simulator.state.totalAnsemLiabilityAtomic;
    const p = simulator.state.positions.get("p1")!;
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: p.unstakeEligibleAt + 1n });
    const carry = simulator.state.positions.get("p1")!.cowboyAccrualRemainderScaled;
    expect(carry).toBeGreaterThan(0n);
    expect(carry).toBeLessThan(COWBOY_REWARD_INDEX_SCALE);

    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: false } });
    expect(simulator.state.cowboyOrphanedAccrualRemainderScaled).toBe(carry);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBe(beforeTotalLiability);
  });

  it("updates accounted principal on stake and unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    expect(simulator.state.accountedPrincipalAtomic).toBe(stakeAmount);
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: false } });
    expect(simulator.state.accountedPrincipalAtomic).toBe(0n);
  });

  it("materializes Cowboy orphaned remainder by reducing liability, not by routing to Bulls", () => {
    const simulator = new EconomicSimulator(config);
    simulator.state.rewardVaultAnsemAtomic = 1_000n;
    simulator.state.recognizedRewardBalanceAtomic = 1_000n;
    simulator.state.totalAnsemLiabilityAtomic = 100n;
    simulator.state.cowboyUnmaterializedLiabilityAtomic = 100n;
    simulator.state.cowboyOrphanedAccrualRemainderScaled = 2n * COWBOY_REWARD_INDEX_SCALE + 500n;
    const beforeFree = simulator.state.recognizedRewardBalanceAtomic - simulator.state.totalAnsemLiabilityAtomic;
    const beforeBull = simulator.state.bullPoolLiabilityAtomic;
    const beforeSuit = simulator.state.suitVaultLiabilityAtomic;

    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1n });

    expect(simulator.state.cowboyOrphanedAccrualRemainderScaled).toBe(500n);
    expect(simulator.state.cowboyUnmaterializedLiabilityAtomic).toBe(98n);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBe(98n);
    expect(simulator.state.orphanedRewardReleasedAtomic).toBe(2n);
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(1_000n);
    expect(simulator.state.bullPoolLiabilityAtomic).toBe(beforeBull);
    expect(simulator.state.suitVaultLiabilityAtomic).toBe(beforeSuit);
    const recognizedAfterCowboy = simulator.state.recognizedRewardBalanceAtomic < simulator.state.rewardVaultAnsemAtomic
      ? simulator.state.recognizedRewardBalanceAtomic
      : simulator.state.rewardVaultAnsemAtomic;
    expect(recognizedAfterCowboy - simulator.state.totalAnsemLiabilityAtomic).toBe(beforeFree + 2n);
  });

  it("materializes Bull orphaned remainder by reducing liability, not by routing to suits", () => {
    const simulator = new EconomicSimulator(config);
    simulator.state.rewardVaultAnsemAtomic = 1_000n;
    simulator.state.recognizedRewardBalanceAtomic = 1_000n;
    simulator.state.totalAnsemLiabilityAtomic = 100n;
    simulator.state.bullPoolLiabilityAtomic = 100n;
    simulator.state.bullOrphanedAccrualRemainderScaled = 3n * REWARD_PER_WEIGHT_SCALE + 700n;
    const beforeFree = simulator.state.recognizedRewardBalanceAtomic - simulator.state.totalAnsemLiabilityAtomic;
    const beforeCowboyUnmat = simulator.state.cowboyUnmaterializedLiabilityAtomic;
    const beforeSuit = simulator.state.suitVaultLiabilityAtomic;

    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1n });

    expect(simulator.state.bullOrphanedAccrualRemainderScaled).toBe(700n);
    expect(simulator.state.bullPoolLiabilityAtomic).toBe(97n);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBe(97n);
    expect(simulator.state.orphanedRewardReleasedAtomic).toBe(3n);
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(1_000n);
    expect(simulator.state.cowboyUnmaterializedLiabilityAtomic).toBe(beforeCowboyUnmat);
    expect(simulator.state.suitVaultLiabilityAtomic).toBe(beforeSuit);
    const recognizedAfterBull = simulator.state.recognizedRewardBalanceAtomic < simulator.state.rewardVaultAnsemAtomic
      ? simulator.state.recognizedRewardBalanceAtomic
      : simulator.state.rewardVaultAnsemAtomic;
    expect(recognizedAfterBull - simulator.state.totalAnsemLiabilityAtomic).toBe(beforeFree + 3n);
  });

  it("rejects orphaned remainder materialization that would underflow a liability bucket", () => {
    const simulator = new EconomicSimulator(config);
    simulator.state.rewardVaultAnsemAtomic = 1_000n;
    simulator.state.recognizedRewardBalanceAtomic = 1_000n;
    simulator.state.totalAnsemLiabilityAtomic = 0n;
    simulator.state.cowboyUnmaterializedLiabilityAtomic = 0n;
    simulator.state.cowboyOrphanedAccrualRemainderScaled = COWBOY_REWARD_INDEX_SCALE;
    expect(() => simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1n })).toThrow("underflow");
  });

  it("recognizes only the requested amount capped by the unrecognized surplus", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealCowboy("rank4", "hearts") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1_000n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 300n });
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(300n);
    simulator.apply({ type: "recognizeRewards", settlementId: "rec2", ansemAtomic: 900n });
    expect(simulator.state.recognizedRewardBalanceAtomic).toBe(1_000n);
  });

  it("counts ansemEmittedAtomic by full epoch emission even when no Cowboys are active", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealBull("tier1", "spades") });
    simulator.apply({ type: "directRewardTransfer", settlementId: "dr1", ansemAtomic: 1_000_000n });
    simulator.apply({ type: "recognizeRewards", settlementId: "rec1", ansemAtomic: 1_000_000n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    expect(simulator.state.ansemEmittedAtomic).toBeGreaterThan(0n);
    expect(simulator.state.cowboyUnmaterializedLiabilityAtomic).toBe(0n);
    // The full emission is split 90/10; with no Cowboys, the 90% stays free and only the suit 10% is reserved.
    expect(simulator.state.suitVaultLiabilityAtomic).toBeGreaterThan(0n);
  });

  it("V2 config produces different reveal outcomes than V1 for the same deterministic random value", () => {
    let foundDifference = false;
    for (let seed = 0; seed < 64; seed++) {
      const v1Sim = new EconomicSimulator(config);
      const v2Sim = new EconomicSimulator(config);
      v2Sim.state.protocolConfigs.set(2n, PROTOCOL_CONFIG_V2);
      v2Sim.state.currentConfigVersion = 2n;

      v1Sim.apply({ type: "stake", settlementId: "s", positionId: "p", owner: "alice", openedAt: now });
      v2Sim.apply({ type: "stake", settlementId: "s", positionId: "p", owner: "alice", openedAt: now });

      const output = new Uint8Array(32).fill(seed);
      v1Sim.apply({ type: "reveal", settlementId: "r", positionId: "p", randomOutput: output });
      v2Sim.apply({ type: "reveal", settlementId: "r", positionId: "p", randomOutput: output });

      const p1 = v1Sim.state.positions.get("p")!;
      const p2 = v2Sim.state.positions.get("p")!;
      if (
        p1.role !== p2.role ||
        p1.suit !== p2.suit ||
        p1.bullTier !== p2.bullTier ||
        p1.accrualWeight !== p2.accrualWeight
      ) {
        foundDifference = true;
        break;
      }
    }
    expect(foundDifference).toBe(true);
  });
});
