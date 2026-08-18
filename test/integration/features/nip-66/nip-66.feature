@nip-66
Feature: NIP-66 relay monitoring
  Scenario: probe run stores latest snapshot in Redis
    Given NIP-66 relay monitoring is enabled
    And the probe target is "ws://localhost:18808"
    When the relay monitor worker completes a probe run
    Then the latest probe snapshot in Redis has status "ok"
    And the snapshot includes probe results for "ws://localhost:18808"

  Scenario: disabled monitoring does not write a snapshot
    Given NIP-66 relay monitoring is disabled
    When the relay monitor worker is started
    Then the relay monitor worker does not store a probe snapshot

  Scenario: empty targets fall back to info.relay_url
    Given NIP-66 relay monitoring is enabled
    And no explicit NIP-66 probe targets are configured
    When the relay monitor worker completes a probe run
    Then the snapshot uses the configured relay URL as its probe target
    And the latest probe snapshot in Redis has status "ok"

  Scenario: invalid probe targets are skipped
    Given NIP-66 relay monitoring is enabled
    And invalid and valid NIP-66 probe targets are configured
    When the relay monitor worker completes a probe run
    Then the latest probe snapshot in Redis has status "ok"
    And the snapshot includes probe results for "ws://localhost:18808"
