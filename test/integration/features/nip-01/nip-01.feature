Feature: NIP-01
  Scenario: Alice posts a set_metadata event
    Given someone is Alice
    And Alice subscribes to author Alice
    When Alice sends a set_metadata event
    Then Alice receives a set_metadata event from Alice

  Scenario: Alice posts a text_note event
    Given someone is Alice
    And Alice subscribes to author Alice
    When Alice sends a text_note event with content "hello world"
    Then Alice receives a text_note event from Alice with content "hello world"

  Scenario: Alice posts a recommend_server event
    Given someone is Alice
    And Alice subscribes to author Alice
    When Alice sends a recommend_server event with content "https://nostr-ts-relay.wlvs.space"
    Then Alice receives a recommend_server event from Alice with content "https://nostr-ts-relay.wlvs.space"

  Scenario: Alice can't post a text_note event with an invalid signature
    Given someone is Alice
    When Alice sends a text_note event with invalid signature
    Then Alice receives a notice with invalid signature

  Scenario: Alice and Bob exchange text_note events
    Given someone is Alice
    And someone is Bob
    And Alice subscribes to author Bob
    And Bob subscribes to author Alice
    When Bob sends a text_note event with content "hello alice"
    Then Alice receives a text_note event from Bob with content "hello alice"
    When Alice sends a text_note event with content "hello bob"
    Then Bob receives a text_note event from Alice with content "hello bob"

  Scenario: Alice is interested in text_note events
    Given someone is Alice
    And someone is Bob
    And Alice subscribes to text_note events
    When Bob sends a text_note event with content "hello nostr"
    Then Alice receives a text_note event from Bob with content "hello nostr"

  Scenario: Alice is interested in the #NostrNovember hashtag
    Given someone is Alice
    And someone is Bob
    And Alice subscribes to tag t with "NostrNovember"
    When Bob sends a text_note event with content "Nostr FTW!" and tag t containing "NostrNovember"
    Then Alice receives a text_note event from Bob with content "Nostr FTW!"

  Scenario: Alice is interested in Bob's events from back in November
    Given someone is Alice
    And someone is Bob
    When Bob sends a text_note event with content "What's up?" on 1668074223
    And Alice subscribes to any event since 1667275200 until 1669870799
    Then Alice receives a text_note event from Bob with content "What's up?"

  Scenario: Alice is interested Bob's in 2 past events
    Given someone is Alice
    And someone is Bob
    Then Bob subscribes to author Bob
    And Bob sends a text_note event with content "One"
    And Bob receives a text_note event from Bob with content "One"
    And Bob sends a text_note event with content "Two"
    And Bob receives a text_note event from Bob with content "Two"
    And Bob sends a text_note event with content "Three"
    And Bob receives a text_note event from Bob with content "Three"
    When Alice subscribes to author Bob with a limit of 2
    Then Alice receives 2 text_note events from Bob and EOSE


