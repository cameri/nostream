---
"nostream": patch
---

fix(payments): accept LNbits 1.x callback bodies

LNbits 1.x sends the payment object as a JSON string inside the webhook body.
The callback route now allows a top-level JSON string, the controller parses it
before validation, and the body schema accepts and strips LNbits' extra payment
fields while still requiring a valid `payment_hash`.

Non-JSON string bodies still return `400 Malformed body`; the HMAC query check
and the invoice lookup from LNbits remain unchanged.
