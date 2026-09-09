import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { DiaryRelayOperationCancelledError, DiaryRelayOutbox } from './diaryRelayOutbox.js';

const RELAY = {
    url: 'https://project.supabase.co/functions/v1/diary-relay',
    relayId: 'pi-relay-delete-0001',
    token: 'scoped-test-credential',
    ownerId: 'owner-delete-test',
};

function acknowledgement(operationId: string): Response {
    return new Response(JSON.stringify({ ok: true, cancelled: true, client_operation_id: operationId }));
}

function accepted(operationId: string): Response {
    return new Response(
        JSON.stringify({
            ok: true,
            status: 'accepted',
            entry: { client_operation_id: operationId, client_revision: 1, body: 'private diary body' },
        }),
    );
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

async function harness(t: TestContext, cancelResponse?: Promise<Response>) {
    const dir = mkdtempSync(join(tmpdir(), 'diary-cancellation-'));
    const dbPath = join(dir, 'diary-relay', 'outbox.db');
    const outbox = new DiaryRelayOutbox(dir, {
        trustedSupabaseOrigin: new URL(RELAY.url).origin,
        retryIntervalMs: 0,
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init.body));
            return body.action === 'cancel'
                ? (cancelResponse ?? acknowledgement(body.client_operation_id))
                : accepted(body.entry.client_operation_id);
        },
    });
    outbox.configure({ ...RELAY, allowInternet: true });
    await settled();
    t.after(() => {
        outbox.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return { outbox, dir, dbPath };
}

test('confirmed cancellation removes synced payloads and count while retaining the owner-bound tombstone', async (t) => {
    const response = deferred<Response>();
    const { outbox, dbPath } = await harness(t, response.promise);
    const operationId = 'cancel-synced-entry';
    const entry = { client_operation_id: operationId, body: 'private diary body' };
    outbox.enqueue({ entry, relay: RELAY });
    await outbox.attempt(operationId);
    assert.equal(outbox.getStats().synced, 1);
    assert.ok(outbox.getCanonicalEntry(operationId));

    outbox.cancel(operationId);
    assert.equal(outbox.getStats().synced, 1, 'retain synced content until the cloud acknowledges cancellation');
    assert.equal(
        outbox.getCanonicalEntry(operationId),
        null,
        'a pending deletion must not return stale canonical content',
    );
    response.resolve(acknowledgement(operationId));
    await settled();
    assert.equal(outbox.getStats().synced, 0);
    assert.equal(outbox.getStats().cancellationsSynced, 1);
    assert.equal(outbox.getStatus(operationId)?.kind, 'cancellation');
    assert.throws(() => outbox.enqueue({ entry, relay: RELAY }), DiaryRelayOperationCancelledError);

    const db = new Database(dbPath, { readonly: true });
    try {
        assert.equal(
            db
                .prepare('SELECT entry_json, server_entry_json FROM diary_relay_outbox WHERE operation_id = ?')
                .get(operationId),
            undefined,
        );
        assert.deepEqual(
            db
                .prepare('SELECT relay_owner_id, status FROM diary_relay_cancellations WHERE operation_id = ?')
                .get(operationId),
            {
                relay_owner_id: RELAY.ownerId,
                status: 'synced',
            },
        );
    } finally {
        db.close();
    }
});

test('an acknowledgement for another operation retains the synced payload for retry', async (t) => {
    const { outbox, dbPath } = await harness(t, Promise.resolve(acknowledgement('different-operation')));
    const operationId = 'cancel-invalid-ack';
    outbox.enqueue({ entry: { client_operation_id: operationId, body: 'keep until confirmed' }, relay: RELAY });
    await outbox.attempt(operationId);
    outbox.cancel(operationId);
    await settled();
    assert.equal(outbox.getStatus(operationId)?.status, 'queued');
    assert.equal(outbox.getStats().synced, 1);
    const db = new Database(dbPath, { readonly: true });
    try {
        assert.ok(db.prepare('SELECT entry_json FROM diary_relay_outbox WHERE operation_id = ?').get(operationId));
    } finally {
        db.close();
    }
});

test('startup only purges a legacy payload with a confirmed cancellation for the same owner', async (t) => {
    const { outbox, dir, dbPath } = await harness(t);
    outbox.configure({ allowInternet: false });
    const db = new Database(dbPath);
    try {
        for (const operationId of ['confirmed', 'pending', 'other-owner', 'ownerless', 'needs-repair', 'unrelated']) {
            outbox.enqueue({ entry: { client_operation_id: operationId, body: 'retained legacy body' }, relay: RELAY });
            db.prepare(
                "UPDATE diary_relay_outbox SET status = 'synced', server_entry_json = entry_json WHERE operation_id = ?",
            ).run(operationId);
            if (operationId === 'unrelated') continue;
            outbox.cancel(operationId);
            if (operationId !== 'pending') {
                db.prepare("UPDATE diary_relay_cancellations SET status = 'synced' WHERE operation_id = ?").run(
                    operationId,
                );
            }
        }
        db.prepare(
            "UPDATE diary_relay_cancellations SET relay_owner_id = 'other-owner' WHERE operation_id = 'other-owner'",
        ).run();
        db.prepare("UPDATE diary_relay_cancellations SET relay_owner_id = NULL WHERE operation_id = 'ownerless'").run();
        db.prepare("UPDATE diary_relay_outbox SET relay_owner_id = NULL WHERE operation_id = 'ownerless'").run();
        db.prepare("UPDATE diary_relay_cancellations SET needs_repair = 1 WHERE operation_id = 'needs-repair'").run();
    } finally {
        db.close();
    }
    outbox.close();

    const restarted = new DiaryRelayOutbox(dir, {
        trustedSupabaseOrigin: new URL(RELAY.url).origin,
        retryIntervalMs: 0,
    });
    try {
        assert.equal(restarted.getStats().synced, 5);
        assert.equal(restarted.getStatus('confirmed')?.status, 'synced');
        const verified = new Database(dbPath, { readonly: true });
        try {
            assert.deepEqual(
                verified.prepare('SELECT operation_id FROM diary_relay_outbox ORDER BY operation_id').all(),
                ['needs-repair', 'other-owner', 'ownerless', 'pending', 'unrelated'].map((operation_id) => ({
                    operation_id,
                })),
            );
            assert.equal(
                (
                    verified
                        .prepare('SELECT relay_owner_id FROM diary_relay_cancellations WHERE operation_id = ?')
                        .get('confirmed') as { relay_owner_id: string }
                ).relay_owner_id,
                RELAY.ownerId,
            );
        } finally {
            verified.close();
        }
    } finally {
        restarted.close();
    }
});

test('an entry acknowledgement arriving after cancellation cannot restore its payload or synced count', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'diary-cancel-inflight-'));
    const entryResponse = deferred<Response>();
    let entrySignal: AbortSignal | null | undefined;
    const operationId = 'cancel-inflight-entry';
    const outbox = new DiaryRelayOutbox(dir, {
        trustedSupabaseOrigin: new URL(RELAY.url).origin,
        retryIntervalMs: 0,
        fetchImpl: async (_url, init) => {
            if (JSON.parse(String(init.body)).action === 'cancel') return acknowledgement(operationId);
            entrySignal = init.signal;
            return entryResponse.promise;
        },
    });
    t.after(() => {
        outbox.close();
        rmSync(dir, { recursive: true, force: true });
    });
    outbox.configure({ ...RELAY, allowInternet: true });
    await settled();
    outbox.enqueue({ entry: { client_operation_id: operationId, body: 'late acceptance' }, relay: RELAY });
    const attempt = outbox.attempt(operationId);
    outbox.cancel(operationId);
    await settled();
    assert.equal(entrySignal?.aborted, true);
    entryResponse.resolve(accepted(operationId));
    assert.equal((await attempt)?.kind, 'cancellation');
    assert.equal(outbox.getStats().synced, 0);
    assert.equal(outbox.getStats().queued, 0);
    assert.equal(outbox.getStats().cancellationsSynced, 1);
    assert.equal(outbox.getCanonicalEntry(operationId), null);
});
