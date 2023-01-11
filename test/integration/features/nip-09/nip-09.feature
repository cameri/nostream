@Test
Feature: NIP-09
  Scenario: Charlie deletes an event
    Given someone called Charlie
    And someone called Bob
    And Charlie sends a text_note event with content "Twitter > Nostr"
    And Charlie subscribes to author Charlie
    And Charlie receives a text_note event from Charlie with content "Twitter > Nostr"
    And Charlie unsubscribes from author Charlie
    When Charlie sends a delete event for their last event
    And Charlie subscribes to author Charlie
    And Charlie receives 1 delete event from Charlie and EOSE
    Then Bob subscribes to author Charlie
    Then Bob receives 1 delete event from Charlie and EOSE
