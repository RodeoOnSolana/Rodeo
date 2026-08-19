#!/usr/bin/env bash
# Background health / heartbeat trace for a solana-test-validator managed by
# scripts/run-localnet-suite.sh.  Prints a compact line to stderr (live) and
# appends to a log file (archived by CI).
set -uo pipefail

RPC_URL="${1:-}"
LOG_FILE="${2:-}"
LEDGER_PREFIX="${3:-/tmp/rodeo-localnet-suite-ledger}"
INTERVAL="${CI_HEALTH_INTERVAL:-45}"

if [ -z "${RPC_URL}" ] || [ -z "${LOG_FILE}" ]; then
  echo "usage: $0 <rpc_url> <log_file> [ledger_prefix]" >&2
  exit 2
fi

touch "${LOG_FILE}"

while sleep "${INTERVAL}"; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  VAL_PID=$(pgrep -f 'solana-test-validator' | head -1 || true)
  BLOCK=$(solana block-height --url "${RPC_URL}" 2>/dev/null || echo 'n/a')
  FREE_MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}' || echo 'n/a')
  if [ -n "${VAL_PID}" ]; then
    VAL_RSS=$(ps -p "${VAL_PID}" -o rss= 2>/dev/null || echo 'n/a')
  else
    VAL_RSS='n/a'
  fi
  LEDGER_SIZE=$(du -sm "${LEDGER_PREFIX}"* 2>/dev/null | awk '{s+=$1} END{print s+0}' || echo 'n/a')
  LINE="${TS} | validator_pid=${VAL_PID:-n/a} | block=${BLOCK} | free_mem_mb=${FREE_MEM} | validator_rss_kb=${VAL_RSS} | ledger_size_mb=${LEDGER_SIZE}"
  echo "${LINE}" >> "${LOG_FILE}"
  echo "[health] ${LINE}" >&2
done
