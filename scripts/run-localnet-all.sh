#!/usr/bin/env bash
set -uo pipefail

# Reproducible CI entry point for all localnet integration suites.
# Each suite runs in its own fresh validator to avoid clock/epoch drift.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"${ROOT}/scripts/run-localnet-suite.sh" claim && \
"${ROOT}/scripts/run-localnet-suite.sh" epoch && \
"${ROOT}/scripts/run-localnet-suite.sh" benchmark
