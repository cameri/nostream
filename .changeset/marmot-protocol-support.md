---
"nostream": minor
---

Add relay support for the Marmot Protocol (E2EE group messaging over Nostr).

Supported MIPs: 00 (KeyPackages), 01 (Group Construction), 02 (Welcome Events), 03 (Group Messages).

- kind 443 (legacy KeyPackage): stored as a regular event
- kind 10051 (KeyPackage relay list): stored as a replaceable event
- kind 30443 (KeyPackage): stored as a parameterized-replaceable event with `d`-tag deduplication
- kind 444 (Welcome rumor): blocked from direct publishing; must travel inside a kind 1059 gift wrap
- kind 445 (Group Event): dedicated strategy validates the required `h` tag (nostr_group_id) before storing; `#h` tag subscriptions work via the existing generic tag index
- NIP-11 relay info now advertises `supported_mips: [0, 1, 2, 3]`
