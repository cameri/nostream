Feature: NIP-03 OpenTimestamps
  Scenario: Alice publishes a valid OpenTimestamps attestation for her text note
    Given someone called Alice
    When Alice sends a text_note event with content "anchor this note"
    And Alice sends a valid OpenTimestamps attestation for her last text_note event
    And Alice subscribes to OpenTimestamps events from Alice
    Then Alice receives an OpenTimestamps attestation from Alice for her last text_note event

  Scenario: Alice cannot publish an attestation whose OTS digest does not match the e tag
    Given someone called Alice
    When Alice sends a text_note event with content "wrong digest"
    And Alice sends an OpenTimestamps attestation with mismatching OTS digest for her last text_note event
