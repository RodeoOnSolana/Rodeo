#!/usr/bin/env bash
set -uo pipefail

# Run the production-size BullProofBuffer regression test against a real SBF
# program built with the production 16,384-byte MAX_PAYLOAD (no test-fixtures).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_BASE="/tmp/rodeo-localnet-prod-buffer-ledger"
WALLET="${HOME}/.config/solana/id.json"

export PATH="/home/rodeosolana/.cargo/bin:/home/rodeosolana/.local/bin:/home/rodeosolana/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

BUILD_FEATURES="mock-randomness,test-short-timeout"
TEST_FILE="localnet-production-buffer.test.ts"

wait_for_health() {
  local rpc_url="$1"
  for _ in $(seq 1 60); do
    if curl -sS --max-time 2 "${rpc_url}" -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_rpc_ready() {
  local rpc_url="$1"
  for _ in $(seq 1 60); do
    if curl -sS --max-time 2 "${rpc_url}" -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | grep -q '"result"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_ws() {
  local ws_port="$1"
  for _ in $(seq 1 60); do
    local ws_out
    ws_out=$(curl -sS --max-time 1 -i -N \
      -H 'Upgrade: websocket' \
      -H 'Connection: Upgrade' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H 'Sec-WebSocket-Version: 13' \
      "http://127.0.0.1:${ws_port}" 2>/dev/null || true)
    if grep -q '101 Switching' <<< "$ws_out"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

kill_validator() {
  pkill -9 -f 'solana-test-validator' >/dev/null 2>&1 || true
  pkill -9 -f 'solana logs' >/dev/null 2>&1 || true
  pkill -9 -f 'solana faucet' >/dev/null 2>&1 || true

  for _ in $(seq 1 30); do
    if pgrep -f 'solana-test-validator' >/dev/null 2>&1; then
      sleep 1
    else
      break
    fi
  done

  rm -rf "${ROOT}/.anchor/test-ledger" "${LEDGER_BASE}"-*
}

# Clean up anything left over from an aborted run.
kill_validator

BASE_PORT=$((RANDOM % 10000 + 20000))
WS_PORT=$((BASE_PORT + 1))
FAUCET_PORT=$((BASE_PORT + 1000))
RPC_URL="http://127.0.0.1:${BASE_PORT}"
LEDGER="${LEDGER_BASE}-${BASE_PORT}"

rm -rf "${LEDGER}"
mkdir -p "${LEDGER}"

cd "${ROOT}"

if ! pnpm program-keys:localnet >/dev/null 2>&1; then
  echo "ERROR: program-keys:localnet failed" >&2
  exit 1
fi

# Make the test wallet the upgrade authority (and mint) for this fresh localnet.
# The production initialize_protocol instruction checks that the signer is the
# program's upgrade authority, so this must match the ANCHOR_WALLET used below.
PAYER_PUBKEY="$(solana-keygen pubkey "${WALLET}")"

echo "===> Building production SBF with MAX_PAYLOAD=16,384 (features: ${BUILD_FEATURES})"
if ! scripts/check-sbf-stack-safety.sh anchor build -p rodeo_core -- --features "${BUILD_FEATURES}"; then
  echo "ERROR: production buffer SBF build failed" >&2
  exit 1
fi
# Anchor's SBF step does not consistently apply --features, so rebuild the .so
# explicitly with cargo-build-sbf and overwrite the deploy artifact.
SBF_FEATURES="${BUILD_FEATURES//,/ }"
if ! cargo build-sbf --manifest-path "${ROOT}/programs/rodeo_core/Cargo.toml" --features "${SBF_FEATURES}"; then
  echo "ERROR: cargo build-sbf failed for ${SUITE} with features ${BUILD_FEATURES}" >&2
  exit 1
fi
SBF_OUT_DIR="${ROOT}/target/sbpf-solana-solana/release"
if [ ! -f "${SBF_OUT_DIR}/rodeo_core.so" ]; then
    SBF_OUT_DIR="${ROOT}/target/sbpfv2-solana-solana/release"
fi
cp "${SBF_OUT_DIR}/rodeo_core.so" "${ROOT}/target/deploy/rodeo_core.so"

nohup solana-test-validator \
  --ledger "${LEDGER}" \
  --rpc-port "${BASE_PORT}" \
  --faucet-port "${FAUCET_PORT}" \
  --bind-address 127.0.0.1 \
  --limit-ledger-size 100000 \
  --mint "${PAYER_PUBKEY}" \
  --upgradeable-program CdEU5FfgsPgrPMMLsDAPY29sN4sWqZpMetAXVY633NhA target/deploy/rodeo_core.so "${PAYER_PUBKEY}" \
  --upgradeable-program 9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n target/deploy/rodeo_market.so "${PAYER_PUBKEY}" \
  --upgradeable-program CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD target/deploy/rodeo_router.so "${PAYER_PUBKEY}" \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d vendor/mpl-core/mpl_core_program.so \
  > "${LEDGER}/validator.log" 2>&1 &
disown
VALIDATOR_PID=$!

sleep 1

if ! kill -0 "${VALIDATOR_PID}" 2>/dev/null && ! pgrep -f "solana-test-validator.*${LEDGER}" >/dev/null 2>&1; then
  echo "ERROR: validator process for production buffer not found" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

if ! wait_for_health "${RPC_URL}"; then
  echo "ERROR: validator did not reach healthy state on port ${BASE_PORT}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

if ! wait_for_rpc_ready "${RPC_URL}"; then
  echo "ERROR: validator RPC not ready on port ${BASE_PORT}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

# Fund the test wallet from the localnet faucet so it can pay for accounts.
if ! solana airdrop 1000 "${PAYER_PUBKEY}" --url "${RPC_URL}" >/dev/null 2>&1; then
  echo "ERROR: failed to airdrop localnet funds to ${PAYER_PUBKEY}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

if ! wait_for_ws "${WS_PORT}"; then
  echo "ERROR: validator WebSocket not ready on port ${BASE_PORT}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

echo "===> Running production buffer suite (RPC ${BASE_PORT} / WS ${WS_PORT})"

SUITE_EXIT=0
if ! ANCHOR_PROVIDER_URL="${RPC_URL}" ANCHOR_WALLET="${WALLET}" \
     RODEO_TEST_SUITE="prod-buffer" \
     pnpm --filter @rodeo/integration exec vitest run "${TEST_FILE}"; then
  echo "===> Production buffer FAILED" >&2
  SUITE_EXIT=1
fi

if [ "${SUITE_EXIT}" -ne 0 ]; then
  cp "${LEDGER}/validator.log" "/tmp/rodeo-prod-buffer-${BASE_PORT}-fail.log" 2>/dev/null || true
  echo "===> Production buffer validator log preserved at /tmp/rodeo-prod-buffer-${BASE_PORT}-fail.log" >&2
fi

kill_validator

if [ "${SUITE_EXIT}" -eq 0 ]; then
  echo "===> Production buffer OK"
fi
exit "${SUITE_EXIT}"
