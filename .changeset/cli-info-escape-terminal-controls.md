---
'nostream': patch
---

fix(cli): show control characters in `nostream info` output as escapes

`nostream info` printed the relay name, URL and other settings values as they are. These can be changed through the admin settings, so a value containing a newline or terminal escape sequence could add forged lines to the output or send commands to the operator's terminal, such as replacing the clipboard where the terminal allows it. The text output now shows control characters as visible escapes (for example `\x0a`). `nostream info --json` is unchanged.
