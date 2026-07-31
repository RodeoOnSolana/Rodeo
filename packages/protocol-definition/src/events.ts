export interface ProtocolEventEnvelope<Name extends string, Data> {
  readonly id: string;
  readonly epoch: bigint;
  readonly name: Name;
  readonly data: Data;
}

export type PositionStakedEvent = ProtocolEventEnvelope<"positionStaked", {
  readonly position: string;
  readonly owner: string;
  readonly principalAtomic: bigint;
  readonly commitment: Uint8Array;
}>;

export type MockRandomnessRevealedEvent = ProtocolEventEnvelope<"mockRandomnessRevealed", {
  readonly position: string;
  readonly owner: string;
  readonly randomness: Uint8Array;
  readonly settlementNonce: bigint;
}>;

export type RodeoProtocolEvent = PositionStakedEvent | MockRandomnessRevealedEvent;
