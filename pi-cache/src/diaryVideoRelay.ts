/**
 * diaryVideoRelay — the boat babysits the big uploads.
 *
 * A minute of 4K is ~200MB. The phone hands the clip to the Pi over the boat
 * LAN in seconds and gets on with its life; the Pi parks it on disk and pushes
 * it to Supabase Storage whenever WAN comes good — Starlink at anchor, marina
 * WiFi next Tuesday, whenever. The diary entry itself already relays through
 * the Pi outbox, so the pair travels the same road.
 *
 * CREDENTIALS: the Pi never holds anything that can write to Storage. When a
 * clip is due, it presents the diary relay token (the pairing credential the
 * outbox already holds) to the diary-relay Edge Function, which answers with a
 * SIGNED UPLOAD URL scoped to that one object in the owner's folder. The Pi
 * redeems it and is again holding nothing.
 *
 * ARRIVAL is chunked (the Capacitor bridge cannot carry a 200MB body, and the
 * boat WiFi drops mid-transfer as a matter of routine) and verified: the
 * upload only parks when the assembled file's SHA-256 matches what the phone
 * declared. A half-arrived clip is deleted, never uploaded.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface VideoRelayCredentials {
    url: string;
    relayId: string;
    token: string;
    ownerId: string;
}

interface LedgerRecord {
    id: string;
    operationId: string;
    ownerId: string;
    /** Storage object path, chosen by the phone: `<ownerId>/<millis>.mp4`. */
    path: string;
    totalBytes: number;
    sha256: string;
    state: 'receiving' | 'parked' | 'done' | 'failed';
    receivedBytes: number;
    nextChunk: number;
    createdAt: number;
    lastError?: string;
}

const MAX_CLIP_BYTES = 600 * 1024 * 1024;
const MAX_PARKED = 4;
const LEDGER_RETENTION_MS = 7 * 24 * 3600 * 1000;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const PATH_RE = /^[0-9a-f-]{16,64}\/[0-9]{10,16}\.(mp4|mov)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class DiaryVideoRelay {
    private readonly dir: string;
    private uploading = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        cacheDir: string,
        /** Borrowed from the outbox: present only when a skipper has paired. */
        private readonly lendCredentials: () => VideoRelayCredentials | null,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {
        this.dir = join(cacheDir, 'diary-video-outbox');
    }

    private ledgerPath(id: string): string {
        return join(this.dir, `${id}.json`);
    }
    private blobPath(id: string): string {
        return join(this.dir, `${id}.bin`);
    }

    private async readLedger(id: string): Promise<LedgerRecord | null> {
        if (!ID_RE.test(id)) return null;
        try {
            return JSON.parse(await readFile(this.ledgerPath(id), 'utf8')) as LedgerRecord;
        } catch {
            return null;
        }
    }

    private async writeLedger(record: LedgerRecord): Promise<void> {
        await writeFile(this.ledgerPath(record.id), JSON.stringify(record));
    }

    async begin(input: {
        operationId: string;
        path: string;
        totalBytes: number;
        sha256: string;
    }): Promise<{ id: string } | { error: string; status: number }> {
        const creds = this.lendCredentials();
        if (!creds) return { error: 'No diary relay is paired on this Pi', status: 409 };
        if (!ID_RE.test(input.operationId)) return { error: 'Invalid operation id', status: 400 };
        if (!PATH_RE.test(input.path) || !input.path.startsWith(`${creds.ownerId}/`)) {
            return { error: 'Video path does not belong to the paired skipper', status: 403 };
        }
        if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0 || input.totalBytes > MAX_CLIP_BYTES) {
            return { error: 'Video size is missing or over the 600MB ceiling', status: 400 };
        }
        if (!/^[0-9a-f]{64}$/.test(input.sha256)) return { error: 'A SHA-256 of the clip is required', status: 400 };

        await mkdir(this.dir, { recursive: true });
        const existing = await this.list();
        if (existing.filter((r) => r.state === 'receiving' || r.state === 'parked').length >= MAX_PARKED) {
            return { error: 'The Pi already holds its maximum of parked clips', status: 429 };
        }

        // One clip per diary operation: a retried begin replaces the earlier
        // attempt rather than stacking half-received siblings.
        for (const record of existing) {
            if (record.operationId === input.operationId && record.state !== 'done') {
                await this.remove(record.id);
            }
        }

        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        await this.writeLedger({
            id,
            operationId: input.operationId,
            ownerId: creds.ownerId,
            path: input.path,
            totalBytes: input.totalBytes,
            sha256: input.sha256,
            state: 'receiving',
            receivedBytes: 0,
            nextChunk: 0,
            createdAt: Date.now(),
        });
        await writeFile(this.blobPath(id), Buffer.alloc(0));
        return { id };
    }

    async chunk(id: string, index: number, data: Buffer): Promise<{ ok: true } | { error: string; status: number }> {
        const record = await this.readLedger(id);
        if (!record || record.state !== 'receiving') return { error: 'Unknown or finished upload', status: 404 };
        if (index !== record.nextChunk) {
            // A retried chunk the disk already holds is success, not an error —
            // the boat WiFi WILL drop acks.
            if (index === record.nextChunk - 1) return { ok: true };
            return { error: `Expected chunk ${record.nextChunk}, got ${index}`, status: 409 };
        }
        if (record.receivedBytes + data.length > record.totalBytes) {
            await this.remove(id);
            return { error: 'More bytes than declared — upload discarded', status: 400 };
        }
        await appendFile(this.blobPath(id), data);
        record.receivedBytes += data.length;
        record.nextChunk += 1;
        await this.writeLedger(record);
        return { ok: true };
    }

    async finish(id: string): Promise<{ ok: true; path: string } | { error: string; status: number }> {
        const record = await this.readLedger(id);
        if (!record || record.state !== 'receiving') return { error: 'Unknown or finished upload', status: 404 };
        if (record.receivedBytes !== record.totalBytes) {
            return { error: `Received ${record.receivedBytes} of ${record.totalBytes} bytes`, status: 409 };
        }
        const bytes = await readFile(this.blobPath(id));
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== record.sha256) {
            await this.remove(id);
            return { error: 'Checksum mismatch — upload discarded, send it again', status: 422 };
        }
        // The clip survives a power cut from this moment on.
        const fd = openSync(this.blobPath(id), 'r');
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        record.state = 'parked';
        await this.writeLedger(record);
        void this.drainSoon();
        return { ok: true, path: record.path };
    }

    /** Cancel any parked clip for a diary operation the skipper deleted. */
    async cancelOperation(operationId: string): Promise<void> {
        for (const record of await this.list()) {
            if (record.operationId === operationId && record.state !== 'done') {
                await this.remove(record.id);
            }
        }
    }

    async status(operationId: string): Promise<{ state: string; error?: string } | null> {
        for (const record of await this.list()) {
            if (record.operationId === operationId) {
                return { state: record.state, ...(record.lastError ? { error: record.lastError } : {}) };
            }
        }
        return null;
    }

    private async list(): Promise<LedgerRecord[]> {
        try {
            const names = await readdir(this.dir);
            const records: LedgerRecord[] = [];
            for (const name of names) {
                if (!name.endsWith('.json')) continue;
                const record = await this.readLedger(name.slice(0, -5));
                if (record) records.push(record);
            }
            return records;
        } catch {
            return [];
        }
    }

    private async remove(id: string): Promise<void> {
        await rm(this.blobPath(id), { force: true });
        await rm(this.ledgerPath(id), { force: true });
    }

    start(intervalMs = 60_000): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.drainSoon(), intervalMs);
        this.timer.unref?.();
        void this.drainSoon();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async drainSoon(): Promise<void> {
        if (this.uploading) return;
        this.uploading = true;
        try {
            await this.drain();
        } finally {
            this.uploading = false;
        }
    }

    private async drain(): Promise<void> {
        const creds = this.lendCredentials();
        const records = await this.list();
        const now = Date.now();
        for (const record of records) {
            // Old ledgers (done, failed, or abandoned mid-receive) age out.
            if (now - record.createdAt > LEDGER_RETENTION_MS && record.state !== 'parked') {
                await this.remove(record.id);
                continue;
            }
            if (record.state !== 'parked' || !creds) continue;
            try {
                await this.upload(record, creds);
            } catch (err) {
                record.lastError = err instanceof Error ? err.message : String(err);
                await this.writeLedger(record);
                console.warn(`[diaryVideo] upload deferred (${record.path}): ${record.lastError}`);
            }
        }
    }

    private async upload(record: LedgerRecord, creds: VideoRelayCredentials): Promise<void> {
        // Step 1: redeem the relay pairing for a one-object signed URL.
        const grant = await this.fetchImpl(creds.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Thalassa-Pi-Relay-Id': creds.relayId,
                'X-Thalassa-Pi-Relay-Token': creds.token,
            },
            body: JSON.stringify({ action: 'video-upload-url', path: record.path }),
        });
        if (!grant.ok) throw new Error(`upload-url request returned ${grant.status}`);
        const granted = (await grant.json()) as { url?: string };
        if (!granted.url || typeof granted.url !== 'string') throw new Error('No signed URL in the grant');
        // The signed URL must live on the same origin as the relay endpoint —
        // this worker uploads to the skipper's own project and nowhere else.
        if (new URL(granted.url).origin !== new URL(creds.url).origin) {
            throw new Error('Signed URL points off the trusted origin');
        }

        // Step 2: put the bytes. No timeout race shorter than the transfer —
        // 200MB on a marina uplink legitimately takes a while.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        try {
            const body = await readFile(this.blobPath(record.id));
            const contentType = record.path.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
            const put = await this.fetchImpl(granted.url, {
                method: 'PUT',
                headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
                body,
                signal: controller.signal,
            });
            if (!put.ok && put.status !== 409) {
                // 409 = the object already exists: a previous attempt landed and
                // only the ack was lost. That is success wearing a frown.
                throw new Error(`storage PUT returned ${put.status}`);
            }
        } finally {
            clearTimeout(timeout);
        }
        record.state = 'done';
        record.lastError = undefined;
        await this.writeLedger(record);
        await rm(this.blobPath(record.id), { force: true });
        console.log(
            `[diaryVideo] uploaded ${record.path} (${(record.totalBytes / 1048576).toFixed(1)}MB) for op ${record.operationId}`,
        );
    }
}

/** True when the file for a parked upload still exists (used by tests). */
export async function parkedBlobExists(cacheDir: string, id: string): Promise<boolean> {
    const path = join(cacheDir, 'diary-video-outbox', `${id}.bin`);
    if (!existsSync(path)) return false;
    return (await stat(path)).size >= 0;
}
