import { describe, expect, it } from "vitest";
import { ACCOUNT_VERSIONS } from "../accounts.js";

describe("account versions", () => {
  it("matches the Rust ACCOUNT_VERSION_* constants", () => {
    expect(ACCOUNT_VERSIONS.globalConfig).toBe(1);
    expect(ACCOUNT_VERSIONS.rewardState).toBe(3);
    expect(ACCOUNT_VERSIONS.globalGameState).toBe(3);
    expect(ACCOUNT_VERSIONS.bullAccumulator).toBe(3);
    expect(ACCOUNT_VERSIONS.position).toBe(3);
    expect(ACCOUNT_VERSIONS.walletClaimCooldown).toBe(1);
    expect(ACCOUNT_VERSIONS.pendingRandomness).toBe(3);
  });

  it("does not contain removed or out-of-scope accounts", () => {
    expect("roleStatistics" in ACCOUNT_VERSIONS).toBe(false);
  });
});
