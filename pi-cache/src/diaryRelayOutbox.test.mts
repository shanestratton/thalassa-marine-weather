import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
    canonicalDiaryRelayEndpoint,
    DiaryRelayOperationCancelledError,
    DiaryRelayOperationConflictError,
    DiaryRelayOutbox,
    DiaryRelayValidationError,
    type DiaryRelayEnvelope,
    type DiaryRelayOutboxOptions,
} from './diaryRelayOutbox.js';

const relay = {
    url: 'https://project.supabase.co/functions/v1/diary-relay',
    relayId: 'pi-relay-0000001',
    token: 'scoped-relay-token-that-must-not-leak',
    ownerId: 'owner-1',
};

const entry = {
    client_operation_id: 'diary-op-1',
    body: 'A private, offline diary entry',
    created_at: '2026-07-27T09:00:00.000Z',
    boat_id: '2e39983f-5d86-4dcb-b6f9-34df05c08d90',
};

const baseEnvelope: DiaryRelayEnvelope = { entry, relay, allowInternet: false };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-diary-relay-test-'));

function createOutbox(
    cacheDir: string,
    options: Omit<DiaryRelayOutboxOptions, 'trustedSupabaseOrigin'> = {},
): DiaryRelayOutbox {
    return new DiaryRelayOutbox(cacheDir, { trustedSupabaseOrigin: new URL(relay.url).origin, ...options });
}

function acceptedEntry(
    operationId: string,
    clientRevision: number,
    fields: Record<string, unknown> = {},
    status: 'accepted' | 'stale' = 'accepted',
    httpStatus = 200,
): Response {
    return new Response(
        JSON.stringify({
            ok: true,
            status,
            entry: {
                ...fields,
                client_operation_id: operationId,
                client_revision: clientRevision,
            },
        }),
        { status: httpStatus },
    );
}

function cancellationAcknowledgement(operationId: string, httpStatus = 200): Response {
    return new Response(JSON.stringify({ ok: true, cancelled: true, client_operation_id: operationId }), {
        status: httpStatus,
    });
}

function requestedEntry(init: RequestInit): Record<string, unknown> {
    const payload: unknown = JSON.parse(String(init.body));
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    const entry = (payload as { entry?: unknown }).entry;
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry));
    return entry as Record<string, unknown>;
}

try {
    assert.equal(canonicalDiaryRelayEndpoint('https://PROJECT.supabase.co:443'), relay.url);

    // Relay credentials and private diary payloads may target only the exact
    // Edge endpoint below the process-startup Supabase trust anchor.
    const authorityBound = createOutbox(path.join(tempDir, 'authority-bound'), { retryIntervalMs: 0 });
    for (const url of [
        'https://attacker.invalid/functions/v1/diary-relay',
        'https://project.supabase.co/other/functions/v1/diary-relay',
        `${relay.url}/`,
        `${relay.url}?redirect=https://attacker.invalid`,
    ]) {
        assert.throws(() => authorityBound.configure({ ...relay, url }), DiaryRelayValidationError);
        assert.throws(
            () =>
                authorityBound.enqueue({
                    entry: {
                        ...entry,
                        client_operation_id: `rejected-${Buffer.from(url).toString('hex').slice(0, 24)}`,
                    },
                    relay: { ...relay, url },
                }),
            DiaryRelayValidationError,
        );
    }
    authorityBound.close();

    // Upgrade safety: pre-hardening databases may contain an arbitrary host
    // in config and durable entry/cancellation snapshots. Startup must scrub
    // those credentials and quarantine pending work before its first sweep.
    const legacyDir = path.join(tempDir, 'legacy-authority');
    const legacyEntryId = 'diary-op-legacy-authority';
    const legacyCancellationId = 'diary-op-legacy-cancellation';
    const legacy = createOutbox(legacyDir, { retryIntervalMs: 0 });
    legacy.configure({ ...relay, allowInternet: false });
    legacy.enqueue({ entry: { ...entry, client_operation_id: legacyEntryId }, relay });
    legacy.enqueue({ entry: { ...entry, client_operation_id: legacyCancellationId }, relay });
    legacy.cancel(legacyCancellationId);
    legacy.close();

    const maliciousRelayUrl = 'https://attacker.invalid/prefix/functions/v1/diary-relay';
    const legacyDbPath = path.join(legacyDir, 'diary-relay', 'outbox.db');
    const legacyDb = new Database(legacyDbPath);
    legacyDb
        .prepare(
            'UPDATE diary_relay_config SET relay_url = ?, relay_token = ?, relay_owner_id = ?, allow_internet = 1 WHERE singleton = 1',
        )
        .run(maliciousRelayUrl, 'legacy-config-token', relay.ownerId);
    legacyDb
        .prepare('UPDATE diary_relay_outbox SET relay_url = ?, relay_token = ? WHERE operation_id = ?')
        .run(maliciousRelayUrl, 'legacy-entry-token', legacyEntryId);
    legacyDb
        .prepare('UPDATE diary_relay_cancellations SET relay_url = ?, relay_token = ? WHERE operation_id = ?')
        .run(maliciousRelayUrl, 'legacy-cancellation-token', legacyCancellationId);
    legacyDb.close();

    let legacyFetchCalls = 0;
    const migratedLegacy = createOutbox(legacyDir, {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            legacyFetchCalls += 1;
            return acceptedEntry(legacyEntryId, 1);
        },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(migratedLegacy.getConfiguration().configured, false);
    assert.equal(migratedLegacy.getConfiguration().allowInternet, false);
    assert.equal(migratedLegacy.getStatus(legacyEntryId)?.status, 'needs_repair');
    assert.equal(migratedLegacy.getStatus(legacyCancellationId)?.status, 'needs_repair');
    assert.equal(legacyFetchCalls, 0);
    migratedLegacy.close();

    const scrubbedDb = new Database(legacyDbPath, { readonly: true });
    for (const table of ['diary_relay_config', 'diary_relay_outbox', 'diary_relay_cancellations']) {
        const row = scrubbedDb.prepare(`SELECT relay_url, relay_token FROM ${table} LIMIT 1`).get() as {
            relay_url: string | null;
            relay_token: string | null;
        };
        assert.equal(row.relay_url, null);
        assert.equal(row.relay_token, null);
    }
    scrubbedDb.close();

    // A policy-only update occurs before initial pairing on a fresh Pi. It
    // must not erase the public, generated id that the phone uses to pair.
    const unpaired = createOutbox(path.join(tempDir, 'unpaired'), { retryIntervalMs: 0 });
    const generatedRelayId = unpaired.getConfiguration().relayId;
    assert.ok(generatedRelayId);
    unpaired.configure({ allowInternet: true });
    assert.equal(unpaired.getConfiguration().relayId, generatedRelayId);
    assert.equal(unpaired.getConfiguration().configured, false);
    unpaired.close();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        return acceptedEntry(
            entry.client_operation_id,
            1,
            { id: 'server-entry-1', synced: true, body: entry.body },
            'accepted',
            201,
        );
    };

    // The Pi's persisted policy is the sole WAN gate. A temporary satellite
    // flag on the sending phone must not permanently strand an entry after
    // the Pi later gets ordinary internet.
    const first = createOutbox(tempDir, { fetchImpl, retryIntervalMs: 0 });
    first.configure({ ...relay, allowInternet: true });
    const queued = first.enqueue(baseEnvelope);
    assert.equal(queued.status, 'queued');
    const synced = await first.attempt(queued.operationId);
    assert.equal(synced?.status, 'synced');
    assert.equal(synced?.operationId, entry.client_operation_id);
    // The canonical row is available to the immediate POST handler, but it is
    // deliberately separate from the Boat-LAN metadata status record.
    assert.deepEqual(first.getCanonicalEntry(entry.client_operation_id), {
        id: 'server-entry-1',
        synced: true,
        body: entry.body,
        client_operation_id: entry.client_operation_id,
        client_revision: 1,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, relay.url);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('X-Thalassa-Pi-Relay-Id'), relay.relayId);
    assert.equal(headers.get('X-Thalassa-Pi-Relay-Token'), relay.token);
    assert.equal(calls[0].init.body, JSON.stringify({ entry }));

    // Public status is safe to expose to the Boat LAN: metadata only, never
    // diary text/media, scoped token, relay URL, or the server row.
    const publicStatus = first.getStatus(entry.client_operation_id);
    assert.ok(publicStatus);
    assert.equal(JSON.stringify(publicStatus).includes(entry.body), false);
    assert.equal(JSON.stringify(publicStatus).includes(relay.token), false);
    assert.equal(JSON.stringify(publicStatus).includes(relay.url), false);

    // Same operation + same content is idempotent; same operation + different
    // content is rejected instead of replacing the durable diary record.
    assert.equal(first.enqueue({ ...baseEnvelope, allowInternet: true }).status, 'synced');
    assert.throws(
        () =>
            first.enqueue({
                ...baseEnvelope,
                entry: { ...entry, body: 'Different entry content' },
                allowInternet: true,
            }),
        DiaryRelayOperationConflictError,
    );
    first.close();

    // Failed WAN attempts remain queued and are eligible for a later retry.
    let attempts = 0;
    const retrying = createOutbox(path.join(tempDir, 'retry'), {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('WAN unavailable');
            return acceptedEntry('diary-op-retry', 1, { id: 'server-entry-2' });
        },
    });
    retrying.configure({ ...relay, allowInternet: true });
    retrying.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-retry' }, relay, allowInternet: true });
    assert.equal((await retrying.attempt('diary-op-retry'))?.status, 'queued');
    assert.equal(retrying.getStatus('diary-op-retry')?.attemptCount, 1);
    assert.equal((await retrying.attempt('diary-op-retry'))?.status, 'synced');
    assert.equal(attempts, 2);
    retrying.close();

    // A generic 2xx is not enough — only the relay's explicit `{ ok: true }`
    // acknowledgement may move a row out of the durable queue.
    const incompleteAck = createOutbox(path.join(tempDir, 'incomplete-ack'), {
        retryIntervalMs: 0,
        fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    });
    incompleteAck.configure({ ...relay, allowInternet: true });
    incompleteAck.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-incomplete-ack' },
        relay,
        allowInternet: true,
    });
    const stillQueued = await incompleteAck.attempt('diary-op-incomplete-ack');
    assert.equal(stillQueued?.status, 'queued');
    assert.equal(stillQueued?.attemptCount, 1);
    assert.equal(stillQueued?.operationId, 'diary-op-incomplete-ack');
    incompleteAck.close();

    // A successful HTTP response may only acknowledge the exact durable
    // operation. A mismatched operation or accepted revision remains queued
    // rather than allowing an unrelated canonical row to retire it.
    const invalidCanonicalAck = createOutbox(path.join(tempDir, 'invalid-canonical-ack'), {
        retryIntervalMs: 0,
        fetchImpl: async (_url, init) => {
            const sent = requestedEntry(init);
            if (sent.client_operation_id === 'diary-op-wrong-operation') {
                return acceptedEntry('diary-op-someone-else', 1, { id: 'wrong-operation' });
            }
            return acceptedEntry('diary-op-wrong-revision', 2, { id: 'wrong-revision' });
        },
    });
    invalidCanonicalAck.configure({ ...relay, allowInternet: true });
    invalidCanonicalAck.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-wrong-operation' },
        relay,
    });
    assert.equal((await invalidCanonicalAck.attempt('diary-op-wrong-operation'))?.status, 'queued');
    invalidCanonicalAck.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-wrong-revision' },
        relay,
    });
    assert.equal((await invalidCanonicalAck.attempt('diary-op-wrong-revision'))?.status, 'queued');
    assert.equal(invalidCanonicalAck.getCanonicalEntry('diary-op-wrong-operation'), null);
    assert.equal(invalidCanonicalAck.getCanonicalEntry('diary-op-wrong-revision'), null);
    invalidCanonicalAck.close();

    // A stale response is still a valid acknowledgement when it proves that
    // the same operation already has an equal-or-newer canonical revision.
    // This is how a delayed Pi handoff safely yields to a newer direct-device
    // upload without retrying the stale snapshot forever.
    const staleCanonicalAck = createOutbox(path.join(tempDir, 'stale-canonical-ack'), {
        retryIntervalMs: 0,
        fetchImpl: async () => acceptedEntry('diary-op-stale-canonical', 2, { id: 'newer-row' }, 'stale'),
    });
    staleCanonicalAck.configure({ ...relay, allowInternet: true });
    staleCanonicalAck.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-stale-canonical', client_revision: 1 },
        relay,
    });
    assert.equal((await staleCanonicalAck.attempt('diary-op-stale-canonical'))?.status, 'synced');
    assert.equal(staleCanonicalAck.getCanonicalEntry('diary-op-stale-canonical')?.client_revision, 2);
    staleCanonicalAck.close();

    // A newer revision may replace a queued or already-synced operation. A
    // lower revision is ignored, while same revision with different content
    // remains a conflict (it might be a stale device replay).
    const revisionBodies: string[] = [];
    const revisions = createOutbox(path.join(tempDir, 'revisions'), {
        retryIntervalMs: 0,
        fetchImpl: async (_url, init) => {
            revisionBodies.push(String(init.body));
            const sent = requestedEntry(init);
            return acceptedEntry(
                String(sent.client_operation_id),
                typeof sent.client_revision === 'number' ? sent.client_revision : 1,
                { id: `revision-${revisionBodies.length}` },
            );
        },
    });
    revisions.configure({ ...relay, allowInternet: true });
    revisions.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-revision', client_revision: 1, body: 'Original revision' },
        relay,
        allowInternet: false,
    });
    assert.equal((await revisions.attempt('diary-op-revision'))?.status, 'synced');
    const revised = revisions.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-revision', client_revision: 2, body: 'Corrected revision' },
        relay,
        allowInternet: false,
    });
    assert.equal(revised.status, 'queued');
    assert.equal(revised.clientRevision, 2);
    assert.equal((await revisions.attempt('diary-op-revision'))?.status, 'synced');
    assert.equal(
        revisions.enqueue({
            entry: {
                ...entry,
                client_operation_id: 'diary-op-revision',
                client_revision: 1,
                body: 'Original revision',
            },
            relay,
        }).clientRevision,
        2,
    );
    assert.throws(
        () =>
            revisions.enqueue({
                entry: {
                    ...entry,
                    client_operation_id: 'diary-op-revision',
                    client_revision: 2,
                    body: 'Conflicting revision two',
                },
                relay,
            }),
        DiaryRelayOperationConflictError,
    );
    assert.deepEqual(revisionBodies, [
        JSON.stringify({
            entry: {
                ...entry,
                client_operation_id: 'diary-op-revision',
                client_revision: 1,
                body: 'Original revision',
            },
        }),
        JSON.stringify({
            entry: {
                ...entry,
                client_operation_id: 'diary-op-revision',
                client_revision: 2,
                body: 'Corrected revision',
            },
        }),
    ]);
    revisions.close();

    // A cancellation is a durable tombstone, not a best-effort delete. It
    // deletes its unsent entry atomically, survives reboot, retries ahead of
    // all normal entries, and never reveals the scoped token in LAN status.
    const cancellationDir = path.join(tempDir, 'cancellation');
    const cancellationBeforeRestart = createOutbox(cancellationDir, { retryIntervalMs: 0 });
    cancellationBeforeRestart.configure({ ...relay, allowInternet: false });
    cancellationBeforeRestart.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-cancelled' },
        relay,
        allowInternet: false,
    });
    const tombstone = cancellationBeforeRestart.cancel('diary-op-cancelled');
    assert.equal(tombstone.kind, 'cancellation');
    assert.equal(tombstone.status, 'queued');
    assert.equal(tombstone.operationId, 'diary-op-cancelled');
    assert.equal((await cancellationBeforeRestart.attempt('diary-op-cancelled'))?.kind, 'cancellation');
    assert.throws(
        () =>
            cancellationBeforeRestart.enqueue({
                entry: { ...entry, client_operation_id: 'diary-op-cancelled', client_revision: 2 },
                relay,
            }),
        DiaryRelayOperationCancelledError,
    );
    // This unrelated entry is retained; cancellation must be sent before it
    // when the persisted outbox restarts with internet permission.
    cancellationBeforeRestart.enqueue({
        entry: { ...entry, client_operation_id: 'diary-op-after-cancel' },
        relay,
        allowInternet: false,
    });
    cancellationBeforeRestart.close();

    const cancellationCalls: Array<{ body: string; headers: Headers }> = [];
    const cancellationAfterRestart = createOutbox(cancellationDir, {
        retryIntervalMs: 0,
        fetchImpl: async (_url, init) => {
            cancellationCalls.push({ body: String(init.body), headers: new Headers(init.headers) });
            const payload = JSON.parse(String(init.body)) as { action?: unknown; client_operation_id?: unknown };
            if (payload.action === 'cancel' && typeof payload.client_operation_id === 'string') {
                return cancellationAcknowledgement(payload.client_operation_id);
            }
            const sent = requestedEntry(init);
            return acceptedEntry(
                String(sent.client_operation_id),
                typeof sent.client_revision === 'number' ? sent.client_revision : 1,
                { id: 'remote' },
            );
        },
    });
    cancellationAfterRestart.configure({ ...relay, allowInternet: true });
    await cancellationAfterRestart.flushDue();
    assert.deepEqual(
        cancellationCalls.map((call) => call.body),
        [
            JSON.stringify({ action: 'cancel', client_operation_id: 'diary-op-cancelled' }),
            JSON.stringify({ entry: { ...entry, client_operation_id: 'diary-op-after-cancel' } }),
        ],
    );
    assert.equal(cancellationCalls[0].headers.get('X-Thalassa-Pi-Relay-Id'), relay.relayId);
    assert.equal(cancellationCalls[0].headers.get('X-Thalassa-Pi-Relay-Token'), relay.token);
    const cancelledStatus = cancellationAfterRestart.getStatus('diary-op-cancelled');
    assert.equal(cancelledStatus?.kind, 'cancellation');
    assert.equal(cancelledStatus?.status, 'synced');
    assert.equal(JSON.stringify(cancelledStatus).includes(relay.token), false);
    assert.equal(JSON.stringify(cancellationAfterRestart.getStats()).includes(relay.token), false);
    cancellationAfterRestart.close();

    // Cancelling is just as strict as entry forwarding: an arbitrary 2xx or
    // a cancellation acknowledgement for another operation must not retire
    // this durable tombstone.
    const invalidCancellationAck = createOutbox(path.join(tempDir, 'invalid-cancellation-ack'), {
        retryIntervalMs: 0,
        fetchImpl: async () => cancellationAcknowledgement('diary-op-someone-else'),
    });
    invalidCancellationAck.configure({ ...relay, allowInternet: false });
    invalidCancellationAck.cancel('diary-op-wrong-cancellation-ack');
    invalidCancellationAck.configure({ allowInternet: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const invalidCancellationStatus = invalidCancellationAck.getStatus('diary-op-wrong-cancellation-ack');
    assert.equal(invalidCancellationStatus?.kind, 'cancellation');
    assert.equal(invalidCancellationStatus?.status, 'queued');
    assert.equal(invalidCancellationStatus?.attemptCount, 1);
    invalidCancellationAck.close();

    // A failed cancellation remains durable and redacts a malicious upstream
    // error that tries to echo the scoped bearer token into public status.
    const failingCancellation = createOutbox(path.join(tempDir, 'failing-cancellation'), {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            throw new Error(`upstream echo ${relay.token}`);
        },
    });
    failingCancellation.configure({ ...relay, allowInternet: false });
    failingCancellation.cancel('diary-op-failed-cancel');
    failingCancellation.configure({ allowInternet: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failedCancel = failingCancellation.getStatus('diary-op-failed-cancel');
    assert.equal(failedCancel?.status, 'queued');
    assert.equal(failedCancel?.attemptCount, 1);
    assert.equal(JSON.stringify(failedCancel).includes(relay.token), false);
    failingCancellation.close();

    // Validation/auth failures cannot improve by retrying the same payload.
    // They become visible metadata (`needs_repair`) and are omitted from future
    // sweep attempts until a deliberate revision/configuration repair occurs.
    let repairCalls = 0;
    const needsRepair = createOutbox(path.join(tempDir, 'needs-repair'), {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            repairCalls += 1;
            return new Response(JSON.stringify({ error: 'not authorised' }), { status: 401 });
        },
    });
    needsRepair.configure({ ...relay, allowInternet: true });
    needsRepair.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-needs-repair' }, relay });
    const repairStatus = await needsRepair.attempt('diary-op-needs-repair');
    assert.equal(repairStatus?.status, 'needs_repair');
    assert.equal(repairStatus?.attemptCount, 1);
    assert.equal(JSON.stringify(repairStatus).includes(entry.body), false);
    await needsRepair.flushDue();
    assert.equal(repairCalls, 1);
    needsRepair.close();

    // A 409 carrying Edge's authoritative cancellation tombstone is terminal
    // for the stale write: the Pi records a synced local cancellation and
    // never retries the entry itself.
    let remoteCancellationCalls = 0;
    const remoteCancellation = createOutbox(path.join(tempDir, 'remote-cancellation'), {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            remoteCancellationCalls += 1;
            return new Response(JSON.stringify({ cancelled: true, client_operation_id: 'diary-op-remote-cancelled' }), {
                status: 409,
            });
        },
    });
    remoteCancellation.configure({ ...relay, allowInternet: true });
    remoteCancellation.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-remote-cancelled' }, relay });
    const remotelyCancelled = await remoteCancellation.attempt('diary-op-remote-cancelled');
    assert.equal(remotelyCancelled?.kind, 'cancellation');
    assert.equal(remotelyCancelled?.status, 'synced');
    await remoteCancellation.flushDue();
    assert.equal(remoteCancellationCalls, 1);
    remoteCancellation.close();

    // A Pi may later be re-paired to a different account. Existing queued
    // owner-A data must never leave using owner-B's current credential (and
    // the same rule applies to cancellation tombstones).
    const relayB = { ...relay, token: 'scoped-relay-token-for-owner-two', ownerId: 'owner-2' };
    let crossOwnerCalls = 0;
    const crossOwner = createOutbox(path.join(tempDir, 'cross-owner'), {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            crossOwnerCalls += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
    });
    crossOwner.configure({ ...relay, allowInternet: false });
    crossOwner.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-owner-a' }, relay });
    crossOwner.configure({ ...relayB, allowInternet: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(crossOwner.getStatus('diary-op-owner-a')?.status, 'needs_repair');
    assert.equal(crossOwnerCalls, 0);

    crossOwner.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-owner-a-cancel' }, relay });
    crossOwner.configure({ ...relay, allowInternet: false });
    crossOwner.cancel('diary-op-owner-a-cancel');
    crossOwner.configure({ ...relayB, allowInternet: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const crossOwnerCancellation = crossOwner.getStatus('diary-op-owner-a-cancel');
    assert.equal(crossOwnerCancellation?.kind, 'cancellation');
    assert.equal(crossOwnerCancellation?.status, 'needs_repair');
    assert.equal(crossOwnerCalls, 0);
    crossOwner.close();

    // Old/partial Pi rows that have no verifiable relay owner are quarantined
    // rather than becoming deliverable after a later pairing.
    const ownerless = createOutbox(path.join(tempDir, 'ownerless'), { retryIntervalMs: 0 });
    ownerless.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-ownerless' } });
    assert.equal(ownerless.getStatus('diary-op-ownerless')?.status, 'needs_repair');
    ownerless.close();

    // Keep the Pi below the Edge body's 160 KiB ceiling even before the extra
    // relay envelope is added.
    const bounded = createOutbox(path.join(tempDir, 'bounded'), { retryIntervalMs: 0 });
    assert.throws(
        () =>
            bounded.enqueue({
                entry: { ...entry, client_operation_id: 'diary-op-too-large', body: 'x'.repeat(128 * 1024) },
            }),
        DiaryRelayValidationError,
    );
    bounded.close();

    // A restart fails closed until the authenticated phone reasserts its
    // current WAN policy. That prevents a stale pre-restart allow=true from
    // draining the outbox over a newly selected satellite link.
    let startupCalls = 0;
    const startupDir = path.join(tempDir, 'startup');
    const beforeRestart = createOutbox(startupDir, {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            startupCalls += 1;
            return acceptedEntry('diary-op-startup', 1, { id: 'startup-entry' });
        },
    });
    beforeRestart.configure({ ...relay, allowInternet: true });
    beforeRestart.enqueue({ entry: { ...entry, client_operation_id: 'diary-op-startup' }, relay, allowInternet: true });
    beforeRestart.close();
    const afterRestart = createOutbox(startupDir, {
        retryIntervalMs: 0,
        fetchImpl: async () => {
            startupCalls += 1;
            return acceptedEntry('diary-op-startup', 1, { id: 'startup-entry' });
        },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(afterRestart.getStatus('diary-op-startup')?.status, 'queued');
    assert.equal(startupCalls, 0);
    afterRestart.configure({ allowInternet: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(afterRestart.getStatus('diary-op-startup')?.status, 'synced');
    assert.equal(startupCalls, 1);
    afterRestart.close();
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
