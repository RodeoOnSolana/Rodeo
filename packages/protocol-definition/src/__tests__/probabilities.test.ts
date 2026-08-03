import { describe, expect, it } from "vitest";
import {
  BULL_TIER_TABLE,
  COWBOY_RANK_TABLE,
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
