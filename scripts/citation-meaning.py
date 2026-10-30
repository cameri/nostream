#!/usr/bin/env python3
"""citation-meaning — print each cited line beside the sentence that cites it.

The factory's `citation-oracle.ts` proves a `path:line` resolves and is in bounds. It does not
read the line, so a citation that drifted into a different function passes. This script closes
that gap the only honest way a machine can: it prints both texts, adjacent, so a reader (or a
later pass) compares meaning instead of bounds.

    python3 scripts/citation-meaning.py <doc.md> [<doc.md> ...]

For every `path:line` / `path:a-b` it prints:

    L<doc line>  <path>:<a>(-<b>)   EXISTS|MISSING|OUT
      cites:  <the sentence on that document line>
      says:   <the first cited line, then the last when a range>

Exit 1 when any citation is MISSING or OUT, so it also works as a check; 0 otherwise.
"""
import os
import re
import sys

REF = re.compile(r"((?:[\w.\-]+/)*[\w.\-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?")


def resolve(path: str) -> str | None:
    candidate = path
    while True:
        if os.path.isfile(candidate):
            return candidate
        if "/" not in candidate:
            return None
        candidate = candidate.split("/", 1)[1]


def main(docs: list[str]) -> int:
    bad = 0
    for doc in docs:
        print(f"== {doc}")
        for number, line in enumerate(open(doc, errors="replace"), 1):
            for match in REF.finditer(line):
                path, first, last = match.group(1), int(match.group(2)), match.group(3)
                end = int(last) if last else first
                real = resolve(path)
                if real is None:
                    print(f"  L{number} {match.group(0)}  MISSING")
                    bad += 1
                    continue
                body = open(real, errors="replace").read().split("\n")
                if not (1 <= first <= len(body)) or end > len(body):
                    print(f"  L{number} {match.group(0)}  OUT ({len(body)} lines)")
                    bad += 1
                    continue
                print(f"  L{number} {match.group(0)}  EXISTS")
                print(f"    cites: {line.strip()[:150]}")
                print(f"    says:  {body[first - 1].strip()[:150]}")
                if end != first:
                    print(f"    ends:  {body[end - 1].strip()[:150]}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
