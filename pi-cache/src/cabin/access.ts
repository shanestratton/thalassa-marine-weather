import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CABIN_VIEWER_HEADER = 'x-thalassa-cabin-viewer';
export const CABIN_CODE_TTL_MS = 10 * 60_000;
export const CABIN_SESSION_TTL_MS = 12 * 60 * 60_000;
export interface CabinCodeRecord {
    schema: 1;
    nonce: string;
    codeHash: string;
    issuedAt: number;
    expiresAt: number;
}
export interface CabinReadLease {
    isCurrent(): boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function validCabinCodeRecord(value: unknown, now: number): value is CabinCodeRecord {
    const record = value as CabinCodeRecord | null;
    return (
        !!record &&
        record.schema === 1 &&
        /^[a-f0-9]{32}$/.test(record.nonce) &&
        /^[a-f0-9]{64}$/.test(record.codeHash) &&
        Number.isSafeInteger(record.issuedAt) &&
        Number.isSafeInteger(record.expiresAt) &&
        record.issuedAt <= now + 5_000 &&
        record.issuedAt > 0 &&
        record.expiresAt > record.issuedAt &&
        record.expiresAt - record.issuedAt <= CABIN_CODE_TTL_MS
    );
}

/** Separate credential domain: it can read only the dedicated cabin listener. */
export class CabinAccess {
    private context: string | null = null;
    private generation = 0;
    private sessions = new Map<string, { generation: number; issuedAt: number; expiresAt: number }>();
    private attempts: number[] = [];
    private peers = new Map<string, number[]>();
    private closed = false;
    constructor(
        private readonly deps: {
            code(): CabinCodeRecord | null;
            /** Includes the actual process-local authority generation; never merely owner A's name. */
            context(): string | null;
            now?: () => number;
        },
    ) {}
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private refresh(): CabinCodeRecord | null {
        let record: CabinCodeRecord | null = null,
            context: string | null = null;
        try {
            record = this.deps.code();
            const owner = this.deps.context();
            if (!this.closed && owner && validCabinCodeRecord(record, this.now()))
                context = hash(owner + '|' + record.nonce);
        } catch {
            /* Missing/corrupt state has no read authority. */
        }
        if (context !== this.context) {
            this.context = context;
            this.generation++;
            this.sessions.clear();
        }
        for (const [key, session] of this.sessions) {
            if (session.expiresAt <= this.now() || session.issuedAt > this.now() + 5_000) this.sessions.delete(key);
        }
        return context ? record : null;
    }
    pair(code: unknown, peer: string): { token: string; expiresAt: number } | null {
        const record = this.refresh(),
            now = this.now();
        this.attempts = this.attempts.filter((at) => now - at < 60_000 && now >= at);
        const peerKey = hash(peer.slice(0, 128));
        const attempts = (this.peers.get(peerKey) ?? []).filter((at) => now - at < 60_000 && now >= at);
        if (this.attempts.length >= 30 || attempts.length >= 5) return null;
        if (!this.peers.has(peerKey) && this.peers.size >= 64) this.peers.delete(this.peers.keys().next().value!);
        attempts.push(now);
        this.peers.set(peerKey, attempts);
        this.attempts.push(now);
        if (
            !record ||
            record.expiresAt <= now ||
            typeof code !== 'string' ||
            !/^\d{8}$/.test(code) ||
            !same(hash(code), record.codeHash) ||
            this.sessions.size >= 8
        )
            return null;
        const token = 'cabin-' + randomBytes(32).toString('hex'),
            expiresAt = now + CABIN_SESSION_TTL_MS;
        this.sessions.set(hash(token), { generation: this.generation, issuedAt: now, expiresAt });
        return { token, expiresAt };
    }
    lease(value: unknown): CabinReadLease | null {
        this.refresh();
        if (!this.context || typeof value !== 'string' || !/^cabin-[a-f0-9]{64}$/.test(value)) return null;
        const key = hash(value),
            session = this.sessions.get(key),
            generation = this.generation;
        if (!session || session.generation !== generation) return null;
        return {
            isCurrent: () => {
                this.refresh();
                return !!this.context && generation === this.generation && this.sessions.get(key) === session;
            },
        };
    }
    close(): void {
        this.closed = true;
        this.refresh();
        this.sessions.clear();
    }
}
