@nip43
@join
Feature: NIP-43 relay membership

  # admit_user() is a stored function guarded by PERFORM ASSERT_SERIALIZED(),
  # so it only runs inside a serializable transaction. A join that is not
  # wrapped in one reaches the handler, claims its invite and then fails with
  # SN_NOT_SERIALIZABLE — which no unit test could see, because every unit test
  # stubs the repository or passes its own client.
  Scenario: A join request with a valid invite admits the pubkey
    Given Alice connects and keeps the relay's auth challenge
    And an invite code "join-alice" with one use
    When Alice authenticates with the relay
    And Alice sends a join request claiming "join-alice"
    Then the join request is accepted
    And Alice is admitted

  Scenario: A join request with an unknown invite code is refused
    Given Bob connects and keeps the relay's auth challenge
    When Bob authenticates with the relay
    And Bob sends a join request claiming "no-such-invite"
    Then the join request is refused with "restricted: invalid or expired invite code"
    And Bob is not admitted
