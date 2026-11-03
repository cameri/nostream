Feature: Peering sync planning
  Scenario: Wide peering scopes are chunked for a peer
    When a peering scope covers kinds 0 through 7
    Then the scope produces filters of at most 4 kinds

  Scenario: Short rolling windows keep their own cutoff
    When a peering scope uses a 5 second rolling window at 1000
    Then its live filter starts at 995

  Scenario: Oversized filter is split in time
    When an unbounded peering filter is split at 1000
    Then the split filters cover 0 to 500 and 501 to 1000

  Scenario: NIP-11 private addresses are rejected
    Then the NIP-11 address "127.0.0.1" is blocked
