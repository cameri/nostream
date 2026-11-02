# Security Policy

## Supported Versions

Security fixes land on **nostream 3.5 and newer** only. The current release line is 3.6.x (3.6.1 at the time of writing).

| Version         | Supported          |
| --------------- | ------------------ |
| 3.5.x and newer | :white_check_mark: |
| 3.0.x – 3.4.x   | :x:                |
| 2.x             | :x:                |
| 1.x             | :x:                |

Unsupported lines receive no advisories, backports or patches. If you run one of them, upgrade to a supported version before reporting.

The Rust rewrite (`rewrite/main`) does not ship a release yet. It is covered by this policy as it ships.

## Reporting a Vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's private vulnerability reporting:

<https://github.com/cameri/nostream/security/advisories/new>

Include the affected version, how your deployment is configured, and steps to reproduce.

You can expect a first response within 7 days. After that, we will keep you updated on the progress of the report. If the report is accepted, we will work on a fix and publish a security advisory once a patched release is available. If it is declined, we will explain why.
