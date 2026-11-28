---
'nostream': patch
---

fix(cli): show control characters in `nostream import` error messages as escapes

When a line of an import file could not be parsed, `nostream import` printed the parser's message as it is, and that message quotes part of the file. A file with a terminal escape sequence in a malformed record could therefore change the operator's display or, where the terminal allows it, replace the clipboard. The per-line errors, the failure message and an error that quotes the input path (for example a file that does not exist) now show control characters as visible escapes (for example `\x1b`), so the context stays readable and nothing is sent to the terminal.
