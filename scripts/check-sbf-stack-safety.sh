#!/usr/bin/env bash
# Runs the given `anchor build` / `cargo build-sbf` command, preserving its
# real exit code and full stdout/stderr output, while ALSO failing the step
# if the SBF build emits a stack-safety diagnostic that cargo-build-sbf
# currently treats as non-fatal (it prints "Error:" but still exits 0).
#
# This guards against a real class of bug: an SBF program whose
# Anchor-generated `try_accounts` (or any other function) stack frame
# exceeds the fixed 4096-byte SBF stack limit produces undefined behavior
# at runtime (observed in production as "Access violation in unknown
# section"), but a plain `anchor build` / `cargo build-sbf` invocation does
# not fail on its own when this happens.
#
# Usage: scripts/check-sbf-stack-safety.sh <command> [args...]
# Example: scripts/check-sbf-stack-safety.sh anchor build
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

LOG_FILE="$(mktemp)"
trap 'rm -f "$LOG_FILE"' EXIT

"$@" 2>&1 | tee "$LOG_FILE"
BUILD_STATUS=${PIPESTATUS[0]}

if grep -Fq "overwrites values in the frame" "$LOG_FILE"; then
  echo "::error::SBF stack-safety guard: build output contains 'overwrites values in the frame'. This indicates real undefined behavior in a generated SBF function (see docs/mpl-core-integration-proof.md and the settle_unstake stack-frame hotfix for prior art)." >&2
  BUILD_STATUS=1
fi

if grep -Eq "Stack offset of [0-9]+ exceeded max offset" "$LOG_FILE"; then
  echo "::error::SBF stack-safety guard: build output contains a 'Stack offset ... exceeded max offset' diagnostic. A generated SBF function's stack frame exceeds the 4096-byte SBF limit. Box additional large Account<...> fields in the offending Accounts struct." >&2
  BUILD_STATUS=1
fi

exit "$BUILD_STATUS"
