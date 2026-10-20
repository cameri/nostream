//! The nine trait implementations on [`PostgresBackend`], and the three the serializable
//! [`PostgresTransaction`] carries.

use nostream_core::{EventId, Filter, Kind, Pubkey};

use super::{
    PostgresBackend, PostgresTransaction, events, invoices, metadata, notifications, users,
};
use crate::error::StorageError;
use crate::repositories::{
    ActionableTarget, CreateInviteCodeOptions, DeliveryLogEntry, DeliveryLogFilters, DvmJob,
    DvmJobRepository, DvmJobUpdate, EventPurgeCounts, EventRecord, EventRepository,
    EventRetentionOptions, InviteCode, InviteCodeRepository, Invoice, InvoiceRepository,
    InvoiceStatus, NewDeliveryLogEntry, NewReport, Nip05Verification, Nip05VerificationRepository,
    NotificationDeliveryLogRepository, NotificationOutboxRepository, OutboxMessage, OutboxPayload,
    QueryStream, ReconciliationItem, Report, ReportRepository, StorageFuture, User, UserPatch,
    UserRepository,
};

impl EventRepository for PostgresBackend {
    fn create<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move { events::create(&self.master, record).await })
    }

    fn create_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move { events::create_many(&self.master, records).await })
    }

    fn upsert<'a>(&'a self, record: &'a EventRecord) -> StorageFuture<'a, u64> {
        Box::pin(async move { events::upsert(&self.master, record).await })
    }

    fn upsert_many<'a>(&'a self, records: &'a [EventRecord]) -> StorageFuture<'a, u64> {
        Box::pin(async move { events::upsert_many(&self.master, records).await })
    }

    fn find_by_filters<'a>(
        &'a self,
        filters: &'a [Filter],
    ) -> StorageFuture<'a, QueryStream<'a, EventRecord>> {
        Box::pin(async move {
            let gates = self.gates();
            events::find_by_filters(&self.reader, filters, &gates)
        })
    }

    fn count_by_filters<'a>(&'a self, filters: &'a [Filter]) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            let gates = self.gates();
            events::count_by_filters(&self.reader, filters, &gates).await
        })
    }

    fn find_reconciliation_items<'a>(
        &'a self,
        filter: &'a Filter,
    ) -> StorageFuture<'a, QueryStream<'a, ReconciliationItem>> {
        Box::pin(async move {
            let gates = self.gates();
            events::find_reconciliation_items(&self.reader, filter, &gates)
        })
    }

    fn delete_by_pubkey_and_ids<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        ids: &'a [EventId],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move { events::delete_by_pubkey_and_ids(&self.master, pubkey, ids).await })
    }

    fn delete_by_pubkey_except_kinds<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        excluded_kinds: &'a [Kind],
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            events::delete_by_pubkey_except_kinds(&self.master, pubkey, excluded_kinds).await
        })
    }

    fn has_active_request_to_vanish<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move { events::has_active_request_to_vanish(&self.reader, pubkey).await })
    }

    fn delete_expired_and_retained<'a>(
        &'a self,
        options: &'a EventRetentionOptions,
    ) -> StorageFuture<'a, EventPurgeCounts> {
        Box::pin(async move { events::delete_expired_and_retained(&self.master, options).await })
    }
}

impl InvoiceRepository for PostgresBackend {
    fn find_by_id<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move { invoices::find_by_id(&self.master, id).await })
    }

    fn upsert<'a>(&'a self, invoice: &'a Invoice) -> StorageFuture<'a, u64> {
        Box::pin(async move { invoices::upsert(&self.master, invoice).await })
    }

    fn update_status<'a>(
        &'a self,
        id: &'a str,
        status: InvoiceStatus,
    ) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move { invoices::update_status(&self.master, id, status).await })
    }

    fn confirm_invoice<'a>(
        &'a self,
        invoice_id: &'a str,
        amount_received: i64,
        confirmed_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let mut transaction = self
                .master
                .begin_with("BEGIN ISOLATION LEVEL SERIALIZABLE")
                .await?;
            invoices::confirm_invoice(&mut *transaction, invoice_id, amount_received, confirmed_at)
                .await?;
            transaction.commit().await?;
            Ok(())
        })
    }

    fn find_pending_invoices<'a>(
        &'a self,
        offset: u64,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Invoice>> {
        Box::pin(async move { invoices::find_pending_invoices(&self.master, offset, limit).await })
    }
}

impl UserRepository for PostgresBackend {
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async move { users::find_by_pubkey(&self.master, pubkey).await })
    }

    fn upsert<'a>(&'a self, user: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async move { users::upsert(&self.master, user).await })
    }

    fn get_balance_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async move { users::get_balance_by_pubkey(&self.master, pubkey).await })
    }

    fn is_vanished<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            if let Some(user) = users::find_by_pubkey(&self.master, pubkey).await? {
                return Ok(user.is_vanished);
            }
            let vanished = events::has_active_request_to_vanish(&self.reader, pubkey).await?;
            users::upsert_vanish_state(&self.master, pubkey, vanished).await?;
            Ok(vanished)
        })
    }

    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async move { users::upsert_vanish_state(&self.master, pubkey, vanished).await })
    }

    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            let mut transaction = self
                .master
                .begin_with("BEGIN ISOLATION LEVEL SERIALIZABLE")
                .await?;
            users::admit_user(&mut *transaction, pubkey, admitted_at).await?;
            transaction.commit().await?;
            Ok(())
        })
    }

    fn revoke_admission<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move { users::revoke_admission(&self.master, pubkey).await })
    }
}

impl Nip05VerificationRepository for PostgresBackend {
    fn find_by_pubkey<'a>(
        &'a self,
        pubkey: &'a Pubkey,
    ) -> StorageFuture<'a, Option<Nip05Verification>> {
        Box::pin(async move { metadata::nip05_find_by_pubkey(&self.master, pubkey).await })
    }

    fn upsert<'a>(&'a self, verification: &'a Nip05Verification) -> StorageFuture<'a, u64> {
        Box::pin(async move { metadata::nip05_upsert(&self.master, verification).await })
    }

    fn find_pending_verifications<'a>(
        &'a self,
        update_frequency_ms: i64,
        max_failures: i32,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Nip05Verification>> {
        Box::pin(async move {
            metadata::nip05_find_pending(&self.master, update_frequency_ms, max_failures, limit)
                .await
        })
    }

    fn delete_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move { metadata::nip05_delete_by_pubkey(&self.master, pubkey).await })
    }
}

impl InviteCodeRepository for PostgresBackend {
    fn create<'a>(
        &'a self,
        code: &'a str,
        options: &'a CreateInviteCodeOptions,
    ) -> StorageFuture<'a, InviteCode> {
        Box::pin(async move { metadata::invite_create(&self.master, code, options).await })
    }

    fn find_by_code<'a>(&'a self, code: &'a str) -> StorageFuture<'a, Option<InviteCode>> {
        Box::pin(async move { metadata::invite_find_by_code(&self.master, code).await })
    }

    fn claim_code<'a>(&'a self, code: &'a str, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move { metadata::invite_claim_code(&self.master, code, pubkey).await })
    }

    fn find_active_codes<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<InviteCode>> {
        Box::pin(async move { metadata::invite_find_active_codes(&self.master, limit).await })
    }

    fn delete_expired_codes<'a>(&'a self) -> StorageFuture<'a, u64> {
        Box::pin(async move { metadata::invite_delete_expired(&self.master).await })
    }
}

impl DvmJobRepository for PostgresBackend {
    fn create<'a>(
        &'a self,
        id: &'a EventId,
        requester: &'a Pubkey,
        kind: Kind,
    ) -> StorageFuture<'a, DvmJob> {
        Box::pin(async move { metadata::dvm_create(&self.master, id, requester, kind).await })
    }

    fn find_by_id<'a>(&'a self, id: &'a EventId) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move { metadata::dvm_find_by_id(&self.master, id).await })
    }

    fn assign_worker<'a>(&'a self, id: &'a EventId, worker_index: i32) -> StorageFuture<'a, bool> {
        Box::pin(async move { metadata::dvm_assign_worker(&self.master, id, worker_index).await })
    }

    fn update_status<'a>(&'a self, update: &'a DvmJobUpdate) -> StorageFuture<'a, Option<DvmJob>> {
        Box::pin(async move { metadata::dvm_update_status(&self.master, update).await })
    }

    fn find_pending_jobs<'a>(
        &'a self,
        limit: u64,
        kinds: Option<&'a [Kind]>,
    ) -> StorageFuture<'a, Vec<DvmJob>> {
        Box::pin(async move { metadata::dvm_find_pending_jobs(&self.master, limit, kinds).await })
    }
}

impl ReportRepository for PostgresBackend {
    fn create<'a>(&'a self, report: &'a NewReport) -> StorageFuture<'a, Report> {
        Box::pin(async move { metadata::report_create(&self.master, report).await })
    }

    fn create_many<'a>(&'a self, reports: &'a [NewReport]) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move {
            if reports.is_empty() {
                return Ok(Vec::new());
            }
            let mut transaction = self.master.begin().await?;
            let mut created = Vec::with_capacity(reports.len());
            for report in reports {
                created.push(metadata::report_create(&mut *transaction, report).await?);
            }
            transaction.commit().await?;
            Ok(created)
        })
    }

    fn find_by_event_id<'a>(&'a self, event_id: &'a EventId) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move { metadata::report_find_by_event_id(&self.master, event_id).await })
    }

    fn find_actionable<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<Report>> {
        Box::pin(async move { metadata::report_find_actionable(&self.master, limit).await })
    }

    fn find_actionable_targets<'a>(&'a self) -> StorageFuture<'a, Vec<ActionableTarget>> {
        Box::pin(async move { metadata::report_find_actionable_targets(&self.master).await })
    }
}

impl NotificationDeliveryLogRepository for PostgresBackend {
    fn append<'a>(&'a self, entry: &'a NewDeliveryLogEntry) -> StorageFuture<'a, ()> {
        Box::pin(async move { notifications::append(&self.master, entry).await })
    }

    fn find_recent<'a>(
        &'a self,
        limit: u64,
        filters: &'a DeliveryLogFilters,
    ) -> StorageFuture<'a, Vec<DeliveryLogEntry>> {
        Box::pin(async move { notifications::find_recent(&self.master, limit, filters).await })
    }

    fn find_successful_target_ids<'a>(
        &'a self,
        outbox_id: &'a str,
    ) -> StorageFuture<'a, Vec<String>> {
        Box::pin(
            async move { notifications::find_successful_target_ids(&self.master, outbox_id).await },
        )
    }

    fn delete_older_than<'a>(
        &'a self,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move { notifications::delete_older_than(&self.master, cutoff).await })
    }
}

impl NotificationOutboxRepository for PostgresBackend {
    fn enqueue<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a OutboxPayload,
    ) -> StorageFuture<'a, OutboxMessage> {
        Box::pin(async move { notifications::enqueue(&self.master, event_type, payload).await })
    }

    fn claim_batch<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>> {
        Box::pin(async move { notifications::claim_batch(&self.master, limit).await })
    }

    fn mark_delivered<'a>(&'a self, id: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move { notifications::mark_delivered(&self.master, id).await })
    }

    fn mark_failed<'a>(
        &'a self,
        id: &'a str,
        error: &'a str,
        attempt_count: i32,
        max_attempts: i32,
        base_delay_ms: i64,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            notifications::mark_failed(
                &self.master,
                id,
                error,
                attempt_count,
                max_attempts,
                base_delay_ms,
            )
            .await
        })
    }

    fn delete_terminal_older_than<'a>(
        &'a self,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, u64> {
        Box::pin(
            async move { notifications::delete_terminal_older_than(&self.master, cutoff).await },
        )
    }
}

/// The three repositories the payments service spans inside one serializable transaction.
macro_rules! with_transaction {
    ($self:ident, |$transaction:ident| $body:expr) => {{
        let mut guard = $self.transaction.lock().await;
        let Some($transaction) = guard.as_mut() else {
            return Err(StorageError::InvalidArgument {
                message: "the transaction is already closed",
            });
        };
        $body
    }};
}

impl UserRepository for PostgresTransaction {
    fn find_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, Option<User>> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::find_by_pubkey(&mut **transaction, pubkey).await
            })
        })
    }

    fn upsert<'a>(&'a self, user: &'a UserPatch) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::upsert(&mut **transaction, user).await
            })
        })
    }

    fn get_balance_by_pubkey<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, i64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::get_balance_by_pubkey(&mut **transaction, pubkey).await
            })
        })
    }

    fn is_vanished<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, bool> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                if let Some(user) = users::find_by_pubkey(&mut **transaction, pubkey).await? {
                    return Ok(user.is_vanished);
                }
                let vanished =
                    events::has_active_request_to_vanish(&mut **transaction, pubkey).await?;
                users::upsert_vanish_state(&mut **transaction, pubkey, vanished).await?;
                Ok(vanished)
            })
        })
    }

    fn set_vanished<'a>(&'a self, pubkey: &'a Pubkey, vanished: bool) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::upsert_vanish_state(&mut **transaction, pubkey, vanished).await
            })
        })
    }

    fn admit_user<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        admitted_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::admit_user(&mut **transaction, pubkey, admitted_at).await
            })
        })
    }

    fn revoke_admission<'a>(&'a self, pubkey: &'a Pubkey) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                users::revoke_admission(&mut **transaction, pubkey).await
            })
        })
    }
}

impl InvoiceRepository for PostgresTransaction {
    fn find_by_id<'a>(&'a self, id: &'a str) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                invoices::find_by_id(&mut **transaction, id).await
            })
        })
    }

    fn upsert<'a>(&'a self, invoice: &'a Invoice) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                invoices::upsert(&mut **transaction, invoice).await
            })
        })
    }

    fn update_status<'a>(
        &'a self,
        id: &'a str,
        status: InvoiceStatus,
    ) -> StorageFuture<'a, Option<Invoice>> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                invoices::update_status(&mut **transaction, id, status).await
            })
        })
    }

    fn confirm_invoice<'a>(
        &'a self,
        invoice_id: &'a str,
        amount_received: i64,
        confirmed_at: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                invoices::confirm_invoice(
                    &mut **transaction,
                    invoice_id,
                    amount_received,
                    confirmed_at,
                )
                .await
            })
        })
    }

    fn find_pending_invoices<'a>(
        &'a self,
        offset: u64,
        limit: u64,
    ) -> StorageFuture<'a, Vec<Invoice>> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                invoices::find_pending_invoices(&mut **transaction, offset, limit).await
            })
        })
    }
}

impl NotificationOutboxRepository for PostgresTransaction {
    fn enqueue<'a>(
        &'a self,
        event_type: &'a str,
        payload: &'a OutboxPayload,
    ) -> StorageFuture<'a, OutboxMessage> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                notifications::enqueue(&mut **transaction, event_type, payload).await
            })
        })
    }

    fn claim_batch<'a>(&'a self, limit: u64) -> StorageFuture<'a, Vec<OutboxMessage>> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                notifications::claim_batch_in(transaction, limit).await
            })
        })
    }
    fn mark_delivered<'a>(&'a self, id: &'a str) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                notifications::mark_delivered(&mut **transaction, id).await
            })
        })
    }

    fn mark_failed<'a>(
        &'a self,
        id: &'a str,
        error: &'a str,
        attempt_count: i32,
        max_attempts: i32,
        base_delay_ms: i64,
    ) -> StorageFuture<'a, ()> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                notifications::mark_failed(
                    &mut **transaction,
                    id,
                    error,
                    attempt_count,
                    max_attempts,
                    base_delay_ms,
                )
                .await
            })
        })
    }

    fn delete_terminal_older_than<'a>(
        &'a self,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> StorageFuture<'a, u64> {
        Box::pin(async move {
            with_transaction!(self, |transaction| {
                notifications::delete_terminal_older_than(&mut **transaction, cutoff).await
            })
        })
    }
}
