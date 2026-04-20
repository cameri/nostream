Feature: NIP-02 Contact Lists
  Scenario: Alice publishes a contact list
    Given someone called Alice
    When Alice sends a contact_list event with tags
    And Alice subscribes to author Alice
    Then Alice receives a contact_list event from Alice

  Scenario: Alice publishes an updated contact list
    Given someone called Alice
    When Alice sends a contact_list event with tags
    And Alice sends a second contact_list event with different tags
    And Alice subscribes to author Alice
    Then Alice receives 1 contact_list event from Alice with the latest tags and EOSE

  Scenario: Tie-breaker on Identical Timestamps for contact list
    Given someone called Alice
    When Alice sends two identically-timestamped contact_list events where the second has a lower ID
    And Alice subscribes to author Alice
    Then Alice receives 1 contact_list event from Alice matching the lower ID event and EOSE

  Scenario: Bob subscribes to Alice's contact list
    Given someone called Alice
    And someone called Bob
    When Alice sends a contact_list event with tags
    And Bob subscribes to author Alice
    Then Bob receives a contact_list event from Alice
