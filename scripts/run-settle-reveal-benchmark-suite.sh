#!/usr/bin/env bash
set -uo pipefail

# Run the SettleReveal benchmark for every fixture case. Each case is exercised
# in its own fresh localnet because the fixtures share the same canonical
# position_id and the production stake_and_commit path enforces unique
# positions. The validator ledger is placed on a local ext4 path and each case
# binds a fresh, non-overlapping port pair to avoid TCP TIME_WAIT conflicts that
# make solana-test-validator silently shift to an unexpected RPC/WS port.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_BASE="/tmp/rodeo-test-ledger"
WALLET="${HOME}/.config/solana/id.json"

export PATH="/home/rodeosolana/.cargo/bin:/home/rodeosolana/.local/bin:/home/rodeosolana/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

# Pick a random starting base for this run so repeated manual invocations don't
# immediately collide with TIME_WAIT from a previous run.
BASE_PORT=$((RANDOM % 10000 + 20000))

CASES=(
  J1_4
  J2_4
  J1_10000
  J2_10000
  J1_100000
  J2_100000
  J1_1000000
  J2_1000000
)

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
    if curl -sS --max-time 2 -i -N \
      -H 'Upgrade: websocket' \
      -H 'Connection: Upgrade' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H 'Sec-WebSocket-Version: 13' \
      "http://127.0.0.1:${ws_port}" 2>/dev/null | grep -q '101 Switching'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

kill_validator() {
  # Kill every solana-test-validator, solana logs, and solana-faucet process
  # that might be left behind by this runner, Anchor, or previous manual runs.
  pkill -9 -f 'solana-test-validator' >/dev/null 2>&1 || true
  pkill -9 -f 'solana logs' >/dev/null 2>&1 || true
  pkill -9 -f 'solana faucet' >/dev/null 2>&1 || true

  # Wait until the validator process is actually gone so the next case doesn't
  # inherit fixed gossip/tpu ports or collide with a leftover RPC/WS listener.
  for _ in $(seq 1 30); do
    if pgrep -f 'solana-test-validator' >/dev/null 2>&1; then
      sleep 1
    else
      break
    fi
  done

  # Also clear the repository-local ledger that Anchor may have started.
  rm -rf "${ROOT}/.anchor/test-ledger" "${LEDGER_BASE}"-*
}

# Final overall status. We accumulate failing case exit codes and exit at the
# end instead of stopping on the first failure, so cleanup still runs.
SUITE_EXIT=0

for idx in "${!CASES[@]}"; do
  case="${CASES[$idx]}"
  port=$((BASE_PORT + idx * 2))
  ws_port=$((port + 1))
  faucet_port=$((port + 1000))
  rpc_url="http://127.0.0.1:${port}"
  ledger="${LEDGER_BASE}-${case}-${port}"

  echo "===> Running benchmark case: ${case} (RPC ${port} / WS ${ws_port})"

  kill_validator

  rm -rf "${ledger}"
  mkdir -p "${ledger}"

  cd "${ROOT}"

  # Use nohup + disown so the validator survives the short-lived wsl shell that
  # starts it. The runner's own health/WS waits keep the parent shell alive.
  nohup solana-test-validator \
    --ledger "${ledger}" \
    --rpc-port "${port}" \
    --faucet-port "${faucet_port}" \
    --bind-address 127.0.0.1 \
    --mint 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
    --upgradeable-program EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z target/deploy/rodeo_core.so 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
    --upgradeable-program 9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n target/deploy/rodeo_market.so 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
    --upgradeable-program CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD target/deploy/rodeo_router.so 69tZK9TXp1iCKE5RdQj9i2PFVhPk77WfveyGV77CRyNi \
    --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d vendor/mpl-core/mpl_core_program.so \
    > "${ledger}/validator.log" 2>&1 &
  disown
  VALIDATOR_PID=$!

  # Brief wait so the validator has time to fail before health checks.
  sleep 1

  if ! kill -0 "${VALIDATOR_PID}" 2>/dev/null && ! pgrep -f "solana-test-validator.*${ledger}" >/dev/null 2>&1; then
    echo "ERROR: validator process for ${case} not found" >&2
    cat "${ledger}/validator.log" >&2 || true
    kill_validator
    SUITE_EXIT=1
    continue
  fi

  if ! wait_for_health "${rpc_url}"; then
    echo "ERROR: validator did not reach healthy state on port ${port}" >&2
    cat "${ledger}/validator.log" >&2 || true
    kill_validator
    SUITE_EXIT=1
    continue
  fi

  if ! wait_for_rpc_ready "${rpc_url}"; then
    echo "ERROR: validator RPC not ready on port ${port}" >&2
    cat "${ledger}/validator.log" >&2 || true
    kill_validator
    SUITE_EXIT=1
    continue
  fi

  if ! wait_for_ws "${ws_port}"; then
    echo "ERROR: validator WebSocket not ready on port ${ws_port}" >&2
    cat "${ledger}/validator.log" >&2 || true
    kill_validator
    SUITE_EXIT=1
    continue
  fi

  # Run vitest directly so ANCHOR_PROVIDER_URL is honored. anchor test would
  # reset the provider URL to its own local validator defaults.
  if ! ANCHOR_PROVIDER_URL="${rpc_url}" ANCHOR_WALLET="${WALLET}" \
    RODEO_BENCHMARK_CASE="${case}" RODEO_TEST_SUITE=benchmark \
    pnpm --filter @rodeo/integration exec vitest run localnet-settle-reveal-benchmark.test.ts; then
    echo "===> ${case} FAILED" >&2
    SUITE_EXIT=1
  else
    echo "===> ${case} OK"
  fi

  kill_validator
done

kill_validator
rm -rf "${LEDGER_BASE}"-*
echo "===> Suite finished"
exit "${SUITE_EXIT}"
