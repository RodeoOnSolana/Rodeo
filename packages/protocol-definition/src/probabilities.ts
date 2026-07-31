export interface ProbabilityEntry<Outcome extends string = string> {
  readonly outcome: Outcome;
  readonly weight: bigint;
}

export interface ProbabilityTable<Outcome extends string = string> {
  readonly denominator: bigint;
  readonly entries: readonly ProbabilityEntry<Outcome>[];
}

export function probabilityWeight<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
): bigint {
  return table.entries.reduce((sum, entry) => sum + entry.weight, 0n);
}

export function isNormalized<Outcome extends string>(
  table: ProbabilityTable<Outcome>,
): boolean {
  return table.denominator > 0n &&
    table.entries.length > 0 &&
    table.entries.every(({ weight }) => weight >= 0n) &&
    probabilityWeight(table) === table.denominator;
}
