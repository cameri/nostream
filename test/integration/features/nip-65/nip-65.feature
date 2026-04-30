Feature: NIP-65 Relay List Metadata
  Scenario: Alice publishes a relay list and retrieves it
    Given someone called Alice
    When Alice sends a relay_list event with relays "wss://alice.relay.com"
    And Alice subscribes to her relay_list events
    Then Alice receives a relay_list event with relays "wss://alice.relay.com"

  Scenario: Alice updates her relay list and only the latest is kept
    Given someone called Alice
    When Alice sends a relay_list event with relays "wss://old.relay.com"
    And Alice sends a relay_list event with relays "wss://new.relay.com"
    And Alice subscribes to her relay_list events
    Then Alice receives 1 relay_list event and EOSE
    And the relay_list event has relays "wss://new.relay.com"

  Scenario: Bob can query Alice's relay list
    Given someone called Alice
    And someone called Bob
    When Alice sends a relay_list event with relays "wss://alice.relay.com"
    And Bob subscribes to author Alice
    Then Bob receives a relay_list event with relays "wss://alice.relay.com"

  Scenario: Alice publishes a relay list with read and write markers
    Given someone called Alice
    When Alice sends a relay_list event with a read relay "wss://read.relay.com" and a write relay "wss://write.relay.com"
    And Alice subscribes to her relay_list events
    Then Alice receives a relay_list event with a read relay "wss://read.relay.com" and a write relay "wss://write.relay.com"
