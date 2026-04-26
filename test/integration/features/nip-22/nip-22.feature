@nip-22
Feature: NIP-22 created_at timestamp limits
  Scenario: Event with created_at at current time is accepted
    Given someone called Alice
    And created_at limits are set to maxPositiveDelta 900 and maxNegativeDelta 0
    When Alice drafts a text_note event with content "test event" and created_at 0 seconds from now
    Then Alice sends their last draft event successfully
    When Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "test event"

  Scenario: Event with created_at above positive delta limit is rejected
    Given someone called Alice
    And created_at limits are set to maxPositiveDelta 900 and maxNegativeDelta 0
    When Alice drafts a text_note event with content "test event" and created_at 910 seconds from now
    Then Alice sends their last draft event unsuccessfully with reason containing "rejected"

  Scenario: Event older than configured negative delta limit is rejected
    Given someone called Alice
    And created_at limits are set to maxPositiveDelta 900 and maxNegativeDelta 3600
    When Alice drafts a text_note event with content "test event" and created_at -3601 seconds from now
    Then Alice sends their last draft event unsuccessfully with reason containing "rejected"

  Scenario: Event within configured negative delta limit is accepted
    Given someone called Alice
    And created_at limits are set to maxPositiveDelta 900 and maxNegativeDelta 3600
    When Alice drafts a text_note event with content "test event" and created_at -3590 seconds from now
    Then Alice sends their last draft event successfully
    When Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "test event"
