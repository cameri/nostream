@nip13
Feature: NIP-13 Proof of Work enforcement
  Scenario: Event ID PoW disabled accepts event
    Given someone called Alice
    And NIP-13 event ID minimum leading zero bits is 0
    And NIP-13 pubkey minimum leading zero bits is 0
    When Alice sends a plain text_note event with content "event-id-disabled" and records the command result
    Then Alice receives a successful NIP-13 command result
    When Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "event-id-disabled"

  Scenario: Event ID PoW rejects insufficient proof of work
    Given someone called Alice
    And NIP-13 event ID minimum leading zero bits is 10
    And NIP-13 pubkey minimum leading zero bits is 0
    When Alice sends a text_note event with content "event-id-fail" and event ID PoW below the required threshold
    Then Alice receives an unsuccessful NIP-13 event ID PoW result

  Scenario: Event ID PoW accepts sufficient proof of work
    Given someone called Alice
    And NIP-13 event ID minimum leading zero bits is 10
    And NIP-13 pubkey minimum leading zero bits is 0
    When Alice sends a text_note event with content "event-id-pass" and event ID PoW at least the required threshold
    Then Alice receives a successful NIP-13 command result
    When Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "event-id-pass"

  Scenario: Pubkey PoW rejects insufficient proof of work
    Given someone called Alice
    And NIP-13 event ID minimum leading zero bits is 0
    And NIP-13 pubkey minimum leading zero bits is 10
    When Alice sends a text_note event with content "pubkey-fail" and pubkey PoW below the required threshold
    Then Alice receives an unsuccessful NIP-13 pubkey PoW result

  Scenario: Pubkey PoW accepts sufficient proof of work
    Given someone called Alice
    And NIP-13 event ID minimum leading zero bits is 0
    And NIP-13 pubkey minimum leading zero bits is 10
    When Alice sends a text_note event with content "pubkey-pass" and pubkey PoW at least the required threshold
    Then Alice receives a successful NIP-13 command result
    When Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "pubkey-pass"
