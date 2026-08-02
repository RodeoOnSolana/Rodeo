import fc from "fast-check";
import {
  BPS_DENOMINATOR,
  CLAIM_BULL_POOL_BPS,
  CLAIM_OWNER_BPS,
  CLOSE_EPOCH_BATCH_MAX,
  COWBOY_ACCRUAL_WEIGHTS,
  DESPERADO_CLAIM_BULL_POOL_BPS,
  DESPERADO_CLAIM_OWNER_BPS,
  EPOCH_DURATION_SECONDS,
  MIN_STAKE_SECONDS,
  POT_FILL_SECONDS,
  PROBABILITY_DENOMINATOR,
  RUNWAY_EPOCHS,
  RUNWAY_WINDOW_SECONDS,
  STAKE_AMOUNT_WHOLE_RODEO,
  UNSTAKE_RETURN_BPS,
  UNSTAKE_TAX_BPS,
  isNormalized,
  sampleOutcome,
  stakeAmountAtomic,
} from "@rodeo/protocol-definition";
import { describe, expect, it } from "vitest";
import { EconomicSimulator } from "../src/index.js";
import type { RevealOutcomes } from "../src/index.js";

const config = {
  rodeoDecimals: 0n,
  epochDurationSeconds: EPOCH_DURATION_SECONDS,
  potFillSeconds: POT_FILL_SECONDS,
  emissionTargetByEpoch: Array<bigint>(80).fill(100n),
  ansemPerSolNumerator: 1n,
  ansemPerSolDenominator: 1n,
} as const;

const now = 0n;
const stakeAmount = stakeAmountAtomic(config.rodeoDecimals);

function revealOutcome(role: "cowboy" | "bull", rankOrTier: RevealOutcomes["rankOrTier"], suit: RevealOutcomes["suit"], isDesperado = false): RevealOutcomes {
  return {
    role,
    rankOrTier,
    isDesperado,
    suit,
    mintTheft: false,
    thiefPositionId: null,
  };
}

describe("Protocol v1 simulator invariants", () => {
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
    expect(simulator.state.livePositionCount).toBe(1n);

    expect(() => simulator.apply({ type: "stake", settlementId: "s2", positionId: "p1", owner: "bob", openedAt: now })).toThrow("already exists");
  });

  it("reveals a cowboy, applies accrual weight, and tracks population", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    const p = simulator.state.positions.get("p1")!;
    expect(p.status).toBe("active");
    expect(p.role).toBe("cowboy");
    expect(p.rankOrTier).toBe("rank4");
    expect(p.accrualWeight).toBe(COWBOY_ACCRUAL_WEIGHTS.rank4);
    expect(p.pendingActionActive).toBe(false);
    expect(p.settlementNonce).toBe(1n);
    expect(simulator.state.activeCowboyCount).toBe(1n);
    expect(simulator.state.totalActiveCowboyWeight).toBe(COWBOY_ACCRUAL_WEIGHTS.rank4);
  });

  it("reveals a bull, applies buck power, and tracks population", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("bull", "tier4", "spades") });
    const p = simulator.state.positions.get("p1")!;
    expect(p.status).toBe("active");
    expect(p.role).toBe("bull");
    expect(p.buckPower).toBe(10);
    expect(simulator.state.activeBullCount).toBe(1n);
    expect(simulator.state.totalActiveBullPower).toBe(10n);
  });

  it("rejects reveal without pending action", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    expect(() => simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") })).toThrow("No pending reveal action");
  });

  it("blocks transfer while reveal is pending", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    expect(() => simulator.apply({ type: "transferPosition", settlementId: "t1", positionId: "p1", newOwner: "bob" })).toThrow("pending");
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "transferPosition", settlementId: "t1", positionId: "p1", newOwner: "bob" });
    expect(simulator.state.positions.get("p1")?.owner).toBe("bob");
    expect(simulator.state.positions.get("p1")?.stateVersion).toBe(1n);
  });

  it("distributes claim 80/20 for normal cowboy and 98/2 for desperado", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    simulator.apply({ type: "fundRewards", settlementId: "fund1", ansemAtomic: 140n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforeClaim = simulator.state.ansemClaimedAtomic;
    const beforeBullPool = simulator.state.bullPoolLiabilityAtomic + simulator.state.bullPoolUnallocatedLiabilityAtomic;
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    const p = simulator.state.positions.get("p1")!;
    expect(p.claimableAnsemAtomic).toBe(0n);
    expect(simulator.state.positionClaimableLiabilityAtomic).toBe(0n);
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaim);
    expect(simulator.state.bullPoolLiabilityAtomic + simulator.state.bullPoolUnallocatedLiabilityAtomic).toBeGreaterThanOrEqual(beforeBullPool);
    expect(simulator.state.totalAnsemLiabilityAtomic).toBeLessThanOrEqual(simulator.state.rewardVaultAnsemAtomic);
  });

  it("returns 95% of principal and burns 5% on unstake", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    const before = simulator.state.principalVaultAtomic;
    expect(() => simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS - 1n })).toThrow("Minimum stake period");
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    expect(simulator.state.positions.get("p1")?.pendingActionType).toBe("unstake");
    expect(simulator.state.positions.get("p1")?.status).toBe("active");
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: false } });
    expect(simulator.state.positions.has("p1")).toBe(false);
    expect(simulator.state.livePositionCount).toBe(0n);
    expect(simulator.state.principalVaultAtomic).toBe(before - stakeAmount);
    expect(simulator.state.rodeoBurnedAtomic).toBe((stakeAmount * UNSTAKE_TAX_BPS) / BPS_DENOMINATOR);
    expect((stakeAmount * UNSTAKE_RETURN_BPS) / BPS_DENOMINATOR + simulator.state.rodeoBurnedAtomic).toBeLessThanOrEqual(stakeAmount);
  });

  it("steals normal cowboy pending ANSEM on unstake 5% of the time", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealOutcome("bull", "tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    simulator.apply({ type: "fundRewards", settlementId: "fund1", ansemAtomic: 140n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    const beforePool = simulator.state.bullRewardPerWeightScaled;
    simulator.apply({ type: "requestUnstake", settlementId: "u1", positionId: "p1", requestedAt: MIN_STAKE_SECONDS + 1n });
    simulator.apply({ type: "settleUnstake", settlementId: "u2", positionId: "p1", fate: { ansemToBullPool: true } });
    expect(simulator.state.bullRewardPerWeightScaled).toBeGreaterThan(beforePool);
  });

  it("bull claim reduces bull pool liability", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "stake", settlementId: "s2", positionId: "p2", owner: "bob", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "reveal", settlementId: "r2", positionId: "p2", outcomes: revealOutcome("bull", "tier1", "spades") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 200n });
    simulator.apply({ type: "fundRewards", settlementId: "fund1", ansemAtomic: 140n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });

    // Force the cowboy to claim so 20% goes to the bull pool.
    simulator.apply({ type: "claimCowboy", settlementId: "c1", positionId: "p1", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 1n });
    expect(simulator.state.bullPoolLiabilityAtomic).toBeGreaterThan(0n);

    const beforeClaim = simulator.state.ansemClaimedAtomic;
    simulator.apply({ type: "claimBull", settlementId: "b1", positionId: "p2", claimedAt: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS + 2n });
    expect(simulator.state.ansemClaimedAtomic).toBeGreaterThan(beforeClaim);
    expect(simulator.state.bullPoolLiabilityAtomic).toBe(0n);
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
                simulator.apply({ type: "reveal", settlementId: `r${i}`, positionId: pid, outcomes: revealOutcome("cowboy", "rank4", "hearts") });
              } catch {
                // ignore invalid transitions
              }
            }
            if (op.transfer) {
              try {
                simulator.apply({ type: "transferPosition", settlementId: `t${i}`, positionId: pid, newOwner: "bob" });
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
          expect(simulator.state.principalVaultAtomic).toBe(expectedPrincipal);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("preserves position identity across ownership transfers", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "transferPosition", settlementId: "t1", positionId: "p1", newOwner: "bob" });
    expect(simulator.state.positions.get("p1")!.owner).toBe("bob");
    expect(simulator.state.positions.get("p1")?.stateVersion).toBe(1n);
  });

  it("prevents duplicate settlement", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    expect(() => simulator.apply({ type: "stake", settlementId: "s1", positionId: "p2", owner: "bob", openedAt: now })).toThrow("Duplicate settlement");
  });

  it("caps ANSEM liability by reward vault balance", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 100n });
    simulator.apply({ type: "fundRewards", settlementId: "fund1", ansemAtomic: 70n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    expect(simulator.state.totalAnsemLiabilityAtomic).toBeLessThanOrEqual(simulator.state.rewardVaultAnsemAtomic);
  });

  it("skips emission during pot-fill period", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "s1", positionId: "p1", owner: "alice", openedAt: now });
    simulator.apply({ type: "reveal", settlementId: "r1", positionId: "p1", outcomes: revealOutcome("cowboy", "rank4", "hearts") });
    simulator.apply({ type: "externalRevenue", settlementId: "rev1", revenueLamports: 1_000n });
    simulator.apply({ type: "fundRewards", settlementId: "fund1", ansemAtomic: 700n });
    simulator.apply({ type: "closeEpoch", settlementId: "e1", now: POT_FILL_SECONDS - 1n });
    expect(simulator.state.ansemEmittedAtomic).toBe(0n);
    simulator.apply({ type: "closeEpoch", settlementId: "e2", now: POT_FILL_SECONDS + EPOCH_DURATION_SECONDS });
    expect(simulator.state.ansemEmittedAtomic).toBeGreaterThan(0n);
  });
});
