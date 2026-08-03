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
    }
  ],
  "events": [
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
      "name": "AlreadyInitialized",
      "msg": "Protocol has already been initialized"
    },
    {
      "code": 6004,
      "name": "InvalidProgramAccount",
      "msg": "Invalid program account"
    },
    {
      "code": 6005,
      "name": "InvalidProgramData",
      "msg": "Invalid program data account"
    },
    {
      "code": 6006,
      "name": "UnauthorizedInitializer",
      "msg": "Initializer is not the program upgrade authority"
    },
    {
      "code": 6007,
      "name": "InvalidGovernanceAuthority",
      "msg": "Invalid governance authority"
    },
    {
      "code": 6008,
      "name": "GovernanceAuthoritiesNotDistinct",
      "msg": "Governance authorities must be pairwise distinct"
    },
    {
      "code": 6009,
      "name": "IdenticalTokenMints",
      "msg": "RODEO and ANSEM mints must be different"
    },
    {
      "code": 6010,
      "name": "ActiveMintAuthority",
      "msg": "Mint authority must be revoked"
    },
    {
      "code": 6011,
      "name": "ActiveFreezeAuthority",
      "msg": "Freeze authority must be revoked"
    },
    {
      "code": 6012,
      "name": "RejectionSamplingExhausted",
      "msg": "Rejection sampling exhausted without an accepted candidate"
    },
    {
      "code": 6013,
      "name": "InvalidBps",
      "msg": "Invalid BPS value"
    },
    {
      "code": 6014,
      "name": "InvalidMint",
      "msg": "Invalid mint account"
    },
    {
      "code": 6015,
      "name": "UnexpectedRodeoSupply",
      "msg": "RODEO mint supply does not match the expected total supply"
    },
    {
      "code": 6016,
      "name": "InvalidVault",
      "msg": "Invalid vault account"
    },
    {
      "code": 6017,
      "name": "InvalidDecimals",
      "msg": "Invalid decimals or atomic conversion failed"
    },
    {
      "code": 6018,
      "name": "ZeroPrincipal",
      "msg": "Principal must be greater than zero"
    },
    {
      "code": 6019,
      "name": "AlreadySettled",
      "msg": "Randomness has already been settled"
    },
    {
      "code": 6020,
      "name": "InvalidReveal",
      "msg": "Reveal does not match the commitment"
    },
    {
      "code": 6021,
      "name": "InvalidOwner",
      "msg": "Position owner does not match the signer"
    },
    {
      "code": 6022,
      "name": "NoPendingRevealAction",
      "msg": "No reveal action is pending for this position"
    },
    {
      "code": 6023,
      "name": "PositionLocked",
      "msg": "Position has a pending action and cannot be transferred"
    },
    {
      "code": 6024,
      "name": "StakeAmountMismatch",
      "msg": "Stake amount must equal the configured requirement"
    },
    {
      "code": 6025,
      "name": "MinimumStakePeriodNotMet",
      "msg": "Position has not been active long enough"
    },
    {
      "code": 6026,
      "name": "ClaimCooldownNotMet",
      "msg": "Wallet claim cooldown has not elapsed"
    },
    {
      "code": 6027,
      "name": "NoClaimableRewards",
      "msg": "Position has no claimable ANSEM after synchronization"
    },
    {
      "code": 6028,
      "name": "EpochsNotClosed",
      "msg": "All elapsed epochs must be closed before this operation"
    },
    {
      "code": 6029,
      "name": "InvalidProbabilityOutcome",
      "msg": "Randomness outcome does not map to a valid role/cowboy_kind/bull_tier/suit"
    },
    {
      "code": 6030,
      "name": "InvalidProbabilityTable",
      "msg": "Probability table weights do not sum to denominator"
    },
    {
      "code": 6031,
      "name": "PendingActionBlocksTransfer",
      "msg": "Cannot change owner while a randomness action is pending"
    },
    {
      "code": 6032,
      "name": "PendingActionBlocksClaim",
      "msg": "Cannot claim while a randomness action is pending"
    },
    {
      "code": 6033,
      "name": "StaleListing",
      "msg": "Listing no longer matches the position state"
    },
    {
      "code": 6034,
      "name": "InvalidMarketReceipt",
      "msg": "Receipt asset does not match the position"
    },
    {
      "code": 6035,
      "name": "InvalidSocialAttestation",
      "msg": "Social oracle attestation signatures are invalid"
    },
    {
      "code": 6036,
      "name": "SuitCompetitionNotEnded",
      "msg": "Social competition epoch has not ended"
    },
    {
      "code": 6037,
      "name": "UnrecognizedRewardFunding",
      "msg": "ANSEM in the vault is not yet recognized for liability accounting"
    },
    {
      "code": 6038,
      "name": "UnauthorizedSwapVenue",
      "msg": "Unauthorized swap venue"
    },
    {
      "code": 6039,
      "name": "SlippageExceeded",
      "msg": "Swap output below minimum"
    },
    {
      "code": 6040,
      "name": "PausedNewStakes",
      "msg": "New stakes are paused"
    },
    {
      "code": 6041,
      "name": "PausedNewRevealRequests",
      "msg": "New reveal requests are paused"
    },
    {
      "code": 6042,
      "name": "PausedNewMarketplaceListings",
      "msg": "New marketplace listings are paused"
    },
    {
      "code": 6043,
      "name": "PausedRouterSwaps",
      "msg": "Router swaps are paused"
    }
  ],
  "types": [
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
