# Rodeo repository guidance

- The definitive Rodeo Protocol Specification v1, once supplied, is the sole source of truth for economic behavior.
- Phase 0 must not invent missing economic values or expose economic constants as administrator-controlled state.
- Keep player RODEO principal in its dedicated program-controlled vault and ANSEM rewards in a separate liability-backed vault.
- Use integer arithmetic only in protocol, SDK, and simulator code. State rounding direction at every division.
- Local verification: `pnpm test`, `pnpm typecheck`, and, with the Solana/Anchor toolchain installed, `anchor test`.
- Refresh SDK clients after an Anchor build with `pnpm sdk:generate`.
