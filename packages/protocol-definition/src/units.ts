export type AtomicAmount<Token extends string> = bigint & { readonly __token: Token };
export type RodeoAtomic = AtomicAmount<"RODEO">;
export type AnsemAtomic = AtomicAmount<"ANSEM">;
export type RevenueAtomic = AtomicAmount<"REVENUE">;

export function atomic<Token extends string>(value: bigint): AtomicAmount<Token> {
  if (value < 0n) throw new RangeError("Atomic token amounts cannot be negative");
  return value as AtomicAmount<Token>;
}
