import type { Idl } from "@coral-xyz/anchor";

export const rodeoCoreIdl = {
  "address": "EkEPd5wXSi3NQUHewx64cP27tDQ6uTcK5poG6AuWmy8Z",
  "metadata": {
    "name": "rodeo_core",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Rodeo Phase 2A core foundation: accounts, constants, probability, and initialization"
  },
  "instructions": [
    {
      "name": "append_bull_proof",
      "discriminator": [
        116,
        101,
        133,
        187,
        96,
        216,
        220,
        112
      ],
      "accounts": [
        {
          "name": "prover",
          "writable": true,
          "signer": true
        },
        {
          "name": "bull_proof_buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "bull_proof_buffer.pending_randomness",
                "account": "BullProofBuffer"
              },
              {
                "kind": "account",
                "path": "prover"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "offset",
          "type": "u32"
        },
        {
          "name": "chunk",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "claim_position",
      "discriminator": [
        168,
        90,
        89,
        44,
        203,
        246,
        210,
        46
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "wallet_claim_cooldown",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  99,
                  111,
                  111,
                  108,
                  100,
                  111,
                  119,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "reward_vault",
          "writable": true
        },
        {
          "name": "owner_ansem_account",
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "close_bull_proof",
      "discriminator": [
        211,
        118,
        225,
        48,
        176,
        73,
        171,
        10
      ],
      "accounts": [
        {
          "name": "prover"
        },
        {
          "name": "bull_proof_buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "bull_proof_buffer.pending_randomness",
                "account": "BullProofBuffer"
              },
              {
                "kind": "account",
                "path": "prover"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "refund_recipient",
          "writable": true
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "close_epochs",
      "discriminator": [
        104,
        146,
        11,
        55,
        102,
        32,
        206,
        240
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "reward_vault",
          "writable": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "max_epochs",
          "type": "u8"
        }
      ]
    },
    {
      "name": "finalize_bull_proof",
      "discriminator": [
        110,
        36,
        98,
        138,
        130,
        249,
        238,
        55
      ],
      "accounts": [
        {
          "name": "prover",
          "writable": true,
          "signer": true
        },
        {
          "name": "bull_proof_buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "bull_proof_buffer.pending_randomness",
                "account": "BullProofBuffer"
              },
              {
                "kind": "account",
                "path": "prover"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize_bull_proof",
      "discriminator": [
        19,
        36,
        91,
        228,
        141,
        207,
        64,
        224
      ],
      "accounts": [
        {
          "name": "prover",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness"
        },
        {
          "name": "bull_proof_buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pending_randomness"
              },
              {
                "kind": "account",
                "path": "prover"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "bull_registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "action_type",
          "type": {
            "defined": {
              "name": "ActionType"
            }
          }
        },
        {
          "name": "expected_payload_length",
          "type": "u32"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize_protocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "initializer",
          "docs": [
            "The upgrade authority of the deployed rodeo_core program."
          ],
          "signer": true
        },
        {
          "name": "program",
          "docs": [
            "hardcoded program ID and confirmed executable."
          ]
        },
        {
          "name": "program_data",
          "docs": [
            "be the program-data PDA of this program and owned by the upgrade loader."
          ]
        },
        {
          "name": "rodeo_mint"
        },
        {
          "name": "ansem_mint"
        },
        {
          "name": "global_config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "protocol_config",
          "writable": true
        },
        {
          "name": "principal_vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  110,
                  99,
                  105,
                  112,
                  97,
                  108,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "reward_vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "receipt_collection",
          "docs": [
            "`initialize_protocol` via the MPL Core `CreateCollectionV2` CPI."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "receipt_authority",
          "docs": [
            "authority and as the signer for all receipt lifecycle actions."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "mpl_core_program",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "upgrade_council",
          "type": "pubkey"
        },
        {
          "name": "treasury_council",
          "type": "pubkey"
        },
        {
          "name": "emergency_guardians",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "recognize_rewards",
      "discriminator": [
        253,
        223,
        175,
        255,
        104,
        38,
        36,
        191
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "reward_vault"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "recover_reveal_timeout",
      "discriminator": [
        114,
        152,
        110,
        18,
        70,
        164,
        31,
        226
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "principal_vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  110,
                  99,
                  105,
                  112,
                  97,
                  108,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "owner_rodeo_account",
          "writable": true
        },
        {
          "name": "owner",
          "docs": [
            "Also receives the unused ReceiptFunder reserve when the reveal times out."
          ],
          "writable": true
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "receipt_funder",
          "docs": [
            "because the reveal was never completed and no receipt was created."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  102,
                  117,
                  110,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "recover_unstake_timeout",
      "discriminator": [
        231,
        189,
        160,
        114,
        161,
        47,
        104,
        99
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "owner",
          "writable": true
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "request_unstake",
      "discriminator": [
        44,
        154,
        110,
        253,
        160,
        202,
        54,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocol_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "global_config.current_config_version",
                "account": "GlobalConfig"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "provider_randomness_account",
          "docs": [
            "fulfilled and used as the entropy source for unstake settlement.",
            "Must be owned by the Switchboard On-Demand program and unresolved."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "settle_reveal",
      "discriminator": [
        160,
        140,
        148,
        163,
        185,
        71,
        2,
        234
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "bull_proof_buffer",
          "docs": [
            "Proof buffer is optional.  It is required when mint theft or new-Bull",
            "current-mutation proof data is needed, and must be omitted when no",
            "proof is required."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "refund_recipient",
          "writable": true,
          "optional": true
        },
        {
          "name": "protocol_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "pending_randomness.config_version_snapshot",
                "account": "PendingRandomness"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true
        },
        {
          "name": "receipt_owner",
          "docs": [
            "asset owner for the PositionReceipt. It is verified against the mutated",
            "position owner before the CreateV2 CPI."
          ]
        },
        {
          "name": "receipt_asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "receipt_collection",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "receipt_authority",
          "docs": [
            "and asset-creation authority."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "receipt_funder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  102,
                  117,
                  110,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "mpl_core_program",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "provider_randomness_account",
          "docs": [
            "Required in production builds; ignored when the `mock-randomness` feature is enabled."
          ],
          "optional": true
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "settle_unstake",
      "discriminator": [
        235,
        119,
        26,
        224,
        149,
        215,
        180,
        124
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "reward_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_accumulator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  97,
                  99,
                  99,
                  117,
                  109,
                  117,
                  108,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_proof_buffer",
          "docs": [
            "Proof buffer is only required for Bull removal.",
            "It is loaded manually in the handler to keep `SettleUnstake::try_accounts`",
            "within the SBF stack limit.  The buffer is prover-funded and its",
            "`refund_recipient` is committed at initialization to the prover's key,",
            "which may differ from the position owner (independent proof service)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "refund_recipient",
          "docs": [
            "Validated against `buffer.refund_recipient` in the handler.  This is",
            "separate from the owner-funded ReceiptFunder reserve refund."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "position.position_id",
                "account": "Position"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "protocol_config"
        },
        {
          "name": "principal_vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  110,
                  99,
                  105,
                  112,
                  97,
                  108,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "rodeo_mint",
          "writable": true
        },
        {
          "name": "owner_rodeo_account",
          "writable": true
        },
        {
          "name": "reward_vault",
          "writable": true
        },
        {
          "name": "owner_ansem_account",
          "writable": true
        },
        {
          "name": "owner",
          "docs": [
            "Also receives the residual ReceiptFunder SOL after receipt burn."
          ],
          "writable": true
        },
        {
          "name": "receipt_asset",
          "writable": true
        },
        {
          "name": "receipt_collection",
          "writable": true
        },
        {
          "name": "receipt_authority"
        },
        {
          "name": "receipt_funder",
          "writable": true
        },
        {
          "name": "mpl_core_program",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "provider_randomness_account",
          "docs": [
            "request time and must now be resolved to settle the unstake."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "stake_and_commit",
      "discriminator": [
        238,
        71,
        59,
        244,
        241,
        200,
        137,
        79
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "owner_rodeo_token_account",
          "writable": true
        },
        {
          "name": "global_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocol_config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "account",
                "path": "global_config.current_config_version",
                "account": "GlobalConfig"
              }
            ]
          }
        },
        {
          "name": "principal_vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  110,
                  99,
                  105,
                  112,
                  97,
                  108,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              },
              {
                "kind": "arg",
                "path": "position_id"
              }
            ]
          }
        },
        {
          "name": "pending_randomness",
          "writable": true
        },
        {
          "name": "reward_state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "global_game_state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  45,
                  103,
                  97,
                  109,
                  101,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "bull_registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  108,
                  108,
                  45,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "global_config"
              }
            ]
          }
        },
        {
          "name": "receipt_funder",
          "docs": [
            "Created and prefunded by the player during stake_and_commit; it is",
            "later used as the MPL Core payer for receipt create/burn."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116,
                  45,
                  102,
                  117,
                  110,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "position"
              }
            ]
          }
        },
        {
          "name": "provider_randomness_account",
          "docs": [
            "Required in production builds; ignored when the `mock-randomness` feature is enabled."
          ],
          "optional": true
        },
        {
          "name": "token_program",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "position_id",
          "type": "u64"
        },
        {
          "name": "principal_amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "BullAccumulator",
      "discriminator": [
        197,
        245,
        248,
        67,
        203,
        22,
        3,
        121
      ]
    },
    {
      "name": "BullProofBuffer",
      "discriminator": [
        149,
        159,
        68,
        187,
        102,
        204,
        75,
        17
      ]
    },
    {
      "name": "BullRegistry",
      "discriminator": [
        80,
        20,
        181,
        29,
        55,
        244,
        226,
        245
      ]
    },
    {
      "name": "GlobalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "GlobalGameState",
      "discriminator": [
        35,
        214,
        121,
        32,
        216,
        49,
        42,
        6
      ]
    },
    {
      "name": "PendingRandomness",
      "discriminator": [
        16,
        150,
        100,
        84,
        118,
        59,
        0,
        34
      ]
    },
    {
      "name": "Position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "ProtocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "RewardState",
      "discriminator": [
        86,
        245,
        149,
        170,
        90,
        108,
        31,
        251
      ]
    },
    {
      "name": "WalletClaimCooldown",
      "discriminator": [
        217,
        2,
        100,
        244,
        15,
        245,
        114,
        125
      ]
    }
  ],
  "events": [
    {
      "name": "BullPoolContribution",
      "discriminator": [
        72,
        124,
        112,
        142,
        19,
        157,
        250,
        245
      ]
    },
    {
      "name": "BullRegistryTransition",
      "discriminator": [
        42,
        86,
        103,
        6,
        234,
        105,
        0,
        139
      ]
    },
    {
      "name": "BullRewardDistributed",
      "discriminator": [
        145,
        221,
        25,
        41,
        42,
        182,
        95,
        9
      ]
    },
    {
      "name": "EpochClosed",
      "discriminator": [
        21,
        4,
        48,
        56,
        29,
        169,
        77,
        42
      ]
    },
    {
      "name": "EpochsClosed",
      "discriminator": [
        131,
        172,
        20,
        52,
        234,
        209,
        20,
        117
      ]
    },
    {
      "name": "MintTheft",
      "discriminator": [
        73,
        70,
        112,
        8,
        244,
        86,
        17,
        30
      ]
    },
    {
      "name": "OrphanedRewardReleased",
      "discriminator": [
        126,
        100,
        136,
        24,
        112,
        124,
        82,
        104
      ]
    },
    {
      "name": "PositionClaimed",
      "discriminator": [
        149,
        250,
        141,
        45,
        210,
        198,
        94,
        148
      ]
    },
    {
      "name": "PositionOwnerChanged",
      "discriminator": [
        56,
        220,
        32,
        233,
        253,
        106,
        221,
        35
      ]
    },
    {
      "name": "PositionRevealed",
      "discriminator": [
        27,
        238,
        5,
        238,
        6,
        99,
        20,
        146
      ]
    },
    {
      "name": "PositionStaked",
      "discriminator": [
        205,
        85,
        71,
        209,
        52,
        63,
        247,
        2
      ]
    },
    {
      "name": "PositionUnstaked",
      "discriminator": [
        157,
        31,
        33,
        230,
        178,
        93,
        69,
        19
      ]
    },
    {
      "name": "ProtocolInitialized",
      "discriminator": [
        173,
        122,
        168,
        254,
        9,
        118,
        76,
        132
      ]
    },
    {
      "name": "RandomnessRequested",
      "discriminator": [
        10,
        64,
        183,
        29,
        104,
        63,
        90,
        149
      ]
    },
    {
      "name": "RandomnessSettled",
      "discriminator": [
        219,
        235,
        45,
        239,
        116,
        19,
        92,
        74
      ]
    },
    {
      "name": "RandomnessTimeoutRecovered",
      "discriminator": [
        9,
        55,
        116,
        123,
        255,
        74,
        178,
        144
      ]
    },
    {
      "name": "ReceiptBurned",
      "discriminator": [
        167,
        239,
        65,
        58,
        167,
        36,
        4,
        147
      ]
    },
    {
      "name": "ReceiptCreated",
      "discriminator": [
        53,
        236,
        206,
        24,
        194,
        10,
        208,
        163
      ]
    },
    {
      "name": "RewardFundingRecognized",
      "discriminator": [
        199,
        179,
        185,
        118,
        43,
        161,
        249,
        222
      ]
    },
    {
      "name": "RewardPaid",
      "discriminator": [
        132,
        160,
        190,
        117,
        215,
        177,
        19,
        95
      ]
    },
    {
      "name": "UnstakeRequested",
      "discriminator": [
        21,
        253,
        177,
        85,
        129,
        206,
        42,
        152
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "ArithmeticOverflow",
      "msg": "Integer arithmetic overflow"
    },
    {
      "code": 6001,
      "name": "ArithmeticUnderflow",
      "msg": "Integer arithmetic underflow"
    },
    {
      "code": 6002,
      "name": "DivisionByZero",
      "msg": "Division by zero"
    },
    {
      "code": 6003,
      "name": "InvalidProgramAccount",
      "msg": "Invalid program account"
    },
    {
      "code": 6004,
      "name": "InvalidProgramData",
      "msg": "Invalid program data account"
    },
    {
      "code": 6005,
      "name": "UnauthorizedInitializer",
      "msg": "Initializer is not the program upgrade authority"
    },
    {
      "code": 6006,
      "name": "InvalidGovernanceAuthority",
      "msg": "Invalid governance authority"
    },
    {
      "code": 6007,
      "name": "GovernanceAuthoritiesNotDistinct",
      "msg": "Governance authorities must be pairwise distinct"
    },
    {
      "code": 6008,
      "name": "IdenticalTokenMints",
      "msg": "RODEO and ANSEM mints must be different"
    },
    {
      "code": 6009,
      "name": "ActiveMintAuthority",
      "msg": "Mint authority must be revoked"
    },
    {
      "code": 6010,
      "name": "ActiveFreezeAuthority",
      "msg": "Freeze authority must be revoked"
    },
    {
      "code": 6011,
      "name": "RejectionSamplingExhausted",
      "msg": "Rejection sampling exhausted without an accepted candidate"
    },
    {
      "code": 6012,
      "name": "InvalidBps",
      "msg": "Invalid BPS value"
    },
    {
      "code": 6013,
      "name": "InvalidMint",
      "msg": "Invalid mint account"
    },
    {
      "code": 6014,
      "name": "UnexpectedRodeoSupply",
      "msg": "RODEO mint supply does not match the expected total supply"
    },
    {
      "code": 6015,
      "name": "InvalidVault",
      "msg": "Invalid vault account"
    },
    {
      "code": 6016,
      "name": "InvalidDecimals",
      "msg": "Invalid decimals or atomic conversion failed"
    },
    {
      "code": 6017,
      "name": "ZeroPrincipal",
      "msg": "Principal must be greater than zero"
    },
    {
      "code": 6018,
      "name": "AlreadySettled",
      "msg": "Randomness has already been settled"
    },
    {
      "code": 6019,
      "name": "InvalidReveal",
      "msg": "Reveal does not match the commitment"
    },
    {
      "code": 6020,
      "name": "InvalidOwner",
      "msg": "Position owner does not match the signer"
    },
    {
      "code": 6021,
      "name": "NoPendingRevealAction",
      "msg": "No reveal action is pending for this position"
    },
    {
      "code": 6022,
      "name": "PositionLocked",
      "msg": "Position has a pending action and cannot be transferred"
    },
    {
      "code": 6023,
      "name": "StakeAmountMismatch",
      "msg": "Stake amount must equal the configured requirement"
    },
    {
      "code": 6024,
      "name": "MinimumStakePeriodNotMet",
      "msg": "Position has not been active long enough"
    },
    {
      "code": 6025,
      "name": "ClaimCooldownNotMet",
      "msg": "Wallet claim cooldown has not elapsed"
    },
    {
      "code": 6026,
      "name": "NoClaimableRewards",
      "msg": "Position has no claimable ANSEM after synchronization"
    },
    {
      "code": 6027,
      "name": "EpochsNotClosed",
      "msg": "All elapsed epochs must be closed before this operation"
    },
    {
      "code": 6028,
      "name": "InvalidProbabilityOutcome",
      "msg": "Randomness outcome does not map to a valid role/cowboy_kind/bull_tier/suit"
    },
    {
      "code": 6029,
      "name": "InvalidProbabilityTable",
      "msg": "Probability table weights do not sum to denominator"
    },
    {
      "code": 6030,
      "name": "PendingActionBlocksTransfer",
      "msg": "Cannot change owner while a randomness action is pending"
    },
    {
      "code": 6031,
      "name": "PendingActionBlocksClaim",
      "msg": "Cannot claim while a randomness action is pending"
    },
    {
      "code": 6032,
      "name": "StaleListing",
      "msg": "Listing no longer matches the position state"
    },
    {
      "code": 6033,
      "name": "InvalidMarketReceipt",
      "msg": "Receipt asset does not match the position"
    },
    {
      "code": 6034,
      "name": "InvalidSocialAttestation",
      "msg": "Social oracle attestation signatures are invalid"
    },
    {
      "code": 6035,
      "name": "SuitCompetitionNotEnded",
      "msg": "Social competition epoch has not ended"
    },
    {
      "code": 6036,
      "name": "UnrecognizedRewardFunding",
      "msg": "ANSEM in the vault is not yet recognized for liability accounting"
    },
    {
      "code": 6037,
      "name": "UnauthorizedSwapVenue",
      "msg": "Unauthorized swap venue"
    },
    {
      "code": 6038,
      "name": "SlippageExceeded",
      "msg": "Swap output below minimum"
    },
    {
      "code": 6039,
      "name": "PausedNewStakes",
      "msg": "New stakes are paused"
    },
    {
      "code": 6040,
      "name": "PausedNewRevealRequests",
      "msg": "New reveal requests are paused"
    },
    {
      "code": 6041,
      "name": "PausedNewMarketplaceListings",
      "msg": "New marketplace listings are paused"
    },
    {
      "code": 6042,
      "name": "PausedRouterSwaps",
      "msg": "Router swaps are paused"
    },
    {
      "code": 6043,
      "name": "PositionAlreadyExists",
      "msg": "Position already exists for the chosen position_id"
    },
    {
      "code": 6044,
      "name": "InvalidPositionId",
      "msg": "position_id must equal the next global position id"
    },
    {
      "code": 6045,
      "name": "InvalidPrincipalVault",
      "msg": "Principal vault is invalid for the configured mint or authority"
    },
    {
      "code": 6046,
      "name": "InvalidTokenAccount",
      "msg": "Owner token account is invalid for the configured mint or signer"
    },
    {
      "code": 6047,
      "name": "PendingActionConflict",
      "msg": "Position already has a conflicting pending action"
    },
    {
      "code": 6048,
      "name": "WrongActionType",
      "msg": "Pending action type does not match the requested operation"
    },
    {
      "code": 6049,
      "name": "InvalidPendingRandomness",
      "msg": "Pending randomness account does not match the position and nonce"
    },
    {
      "code": 6050,
      "name": "RandomnessNotReady",
      "msg": "Randomness result is not yet available"
    },
    {
      "code": 6051,
      "name": "RandomnessTimeoutNotReached",
      "msg": "Randomness timeout has not been reached"
    },
    {
      "code": 6052,
      "name": "RandomnessAlreadyAvailable",
      "msg": "Randomness has already been settled for this action"
    },
    {
      "code": 6053,
      "name": "InvalidEpochBatch",
      "msg": "Invalid epoch batch size"
    },
    {
      "code": 6054,
      "name": "NoElapsedEpoch",
      "msg": "No elapsed epoch to close"
    },
    {
      "code": 6055,
      "name": "InvalidRewardVault",
      "msg": "Reward vault is invalid for the configured mint or authority"
    },
    {
      "code": 6056,
      "name": "InvalidAnsemMint",
      "msg": "ANSEM mint account is invalid"
    },
    {
      "code": 6057,
      "name": "InvalidRewardDestination",
      "msg": "Reward destination account is invalid"
    },
    {
      "code": 6058,
      "name": "InsufficientRecognizedRewards",
      "msg": "Insufficient recognized rewards for the requested operation"
    },
    {
      "code": 6059,
      "name": "LiabilityUnderflow",
      "msg": "Liability underflow"
    },
    {
      "code": 6060,
      "name": "InvalidRewardIndex",
      "msg": "Invalid reward index ordering"
    },
    {
      "code": 6061,
      "name": "InvalidRole",
      "msg": "Position role is invalid for this operation"
    },
    {
      "code": 6062,
      "name": "UnstakeNotEligible",
      "msg": "Position is not yet eligible for unstake"
    },
    {
      "code": 6063,
      "name": "NoPendingUnstakeAction",
      "msg": "No unstake action is pending for this position"
    },
    {
      "code": 6064,
      "name": "UnstakeAlreadySettled",
      "msg": "Unstake has already been settled"
    },
    {
      "code": 6065,
      "name": "InvalidRodeoDestination",
      "msg": "RODEO destination account is invalid"
    },
    {
      "code": 6066,
      "name": "InvalidCoreAssetProgramOwner",
      "msg": "Account is not owned by the MPL Core program"
    },
    {
      "code": 6067,
      "name": "CoreAssetDeserializationFailed",
      "msg": "Failed to deserialize a Core asset account"
    },
    {
      "code": 6068,
      "name": "MissingPermanentTransferDelegate",
      "msg": "Missing or malformed permanent transfer delegate"
    },
    {
      "code": 6069,
      "name": "MissingPermanentBurnDelegate",
      "msg": "Missing or malformed permanent burn delegate"
    },
    {
      "code": 6070,
      "name": "MissingPermanentFreezeDelegate",
      "msg": "Missing or malformed permanent freeze delegate"
    },
    {
      "code": 6071,
      "name": "CoreAssetFrozen",
      "msg": "Core receipt asset is frozen"
    },
    {
      "code": 6072,
      "name": "CoreAssetNotFrozen",
      "msg": "Core receipt asset is not frozen"
    },
    {
      "code": 6073,
      "name": "InvalidCoreAssetOwner",
      "msg": "Core receipt asset is not owned by the expected address"
    },
    {
      "code": 6074,
      "name": "BullRegistryMalformedProof",
      "msg": "BullRegistry Merkle proof is malformed or incomplete"
    },
    {
      "code": 6075,
      "name": "BullRegistryInvalidRoot",
      "msg": "BullRegistry Merkle root does not match the canonical root"
    },
    {
      "code": 6076,
      "name": "BullRegistrySlotOccupied",
      "msg": "BullRegistry proof leaf is not the expected empty slot"
    },
    {
      "code": 6077,
      "name": "BullRegistrySlotEmpty",
      "msg": "BullRegistry proof leaf is not the expected occupied slot"
    },
    {
      "code": 6078,
      "name": "BullRegistryOwnerMismatch",
      "msg": "BullRegistry owner bucket does not match the leaf owner"
    },
    {
      "code": 6079,
      "name": "BullProofBufferNotFinalized",
      "msg": "BullRegistry proof buffer is not finalized"
    },
    {
      "code": 6080,
      "name": "BullProofBufferAlreadyConsumed",
      "msg": "BullRegistry proof buffer has already been consumed"
    },
    {
      "code": 6081,
      "name": "InvalidBullProofBufferPda",
      "msg": "BullRegistry proof buffer PDA is invalid"
    },
    {
      "code": 6082,
      "name": "InvalidRegistrySnapshot",
      "msg": "BullRegistry snapshot root or version does not match"
    },
    {
      "code": 6083,
      "name": "BullProofBufferExpired",
      "msg": "BullRegistry proof buffer has expired"
    },
    {
      "code": 6084,
      "name": "BullProofBufferBindingMismatch",
      "msg": "BullRegistry proof buffer is bound to a different account"
    },
    {
      "code": 6085,
      "name": "BullProofBufferEmptyPayload",
      "msg": "BullProofBuffer payload length must be greater than zero"
    },
    {
      "code": 6086,
      "name": "BullProofBufferOversized",
      "msg": "BullProofBuffer payload exceeds the schema maximum"
    },
    {
      "code": 6087,
      "name": "BullProofBufferOffsetGap",
      "msg": "BullProofBuffer append offset is not sequential"
    },
    {
      "code": 6088,
      "name": "BullProofBufferWrongPosition",
      "msg": "BullProofBuffer is bound to a different Position"
    },
    {
      "code": 6089,
      "name": "BullProofBufferWrongProver",
      "msg": "BullProofBuffer can only be written by the original prover"
    },
    {
      "code": 6090,
      "name": "BullProofBufferFinalized",
      "msg": "BullProofBuffer has already been finalized"
    },
    {
      "code": 6091,
      "name": "BullProofBufferIncomplete",
      "msg": "BullProofBuffer payload is incomplete or wrong length"
    },
    {
      "code": 6092,
      "name": "BullProofBufferNotAbandoned",
      "msg": "BullProofBuffer cannot be closed before expiry or consumption"
    },
    {
      "code": 6093,
      "name": "NoEligibleExternalBull",
      "msg": "No eligible external Bull exists for this theft"
    },
    {
      "code": 6094,
      "name": "InvalidProviderAccount",
      "msg": "The provided randomness account is not a valid Switchboard randomness account"
    },
    {
      "code": 6095,
      "name": "RandomnessNotResolved",
      "msg": "The Switchboard randomness account has not yet been revealed for this slot"
    }
  ],
  "types": [
    {
      "name": "ActionType",
      "docs": [
        "Stable, append-only discriminant for randomness actions.",
        "Variants must never be reordered. Existing discriminants:",
        "Reveal = 0, Unstake = 1."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Reveal"
          },
          {
            "name": "Unstake"
          }
        ]
      }
    },
    {
      "name": "AnsemUnstakeFate",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "ToOwner"
          },
          {
            "name": "ToBullPool"
          },
          {
            "name": "Immune"
          }
        ]
      }
    },
    {
      "name": "BullAccumulator",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "reward_per_weight_scaled",
            "type": "u128"
          },
          {
            "name": "bull_index_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "bull_orphaned_accrual_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "BullLeaf",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "buck_power",
            "type": "u8"
          },
          {
            "name": "reveal_config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "BullPoolContribution",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "amount_atomic",
            "type": "u64"
          },
          {
            "name": "source",
            "type": {
              "defined": {
                "name": "BullPoolSource"
              }
            }
          }
        ]
      }
    },
    {
      "name": "BullPoolSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "CowboyClaimTax"
          },
          {
            "name": "DesperadoClaimTax"
          },
          {
            "name": "UnstakeTheft"
          }
        ]
      }
    },
    {
      "name": "BullProofBuffer",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "schema_version",
            "docs": [
              "Schema version of the payload layout."
            ],
            "type": "u8"
          },
          {
            "name": "pending_randomness",
            "docs": [
              "The PendingRandomness this buffer is bound to."
            ],
            "type": "pubkey"
          },
          {
            "name": "position",
            "docs": [
              "The Position being settled."
            ],
            "type": "pubkey"
          },
          {
            "name": "action_type",
            "docs": [
              "The action this proof buffer is for (Reveal or Unstake)."
            ],
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "snapshot_root",
            "docs": [
              "Snapshot root the proof must be verified against."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "snapshot_version",
            "docs": [
              "Snapshot version the proof must be verified against."
            ],
            "type": "u64"
          },
          {
            "name": "snapshot_total_power",
            "docs": [
              "Historical snapshot total power used for external-weight calculation."
            ],
            "type": "u64"
          },
          {
            "name": "snapshot_total_count",
            "docs": [
              "Historical snapshot total Bull count used for threshold checks."
            ],
            "type": "u64"
          },
          {
            "name": "refund_recipient",
            "docs": [
              "The party that funded the buffer and receives its rent on close."
            ],
            "type": "pubkey"
          },
          {
            "name": "expiry_timestamp",
            "docs": [
              "Timestamp after which the buffer is abandonable even if unconsumed."
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "docs": [
              "Nonce used in the PDA derivation to allow multiple buffers per prover."
            ],
            "type": "u64"
          },
          {
            "name": "expected_payload_length",
            "docs": [
              "Expected total payload length in bytes. Finalize enforces exact match."
            ],
            "type": "u32"
          },
          {
            "name": "finalized",
            "docs": [
              "True once the prover has finalized the payload; settlement may then consume it."
            ],
            "type": "bool"
          },
          {
            "name": "consumed",
            "docs": [
              "True once the buffer has been consumed by settlement."
            ],
            "type": "bool"
          },
          {
            "name": "filled",
            "docs": [
              "Number of payload bytes written so far (test-fixture overwrite tracking)."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "docs": [
              "Bump for the proof-buffer PDA."
            ],
            "type": "u8"
          },
          {
            "name": "payload",
            "docs": [
              "Serialized proof payload (variable length, bounded by `BULL_PROOF_BUFFER_MAX_PAYLOAD`)."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "BullRegistry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "owner_tree_root",
            "docs": [
              "Merkle-sum root of the owner tree."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "total_bull_count",
            "docs": [
              "Total active Bull Position count across all owners."
            ],
            "type": "u64"
          },
          {
            "name": "total_buck_power",
            "docs": [
              "Total active buck power across all owners."
            ],
            "type": "u64"
          },
          {
            "name": "registry_version",
            "docs": [
              "Monotonically increasing version. Incremented on every canonical root change."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "BullRegistryOperation",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Add"
          },
          {
            "name": "Remove"
          }
        ]
      }
    },
    {
      "name": "BullRegistryTransition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "old_root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "new_root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "old_version",
            "type": "u64"
          },
          {
            "name": "new_version",
            "type": "u64"
          },
          {
            "name": "operation",
            "type": {
              "defined": {
                "name": "BullRegistryOperation"
              }
            }
          },
          {
            "name": "bull_position",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "buck_power",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "BullRewardDistributed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount_atomic",
            "type": "u64"
          },
          {
            "name": "reward_per_weight_scaled",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "CowboyKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Unassigned"
          },
          {
            "name": "Rank",
            "fields": [
              "u8"
            ]
          },
          {
            "name": "Desperado"
          }
        ]
      }
    },
    {
      "name": "EpochClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "cowboy_emission",
            "type": "u64"
          },
          {
            "name": "suit_vault_contribution",
            "type": "u64"
          },
          {
            "name": "free_ansem",
            "type": "u64"
          },
          {
            "name": "total_cowboy_weight",
            "type": "u128"
          },
          {
            "name": "total_bull_power",
            "type": "u64"
          },
          {
            "name": "recognized_reward_balance_atomic",
            "type": "u64"
          },
          {
            "name": "total_ansem_liability_atomic",
            "type": "u64"
          },
          {
            "name": "snapshot_timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "EpochsClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "start_epoch",
            "type": "u64"
          },
          {
            "name": "end_epoch",
            "type": "u64"
          },
          {
            "name": "epochs_processed",
            "type": "u64"
          },
          {
            "name": "last_closed_timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "GlobalConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "rodeo_mint",
            "type": "pubkey"
          },
          {
            "name": "ansem_mint",
            "type": "pubkey"
          },
          {
            "name": "rodeo_decimals",
            "type": "u8"
          },
          {
            "name": "ansem_decimals",
            "type": "u8"
          },
          {
            "name": "stake_amount_atomic",
            "type": "u64"
          },
          {
            "name": "expected_total_supply_atomic",
            "type": "u64"
          },
          {
            "name": "launch_timestamp",
            "type": "i64"
          },
          {
            "name": "principal_vault",
            "type": "pubkey"
          },
          {
            "name": "reward_vault",
            "type": "pubkey"
          },
          {
            "name": "pause_new_stakes",
            "type": "bool"
          },
          {
            "name": "pause_new_reveal_requests",
            "type": "bool"
          },
          {
            "name": "pause_new_marketplace_listings",
            "type": "bool"
          },
          {
            "name": "pause_router_swaps",
            "type": "bool"
          },
          {
            "name": "upgrade_council",
            "type": "pubkey"
          },
          {
            "name": "treasury_council",
            "type": "pubkey"
          },
          {
            "name": "emergency_guardians",
            "type": "pubkey"
          },
          {
            "name": "current_config_version",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "principal_vault_bump",
            "type": "u8"
          },
          {
            "name": "reward_vault_bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "GlobalGameState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "next_position_id",
            "type": "u64"
          },
          {
            "name": "total_completed_reveals",
            "type": "u64"
          },
          {
            "name": "live_position_count",
            "type": "u64"
          },
          {
            "name": "active_cowboy_count",
            "type": "u64"
          },
          {
            "name": "active_bull_count",
            "type": "u64"
          },
          {
            "name": "total_active_cowboy_weight",
            "type": "u128"
          },
          {
            "name": "total_active_bull_power",
            "type": "u64"
          },
          {
            "name": "accounted_principal_atomic",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "MintTheft",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "prospective_owner",
            "type": "pubkey"
          },
          {
            "name": "final_owner",
            "type": "pubkey"
          },
          {
            "name": "winning_bull_position",
            "type": "pubkey"
          },
          {
            "name": "winning_bull_owner",
            "type": "pubkey"
          },
          {
            "name": "registry_snapshot_version",
            "type": "u64"
          },
          {
            "name": "config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "OrphanedRewardReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reward_source",
            "type": {
              "defined": {
                "name": "OrphanedRewardSource"
              }
            }
          },
          {
            "name": "amount_atomic",
            "type": "u64"
          },
          {
            "name": "remaining_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "total_ansem_liability_atomic_after",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "OrphanedRewardSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Cowboy"
          },
          {
            "name": "Bull"
          }
        ]
      }
    },
    {
      "name": "OwnershipChangeReason",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Sale"
          },
          {
            "name": "Gift"
          },
          {
            "name": "MintTheft"
          }
        ]
      }
    },
    {
      "name": "PendingRandomness",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "action_type",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "action_nonce",
            "type": "u64"
          },
          {
            "name": "provider_program",
            "type": "pubkey"
          },
          {
            "name": "provider_randomness_account",
            "type": "pubkey"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "committed_slot",
            "type": "u64"
          },
          {
            "name": "committed_protocol_epoch",
            "type": "u64"
          },
          {
            "name": "timeout_timestamp",
            "type": "i64"
          },
          {
            "name": "registry_root_snapshot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "registry_version_snapshot",
            "type": "u64"
          },
          {
            "name": "registry_total_count_snapshot",
            "type": "u64"
          },
          {
            "name": "registry_total_power_snapshot",
            "type": "u64"
          },
          {
            "name": "config_version_snapshot",
            "type": "u64"
          },
          {
            "name": "settled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "principal_amount",
            "type": "u64"
          },
          {
            "name": "role",
            "type": {
              "defined": {
                "name": "Role"
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "PositionStatus"
              }
            }
          },
          {
            "name": "cowboy_kind",
            "type": {
              "defined": {
                "name": "CowboyKind"
              }
            }
          },
          {
            "name": "bull_tier",
            "type": "u8"
          },
          {
            "name": "suit",
            "type": {
              "defined": {
                "name": "Suit"
              }
            }
          },
          {
            "name": "opened_at",
            "type": "i64"
          },
          {
            "name": "active_since",
            "type": "i64"
          },
          {
            "name": "unstake_eligible_at",
            "type": "i64"
          },
          {
            "name": "accrual_weight",
            "type": "u32"
          },
          {
            "name": "buck_power",
            "type": "u8"
          },
          {
            "name": "last_cowboy_reward_index",
            "type": "u128"
          },
          {
            "name": "last_bull_reward_per_weight",
            "type": "u128"
          },
          {
            "name": "cowboy_accrual_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "bull_accrual_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "claimable_ansem_atomic",
            "type": "u64"
          },
          {
            "name": "settlement_nonce",
            "type": "u64"
          },
          {
            "name": "state_version",
            "type": "u64"
          },
          {
            "name": "listing_nonce",
            "type": "u64"
          },
          {
            "name": "receipt_asset",
            "type": "pubkey"
          },
          {
            "name": "pending_action_active",
            "type": "bool"
          },
          {
            "name": "pending_action_type",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "pending_action_nonce",
            "type": "u64"
          },
          {
            "name": "next_action_nonce",
            "type": "u64"
          },
          {
            "name": "reveal_config_version",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "PositionClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "owner_amount",
            "type": "u64"
          },
          {
            "name": "bull_pool_amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "PositionOwnerChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "previous_owner",
            "type": "pubkey"
          },
          {
            "name": "new_owner",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": {
              "defined": {
                "name": "OwnershipChangeReason"
              }
            }
          }
        ]
      }
    },
    {
      "name": "PositionRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "role",
            "type": {
              "defined": {
                "name": "Role"
              }
            }
          },
          {
            "name": "cowboy_kind",
            "type": {
              "defined": {
                "name": "CowboyKind"
              }
            }
          },
          {
            "name": "bull_tier",
            "type": "u8"
          },
          {
            "name": "suit",
            "type": {
              "defined": {
                "name": "Suit"
              }
            }
          },
          {
            "name": "final_owner",
            "type": "pubkey"
          },
          {
            "name": "previous_owner",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "stolen",
            "type": "bool"
          },
          {
            "name": "receipt_asset",
            "type": "pubkey"
          },
          {
            "name": "active_since",
            "type": "i64"
          },
          {
            "name": "unstake_eligible_at",
            "type": "i64"
          },
          {
            "name": "settlement_nonce",
            "type": "u64"
          },
          {
            "name": "config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "PositionStaked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "principal_amount",
            "type": "u64"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "global_game_state",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "PositionStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "RevealPending"
          },
          {
            "name": "Active"
          }
        ]
      }
    },
    {
      "name": "PositionUnstaked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "principal_amount",
            "type": "u64"
          },
          {
            "name": "principal_returned",
            "type": "u64"
          },
          {
            "name": "principal_burned",
            "type": "u64"
          },
          {
            "name": "ansem_fate",
            "type": {
              "defined": {
                "name": "AnsemUnstakeFate"
              }
            }
          },
          {
            "name": "synchronized_ansem",
            "type": "u64"
          },
          {
            "name": "ansem_paid_to_owner",
            "type": "u64"
          },
          {
            "name": "ansem_routed_to_bull_pool",
            "type": "u64"
          },
          {
            "name": "settlement_nonce",
            "type": "u64"
          },
          {
            "name": "config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ProtocolConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "config_version",
            "type": "u64"
          },
          {
            "name": "role_weights",
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "cowboy_rank_weights",
            "type": {
              "array": [
                "u64",
                8
              ]
            }
          },
          {
            "name": "bull_tier_weights",
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "suit_weights",
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "mint_theft_weights",
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "unstake_theft_weights",
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "cowboy_accrual_weights",
            "type": {
              "array": [
                "u32",
                8
              ]
            }
          },
          {
            "name": "bull_buck_powers",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "min_reveals_for_theft",
            "type": "u64"
          },
          {
            "name": "min_bulls_for_theft",
            "type": "u64"
          },
          {
            "name": "unstake_tax_bps",
            "type": "u64"
          },
          {
            "name": "unstake_return_bps",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "_reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ProtocolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "reward_state",
            "type": "pubkey"
          },
          {
            "name": "global_game_state",
            "type": "pubkey"
          },
          {
            "name": "bull_accumulator",
            "type": "pubkey"
          },
          {
            "name": "bull_registry",
            "type": "pubkey"
          },
          {
            "name": "protocol_config",
            "type": "pubkey"
          },
          {
            "name": "rodeo_mint",
            "type": "pubkey"
          },
          {
            "name": "ansem_mint",
            "type": "pubkey"
          },
          {
            "name": "rodeo_decimals",
            "type": "u8"
          },
          {
            "name": "ansem_decimals",
            "type": "u8"
          },
          {
            "name": "stake_amount_atomic",
            "type": "u64"
          },
          {
            "name": "expected_total_supply_atomic",
            "type": "u64"
          },
          {
            "name": "launch_timestamp",
            "type": "i64"
          },
          {
            "name": "principal_vault",
            "type": "pubkey"
          },
          {
            "name": "reward_vault",
            "type": "pubkey"
          },
          {
            "name": "upgrade_council",
            "type": "pubkey"
          },
          {
            "name": "treasury_council",
            "type": "pubkey"
          },
          {
            "name": "emergency_guardians",
            "type": "pubkey"
          },
          {
            "name": "current_config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "RandomnessRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "action_type",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "action_nonce",
            "type": "u64"
          },
          {
            "name": "committed_slot",
            "type": "u64"
          },
          {
            "name": "committed_protocol_epoch",
            "type": "u64"
          },
          {
            "name": "timeout_timestamp",
            "type": "i64"
          },
          {
            "name": "provider_program",
            "type": "pubkey"
          },
          {
            "name": "provider_randomness_account",
            "type": "pubkey"
          },
          {
            "name": "vrf_key",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "callback_id",
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "registry_root_snapshot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "registry_version_snapshot",
            "type": "u64"
          },
          {
            "name": "registry_total_count_snapshot",
            "type": "u64"
          },
          {
            "name": "registry_total_power_snapshot",
            "type": "u64"
          },
          {
            "name": "config_version_snapshot",
            "type": "u64"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "RandomnessSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "action_type",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "action_nonce",
            "type": "u64"
          },
          {
            "name": "settlement_nonce",
            "type": "u64"
          },
          {
            "name": "committed_slot",
            "type": "u64"
          },
          {
            "name": "committed_protocol_epoch",
            "type": "u64"
          },
          {
            "name": "settled_at",
            "type": "i64"
          },
          {
            "name": "config_version_snapshot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "RandomnessTimeoutRecovered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "action_type",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "action_nonce",
            "type": "u64"
          },
          {
            "name": "recovery_action",
            "type": {
              "defined": {
                "name": "TimeoutRecoveryAction"
              }
            }
          }
        ]
      }
    },
    {
      "name": "ReceiptBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "receipt_asset",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "collection",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "ReceiptCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "position_id",
            "type": "u64"
          },
          {
            "name": "receipt_asset",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "collection",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "RewardFundingRecognized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount_atomic",
            "type": "u64"
          },
          {
            "name": "recognized_reward_balance_atomic",
            "type": "u64"
          },
          {
            "name": "actual_reward_vault_balance",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "RewardPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount_atomic",
            "type": "u64"
          },
          {
            "name": "recognized_reward_balance_atomic",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": {
              "defined": {
                "name": "RewardPaidReason"
              }
            }
          }
        ]
      }
    },
    {
      "name": "RewardPaidReason",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "CowboyClaim"
          },
          {
            "name": "DesperadoClaim"
          },
          {
            "name": "BullClaim"
          },
          {
            "name": "UnstakeSettlement"
          },
          {
            "name": "SuitReward"
          }
        ]
      }
    },
    {
      "name": "RewardState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "current_epoch",
            "type": "u64"
          },
          {
            "name": "epoch_started_at",
            "type": "i64"
          },
          {
            "name": "last_closed_epoch_timestamp",
            "type": "i64"
          },
          {
            "name": "total_ansem_liability_atomic",
            "type": "u64"
          },
          {
            "name": "cowboy_unmaterialized_liability_atomic",
            "type": "u64"
          },
          {
            "name": "position_claimable_liability_atomic",
            "type": "u64"
          },
          {
            "name": "bull_pool_liability_atomic",
            "type": "u64"
          },
          {
            "name": "bull_pool_unallocated_liability_atomic",
            "type": "u64"
          },
          {
            "name": "suit_vault_liability_atomic",
            "type": "u64"
          },
          {
            "name": "recognized_reward_balance_atomic",
            "type": "u64"
          },
          {
            "name": "ansem_emitted_atomic",
            "type": "u64"
          },
          {
            "name": "ansem_claimed_atomic",
            "type": "u64"
          },
          {
            "name": "orphaned_reward_released_atomic",
            "type": "u64"
          },
          {
            "name": "cowboy_reward_index",
            "type": "u128"
          },
          {
            "name": "cowboy_index_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "cowboy_orphaned_accrual_remainder_scaled",
            "type": "u128"
          },
          {
            "name": "suit_epoch",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Role",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Unassigned"
          },
          {
            "name": "Cowboy"
          },
          {
            "name": "Bull"
          }
        ]
      }
    },
    {
      "name": "Suit",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Unassigned"
          },
          {
            "name": "Hearts"
          },
          {
            "name": "Diamonds"
          },
          {
            "name": "Clubs"
          },
          {
            "name": "Spades"
          }
        ]
      }
    },
    {
      "name": "TimeoutRecoveryAction",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "CloseAndRefundPrincipal"
          },
          {
            "name": "CancelUnstake"
          }
        ]
      }
    },
    {
      "name": "UnstakeRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "position",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "action_nonce",
            "type": "u64"
          },
          {
            "name": "requested_at",
            "type": "i64"
          },
          {
            "name": "config_version",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "WalletClaimCooldown",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "global_config",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "last_claimed_at",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "DEFAULT_PAUSE_FLAG",
      "type": {
        "defined": {
          "name": "PauseFlag"
        }
      },
      "value": "NewStakes"
    }
  ]
} as const satisfies Idl;
export type RodeoCoreIdl = typeof rodeoCoreIdl;
