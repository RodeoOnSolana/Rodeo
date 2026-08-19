#!/usr/bin/env bash
# Fetches the live Metaplex Core on-chain program binary from mainnet-beta so
# it can be loaded deterministically into `solana-test-validator` at genesis
# (see the `[[test.genesis]]` entry in Anchor.toml).
#
# Why a mainnet dump instead of a prebuilt release asset: the `mpl-core`
# Rust crate we depend on (see programs/rodeo_core/Cargo.toml) is the client
# SDK, published from the `clients/rust` subdirectory of the
# metaplex-foundation/mpl-core monorepo; it does not contain the on-chain
# program. The metaplex-foundation/mpl-core GitHub Releases only publish a
# prebuilt `mpl_core_program.so` for a sparse subset of tags (0.9.x, 0.10.0,
# 0.11.0, 0.12.0+ ...), and there is no `release/core@0.11.1` or
# `release/core@0.11.2` tag matching our pinned client version. Building the
# on-chain program from source at the exact commit the client was published
# from is a follow-up option (tracked in docs/mpl-core-integration-proof.md);
# for this PR we use the single canonical, publicly verifiable source of
# truth for "what mpl-core actually enforces today": the live mainnet-beta
# deployment at CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d.
#
# This is NOT a silent dump: the resulting binary's SHA-256 is always printed
# and written next to the binary, is never committed to git (see
# .gitignore), and is recomputed on every CI run so any unannounced mainnet
# upgrade shows up as a visible hash change in CI output/step summary rather
# than a stale, silently-trusted blob in version control.
#
# The script retries over a small set of public mainnet RPCs with bounded
# exponential backoff. Every successful download is SHA-256 checked against
# the pinned MPL_CORE_EXPECTED_SHA256 before it is accepted.
set -euo pipefail

MPL_CORE_PROGRAM_ID="CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/mpl-core"
OUT_SO="${OUT_DIR}/mpl_core_program.so"
OUT_SHA="${OUT_SO}.sha256"

# Pinned SHA-256 for the Metaplex Core 0.11.2 program binary loaded by
# test validators. If the live deployment no longer matches this pin, the
# CI must fail visibly and the pin must be deliberately updated after a
# human review of the upstream change (see docs/mpl-core-integration-proof.md).
# Override via env to update the pin without editing this script.
DEFAULT_MPL_CORE_SHA256="f03e75373ae9cae07b5875f7818c55147b73c5607ca0f96968bab93cd583dc6e"
MPL_CORE_EXPECTED_SHA256="${MPL_CORE_EXPECTED_SHA256:-${DEFAULT_MPL_CORE_SHA256}}"

# Public mainnet RPCs. The default `MPL_CORE_DUMP_URL` (single override) is
# still honored for backward compatibility and is tried first.
MPL_CORE_DUMP_URL="${MPL_CORE_DUMP_URL:-https://api.mainnet-beta.solana.com}"
ENDPOINTS=(
  "${MPL_CORE_DUMP_URL}"
  "https://solana-mainnet.g.alchemy.com/v2/demo"
  "https://rpc.ankr.com/solana"
  "https://solana-mainnet.rpc.extrnode.com"
)

MAX_ATTEMPTS_PER_ENDPOINT=3
RETRY_BACKOFF_SECONDS=(2 5 10)

mkdir -p "${OUT_DIR}"

compute_sha() {
  sha256sum "$1" | awk '{print $1}'
}

try_dump_from_endpoint() {
  local endpoint="$1"
  local tmp_out="$2"
  echo "Dumping ${MPL_CORE_PROGRAM_ID} from ${endpoint} ..."
  if solana program dump -u "${endpoint}" "${MPL_CORE_PROGRAM_ID}" "${tmp_out}"; then
    return 0
  fi
  return 1
}

dump_with_retries() {
  local endpoint="$1"
  local tmp_out="$2"
  local attempt=0
  while [ $attempt -lt $MAX_ATTEMPTS_PER_ENDPOINT ]; do
    if try_dump_from_endpoint "${endpoint}" "${tmp_out}"; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ $attempt -lt $MAX_ATTEMPTS_PER_ENDPOINT ]; then
      local sleep_for="${RETRY_BACKOFF_SECONDS[$((attempt - 1))]}"
      echo "Endpoint ${endpoint} attempt ${attempt} failed; retrying in ${sleep_for}s ..."
      sleep "${sleep_for}"
    fi
  done
  return 1
}

TMP_OUT="${OUT_SO}.tmp"
rm -f "${TMP_OUT}"

dumped=false
for endpoint in "${ENDPOINTS[@]}"; do
  if dump_with_retries "${endpoint}" "${TMP_OUT}"; then
    dumped=true
    break
  else
    echo "Failed to dump from ${endpoint} after ${MAX_ATTEMPTS_PER_ENDPOINT} attempts."
  fi
done

if [ "$dumped" != "true" ]; then
  echo ""
  echo "ERROR: could not fetch Metaplex Core program from any endpoint." >&2
  rm -f "${TMP_OUT}"
  exit 1
fi

ACTUAL_SHA256="$(compute_sha "${TMP_OUT}")"

if [ "${ACTUAL_SHA256}" != "${MPL_CORE_EXPECTED_SHA256}" ]; then
  echo ""
  echo "ERROR: fetched Metaplex Core program SHA-256 does not match the pinned" >&2
  echo "MPL_CORE_EXPECTED_SHA256. This means the fetched deployment differs" >&2
  echo "from the verified pin. Do not proceed silently -- update the pin only" >&2
  echo "after deliberately reviewing what changed upstream." >&2
  echo "  expected: ${MPL_CORE_EXPECTED_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA256}" >&2
  rm -f "${TMP_OUT}"
  exit 1
fi

mv -f "${TMP_OUT}" "${OUT_SO}"
echo "${ACTUAL_SHA256}  ${OUT_SO}" > "${OUT_SHA}"

echo ""
echo "Metaplex Core program binary fetched:"
echo "  Program ID:   ${MPL_CORE_PROGRAM_ID}"
echo "  Source:       live mainnet-beta deployment"
echo "  Local path:   ${OUT_SO}"
echo "  SHA-256:      ${ACTUAL_SHA256}"
echo "  Pin check:    OK (matches MPL_CORE_EXPECTED_SHA256)"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Metaplex Core program binary"
    echo ""
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Program ID | \`${MPL_CORE_PROGRAM_ID}\` |"
    echo "| Source | live mainnet-beta deployment |"
    echo "| SHA-256 | \`${ACTUAL_SHA256}\` |"
    echo "| Size (bytes) | $(stat -c%s "${OUT_SO}" 2>/dev/null || stat -f%z "${OUT_SO}") |"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
