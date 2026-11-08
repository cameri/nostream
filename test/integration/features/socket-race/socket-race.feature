@socket-race
Feature: Commands that race the connection are answered, not just survived

  # Issue #1052: a relay that drops a REQ has survived perfectly well. Each
  # case asserts the reply the client is entitled to — EOSE, OK, NOTICE — not
  # merely that the socket stayed open.

  Scenario: Subscriptions sent at the open tick each receive their EOSE
    When 10 sockets subscribe at the open tick, repeated 20 times
    Then each socket received EOSE for its own subscription

  Scenario: Two subscriptions sent in one turn are both answered
    When a socket sends REQ "pipelined-1" and then REQ "pipelined-2" in one turn
    Then the socket received EOSE for "pipelined-1" and "pipelined-2"

  Scenario: A subscription closed in the same turn never receives an event
    Given a publisher called race-cancel-author
    When a socket subscribes at the open tick and closes it in the same turn
    And the publisher publishes a text note
    Then "race-cancel" received no event and the socket still answers

  Scenario: An event sent at the open tick receives its OK
    Given a publisher called race-writer
    When the publisher sends an event at the open tick
    Then the socket received OK for that event

  Scenario: Fragmented and binary frames are honoured
    When a socket sends a fragmented REQ and a binary REQ in one turn
    Then both subscriptions received EOSE and the socket still answers

  Scenario: Invalid JSON mid-stream is refused and the socket stays usable
    When a socket sends invalid JSON and then a REQ
    Then the socket received a NOTICE and then EOSE for the REQ
