#!/usr/bin/env bash
set -uo pipefail

# Run a single localnet integration suite (claim, epoch, or benchmark) in a
# fresh solana-test-validator.  This isolates each suite from clock/epoch drift
# and from port/ledger collisions with other suites or previous runs.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_BASE="/tmp/rodeo-localnet-suite-ledger"
WALLET="${HOME}/.config/solana/id.json"
PAYER_PUBKEY="$(solana-keygen pubkey "${WALLET}")"

export PATH="/home/rodeosolana/.cargo/bin:/home/rodeosolana/.local/bin:/home/rodeosolana/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

SUITE="${1:-}"
if [ -z "${SUITE}" ]; then
  echo "usage: $0 <claim|epoch|benchmark>" >&2
  exit 2
fi

case "${SUITE}" in
  claim)
    TEST_FILE="localnet-claim.test.ts"
    ;;
  epoch)
    TEST_FILE="localnet-epoch.test.ts"
    ;;
  benchmark)
    # The benchmark runner already manages fresh validators per case.
    exec "${ROOT}/scripts/run-settle-reveal-benchmark-suite.sh"
    ;;
  *)
    echo "unknown suite: ${SUITE}" >&2
    exit 2
    ;;
esac

case "${SUITE}" in
  claim)
    BUILD_FEATURES="mock-randomness,test-short-timeout,test-fixtures,test-short-claim-cooldown"
    ;;
  epoch)
    BUILD_FEATURES="mock-randomness,test-short-timeout,test-fixtures,test-short-claim-cooldown,test-short-epoch"
    ;;
  *)
    BUILD_FEATURES="mock-randomness,test-short-timeout,test-fixtures,test-short-claim-cooldown,test-short-epoch"
    ;;
esac

# Build the exact SBF feature profile for this suite before starting the validator.
# claim intentionally omits test-short-epoch so the short-epoch test fixture does
# not introduce EpochsNotClosed into the claim suite.
cd "${ROOT}"
if ! pnpm program-keys:localnet >/dev/null 2>&1; then
  echo "ERROR: program-keys:localnet failed" >&2
  exit 1
fi
if ! scripts/check-sbf-stack-safety.sh anchor build -p rodeo_core -- --features "${BUILD_FEATURES}"; then
  echo "ERROR: IDL/SBF build failed for ${SUITE} with features ${BUILD_FEATURES}" >&2
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

BASE_PORT=$((RANDOM % 10000 + 20000))
WS_PORT=$((BASE_PORT + 1))
FAUCET_PORT=$((BASE_PORT + 1000))
RPC_URL="http://127.0.0.1:${BASE_PORT}"
LEDGER="${LEDGER_BASE}-${SUITE}-${BASE_PORT}"

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

rm -rf "${LEDGER}"
mkdir -p "${LEDGER}"

cd "${ROOT}"

nohup solana-test-validator \
  --ledger "${LEDGER}" \
  --rpc-port "${BASE_PORT}" \
  --faucet-port "${FAUCET_PORT}" \
  --bind-address 127.0.0.1 \
  --limit-ledger-size 100000 \
  --mint 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
  --upgradeable-program CdEU5FfgsPgrPMMLsDAPY29sN4sWqZpMetAXVY633NhA target/deploy/rodeo_core.so "${PAYER_PUBKEY}" \
  --upgradeable-program 9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n target/deploy/rodeo_market.so 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
  --upgradeable-program CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD target/deploy/rodeo_router.so 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d vendor/mpl-core/mpl_core_program.so \
  > "${LEDGER}/validator.log" 2>&1 &
disown
VALIDATOR_PID=$!

sleep 1

if ! kill -0 "${VALIDATOR_PID}" 2>/dev/null && ! pgrep -f "solana-test-validator.*${LEDGER}" >/dev/null 2>&1; then
  echo "ERROR: validator process for ${SUITE} not found" >&2
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

# Fund the test wallet from the localnet faucet. The wallet file is created on
# demand above; the fresh ledger starts with no balance for it.
PAYER_PUBKEY="$(solana-keygen pubkey "${WALLET}")"
if ! solana airdrop 1000 "${PAYER_PUBKEY}" --url "${RPC_URL}" >/dev/null 2>&1; then
  echo "ERROR: failed to airdrop localnet funds to ${PAYER_PUBKEY}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

if ! wait_for_ws "${WS_PORT}"; then
  echo "ERROR: validator WebSocket not ready on port ${WS_PORT}" >&2
  cat "${LEDGER}/validator.log" >&2 || true
  kill_validator
  exit 1
fi

echo "===> Running localnet suite: ${SUITE} (RPC ${BASE_PORT} / WS ${WS_PORT})"

SUITE_EXIT=0
if ! ANCHOR_PROVIDER_URL="${RPC_URL}" ANCHOR_WALLET="${WALLET}" \
     RODEO_TEST_SUITE="${SUITE}" \
     pnpm --filter @rodeo/integration exec vitest run "${TEST_FILE}"; then
  echo "===> ${SUITE} FAILED" >&2
  SUITE_EXIT=1
fi

if [ "${SUITE_EXIT}" -ne 0 ]; then
  cp "${LEDGER}/validator.log" "/tmp/rodeo-${SUITE}-${BASE_PORT}-fail.log" 2>/dev/null || true
  echo "===> ${SUITE} validator log preserved at /tmp/rodeo-${SUITE}-${BASE_PORT}-fail.log" >&2
fi

kill_validator

if [ "${SUITE_EXIT}" -eq 0 ]; then
  echo "===> ${SUITE} OK"
fi
exit "${SUITE_EXIT}"
