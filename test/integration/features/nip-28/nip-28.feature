Feature: NIP-28
  Scenario: Alice creates a channel
    Given someone called Alice
    When Alice sends a channel_creation event with content '{\"name\": \"Demo Channel\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice subscribes to last event from Alice
    Then Alice receives a channel_creation event from Alice with content '{\"name\": \"Demo Channel\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'

  Scenario: Alice sets metadata for a channel
    Given someone called Alice
    And Alice subscribes to author Alice
    And Alice sends a channel_creation event with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice receives a channel_creation event from Alice with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    When Alice sends a channel_metadata event with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'
    Then Alice receives a channel_metadata event from Alice with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'

  Scenario: Alice replaces metadata for a channel
    Given someone called Alice
    And Alice subscribes to author Alice
    And Alice sends a channel_creation event with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice receives a channel_creation event from Alice with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice sends a channel_metadata event with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'
    And Alice receives a channel_metadata event from Alice with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'
    When Alice sends a channel_metadata event with content '{\"name\": \"Replaced\", \"about\": \"A different test channel.\", \"picture\": \"https://placekitten.com/400/400\"}'
    Then Alice receives a channel_metadata event from Alice with content '{\"name\": \"Replaced\", \"about\": \"A different test channel.\", \"picture\": \"https://placekitten.com/400/400\"}'

  Scenario: Alice replaces metadata for a channel twice
    Given someone called Alice
    And Alice subscribes to author Alice
    And Alice sends a channel_creation event with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice receives a channel_creation event from Alice with content '{\"name\": \"Original\", \"about\": \"A test channel.\", \"picture\": \"https://placekitten.com/200/200\"}'
    And Alice sends a channel_metadata event with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'
    And Alice receives a channel_metadata event from Alice with content '{\"name\": \"New\", \"about\": \"A better test channel.\", \"picture\": \"https://placekitten.com/256/256\"}'
    When Alice sends a channel_metadata event with content '{\"name\": \"Replaced\", \"about\": \"A different test channel.\", \"picture\": \"https://placekitten.com/400/400\"}'
    Then Alice receives a channel_metadata event from Alice with content '{\"name\": \"Replaced\", \"about\": \"A different test channel.\", \"picture\": \"https://placekitten.com/400/400\"}'
