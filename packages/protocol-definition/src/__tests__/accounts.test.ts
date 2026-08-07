import { describe, expect, it } from "vitest";
import { ACCOUNT_VERSIONS, type ProtocolConfig } from "../accounts.js";
import { PROTOCOL_CONFIG_V1 } from "../probabilities.js";

describe("account versions", () => {
  it("matches the Rust ACCOUNT_VERSION_* constants", () => {
    expect(ACCOUNT_VERSIONS.globalConfig).toBe(2);
    expect(ACCOUNT_VERSIONS.rewardState).toBe(3);
    expect(ACCOUNT_VERSIONS.globalGameState).toBe(3);
    expect(ACCOUNT_VERSIONS.bullAccumulator).toBe(3);
    expect(ACCOUNT_VERSIONS.position).toBe(4);
    expect(ACCOUNT_VERSIONS.walletClaimCooldown).toBe(1);
    expect(ACCOUNT_VERSIONS.pendingRandomness).toBe(4);
    expect(ACCOUNT_VERSIONS.protocolConfig).toBe(1);
  });

  it("does not contain removed or out-of-scope accounts", () => {
    expect("roleStatistics" in ACCOUNT_VERSIONS).toBe(false);
  });

  it("ProtocolConfig account type includes all on-chain fields in order", () => {
    const config: ProtocolConfig = {
      version: PROTOCOL_CONFIG_V1.version,
      globalConfig: PROTOCOL_CONFIG_V1.globalConfig,
      configVersion: PROTOCOL_CONFIG_V1.configVersion,
      roleWeights: PROTOCOL_CONFIG_V1.roleWeights,
      cowboyRankWeights: PROTOCOL_CONFIG_V1.cowboyRankWeights,
      bullTierWeights: PROTOCOL_CONFIG_V1.bullTierWeights,
      suitWeights: PROTOCOL_CONFIG_V1.suitWeights,
      mintTheftWeights: PROTOCOL_CONFIG_V1.mintTheftWeights,
      unstakeTheftWeights: PROTOCOL_CONFIG_V1.unstakeTheftWeights,
      cowboyAccrualWeights: PROTOCOL_CONFIG_V1.cowboyAccrualWeights,
      bullBuckPowers: PROTOCOL_CONFIG_V1.bullBuckPowers,
      minRevealsForTheft: PROTOCOL_CONFIG_V1.minRevealsForTheft,
      minBullsForTheft: PROTOCOL_CONFIG_V1.minBullsForTheft,
      unstakeTaxBps: PROTOCOL_CONFIG_V1.unstakeTaxBps,
      unstakeReturnBps: PROTOCOL_CONFIG_V1.unstakeReturnBps,
      bump: PROTOCOL_CONFIG_V1.bump,
      _reserved: PROTOCOL_CONFIG_V1._reserved,
    };

    expect(config.version).toBe(1);
    expect(config._reserved).toBeInstanceOf(Uint8Array);
    expect(config._reserved.length).toBe(64);
  });
});
