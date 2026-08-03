import type { Idl } from "@coral-xyz/anchor";

export const rodeoRouterIdl = {
  "address": "CFQUWHE88YWrtnu9yADgEAB1MrPAYvdAjUbRwbTLafxD",
  "metadata": {
    "name": "rodeo_router",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Rodeo Phase 0 router program boundary"
  },
  "instructions": [
    {
      "name": "phase_zero",
      "discriminator": [
        141,
        74,
        232,
        225,
        6,
        118,
        28,
        176
      ],
      "accounts": [],
      "args": []
    }
  ]
} as const satisfies Idl;
export type RodeoRouterIdl = typeof rodeoRouterIdl;
