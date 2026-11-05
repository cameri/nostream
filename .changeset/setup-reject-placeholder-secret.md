---
"nostream": patch
---

fix(cli): reject placeholder secret inherited from env or prompt in setup (#1018)

Setup now rejects the default placeholder secret (`change_me_to_something_long_and_random`) when read from inherited environment variables or interactive prompt input, and validates the resolved secret before persisting to `.env`. If a placeholder is detected, setup automatically generates a fresh cryptographically secure 64-byte random hex secret.
