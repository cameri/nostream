---
---

fix(tor): escape the control-port password instead of pasting it into the command

`AUTHENTICATE "{password}"` pasted `TOR_PASSWORD` into a quoted string raw. A password holding `"` or `\` sent different text, and one holding a CRLF ended the command and made the rest of the password a second one; either way `250` never arrived, `TorClient::connect` failed, and the hidden service stayed off with a correct password in the settings. The value is now escaped for the protocol's C-style quoting, with CR and LF escaped too.

Found by the round-9 static review of #870 (issue #1100); the analysis and an earlier implementation came from @tirthraj01's `fix/1100-tor-authenticate-escaping` branch, which could not land because its two tests were pasted inside another test function and never ran.
