const crypto = require("crypto");
function disc(name) {
  return Buffer.from(crypto.createHash("sha256").update("global:" + name).digest().slice(0, 8));
}
const names = [
  "test_fixture_set_global_game_state",
  "test_fixture_set_reward_state",
  "test_fixture_set_bull_registry",
  "test_fixture_create_receipt_funder",
  "test_fixture_close_receipt_funder",
  "test_fixture_initialize_protocol_accounts",
  "test_fixture_set_bull_proof_buffer_snapshot",
  "test_fixture_finalize_bull_proof_buffer",
];
for (const n of names) {
  console.log(n, disc(n).toString("hex"));
}
