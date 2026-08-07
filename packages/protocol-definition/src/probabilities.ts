import { createHash } from "node:crypto";
import {
  MIN_BULLS_FOR_THEFT,
  MIN_REVEALS_FOR_THEFT,
  PROBABILITY_DENOMINATOR,
  RANDOMNESS_DOMAIN_PREFIX,
  RandomnessDomain,
  REJECTION_SAMPLING_MAX_RETRIES,
  UNSTAKE_RETURN_BPS,
  UNSTAKE_TAX_BPS,
} from "./constants.js";
import type { ProtocolConfig } from "./accounts.js";

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
  return (
    table.denominator > 0n &&
    table.entries.length > 0 &&
    table.entries.every(({ weight }) => weight >= 0n) &&
    probabilityWeight(table) === table.denominator
  );
}

export type RoleOutcome = "cowboy" | "bull";
export type CowboyRankOutcome =
  | "rank4"
  | "rank5"
  | "rank6"
  | "rank7"
  | "rank8"
  | "rank9"
  | "rank10"
  | "desperado";
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

export const UNSTAKE_THEFT_FLAG_TABLE: ProbabilityTable<TheftFlagOutcome> =
  THEFT_FLAG_TABLE;

export type AccrualWeight = bigint;
export type BuckPower = number;

export const COWBOY_ACCRUAL_WEIGHTS: Record<CowboyRankOutcome, AccrualWeight> =
  {
    rank4: 10_000n,
    rank5: 10_500n,
    rank6: 11_000n,
    rank7: 11_800n,
    rank8: 12_800n,
    rank9: 14_000n,
    rank10: 15_500n,
    desperado: 10_000n,
  };

export const DESPERADO_ACCRUAL_WEIGHT = COWBOY_ACCRUAL_WEIGHTS.desperado;

export const BULL_BUCK_POWER: Record<BullTierOutcome, BuckPower> = {
  tier1: 4,
  tier2: 6,
  tier3: 8,
  tier4: 10,
};

const ROLE_ORDER: readonly RoleOutcome[] = ["cowboy", "bull"];

const COWBOY_RANK_ORDER: readonly CowboyRankOutcome[] = [
  "rank4",
  "rank5",
  "rank6",
  "rank7",
  "rank8",
  "rank9",
  "rank10",
  "desperado",
];

const BULL_TIER_ORDER: readonly BullTierOutcome[] = ["tier1", "tier2", "tier3", "tier4"];

const SUIT_ORDER: readonly SuitOutcome[] = ["hearts", "diamonds", "clubs", "spades"];

const THEFT_OUTCOME_ORDER: readonly TheftFlagOutcome[] = ["stolen", "safe"];

export function sumWeights(weights: readonly bigint[]): bigint {
  return weights.reduce((sum, w) => sum + w, 0n);
}

export function createProbabilityTable<Outcome extends string>(
  outcomes: readonly Outcome[],
  weights: readonly bigint[],
  denominator: bigint,
): ProbabilityTable<Outcome> {
  if (outcomes.length !== weights.length) {
    throw new Error("Outcome and weight arrays must have the same length");
  }
  const entries = outcomes.map((outcome, i) => ({ outcome, weight: weights[i] ?? 0n }));
  return { denominator, entries };
}

export const PROTOCOL_CONFIG_RESERVED_SIZE = 64;
export const DEFAULT_PROTOCOL_CONFIG_BUMP = 0;
export const ZERO_PROTOCOL_CONFIG_PUBKEY = "11111111111111111111111111111111";

export function createProtocolConfig(
  params: Partial<ProtocolConfig> & Pick<ProtocolConfig, "globalConfig" | "configVersion">,
): ProtocolConfig {
  const base: Omit<ProtocolConfig, "globalConfig" | "configVersion"> = {
    version: 1,
    roleWeights: ROLE_TABLE.entries.map((e) => e.weight),
    cowboyRankWeights: COWBOY_RANK_TABLE.entries.map((e) => e.weight),
    bullTierWeights: BULL_TIER_TABLE.entries.map((e) => e.weight),
    suitWeights: SUIT_TABLE.entries.map((e) => e.weight),
    mintTheftWeights: THEFT_FLAG_TABLE.entries.map((e) => e.weight),
    unstakeTheftWeights: UNSTAKE_THEFT_FLAG_TABLE.entries.map((e) => e.weight),
    cowboyAccrualWeights: COWBOY_RANK_ORDER.map((rank) => COWBOY_ACCRUAL_WEIGHTS[rank]),
    bullBuckPowers: BULL_TIER_ORDER.map((tier) => BULL_BUCK_POWER[tier]),
    minRevealsForTheft: MIN_REVEALS_FOR_THEFT,
    minBullsForTheft: MIN_BULLS_FOR_THEFT,
    unstakeTaxBps: UNSTAKE_TAX_BPS,
    unstakeReturnBps: UNSTAKE_RETURN_BPS,
    bump: DEFAULT_PROTOCOL_CONFIG_BUMP,
    _reserved: new Uint8Array(PROTOCOL_CONFIG_RESERVED_SIZE),
  };
  return { ...base, ...params };
}

/** V1 ProtocolConfig: reproduces the current on-chain default. */
export const PROTOCOL_CONFIG_V1: ProtocolConfig = createProtocolConfig({
  version: 1,
  globalConfig: ZERO_PROTOCOL_CONFIG_PUBKEY,
  configVersion: 1n,
});

/** V2 ProtocolConfig fixture: altered role, cowboy rank, and bull tier distributions. */
export const PROTOCOL_CONFIG_V2: ProtocolConfig = createProtocolConfig({
  globalConfig: ZERO_PROTOCOL_CONFIG_PUBKEY,
  configVersion: 2n,
  roleWeights: [4_500_000n, 5_500_000n],
  cowboyRankWeights: [
    2_023_875n,
    1_124_375n,
    584_675n,
    359_800n,
    224_875n,
    134_925n,
    44_975n,
    2_500n,
  ],
  bullTierWeights: [3_300_000n, 1_375_000n, 550_000n, 275_000n],
});

export function protocolConfigToRoleTable(
  config: ProtocolConfig,
): ProbabilityTable<RoleOutcome> {
  return createProbabilityTable(ROLE_ORDER, config.roleWeights, PROBABILITY_DENOMINATOR);
}

export function protocolConfigToCowboyRankTable(
  config: ProtocolConfig,
): ProbabilityTable<CowboyRankOutcome> {
  return createProbabilityTable(
    COWBOY_RANK_ORDER,
    config.cowboyRankWeights,
    sumWeights(config.cowboyRankWeights),
  );
}

export function protocolConfigToBullTierTable(
  config: ProtocolConfig,
): ProbabilityTable<BullTierOutcome> {
  return createProbabilityTable(
    BULL_TIER_ORDER,
    config.bullTierWeights,
    sumWeights(config.bullTierWeights),
  );
}

export function protocolConfigToSuitTable(
  config: ProtocolConfig,
): ProbabilityTable<SuitOutcome> {
  return createProbabilityTable(SUIT_ORDER, config.suitWeights, PROBABILITY_DENOMINATOR);
}

export function protocolConfigToMintTheftTable(
  config: ProtocolConfig,
): ProbabilityTable<TheftFlagOutcome> {
  return createProbabilityTable(THEFT_OUTCOME_ORDER, config.mintTheftWeights, PROBABILITY_DENOMINATOR);
}

export function protocolConfigToUnstakeTheftTable(
  config: ProtocolConfig,
): ProbabilityTable<TheftFlagOutcome> {
  return createProbabilityTable(
    THEFT_OUTCOME_ORDER,
    config.unstakeTheftWeights,
    PROBABILITY_DENOMINATOR,
  );
}

export function accrualWeightForCowboyIndex(config: ProtocolConfig, index: number): bigint {
  if (index < 0 || index >= config.cowboyAccrualWeights.length) {
    throw new RangeError("Cowboy index out of range");
  }
  return config.cowboyAccrualWeights[index];
}

export function buckPowerForTier(config: ProtocolConfig, tier: number): number {
  if (tier < 1 || tier > config.bullBuckPowers.length) {
    throw new RangeError("Bull tier out of range");
  }
  return config.bullBuckPowers[tier - 1];
}

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

export function outcomeIndexForDraw<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
  draw: bigint,
): number {
  if (draw < 0n || draw >= table.denominator) {
    throw new RangeError("Probability draw out of range");
  }
  let cumulative = 0n;
  for (let i = 0; i < table.entries.length; i++) {
    cumulative += table.entries[i].weight;
    if (draw < cumulative) return i;
  }
  throw new Error("Probability table is not normalized");
}

export interface RejectionSampleContext {
  readonly randomOutput: Uint8Array;
  readonly domain: RandomnessDomain;
  readonly position: Uint8Array;
  readonly actionNonce: bigint;
}

/**
 * Build the canonical preimage shared with the Rust program.
 * Layout (99 bytes total):
 *   [0..18]    RANDOMNESS_DOMAIN_PREFIX (18 bytes)
 *   [18]       domain discriminant (1 byte)
 *   [19..51]   randomOutput (32 bytes)
 *   [51..83]   position pubkey (32 bytes)
 *   [83..91]   actionNonce as little-endian u64 (8 bytes)
 *   [91..99]   retryCounter as little-endian u64 (8 bytes)
 */
export function buildRejectionPreimage(
  context: RejectionSampleContext,
  retryCounter: bigint,
): Buffer {
  if (context.randomOutput.length !== 32) {
    throw new RangeError("randomOutput must be 32 bytes");
  }
  if (context.position.length !== 32) {
    throw new RangeError("position must be 32 bytes");
  }
  const preimage = Buffer.alloc(100);
  let offset = 0;

  Buffer.from(RANDOMNESS_DOMAIN_PREFIX).copy(preimage, offset);
  offset += RANDOMNESS_DOMAIN_PREFIX.length;

  preimage.writeUInt8(context.domain, offset);
  offset += 1;

  Buffer.from(context.randomOutput).copy(preimage, offset);
  offset += 32;

  Buffer.from(context.position).copy(preimage, offset);
  offset += 32;

  preimage.writeBigUInt64LE(context.actionNonce & 0xffffffffffffffffn, offset);
  offset += 8;

  preimage.writeBigUInt64LE(retryCounter & 0xffffffffffffffffn, offset);
  offset += 8;

  if (offset !== 100) {
    throw new Error("Unexpected preimage length");
  }
  return preimage;
}

/**
 * Deterministic rejection sampling that returns an exactly uniform integer in
 * [0, denominator - 1]. The output is bound to the domain, position, action nonce
 * and a deterministic retry counter so the same random bytes cannot be reused
 * across domains. Retries are bounded.
 */
export function rejectionSampleDraw(
  table: ProbabilityTable<string>,
  context: RejectionSampleContext,
): bigint {
  if (!isNormalized(table)) {
    throw new Error("Probability table is not normalized");
  }

  const denominator = table.denominator;
  const rangeSize = 1n << 64n;
  const limit = rangeSize - (rangeSize % denominator);

  for (let retry = 0n; retry < BigInt(REJECTION_SAMPLING_MAX_RETRIES); retry += 1n) {
    const preimage = buildRejectionPreimage(context, retry);
    const digest = createHash("sha256").update(preimage).digest();

    for (let chunkIndex = 0; chunkIndex < 4; chunkIndex += 1) {
      const start = chunkIndex * 8;
      const candidate = BigInt(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        `0x${digest.subarray(start, start + 8).toString("hex")}`,
      );
      if (candidate < limit) {
        return candidate % denominator;
      }
    }
  }

  throw new Error("Rejection sampling exceeded safety limit");
}

export function mapRole(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): RoleOutcome {
  const table = protocolConfigToRoleTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw);
}

export function mapCowboyKind(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): CowboyRankOutcome {
  const table = protocolConfigToCowboyRankTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw);
}

export function mapBullTier(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): BullTierOutcome {
  const table = protocolConfigToBullTierTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw);
}

export function mapSuit(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): SuitOutcome {
  const table = protocolConfigToSuitTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw);
}

export function mapMintTheftFlag(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): boolean {
  const table = protocolConfigToMintTheftTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw) === "stolen";
}

export function mapUnstakeTheftFlag(
  context: RejectionSampleContext,
  config: ProtocolConfig = PROTOCOL_CONFIG_V1,
): boolean {
  const table = protocolConfigToUnstakeTheftTable(config);
  const draw = rejectionSampleDraw(table, context);
  return sampleOutcome(table, draw) === "stolen";
}

export function cowboyRankToIndex(rank: CowboyRankOutcome): number {
  const idx = COWBOY_RANK_ORDER.indexOf(rank);
  if (idx < 0) throw new RangeError(`Unknown cowboy rank: ${rank}`);
  return idx;
}

export function bullTierToIndex(tier: BullTierOutcome): number {
  const idx = BULL_TIER_ORDER.indexOf(tier);
  if (idx < 0) throw new RangeError(`Unknown bull tier: ${tier}`);
  return idx;
}
