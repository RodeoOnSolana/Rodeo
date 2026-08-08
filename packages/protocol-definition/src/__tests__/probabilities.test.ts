import { describe, expect, it } from "vitest";
import {
  BULL_TIER_TABLE,
  COWBOY_RANK_TABLE,
  PROTOCOL_CONFIG_V1,
  PROTOCOL_CONFIG_V2,
  ROLE_TABLE,
  SUIT_TABLE,
  THEFT_FLAG_TABLE,
  UNSTAKE_THEFT_FLAG_TABLE,
  buildRejectionPreimage,
  isNormalized,
  mapBullTier,
  mapCowboyKind,
  mapMintTheftFlag,
  mapRole,
  mapSuit,
  mapUnstakeTheftFlag,
  outcomeIndexForDraw,
  protocolConfigToBullTierTable,
  protocolConfigToCowboyRankTable,
  protocolConfigToMintTheftTable,
  protocolConfigToRoleTable,
  protocolConfigToSuitTable,
  protocolConfigToUnstakeTheftTable,
  rejectionSampleDraw,
} from "../probabilities.js";
import {
  PROBABILITY_DENOMINATOR,
  RandomnessDomain,
  RANDOMNESS_DOMAIN_PREFIX,
} from "../constants.js";

function pubkeyBytes(n: number): Uint8Array {
  return new Uint8Array(32).fill(n);
}

function makeContext(
  domain: RandomnessDomain,
  tag: number,
): ReturnType<typeof buildRejectionPreimage> extends Buffer
  ? { randomOutput: Uint8Array; domain: RandomnessDomain; position: Uint8Array; actionNonce: bigint }
  : never {
  return {
    randomOutput: new Uint8Array(32).fill(tag + 1),
    domain,
    position: pubkeyBytes(tag + 7),
    actionNonce: BigInt(tag),
  };
}

describe("probability tables", () => {
  it("tables are normalized", () => {
    for (const table of [
      ROLE_TABLE,
      COWBOY_RANK_TABLE,
      BULL_TIER_TABLE,
      SUIT_TABLE,
      THEFT_FLAG_TABLE,
      UNSTAKE_THEFT_FLAG_TABLE,
    ]) {
      expect(isNormalized(table)).toBe(true);
    }
  });

  it("role boundary intervals", () => {
    expect(outcomeIndexForDraw(ROLE_TABLE, 0n)).toBe(0);
    expect(outcomeIndexForDraw(ROLE_TABLE, 8_999_999n)).toBe(0);
    expect(outcomeIndexForDraw(ROLE_TABLE, 9_000_000n)).toBe(1);
    expect(outcomeIndexForDraw(ROLE_TABLE, 9_999_999n)).toBe(1);
  });

  it("cowboy rank and desperado boundary intervals", () => {
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 0n)).toBe(0);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 4_047_749n)).toBe(0);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 4_047_750n)).toBe(1);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 4_047_750n + 2_248_749n)).toBe(1);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 4_047_750n + 2_248_750n)).toBe(2);
    const cumulativeBeforeDesperado = 9_000_000n - 5_000n;
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, cumulativeBeforeDesperado - 1n)).toBe(6);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, cumulativeBeforeDesperado)).toBe(7);
    expect(outcomeIndexForDraw(COWBOY_RANK_TABLE, 8_999_999n)).toBe(7);
  });

  it("bull tier boundary intervals", () => {
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 0n)).toBe(0);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 599_999n)).toBe(0);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 600_000n)).toBe(1);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 849_999n)).toBe(1);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 850_000n)).toBe(2);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 949_999n)).toBe(2);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 950_000n)).toBe(3);
    expect(outcomeIndexForDraw(BULL_TIER_TABLE, 999_999n)).toBe(3);
  });

  it("suit boundary intervals", () => {
    expect(outcomeIndexForDraw(SUIT_TABLE, 0n)).toBe(0);
    expect(outcomeIndexForDraw(SUIT_TABLE, 2_499_999n)).toBe(0);
    expect(outcomeIndexForDraw(SUIT_TABLE, 2_500_000n)).toBe(1);
    expect(outcomeIndexForDraw(SUIT_TABLE, 4_999_999n)).toBe(1);
    expect(outcomeIndexForDraw(SUIT_TABLE, 5_000_000n)).toBe(2);
    expect(outcomeIndexForDraw(SUIT_TABLE, 7_499_999n)).toBe(2);
    expect(outcomeIndexForDraw(SUIT_TABLE, 7_500_000n)).toBe(3);
    expect(outcomeIndexForDraw(SUIT_TABLE, 9_999_999n)).toBe(3);
  });

  it("mint and unstake theft boundary intervals", () => {
    for (const table of [THEFT_FLAG_TABLE, UNSTAKE_THEFT_FLAG_TABLE]) {
      expect(outcomeIndexForDraw(table, 0n)).toBe(0);
      expect(outcomeIndexForDraw(table, 499_999n)).toBe(0);
      expect(outcomeIndexForDraw(table, 500_000n)).toBe(1);
      expect(outcomeIndexForDraw(table, 9_999_999n)).toBe(1);
    }
  });
});

describe("canonical rejection sampling", () => {
  it("preimage length equals the canonical layout", () => {
    const ctx = makeContext(RandomnessDomain.Role, 4);
    const preimage = buildRejectionPreimage(ctx, 0n);
    expect(preimage.length).toBe(100);
    expect(preimage.subarray(0, RANDOMNESS_DOMAIN_PREFIX.length).toString()).toBe(
      Buffer.from(RANDOMNESS_DOMAIN_PREFIX).toString(),
    );
    expect(preimage[RANDOMNESS_DOMAIN_PREFIX.length]).toBe(RandomnessDomain.Role);
  });

  it("returns a draw inside [0, denominator)", () => {
    const ctx = makeContext(RandomnessDomain.Role, 4);
    const draw = rejectionSampleDraw(ROLE_TABLE, ctx);
    expect(draw >= 0n && draw < PROBABILITY_DENOMINATOR).toBe(true);
  });

  it("map helpers are deterministic", () => {
    const roleCtx = makeContext(RandomnessDomain.Role, 4);
    const cowboyCtx = makeContext(RandomnessDomain.CowboyKind, 5);
    const bullCtx = makeContext(RandomnessDomain.BullTier, 6);
    const suitCtx = makeContext(RandomnessDomain.Suit, 7);
    const mintTheftCtx = makeContext(RandomnessDomain.MintTheft, 2);
    const unstakeTheftCtx = makeContext(RandomnessDomain.UnstakeTheft, 3);

    expect(mapRole(roleCtx)).toBe(mapRole(roleCtx));
    expect(mapCowboyKind(cowboyCtx)).toBe(mapCowboyKind(cowboyCtx));
    expect(mapBullTier(bullCtx)).toBe(mapBullTier(bullCtx));
    expect(mapSuit(suitCtx)).toBe(mapSuit(suitCtx));
    expect(mapMintTheftFlag(mintTheftCtx)).toBe(mapMintTheftFlag(mintTheftCtx));
    expect(mapUnstakeTheftFlag(unstakeTheftCtx)).toBe(mapUnstakeTheftFlag(unstakeTheftCtx));
  });

  it("matches Rust golden vectors", () => {
    const vectors = [
      { domain: RandomnessDomain.Reveal, tag: 0, denominator: 10_000_000n, draw: 7_594_516n },
      { domain: RandomnessDomain.Unstake, tag: 1, denominator: 10_000_000n, draw: 9_569_442n },
      { domain: RandomnessDomain.MintTheft, tag: 2, denominator: 10_000_000n, draw: 8_120_026n },
      { domain: RandomnessDomain.UnstakeTheft, tag: 3, denominator: 10_000_000n, draw: 4_556_769n },
      { domain: RandomnessDomain.Role, tag: 4, denominator: 10_000_000n, draw: 1_865_101n },
      { domain: RandomnessDomain.CowboyKind, tag: 5, denominator: 9_000_000n, draw: 6_521_817n },
      { domain: RandomnessDomain.BullTier, tag: 6, denominator: 1_000_000n, draw: 813_273n },
      { domain: RandomnessDomain.Suit, tag: 7, denominator: 10_000_000n, draw: 6_972_047n },
    ] as const;

    for (const { domain, tag, denominator, draw } of vectors) {
      const ctx = makeContext(domain, tag);
      // Use a dummy table with the same denominator so the raw draw can be compared.
      const table = { denominator, entries: [{ outcome: "only", weight: denominator }] };
      const sampled = rejectionSampleDraw(table, ctx);
      expect(sampled).toBe(draw);
    }
  });
});

describe("ProtocolConfig fixtures", () => {
  it("V1 ProtocolConfig matches the on-chain default exactly", () => {
    expect(PROTOCOL_CONFIG_V1.version).toBe(1);
    expect(PROTOCOL_CONFIG_V1.globalConfig).toBe("11111111111111111111111111111111");
    expect(PROTOCOL_CONFIG_V1.configVersion).toBe(1n);
    expect(PROTOCOL_CONFIG_V1.roleWeights).toEqual([9_000_000n, 1_000_000n]);
    expect(PROTOCOL_CONFIG_V1.cowboyRankWeights).toEqual([
      4_047_750n,
      2_248_750n,
      1_169_350n,
      719_600n,
      449_750n,
      269_850n,
      89_950n,
      5_000n,
    ]);
    expect(PROTOCOL_CONFIG_V1.bullTierWeights).toEqual([600_000n, 250_000n, 100_000n, 50_000n]);
    expect(PROTOCOL_CONFIG_V1.suitWeights).toEqual([2_500_000n, 2_500_000n, 2_500_000n, 2_500_000n]);
    expect(PROTOCOL_CONFIG_V1.mintTheftWeights).toEqual([500_000n, 9_500_000n]);
    expect(PROTOCOL_CONFIG_V1.unstakeTheftWeights).toEqual([500_000n, 9_500_000n]);
    expect(PROTOCOL_CONFIG_V1.cowboyAccrualWeights).toEqual([
      10_000n,
      10_500n,
      11_000n,
      11_800n,
      12_800n,
      14_000n,
      15_500n,
      10_000n,
    ]);
    expect(PROTOCOL_CONFIG_V1.bullBuckPowers).toEqual([4, 6, 8, 10]);
    expect(PROTOCOL_CONFIG_V1.minRevealsForTheft).toBe(50n);
    expect(PROTOCOL_CONFIG_V1.minBullsForTheft).toBe(3n);
    expect(PROTOCOL_CONFIG_V1.unstakeTaxBps).toBe(500n);
    expect(PROTOCOL_CONFIG_V1.unstakeReturnBps).toBe(9_500n);
    expect(PROTOCOL_CONFIG_V1.bump).toBe(0);
    expect(PROTOCOL_CONFIG_V1._reserved).toBeInstanceOf(Uint8Array);
    expect(PROTOCOL_CONFIG_V1._reserved.length).toBe(64);
  });

  it("V2 ProtocolConfig has the expected override fields", () => {
    expect(PROTOCOL_CONFIG_V2.configVersion).toBe(2n);
    expect(PROTOCOL_CONFIG_V2.roleWeights).toEqual([4_500_000n, 5_500_000n]);
    expect(PROTOCOL_CONFIG_V2.cowboyRankWeights).toEqual([
      2_023_875n,
      1_124_375n,
      584_675n,
      359_800n,
      224_875n,
      134_925n,
      44_975n,
      2_500n,
    ]);
    expect(PROTOCOL_CONFIG_V2.bullTierWeights).toEqual([
      3_300_000n,
      1_375_000n,
      550_000n,
      275_000n,
    ]);
    expect(PROTOCOL_CONFIG_V2.suitWeights).toEqual(PROTOCOL_CONFIG_V1.suitWeights);
    expect(PROTOCOL_CONFIG_V2.mintTheftWeights).toEqual(PROTOCOL_CONFIG_V1.mintTheftWeights);
    expect(PROTOCOL_CONFIG_V2.unstakeTheftWeights).toEqual([5_000_000n, 5_000_000n]);
    expect(PROTOCOL_CONFIG_V2.cowboyAccrualWeights).toEqual(PROTOCOL_CONFIG_V1.cowboyAccrualWeights);
    expect(PROTOCOL_CONFIG_V2.bullBuckPowers).toEqual(PROTOCOL_CONFIG_V1.bullBuckPowers);
  });

  it("versioned tables derived from V1 are normalized", () => {
    expect(isNormalized(protocolConfigToRoleTable(PROTOCOL_CONFIG_V1))).toBe(true);
    expect(isNormalized(protocolConfigToCowboyRankTable(PROTOCOL_CONFIG_V1))).toBe(true);
    expect(isNormalized(protocolConfigToBullTierTable(PROTOCOL_CONFIG_V1))).toBe(true);
    expect(isNormalized(protocolConfigToSuitTable(PROTOCOL_CONFIG_V1))).toBe(true);
    expect(isNormalized(protocolConfigToMintTheftTable(PROTOCOL_CONFIG_V1))).toBe(true);
    expect(isNormalized(protocolConfigToUnstakeTheftTable(PROTOCOL_CONFIG_V1))).toBe(true);
  });

  it("versioned tables derived from V2 are normalized", () => {
    expect(isNormalized(protocolConfigToRoleTable(PROTOCOL_CONFIG_V2))).toBe(true);
    expect(isNormalized(protocolConfigToCowboyRankTable(PROTOCOL_CONFIG_V2))).toBe(true);
    expect(isNormalized(protocolConfigToBullTierTable(PROTOCOL_CONFIG_V2))).toBe(true);
    expect(isNormalized(protocolConfigToSuitTable(PROTOCOL_CONFIG_V2))).toBe(true);
    expect(isNormalized(protocolConfigToMintTheftTable(PROTOCOL_CONFIG_V2))).toBe(true);
    expect(isNormalized(protocolConfigToUnstakeTheftTable(PROTOCOL_CONFIG_V2))).toBe(true);
  });

  it("V2 produces different role and rank outcomes than V1 for the same random context", () => {
    const output = new Uint8Array(32);
    for (let i = 0; i < 32; i++) output[i] = i;
    const position = new Uint8Array(32);
    position[0] = 1;

    const ctx = {
      randomOutput: output,
      domain: RandomnessDomain.Role,
      position,
      actionNonce: 1n,
    };

    const v1Role = mapRole(ctx, PROTOCOL_CONFIG_V1);
    const v2Role = mapRole(ctx, PROTOCOL_CONFIG_V2);
    expect(v1Role).not.toBe(v2Role);
  });
});
