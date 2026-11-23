@peering-owner-attestation
Feature: Owner-attested peering requests

  Scenario: A configured relay is attested and later recognized at AUTH
    When a configured relay presents an owner-signed peering request
    Then the request is stored as an accepted attestation
    And a later AUTH from that relay is recognized without repeating the request
