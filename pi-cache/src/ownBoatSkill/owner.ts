/** Fresh owner proof for issuing/renewing a private Pi capability. No JWT persistence. */
import { outboundFetch, resolveTrustedSupabaseOrigin } from '../outboundHttp.js';
import { ownBoatClock, ownBoatLabel, ownBoatRecord, ownBoatUuid } from '../ownBoatSkillWire.js';
export interface VerifiedSkillOwner {
    ownerId: string;
    vesselId: string;
    vesselRevision: number;
    vesselName: string;
    verifiedAt: number;
}
// Only byte reads and cancellation are consumed. DOM and Node/undici streams
// expose these alike; unrelated pipeThrough overloads need not match.
export type SkillReplyReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel'>;
interface Reply {
    status: number;
    headers: { get(name: string): string | null };
    body: { getReader(): SkillReplyReader; cancel(): Promise<void> } | null;
}
export type SkillOwnerFetch = (
    url: string,
    init: {
        method: 'GET' | 'POST';
        headers: Record<string, string>;
        body?: string;
        signal: AbortSignal;
        redirect: 'error';
    },
) => Promise<Reply>;
export class SkillOwnerVerifier {
    private readonly origin: string;
    private unsettled = 0;
    private active = false;
    constructor(
        private readonly options: {
            trustedOrigin: string;
            anonKey: () => string;
            fetchImpl?: SkillOwnerFetch;
            now?: () => number;
            timeoutMs?: number;
        },
    ) {
        // Startup-owned allowlist; request bodies can never choose an origin.
        this.origin = resolveTrustedSupabaseOrigin(options.trustedOrigin);
    }
    async verify(
        token: unknown,
        ownerId: string,
        vesselId: string,
        current: () => boolean,
    ): Promise<VerifiedSkillOwner> {
        const started = (this.options.now ?? Date.now)(),
            anonKey = this.options.anonKey();
        if (
            !ownBoatClock(started) ||
            !ownBoatUuid(ownerId) ||
            !ownBoatUuid(vesselId) ||
            !current() ||
            typeof token !== 'string' ||
            token.length < 32 ||
            token.length > 12 * 1024 ||
            !/^[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+$/.test(token) ||
            !anonKey ||
            anonKey.length > 8192 ||
            /[\r\n]/.test(anonKey) ||
            this.active
        )
            throw Error('Owner verification unavailable');
        this.active = true;
        const abort = new AbortController();
        const timeoutMs = Math.min(10_000, Math.max(1, this.options.timeoutMs ?? 8000));
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                stopped = true;
                abort.abort();
                reject(Error('Owner verification deadline'));
            }, timeoutMs);
        });
        const check = () => {
            const now = (this.options.now ?? Date.now)();
            if (
                stopped ||
                abort.signal.aborted ||
                !current() ||
                this.options.anonKey() !== anonKey ||
                !ownBoatClock(now) ||
                now < started - 1000 ||
                now - started > timeoutMs
            )
                throw Error('Owner verification retired');
        };
        const read = async (path: '/auth/v1/user' | '/rest/v1/rpc/get_owned_vessel_fleet', limit: number) => {
            check();
            if (this.unsettled >= 2) throw Error('Owner verification capacity unavailable');
            this.unsettled++;
            let charged = true,
                finished = false,
                acquired: Reply | undefined;
            let reader: SkillReplyReader | undefined;
            const release = () => {
                if (charged) {
                    charged = false;
                    this.unsettled--;
                }
            };
            const cancel = () => {
                try {
                    const cleanup = reader ? reader.cancel() : acquired?.body?.cancel();
                    if (!cleanup) release();
                    else void cleanup.then(release, release);
                } catch {
                    release();
                }
            };
            let pending: Promise<Reply>;
            try {
                pending = Promise.resolve(
                    (this.options.fetchImpl ?? outboundFetch)(this.origin + path, {
                        method: path === '/auth/v1/user' ? 'GET' : 'POST',
                        headers: {
                            apikey: anonKey,
                            Authorization: 'Bearer ' + token,
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                        },
                        ...(path === '/auth/v1/user' ? {} : { body: '{}' }),
                        signal: abort.signal,
                        redirect: 'error',
                    }),
                );
            } catch (error) {
                release();
                throw error;
            }
            void pending.then((reply) => {
                acquired = reply;
                if (stopped || finished) cancel();
            }, release);
            try {
                const reply = await Promise.race([pending, expired]);
                check();
                if (
                    reply.status !== 200 ||
                    reply.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
                    !reply.body
                )
                    throw Error('Owner verification refused');
                reader = reply.body.getReader();
                const chunks: Uint8Array[] = [];
                let size = 0;
                for (;;) {
                    const part = await Promise.race([reader.read(), expired]);
                    check();
                    if (part.done) break;
                    size += part.value.byteLength;
                    if (size > limit) throw Error('Owner proof response too large');
                    chunks.push(part.value);
                }
                const all = new Uint8Array(size);
                let at = 0;
                for (const chunk of chunks) {
                    all.set(chunk, at);
                    at += chunk.length;
                }
                return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) as unknown;
            } finally {
                finished = true;
                // Capture every resolved response before acceptance; retirement
                // between resolve and assignment cannot leak its original body.
                if (acquired) cancel();
            }
        };
        try {
            const user = await read('/auth/v1/user', 64 * 1024);
            if (!ownBoatRecord(user) || user.id !== ownerId || user.deleted_at != null || user.banned_until != null)
                throw Error('Owner identity refused');
            const fleet = await read('/rest/v1/rpc/get_owned_vessel_fleet', 1024 * 1024);
            check();
            if (!ownBoatRecord(fleet) || !Array.isArray(fleet.vessels) || fleet.vessels.length > 5)
                throw Error('Owned vessel proof unavailable');
            const matches = fleet.vessels.filter((row) => ownBoatRecord(row) && row.id === vesselId);
            if (matches.length !== 1) throw Error('Owned vessel proof unavailable');
            const boat = matches[0];
            if (
                !ownBoatRecord(boat) ||
                boat.owner_id !== ownerId ||
                boat.archived_at !== null ||
                boat.released_at !== null ||
                !Number.isSafeInteger(boat.revision) ||
                Number(boat.revision) < 1 ||
                Number(boat.revision) > 2147483647 ||
                !ownBoatLabel(boat.name)
            )
                throw Error('Owned vessel proof refused');
            return {
                ownerId,
                vesselId,
                vesselRevision: Number(boat.revision),
                vesselName: boat.name,
                verifiedAt: started,
            };
        } finally {
            stopped = true;
            abort.abort();
            clearTimeout(timer);
            this.active = false;
        }
    }
}
