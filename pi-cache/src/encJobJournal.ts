import fs from 'node:fs/promises';
import path from 'node:path';
import { writeChartFileAtomic } from './encChartStore.js';

const MAX_RECEIPTS = 30;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_ID = /^[a-f0-9-]{36}$/;
const writes = new Map<string, Promise<void>>();

export interface EncJobReceipt {
    id: string;
    status: string;
    startedAt: number;
    completedAt?: number;
    resultKind?: string;
    resultUrl?: string;
    [key: string]: unknown;
}

/** Receives only the public summary; paths, chart keys and source URLs never enter this journal. */
export function saveEncJobReceipt(storeDir: string, summary: EncJobReceipt): Promise<void> {
    if (!JOB_ID.test(summary.id)) return Promise.reject(new Error('Invalid installation job ID'));
    const filename = path.join(storeDir, 'install-jobs', `${summary.id}.json`);
    const text = JSON.stringify(summary);
    const previous = writes.get(filename) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => writeChartFileAtomic(filename, text));
    writes.set(filename, next);
    void next
        .finally(() => {
            if (writes.get(filename) === next) writes.delete(filename);
        })
        .catch(() => {});
    return next;
}

export async function listEncJobReceipts(storeDir: string): Promise<EncJobReceipt[]> {
    const directory = path.join(storeDir, 'install-jobs');
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    const receipts: { filename: string; summary: EncJobReceipt }[] = [];
    for (const name of names) {
        if (!name.endsWith('.json') || !JOB_ID.test(name.slice(0, -5))) continue;
        const filename = path.join(directory, name);
        try {
            const summary = JSON.parse(await fs.readFile(filename, 'utf8')) as EncJobReceipt;
            if (summary.id !== name.slice(0, -5) || !Number.isFinite(summary.startedAt)) continue;
            if (Date.now() - (summary.completedAt ?? summary.startedAt) > RECEIPT_TTL_MS) {
                await fs.unlink(filename).catch(() => {});
                continue;
            }
            receipts.push({ filename, summary });
        } catch {
            // One corrupt receipt must not prevent access to installed charts.
        }
    }
    receipts.sort((a, b) => b.summary.startedAt - a.summary.startedAt);
    for (const extra of receipts.slice(MAX_RECEIPTS)) await fs.unlink(extra.filename).catch(() => {});
    return receipts.slice(0, MAX_RECEIPTS).map(({ summary }) => summary);
}

/** After restart an unfinished receipt is interrupted, never silently successful. */
export function restoredEncJobReceipt(summary: EncJobReceipt): EncJobReceipt {
    if (summary.status === 'error' || (summary.status === 'done' && summary.resultKind === 'installed')) return summary;
    return {
        ...summary,
        status: 'error',
        resultUrl: undefined,
        errorCode: 'installation-interrupted',
        error: 'The Pi restarted before this installation could be confirmed. Check installed charts, then retry the download if needed.',
    };
}
