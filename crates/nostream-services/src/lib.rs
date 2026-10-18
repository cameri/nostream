//! `nostream-services` owns the services, the payment processors, the invoice/callback
//! controllers and the NIP-66 monitor.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/services/` (8 files)
//! - `src/payments-processors/` (7 files)
//! - `src/controllers/{callbacks,invoices}/` (7) and `src/routes/{callbacks,invoices}/index.ts`
//! - `src/schemas/{lnbits,nodeless,opennode,zebedee}-callback-schema.ts`
//! - the NIP-66 monitor: `src/utils/relay-probe/**` (10 files),
//!   `src/utils/{relay-probe-snapshot,relay-probe-targets,monitor-identity,
//!   network-health-mismatches,invoice,operator-notification-enqueue}.ts`
//! - `src/@types/{services,dvm}.ts` (`src/@types/operator-notifications.ts` belongs to
//!   `nostream-config` alongside the settings types it joins)
//! - `src/factories/{payments-processors/*,maintenance-service-factory,
//!   notification-outbox-service-factory,payments-service-factory,wot-graph-service-factory}.ts`
//!
//! Phase 1 carries the module map and labelled stubs only: no HTTP client dependency, no probe
//! run. Phase 2+ areas this crate does not own: the relay wire (nostream-relay) and the admin
//! API (nostream-admin).

pub mod controllers;
pub mod error;
pub mod monitor;
pub mod payments;
pub mod services;

pub use error::ServicesError;
