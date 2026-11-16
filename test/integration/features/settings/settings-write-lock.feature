@settings-write-lock
Feature: Settings write lock

  Every settings-file writer takes the same lock, and a lock held by a process
  in another container or on the host is never stolen while its heartbeat is
  fresh.

  Scenario: Two writers serialize and expose their lock owner
    When two settings writers queue for the lock
    Then the writers run one after the other
    And the lock records the owner host and token

  Scenario: The notifications writer saves inside the lock
    When the admin notifications controller saves settings
    Then the notifications are saved and the lock is released

  Scenario: The settings writer saves inside the lock
    When the admin settings controller saves a client subscription limit
    Then the saved settings contain that limit and the lock is released

  Scenario: The restore writer saves inside the lock
    When an admin settings backup is restored
    Then the restored settings are saved and the lock is released
