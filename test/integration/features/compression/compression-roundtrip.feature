@compression-roundtrip
Feature: Compressed import/export roundtrip
  Scenario Outline: roundtrip events with <format> compression
    Given a seeded compression roundtrip dataset
    When I export events using "<format>" compression
    And I remove the seeded roundtrip events from the database
    And I import the compressed roundtrip file
    Then the seeded roundtrip events are restored

    Examples:
      | format |
      | gzip   |
      | xz     |