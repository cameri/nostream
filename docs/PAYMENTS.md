# Payments

Nostream can charge an admission fee before it accepts a pubkey's events.
Set `payments.enabled`, choose one processor, and restart the relay.

## Accepting payments

1. Before you begin
   - Complete the [Production Setup Guide](https://nostream.dev/docs/setup) or the [quick start](../README.md#quick-start-docker-compose)
   - Create a `.env` file
   - On `.nostr/settings.yaml` file make the following changes:
     - Set `payments.enabled` to `true`
     - Set `payments.feeSchedules.admission[0].enabled` to `true`. The schedules are a list and `[0]` is the entry you edit; the relay charges the sum of every enabled schedule whose pubkey whitelist does not cover the payer, so more than one entry costs more than one fee. The invoice page quotes `[0]` alone (`get-invoice-controller.ts:56`), so with two enabled schedules it shows less than the invoice charges
     - Set `limits.event.pubkey.minBalance` to the minimum balance in msats required to accept events (i.e. `1000000` to require a balance of `1000` sats)
   - Choose one of the following payment processors: `zebedee`, `nodeless`, `opennode`, `lnbits`, `lnurl`, `nwc`

2. [ZEBEDEE](https://zebedee.io)
   - Complete the step "Before you begin"
   - [Sign up for a ZEBEDEE Developer Dashboard account](https://dashboard.zebedee.io/signup), create a new LIVE Project, and get that Project's API Key
   - Set `ZEBEDEE_API_KEY` environment variable with the API Key above on your `.env` file

```
    ZEBEDEE_API_KEY={YOUR_ZEBEDEE_API_KEY_HERE}
```

   - Follow the required steps for all payments processors
   - On `.nostr/settings.yaml` file make the following changes:
     - `payments.processor` to `zebedee`
     - `paymentsProcessors.zebedee.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/zebedee`)
   - Restart Nostream (`nostream stop` followed by `nostream start`)
   - Read the in-depth guide for more information: [Set Up a Paid Nostr Relay with ZEBEDEE API](https://docs.zbdpay.com/payments/nostr/nostr-relay)

3. Nodeless
   - Complete the step "Before you begin"
   - The processor is not usable as shipped: `resources/default-settings.yaml` points `paymentsProcessors.nodeless.baseURL` at `https://nodeless.io`, and that domain no longer resolves, so invoice creation and checks fail at the network. The steps below apply if you have a working host to point that setting at
   - Go to Profile > API Tokens and generate a new key and take note of it
   - Create a store webhook with your Nodeless callback URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/nodeless`) and make sure to enable all of the events. Grab the generated store webhook secret
   - Set `NODELESS_API_KEY` and `NODELESS_WEBHOOK_SECRET` environment variables with generated API key and webhook secret, respectively

```
    NODELESS_API_KEY={YOUR_NODELESS_API_KEY}
    NODELESS_WEBHOOK_SECRET={YOUR_NODELESS_WEBHOOK_SECRET}
```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `nodeless`
     - Set `paymentsProcessors.nodeless.storeId` to your store ID
   - Restart Nostream (`nostream stop` followed by `nostream start`)

4. [OpenNode](https://www.opennode.com/)
   - Complete the step "Before you begin"
   - Sign up for a new account and get verified
   - Go to Developers > Integrations and setup two-factor authentication
   - Create a new API Key with Invoices permission
   - Set `OPENNODE_API_KEY` environment variable on your `.env` file

     ```
     OPENNODE_API_KEY={YOUR_OPENNODE_API_KEY}
     ```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `opennode`
     - Set `paymentsProcessors.opennode.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/opennode`)
   - Restart Nostream (`nostream stop` followed by `nostream start`)

5. [LNBITS](https://lnbits.com/)
    - Complete the step "Before you begin"
    - Create a new wallet on you public LNbits instance
      - [Demo](https://legend.lnbits.com/) server must not be used for production
      - Your instance must be accessible from the internet and have a valid SSL/TLS certificate
    - Get wallet Invoice/read key (in Api docs section of your wallet)
    - set `LNBITS_API_KEY` environment variable with the Invoice/read key Key above on your `.env` file

      ```
      LNBITS_API_KEY={YOUR_LNBITS_API_KEY_HERE}
      ```
    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `lnbits`
      - set `paymentsProcessors.lnbits.baseURL` to your LNbits instance URL (e.g. `https://{YOUR_LNBITS_DOMAIN_HERE}/`)
      - Set `paymentsProcessors.lnbits.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/lnbits`)
    - Restart Nostream (`nostream stop` followed by `nostream start`)

6. [Alby](https://getalby.com/), or another LNURL-pay provider that serves its callback at `<invoiceURL>/callback`. That path is a Nostream requirement, not something [LUD-06](https://github.com/lnurl/luds/blob/luds/06.md) guarantees, since a provider may advertise any callback it likes. [LNURL-verify](https://github.com/lnurl/luds/issues/182) support is also needed
   - Complete the step "Before you begin"
   - [Create a new account](https://getalby.com/) if you don't have an LNURL
   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `lnurl`
     - Set `paymentsProcessors.lnurl.invoiceURL` to your LNURL-pay address up to but excluding `/callback` (e.g. `https://getalby.com/lnurlp/your-username`, with your own username)
   - Restart Nostream (`nostream stop` followed by `nostream start`)

7. Nostr Wallet Connect (NIP-47 / NWC)
    - Complete the step "Before you begin"
    - Create an app connection in your NWC-compatible wallet and copy the generated NWC URL
   - Set `NWC_URL` environment variable on your `.env` file

     ```
     NWC_URL={NOSTR_WALLET_CONNECT_URL}
     ```


   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `nwc`
   - Restart Nostream (`nostream stop` followed by `nostream start`)

8. Ensure payments are required for your public key
   - Visit https://{YOUR-DOMAIN}/
   - You should be presented with a form requesting an admission fee to be paid
   - Fill out the form and take the necessary steps to pay the invoice
   - Wait until the screen indicates that payment was received
   - Add your relay URL to your favorite Nostr client (wss://{YOUR-DOMAIN}) and wait for it to connect
   - Send a couple notes to test
   - Go to https://websocketking.com/ and connect to your relay (wss://{YOUR_DOMAIN})
   - Convert your npub to hexadecimal using a [Key Converter](https://damus.io/key/)
   - Send the following JSON message: `["REQ", "payment-test", {"authors":["your-pubkey-in-hexadecimal"]}]`
   - You should get back the few notes you sent earlier
