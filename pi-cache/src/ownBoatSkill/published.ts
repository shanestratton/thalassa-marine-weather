/** Reads existing own-server rows only; no subscriptions, paid fallback or uploads. */
import { outboundFetch, resolveTrustedSupabaseOrigin } from '../outboundHttp.js';
import { OWN_BOAT_MODELS, OWN_BOAT_SKILL, ownBoatClock, type OwnBoatModel } from '../ownBoatSkillWire.js';
import { decodeOwnWindForecast, type CapturedWindForecast } from './forecast.js';
import type { SkillOwnerFetch } from './owner.js';
export class OwnPublishedWindReader {
    private readonly origin: string;
    private pending = 0;
    constructor(
        private readonly options: {
            trustedOrigin: string;
            anonKey: () => string;
            fetchImpl?: SkillOwnerFetch;
            now?: () => number;
            timeoutMs?: number;
        },
    ) {
        this.origin = resolveTrustedSupabaseOrigin(options.trustedOrigin);
    }
    async read(
        model: OwnBoatModel,
        cell: string,
        parent: AbortSignal,
        current: () => boolean,
    ): Promise<CapturedWindForecast | null> {
        const started = (this.options.now ?? Date.now)(),
            key = this.options.anonKey();
        if (
            !OWN_BOAT_MODELS.includes(model) ||
            !/^-?\d{1,4}_-?\d{1,5}$/.test(cell) ||
            !ownBoatClock(started) ||
            !key ||
            key.length > 8192 ||
            /[\r\n]/.test(key) ||
            this.pending >= 2 ||
            parent.aborted ||
            !current()
        )
            throw Error('Private own-server forecast unavailable');
        const url = new URL('/rest/v1/wx_point_forecasts', this.origin);
        url.searchParams.set('select', 'payload,run_at');
        url.searchParams.set('cell_id', 'eq.' + cell);
        url.searchParams.set('model', 'eq.wx2:' + model);
        url.searchParams.set('limit', '1');
        const controller = new AbortController();
        const stop = () => controller.abort();
        parent.addEventListener('abort', stop, { once: true });
        const timeoutMs = Math.min(5000, Math.max(1, this.options.timeoutMs ?? 3000));
        const timer = setTimeout(stop, timeoutMs);
        let stopped = false,
            charged = true;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let response: Awaited<ReturnType<SkillOwnerFetch>> | undefined;
        const release = () => {
            if (charged) {
                charged = false;
                this.pending--;
            }
        };
        const cancel = () => {
            try {
                const p = reader ? reader.cancel() : response?.body?.cancel();
                if (p) void p.then(release, release);
                else release();
            } catch {
                release();
            }
        };
        let rejectAbort = () => {};
        const aborted = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(Error('Private forecast request retired'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
        });
        void aborted.catch(() => undefined);
        let transportStarted = false;
        const check = () => {
            const now = (this.options.now ?? Date.now)();
            if (
                stopped ||
                controller.signal.aborted ||
                parent.aborted ||
                !current() ||
                this.options.anonKey() !== key ||
                now < started - 1000 ||
                now - started > timeoutMs ||
                !ownBoatClock(now)
            )
                throw Error('Private forecast source retired');
        };
        this.pending++;
        try {
            check();
            let pending: ReturnType<SkillOwnerFetch>;
            try {
                pending = Promise.resolve(
                    (this.options.fetchImpl ?? outboundFetch)(url.href, {
                        method: 'GET',
                        headers: { apikey: key, Accept: 'application/json' },
                        signal: controller.signal,
                        redirect: 'error',
                    }),
                );
                transportStarted = true;
            } catch (error) {
                release();
                throw error;
            }
            void pending.then((v) => {
                response = v;
                if (stopped) cancel();
            }, release);
            const reply = await Promise.race([pending, aborted]);
            check();
            if (
                reply.status !== 200 ||
                reply.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
                !reply.body
            )
                throw Error('Private forecast HTTP unavailable');
            reader = reply.body.getReader();
            const chunks: Buffer[] = [];
            let size = 0;
            for (;;) {
                const part = await Promise.race([reader.read(), aborted]);
                check();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > OWN_BOAT_SKILL.forecastBytes) throw Error('Private forecast original byte limit');
                chunks.push(Buffer.from(part.value));
            }
            return decodeOwnWindForecast(Buffer.concat(chunks, size), model, cell, (this.options.now ?? Date.now)());
        } finally {
            stopped = true;
            controller.abort();
            clearTimeout(timer);
            parent.removeEventListener('abort', stop);
            controller.signal.removeEventListener('abort', rejectAbort);
            if (response) cancel();
            else if (!transportStarted) release();
            // A pending actual transport remains charged; its eventual original
            // body is captured/cancelled above even after caller retirement.
        }
    }
}
