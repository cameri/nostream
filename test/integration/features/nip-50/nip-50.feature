Feature: NIP-50
  Scenario: Alice searches for events by content
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "Bitcoin and Lightning Network are great"
    And Bob sends a text_note event with content "Nostr is a decentralized protocol"
    And Alice subscribes to search for "bitcoin lightning"
    Then Alice receives 1 text_note event from Bob with search match and EOSE

  Scenario: Alice gets no results for a search with no matches
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "Hello world from Nostr"
    And Alice subscribes to search for "ethereum solana"
    Then Alice receives 0 events for search and EOSE

  Scenario: Alice combines search with kind filter
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "Bitcoin is freedom"
    And Alice subscribes to search for "bitcoin" with kinds 1
    Then Alice receives 1 text_note event from Bob with search match and EOSE
