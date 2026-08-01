export const EPOCH_DURATION_SECONDS = 6n * 60n * 60n;
export const RUNWAY_WINDOW_SECONDS = 10n * 24n * 60n * 60n;
export const RUNWAY_EPOCHS = RUNWAY_WINDOW_SECONDS / EPOCH_DURATION_SECONDS;

export const UNRESOLVED_ECONOMIC_PARAMETERS = [
  "RODEO token decimals",
  "ANSEM token decimals",
  "fee rates and fee destinations",
  "ANSEM emission targets and revenue conversion",
  "Cowboy and Bull assignment probabilities",
  "claim, unstaking, reroll, burn, and theft rules",
  "Bull accumulator precision",
  "marketplace royalties and protocol revenue share",
] as const;
