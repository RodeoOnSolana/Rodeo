import { PROBABILITY_DENOMINATOR } from "./constants.js";

export interface ProbabilityEntry<Outcome extends string = string> {
  readonly outcome: Outcome;
  readonly weight: bigint;
}

export interface ProbabilityTable<Outcome extends string = string> {
  readonly denominator: bigint;
  readonly entries: readonly ProbabilityEntry<Outcome>[];
}

export function probabilityWeight<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
): bigint {
  return table.entries.reduce((sum, entry) => sum + entry.weight, 0n);
}

export function isNormalized<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
): boolean {
  return table.denominator > 0n &&
    table.entries.length > 0 &&
    table.entries.every(({ weight }) => weight >= 0n) &&
    probabilityWeight(table) === table.denominator;
}

export type RoleOutcome = "cowboy" | "bull";
export type CowboyRankOutcome = "rank4" | "rank5" | "rank6" | "rank7" | "rank8" | "rank9" | "rank10" | "desperado";
export type BullTierOutcome = "tier1" | "tier2" | "tier3" | "tier4";
export type SuitOutcome = "hearts" | "diamonds" | "clubs" | "spades";
export type TheftFlagOutcome = "stolen" | "safe";

export const ROLE_TABLE: ProbabilityTable<RoleOutcome> = {
  denominator: PROBABILITY_DENOMINATOR,
  entries: [
    { outcome: "cowboy", weight: 9_000_000n },
    { outcome: "bull", weight: 1_000_000n },
  ],
};

export const COWBOY_RANK_TABLE: ProbabilityTable<CowboyRankOutcome> = {
  denominator: 9_000_000n,
  entries: [
    { outcome: "rank4", weight: 4_047_750n },
    { outcome: "rank5", weight: 2_248_750n },
    { outcome: "rank6", weight: 1_169_350n },
    { outcome: "rank7", weight: 719_600n },
    { outcome: "rank8", weight: 449_750n },
    { outcome: "rank9", weight: 269_850n },
    { outcome: "rank10", weight: 89_950n },
    { outcome: "desperado", weight: 5_000n },
  ],
};

export const BULL_TIER_TABLE: ProbabilityTable<BullTierOutcome> = {
  denominator: 1_000_000n,
  entries: [
    { outcome: "tier1", weight: 600_000n },
    { outcome: "tier2", weight: 250_000n },
    { outcome: "tier3", weight: 100_000n },
    { outcome: "tier4", weight: 50_000n },
  ],
};

export const SUIT_TABLE: ProbabilityTable<SuitOutcome> = {
  denominator: PROBABILITY_DENOMINATOR,
  entries: [
    { outcome: "hearts", weight: 2_500_000n },
    { outcome: "diamonds", weight: 2_500_000n },
    { outcome: "clubs", weight: 2_500_000n },
    { outcome: "spades", weight: 2_500_000n },
  ],
};

export const THEFT_FLAG_TABLE: ProbabilityTable<TheftFlagOutcome> = {
  denominator: PROBABILITY_DENOMINATOR,
  entries: [
    { outcome: "stolen", weight: 500_000n },
    { outcome: "safe", weight: 9_500_000n },
  ],
};

export const UNSTAKE_THEFT_FLAG_TABLE: ProbabilityTable<TheftFlagOutcome> = THEFT_FLAG_TABLE;

export type AccrualWeight = bigint;
export type BuckPower = number;

export const COWBOY_ACCRUAL_WEIGHTS: Record<CowboyRankOutcome, AccrualWeight> = {
  rank4: 10_000n,
  rank5: 10_500n,
  rank6: 11_000n,
  rank7: 11_800n,
  rank8: 12_800n,
  rank9: 14_000n,
  rank10: 15_500n,
  desperado: 10_000n,
};

export const BULL_BUCK_POWER: Record<BullTierOutcome, BuckPower> = {
  tier1: 4,
  tier2: 6,
  tier3: 8,
  tier4: 10,
};

export function sampleOutcome<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
  draw: bigint,
): Outcome {
  if (draw < 0n || draw >= table.denominator) {
    throw new RangeError("Probability draw out of range");
  }
  let cumulative = 0n;
  for (const entry of table.entries) {
    cumulative += entry.weight;
    if (draw < cumulative) return entry.outcome;
  }
  throw new Error("Probability table is not normalized");
}
