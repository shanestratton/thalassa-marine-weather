import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listEncJobReceipts, restoredEncJobReceipt, saveEncJobReceipt } from './encJobJournal.js';

test('a reconnect can recover confirmed installed results and interrupted jobs fail explicitly', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-job-journal-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const id = randomUUID();
    const pending = { id, startedAt: Date.now(), status: 'pending', filename: 'charts.zip' };
    await saveEncJobReceipt(directory, pending);
    assert.equal(restoredEncJobReceipt((await listEncJobReceipts(directory))[0]).errorCode, 'installation-interrupted');
    const done = {
        ...pending,
        status: 'done',
        resultKind: 'installed',
        persistedCellIds: ['FR466870'],
        packageSummary: { new: 1, updated: 0, unchanged: 0, total: 1 },
    };
    await saveEncJobReceipt(directory, done);
    assert.deepEqual(restoredEncJobReceipt((await listEncJobReceipts(directory))[0]), done);
});

test('rapid receipt writes preserve final status and history stays bounded', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-job-journal-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const id = randomUUID();
    const base = { id, startedAt: Date.now() + 100, filename: 'charts.zip' };
    await Promise.all([
        saveEncJobReceipt(directory, { ...base, status: 'pending' }),
        saveEncJobReceipt(directory, { ...base, status: 'done', resultKind: 'installed' }),
        ...Array.from({ length: 35 }, (_, i) =>
            saveEncJobReceipt(directory, { id: randomUUID(), startedAt: Date.now() - i, status: 'error' }),
        ),
    ]);
    const receipts = await listEncJobReceipts(directory);
    assert.equal(receipts.length, 30);
    assert.equal(receipts.find((receipt) => receipt.id === id)?.status, 'done');
    assert.equal((await fs.readdir(path.join(directory, 'install-jobs'))).length, 30);
    assert.equal(
        restoredEncJobReceipt({ ...base, status: 'done', resultKind: 'conversion', resultUrl: '/expired-result' })
            .resultUrl,
        undefined,
    );
});
