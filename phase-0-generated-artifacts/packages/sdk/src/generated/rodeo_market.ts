import type { Idl } from "@coral-xyz/anchor";

export const rodeoMarketIdl = {
  "address": "9vhrgTdridvE1uuxPenqDW9RVKdu3A5Dc2DzKVbaew8n",
  "metadata": {
    "name": "rodeo_market",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Rodeo Phase 0 marketplace program boundary"
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
export type RodeoMarketIdl = typeof rodeoMarketIdl;
