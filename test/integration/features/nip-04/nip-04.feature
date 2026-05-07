Feature: NIP-04 Encrypted direct messages
  Scenario: Alice publishes an encrypted direct message to Bob
    Given someone called Alice
    And someone called Bob
    When Alice sends an encrypted_direct_message event with content "ciphertext-for-bob" to Bob
    And Alice subscribes to author Alice
    Then Alice receives an encrypted_direct_message event from Alice with content "ciphertext-for-bob" tagged for Bob

  Scenario: Alice gets her encrypted direct message by event ID
    Given someone called Alice
    And someone called Bob
    When Alice sends an encrypted_direct_message event with content "ciphertext-by-id" to Bob
    And Alice subscribes to last event from Alice
    Then Alice receives an encrypted_direct_message event from Alice with content "ciphertext-by-id" tagged for Bob

  Scenario: Bob receives Alice's encrypted direct message through #p filter
    Given someone called Alice
    And someone called Bob
    When Alice sends an encrypted_direct_message event with content "ciphertext-for-bob-filter" to Bob
    And Bob subscribes to tag p with Bob pubkey
    Then Bob receives an encrypted_direct_message event from Alice with content "ciphertext-for-bob-filter" tagged for Bob

  Scenario: Bob and Charlie receive identical ciphertext for Bob's #p filter
    Given someone called Alice
    And someone called Bob
    And someone called Charlie
    And Bob subscribes to tag p with Bob pubkey
    And Charlie subscribes to tag p with Bob pubkey
    When Alice sends an encrypted_direct_message event with content "ciphertext-visible-to-filter-subscribers" to Bob
    Then Bob receives an encrypted_direct_message event from Alice with content "ciphertext-visible-to-filter-subscribers" tagged for Bob
    And Charlie receives an encrypted_direct_message event from Alice with content "ciphertext-visible-to-filter-subscribers" tagged for Bob

  Scenario: Alice submits a duplicate encrypted direct message
    Given someone called Alice
    And someone called Bob
    When Alice sends an encrypted_direct_message event with content "ciphertext-duplicate" to Bob
    And Alice resubmits their last event
    Then Alice receives a successful command result with message "duplicate:"
