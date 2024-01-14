Feature: NIP-09
  Scenario: Alice deletes her text_note
    Given someone called Alice
    And someone called Bob
    And Alice sends a text_note event with content "Twitter > Nostr"
    When Alice sends a delete event for their last event
    And Alice subscribes to author Alice
    Then Alice receives 1 delete event from Alice and EOSE

  Scenario: Alice deletes her set_metadata
    Given someone called Alice
    And someone called Bob
    And Alice drafts a set_metadata event
    When Alice sends a delete event for their last event
    And Alice subscribes to author Alice
    Then Alice receives 1 delete event from Alice and EOSE

  Scenario: Alice sends a delete before deleted text_note
    Given someone called Alice
    And someone called Bob
    And Alice drafts a text_note event with content "Twitter > Nostr"
    When Alice sends a delete event for their last event
    And Alice sends their last draft event successfully
    And Alice subscribes to author Alice
    Then Alice receives 1 delete event from Alice and EOSE

  Scenario: Alice sends a delete before deleted set_metadata
    Given someone called Alice
    And someone called Bob
    And Alice drafts a set_metadata event
    When Alice sends a delete event for their last event
    And Alice sends their last draft event unsuccessfully
    And Alice subscribes to author Alice
    Then Alice receives 1 delete event from Alice and EOSE
