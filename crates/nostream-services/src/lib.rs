//! `nostream-services` owns everything the relay does besides serving the wire: the worker
//! model and its scheduled passes, the payment processors and their HTTP seam, the operator
//! notification outbox and its channels, the web-of-trust graph, the Tor hidden-service
//! bootstrap and the event importer.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/app/{maintenance,dvm-orchestrator}-worker.ts`
//! - `src/services/` (the seven files this job implements; `subscription-service.ts` is not
//!   owned — see below)
//! - `src/payments-processors/` (7 files) and
//!   `src/factories/{payments-processor-factory,payments-processors/*}.ts`
//! - `src/tor/client.ts`
//! - `src/services/event-import-service.ts` and `src/import-events.ts`'s parser
//! - `src/@types/{services,dvm}.ts`
//! - `src/utils/{invoice,nip05,secret,transform}.ts`'s payment-related surface
//!
//! **Implemented here:** the supervisor (`scheduler`) and its two workers (`workers`), the
//! payments trait with all seven processors and the invoice lifecycle (`payments`,
//! `invoice`, `services::payments_service`), the notification outbox, dispatcher and four
//! channels, the retention step, the web-of-trust graph, the Tor control-port client and its
//! bootstrap, and the streaming event importer with its batch persister.
//!
//! **Still stubbed, labelled to their owning issue:** the NIP-66 probes and the
//! NIP-66 event publisher (issue #865), and the invoice/callback HTTP controllers
//! (issue #867). `nostream-services` does not own `src/services/subscription-service.ts`:
//! the capture's subscription tables and `invoices.plan_id` are not in the Rust schema.

pub mod context;
pub mod controllers;
pub mod error;
pub mod http;
pub mod invoice;
pub mod monitor;
pub mod payments;
pub mod scheduler;
pub mod services;
pub mod testing;
pub mod tor;
pub mod unavailable;
pub mod workers;

pub use context::ServiceContext;
pub use error::ServicesError;
pub use http::{HttpClient, HttpResponse, ReqwestClient};
pub use scheduler::{Supervisor, WorkerSpec};
pub use unavailable::ServiceStores;
