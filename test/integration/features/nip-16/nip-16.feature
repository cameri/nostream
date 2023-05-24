Feature: NIP-16 Event treatment
  Scenario: Alice sends a replaceable event
    Given someone called Alice
    When Alice sends a replaceable_event_0 event with content "created"
    And Alice sends a replaceable_event_0 event with content "updated"
    And Alice subscribes to author Alice
    Then Alice receives a replaceable_event_0 event from Alice with content "updated"
    Then Alice unsubscribes from author Alice
    When Alice subscribes to author Alice
    Then Alice receives 1 replaceable_event_0 event from Alice with content "updated" and EOSE

  Scenario: Charlie sends an ephemeral event
    Given someone called Charlie
    Given someone called Alice
    And Alice subscribes to author Charlie
    When Charlie sends a ephemeral_event_0 event with content "now you see me"
    Then Alice receives a ephemeral_event_0 event from Charlie with content "now you see me"
    Then Alice unsubscribes from author Charlie
    When Alice subscribes to author Charlie
    Then Alice receives 0 ephemeral_event_0 events and EOSE
