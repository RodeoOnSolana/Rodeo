#!/usr/bin/env bash
# Verifies the pinned, committed Metaplex Core on-chain program binary in
# vendor/mpl-core/mpl_core_program.so against MPL_CORE_EXPECTED_SHA256.
# No network access. CI uses this instead of scripts/fetch-mpl-core-program.sh
# so the required merge gate does not depend on public mainnet RPC uptime.
set -euo pipefail

MPL_CORE_PROGRAM_ID="CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/mpl-core"
OUT_SO="${OUT_DIR}/mpl_core_program.so"
OUT_SHA="${OUT_SO}.sha256"

DEFAULT_MPL_CORE_SHA256="f03e75373ae9cae07b5875f7818c55147b73c5607ca0f96968bab93cd583dc6e"
MPL_CORE_EXPECTED_SHA256="${MPL_CORE_EXPECTED_SHA256:-${DEFAULT_MPL_CORE_SHA256}}"

compute_sha() {
  sha256sum "$1" | awk '{print $1}'
}

if [ ! -f "${OUT_SO}" ]; then
  echo "ERROR: ${OUT_SO} not found." >&2
  echo "  Use scripts/fetch-mpl-core-program.sh to (re)download the pinned binary," >&2
  echo "  or restore the committed artifact." >&2
  exit 1
fi

ACTUAL_SHA256="$(compute_sha "${OUT_SO}")"

if [ "${ACTUAL_SHA256}" != "${MPL_CORE_EXPECTED_SHA256}" ]; then
  echo "ERROR: SHA-256 mismatch for ${OUT_SO}" >&2
  echo "  expected: ${MPL_CORE_EXPECTED_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA256}" >&2
  exit 1
fi

echo "${ACTUAL_SHA256}  ${OUT_SO}" > "${OUT_SHA}"

echo "Metaplex Core program binary verified (no network):"
echo "  Program ID:   ${MPL_CORE_PROGRAM_ID}"
echo "  Local path:   ${OUT_SO}"
echo "  SHA-256:      ${ACTUAL_SHA256}"
echo "  Pin check:    OK (matches MPL_CORE_EXPECTED_SHA256)"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Metaplex Core program binary (verified, no network)"
    echo ""
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Program ID | \`${MPL_CORE_PROGRAM_ID}\` |"
    echo "| Source | committed/pinned artifact |"
    echo "| SHA-256 | \`${ACTUAL_SHA256}\` |"
    echo "| Size (bytes) | $(stat -c%s "${OUT_SO}" 2>/dev/null || stat -f%z "${OUT_SO}") |"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
