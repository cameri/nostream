Feature: The relay recovers when the cache forgets its Lua scripts

  A Redis restart empties the script cache, so every subsequent `EVALSHA` answers
  `NOSCRIPT`. The relay calls `EVALSHA` for its rate limiters and its moderation
  counters, which means the cache losing its scripts used to leave the relay
  serving nothing at all: sockets stayed open, `HTTP` answered, and no event was
  ever acknowledged again until the process was restarted (#1002).

  `SCRIPT FLUSH` reproduces that state exactly, without restarting a container and
  without waiting for a reconnect.

  @script-cache
  Scenario: A client publishes before and after the cache drops its scripts
    Given someone called Alice
    When Alice sends a text_note event with content "before the flush"
    And the cache forgets its stored Lua scripts
    And Alice sends a text_note event with content "after the flush"
    And Alice sends a text_note event with content "and once more"
