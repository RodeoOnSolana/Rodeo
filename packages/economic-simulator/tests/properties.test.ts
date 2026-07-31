import fc from "fast-check";
import { EPOCH_DURATION_SECONDS, RUNWAY_WINDOW_SECONDS, isNormalized } from "@rodeo/protocol-definition";
import { describe, expect, it } from "vitest";
import { EconomicSimulator } from "../src/index.js";

const config = {
  epochDurationSeconds: EPOCH_DURATION_SECONDS,
  runwayWindowSeconds: RUNWAY_WINDOW_SECONDS,
  emissionTargetByEpoch: Array<bigint>(80).fill(100n),
  ansemPerRevenueNumerator: 1n,
  ansemPerRevenueDenominator: 1n,
} as const;

describe("Phase 0 invariant scaffolding", () => {
  it("normalizes probability tables exactly in integer units", () => {
    fc.assert(fc.property(
      fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 32 }),
      (weights) => {
        const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
        const table = { denominator, entries: weights.map((weight, index) => ({ outcome: String(index), weight })) };
        expect(isNormalized(table)).toBe(denominator > 0n);
        expect(isNormalized({ ...table, denominator: denominator + 1n })).toBe(false);
      },
    ));
  });

  it("reconciles all RODEO principal to positions", () => {
    fc.assert(fc.property(
      fc.array(fc.bigInt({ min: 1n, max: 1_000_000_000n }), { minLength: 1, maxLength: 50 }),
      (amounts) => {
        const simulator = new EconomicSimulator(config);
        amounts.forEach((principalAtomic, index) => simulator.apply({
          type: "stake",
          settlementId: `stake-${index}`,
          positionId: `position-${index}`,
          owner: `owner-${index}`,
          role: index % 2 === 0 ? "cowboy" : "bull",
          principalAtomic,
        }));
        expect(simulator.state.principalVaultAtomic).toBe(amounts.reduce((sum, amount) => sum + amount, 0n));
        expect(() => simulator.assertInvariants()).not.toThrow();
      },
    ));
  });

  it("prevents duplicate settlement", () => {
    const simulator = new EconomicSimulator(config);
    const event = { type: "stake", settlementId: "same", positionId: "p", owner: "a", role: "cowboy", principalAtomic: 1n } as const;
    simulator.apply(event);
    expect(() => simulator.apply(event)).toThrow("Duplicate settlement");
  });

  it("requires vault backing before ANSEM liability allocation", () => {
    const simulator = new EconomicSimulator(config);
    simulator.apply({ type: "stake", settlementId: "stake", positionId: "p", owner: "a", role: "bull", principalAtomic: 1n });
    expect(() => simulator.apply({ type: "allocateReward", settlementId: "allocation", positionId: "p", ansemAtomic: 1n })).toThrow("not vault-backed");
    simulator.apply({ type: "fundRewards", settlementId: "fund", ansemAtomic: 10n });
    simulator.apply({ type: "allocateReward", settlementId: "backed", positionId: "p", ansemAtomic: 10n });
    expect(simulator.state.rewardVaultAnsemAtomic).toBe(simulator.state.ansemLiabilityAtomic);
  });

  it("moves a position between exactly one owner at a time", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 30 }),
      (owners) => {
        const simulator = new EconomicSimulator(config);
        simulator.apply({ type: "stake", settlementId: "stake", positionId: "p", owner: "initial", role: "cowboy", principalAtomic: 1n });
        owners.forEach((newOwner, index) => simulator.apply({
          type: "transferPosition",
          settlementId: `transfer-${index}`,
          positionId: "p",
          newOwner,
        }));
        expect(simulator.state.positions.get("p")?.owner).toBe(owners.at(-1));
        expect(simulator.state.positions.size).toBe(1);
      },
    ));
  });
});
