Feature: NIP-01
  Scenario: Alice gets an event by ID
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "why is nobody talking about this?"
    And Alice subscribes to last event from Bob
    Then Alice receives a text_note event from Bob with content "why is nobody talking about this?"

  Scenario: Alice posts a set_metadata event
    Given someone called Alice
    And Alice subscribes to author Alice
    When Alice sends a set_metadata event
    Then Alice receives a set_metadata event from Alice

  Scenario: Alice posts a text_note event
    Given someone called Alice
    And Alice subscribes to author Alice
    When Alice sends a text_note event with content "hello world"
    Then Alice receives a text_note event from Alice with content "hello world"

  Scenario: Alice posts a recommend_server event
    Given someone called Alice
    And Alice subscribes to author Alice
    When Alice sends a recommend_server event with content "https://nostr-ts-relay.wlvs.space"
    Then Alice receives a recommend_server event from Alice with content "https://nostr-ts-relay.wlvs.space"

  Scenario: Alice can't post a text_note event with an invalid signature
    Given someone called Alice
    When Alice sends a text_note event with invalid signature
    Then Alice receives an unsuccessful result

  Scenario: Alice and Bob exchange text_note events
    Given someone called Alice
    And someone called Bob
    And Alice subscribes to author Bob
    And Bob subscribes to author Alice
    When Bob sends a text_note event with content "hello alice"
    Then Alice receives a text_note event from Bob with content "hello alice"
    When Alice sends a text_note event with content "hello bob"
    Then Bob receives a text_note event from Alice with content "hello bob"

  Scenario: Alice is interested in text_note events
    Given someone called Alice
    And someone called Bob
    And Alice subscribes to text_note events
    When Bob sends a text_note event with content "hello nostr"
    Then Alice receives a text_note event from Bob with content "hello nostr"

  Scenario: Alice is interested in the #NostrNovember hashtag
    Given someone called Alice
    And someone called Bob
    And Alice subscribes to tag t with "NostrNovember"
    When Bob sends a text_note event with content "Nostr FTW!" and tag t containing "NostrNovember"
    Then Alice receives a text_note event from Bob with content "Nostr FTW!"

  Scenario: Alice is interested to Bob's text_note events and Charlie's set_metadata events
    Given someone called Alice
    And someone called Bob
    And someone called Charlie
    And Bob subscribes to author Bob
    And Charlie subscribes to author Charlie

    When Bob sends a text_note event with content "I'm Bob"
    And Bob receives a text_note event from Bob with content "I'm Bob"
    And Charlie sends a set_metadata event
    And Charlie receives a set_metadata event from Charlie
    And Alice subscribes to text_note events from Bob and set_metadata events from Charlie

    Then Alice receives 2 events from Bob and Charlie

  Scenario: Alice is interested in Bob's events from back in November
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "What's up?" on 1668074223
    And Alice subscribes to any event since 1667275200 until 1669870799
    Then Alice receives a text_note event from Bob with content "What's up?"

  Scenario: Alice is interested Bob's in 2 past events
    Given someone called Alice
    And someone called Bob
    Then Bob subscribes to author Bob
    And Bob sends a text_note event with content "One"
    And Bob receives a text_note event from Bob with content "One"
    And Bob sends a text_note event with content "Two"
    And Bob receives a text_note event from Bob with content "Two"
    And Bob sends a text_note event with content "Three"
    And Bob receives a text_note event from Bob with content "Three"
    When Alice subscribes to author Bob with a limit of 2
    Then Alice receives 2 text_note events from Bob and EOSE


