/**
 * Seabed mapping: the phone sends its queued batches to the seabed-relay
 * Edge Function, oldest first, six at most per cycle.
 *
 * Every 15 minutes while the app is open, and when it comes back to the
 * foreground. Failures back off from 10 minutes to 6 hours. A 404 means the
 * function is not deployed yet: it waits 12 hours and says so once, so the
 * app stays quiet until Shane pushes it. Satellite Mode holds everything on
 * the phone. 409 not-enabled means the owner switched it off elsewhere: the
 * queue is purged. 409 not-logger (another device logs this boat now) and
 * the other 409s wait six hours. 413/422, and 403 not-owner (a boat since
 * released or sold), set that batch aside (kept 30 days, never retried) so
 * it never blocks the batches behind it.
 *
 * Before each cycle the owner's platform row is brought into line (a change
 * made here goes up first, then the row comes down), so a phone the skipper
 * moved logging away from stands down within one cycle.
 *
 * CapacitorHttp ignores AbortSignal on device, so every request is bounded
 * by withTimeout, as AisShareService and anchorPiPush do.
 */
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';
import { satelliteModeBlocks } from '../networkPolicy';
import { supabaseUrl } from '../supabase';
import { getAuthenticatedFunctionHeaders } from '../supabaseAuth';
import type { SeabedFiles } from './SeabedPhoneCapture';
import { readSeabedLocal, syncSeabedPlatform, writeSeabedLocal } from './SeabedSettingsService';

const log = createLogger('Seabed');

export const PHONE_UPLOAD_INTERVAL_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
const NOT_DEPLOYED_WAIT_MS = 12 * 3_600_000;
const DEFER_MS = 6 * 3_600_000;
const REJECTED_KEEP_MS = 30 * 86_400_000;
const BATCHES_PER_CYCLE = 6;
const REQUEST_DEADLINE_MS = 30_000;

export type PhoneUploadOutcome =
    | 'sent'
    | 'idle'
    | 'satellite'
    | 'waiting'
    | 'not-deployed'
    | 'unauthorised'
    | 'unreachable'
    | 'rejected'
    | 'not-enabled'
    | 'deferred';

export interface SeabedReply {
    status: number;
    body: Record<string, unknown>;
}

export interface PhoneUploaderDeps {
    files: SeabedFiles;
    now: () => number;
    /** Satellite Mode. */
    blocked: () => boolean;
    post: (body: Record<string, unknown>) => Promise<SeabedReply | null>;
    /** The owner switched it off elsewhere (the queue is already purged). */
    onWithdrawn: () => void;
    log?: (line: string) => void;
}

export class SeabedPhoneUploader {
    private failures = 0;
    private pausedUntil = 0;
    private inFlight = false;
    private lastOutcome: PhoneUploadOutcome | null = null;

    constructor(private readonly deps: PhoneUploaderDeps) {}

    nextDelayMs(): number {
        if (this.failures === 0) return PHONE_UPLOAD_INTERVAL_MS;
        return Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** this.failures);
    }

    async cycle(): Promise<PhoneUploadOutcome> {
        if (this.inFlight) return this.lastOutcome ?? 'idle';
        this.inFlight = true;
        try {
            const outcome = await this.attempt();
            if (outcome !== this.lastOutcome && outcome !== 'idle') {
                const note = outcome === 'not-deployed' ? ' (seabed-relay is not deployed yet; next try in 12 h)' : '';
                (this.deps.log ?? ((line: string) => log.warn(line)))(`seabed uploader: ${outcome}${note}`);
            }
            this.lastOutcome = outcome;
            if (outcome === 'unreachable' || outcome === 'unauthorised' || outcome === 'rejected') this.failures += 1;
            else if (outcome !== 'waiting' && outcome !== 'satellite') this.failures = 0;
            return outcome;
        } finally {
            this.inFlight = false;
        }
    }

    private async attempt(): Promise<PhoneUploadOutcome> {
        const now = this.deps.now();
        if (this.deps.blocked()) return 'satellite';
        if (now < this.pausedUntil) return 'waiting';
        const files = await this.deps.files.list();
        for (const f of files) {
            if (f.name.startsWith('r-') && now - f.mtime > REJECTED_KEEP_MS) await this.deps.files.remove(f.name);
        }
        const setAside = async (name: string, text: string | null) => {
            await this.deps.files.write(`r-${name.slice(2)}`, text ?? '');
            await this.deps.files.remove(name);
        };
        const queue = files
            .filter((f) => f.name.startsWith('q-'))
            .map((f) => f.name)
            .sort()
            .slice(0, BATCHES_PER_CYCLE);
        let sent = 0;
        for (const name of queue) {
            const text = await this.deps.files.read(name);
            let body: Record<string, unknown>;
            try {
                body = JSON.parse(text ?? '') as Record<string, unknown>;
            } catch {
                await this.deps.files.remove(name); // damaged on disk: nothing to send
                continue;
            }
            const reply = await this.deps.post({ ...body, action: 'batch' });
            if (reply === null) return 'unreachable';
            if (reply.status >= 200 && reply.status < 300) {
                await this.deps.files.remove(name);
                sent += 1;
                continue;
            }
            if (reply.status === 404) {
                this.pausedUntil = now + NOT_DEPLOYED_WAIT_MS;
                return 'not-deployed';
            }
            if (reply.status === 403 && reply.body.code === 'not-owner') {
                await setAside(name, text);
                continue;
            }
            if (reply.status === 401 || reply.status === 403) return 'unauthorised';
            if (reply.status === 409 && reply.body.code === 'not-enabled') {
                // Everything not yet sent: queued and held hours, and the open rows.
                for (const f of await this.deps.files.list()) {
                    if (!f.name.startsWith('r-')) await this.deps.files.remove(f.name);
                }
                this.deps.onWithdrawn();
                return 'not-enabled';
            }
            if (reply.status === 409) {
                this.pausedUntil = now + DEFER_MS;
                return 'deferred';
            }
            if (reply.status === 413 || reply.status === 422) {
                await setAside(name, text);
                continue;
            }
            return 'rejected';
        }
        return sent > 0 ? 'sent' : 'idle';
    }
}

/** POST to seabed-relay with the signed-in user's JWT. Null when it could not be asked. */
export async function postSeabedRelay(body: Record<string, unknown>): Promise<SeabedReply | null> {
    const base = (supabaseUrl || '').replace(/\/$/, '');
    if (!base) return null;
    let headers: Record<string, string>;
    try {
        headers = await getAuthenticatedFunctionHeaders();
    } catch {
        return null;
    }
    const request = (async (): Promise<SeabedReply | null> => {
        const res = await fetch(`${base}/functions/v1/seabed-relay`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            parsed = null;
        }
        const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        return { status: res.status, body: record };
    })().catch(() => null);
    return withTimeout(request, null, REQUEST_DEADLINE_MS);
}

/** "Delete my soundings": every object and index row of this account, and the switch off. */
export async function deleteMySoundingsInCloud(): Promise<boolean> {
    const reply = await postSeabedRelay({ action: 'delete_all' });
    return !!reply && reply.status >= 200 && reply.status < 300;
}

// ── The running uploader ──────────────────────────────────────────────────

let active: { timer: ReturnType<typeof setTimeout> | null; stop: () => void } | null = null;

export function startSeabedUploader(
    files: SeabedFiles,
    afterCycle: () => Promise<void>,
    activeBoatId: () => string | null | undefined,
): void {
    if (active) return;
    const uploader = new SeabedPhoneUploader({
        files,
        now: Date.now,
        blocked: () => satelliteModeBlocks('seabed-upload'),
        post: postSeabedRelay,
        onWithdrawn: () => {
            const local = readSeabedLocal();
            if (local) writeSeabedLocal({ ...local, enabled: false, pendingSync: false, dirty: [] });
        },
    });
    const state: { timer: ReturnType<typeof setTimeout> | null; stop: () => void } = { timer: null, stop: () => {} };
    const run = async () => {
        // A setting changed offline goes up first, so the platform row exists before its
        // batches; then the row comes down, so a logger moved elsewhere stands down.
        await syncSeabedPlatform({ activeBoatId: activeBoatId() }).catch(() => 'pending');
        await uploader.cycle().catch(() => 'unreachable');
        await afterCycle().catch(() => undefined);
    };
    const schedule = (delayMs: number) => {
        if (active !== state) return;
        state.timer = setTimeout(() => {
            void run().finally(() => schedule(uploader.nextDelayMs()));
        }, delayMs);
    };
    const onVisible = () => {
        if (document.visibilityState !== 'visible' || active !== state) return;
        if (state.timer) clearTimeout(state.timer);
        schedule(5_000);
    };
    state.stop = () => {
        if (state.timer) clearTimeout(state.timer);
        document.removeEventListener('visibilitychange', onVisible);
    };
    active = state;
    document.addEventListener('visibilitychange', onVisible);
    schedule(30_000);
}

export function stopSeabedUploader(): void {
    active?.stop();
    active = null;
}
