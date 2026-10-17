import { type PiRelayIdentity, readRelayCredential, type RelayAuthFailure } from '../_shared/pi-relay-auth.ts';
import {
    INTERNET_AIS,
    type InternetAisRequest,
    internetAisRpcTarget,
    type InternetAisTarget,
    parseInternetAisRequest,
} from '../_shared/internetAis.ts';
import { jsonResponse } from '../_shared/http-security.ts';

export interface PiInternetAisReader {
    enabled(): boolean;
    now(): number;
    authenticate(
        credential: { relayId: string; token: string } | null,
        signal: AbortSignal,
    ): Promise<PiRelayIdentity | RelayAuthFailure>;
    deleted(ownerId: string, signal: AbortSignal): Promise<boolean>;
    quota(ownerId: string, signal: AbortSignal): Promise<boolean>;
    coverage(ownerId: string, request: InternetAisRequest, signal: AbortSignal): Promise<'held' | 'limited'>;
    query(request: InternetAisRequest, signal: AbortSignal): Promise<unknown[]>;
}
/** Scoped Pi credential, not a user JWT or service credential on the boat. Gateway JWT stays enabled. */
export function createPiInternetAisHandler(deps: PiInternetAisReader) {
    return async (req: Request): Promise<Response> => {
        if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405, { Allow: 'POST' });
        if (!deps.enabled()) return jsonResponse({ error: 'Internet AIS export is unavailable' }, 503);
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.signal.addEventListener('abort', abort, { once: true });
        if (req.signal.aborted) controller.abort();
        const timer = setTimeout(abort, 8_000);
        let rejectAbort: (() => void) | undefined;
        const expired = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(Error('Internet AIS request retired'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            if (controller.signal.aborted) rejectAbort();
        });
        const read = <T>(value: Promise<T>) => Promise.race([value, expired]);
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
            const credential = readRelayCredential(req, null);
            const owner = await read(deps.authenticate(credential, controller.signal));
            if ('status' in owner) return jsonResponse({ error: 'Pi relay is not authorised' }, owner.status);
            if (await read(deps.deleted(owner.ownerId, controller.signal))) {
                return jsonResponse({ error: 'Pi relay is not authorised' }, 401);
            }
            if (!(await read(deps.quota(owner.ownerId, controller.signal)))) {
                return jsonResponse({ error: 'Internet AIS request limit reached' }, 429, { 'Retry-After': '60' });
            }
            if (
                new URL(req.url).search ||
                req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !req.body ||
                Number(req.headers.get('content-length') || '0') > 512
            ) return jsonResponse({ error: 'Invalid AIS request' }, 400);
            reader = req.body.getReader();
            const parts: Uint8Array[] = [];
            let bytes = 0, chunks = 0;
            for (;;) {
                const { value, done } = await read(reader.read());
                if (done) break;
                if (!value?.byteLength || ++chunks > 32 || (bytes += value.byteLength) > 512) {
                    return jsonResponse({ error: 'Invalid AIS request' }, 400);
                }
                parts.push(value.slice());
            }
            const all = new Uint8Array(bytes);
            let offset = 0;
            for (const part of parts) {
                all.set(part, offset);
                offset += part.byteLength;
            }
            let input: unknown;
            try {
                input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
            } catch {
                return jsonResponse({ error: 'Invalid AIS request' }, 400);
            }
            const request = parseInternetAisRequest(input, deps.now());
            if (!request) return jsonResponse({ error: 'Invalid AIS request' }, 400);
            const coverage = await read(deps.coverage(owner.ownerId, request, controller.signal));
            let targets: InternetAisTarget[] = [], truncated = false;
            if (coverage !== 'held') {
                const rows = await read(deps.query(request, controller.signal));
                if (!Array.isArray(rows) || rows.length > INTERNET_AIS.targets) throw Error('AIS row bound');
                const selected = new Map<number, InternetAisTarget>();
                for (const row of rows) {
                    const target = internetAisRpcTarget(row, request, deps.now());
                    if (target && (!selected.has(target.mmsi) || selected.get(target.mmsi)!.at < target.at)) {
                        selected.set(target.mmsi, target);
                    }
                }
                targets = [...selected.values()].sort((a, b) => b.at - a.at);
                truncated = rows.length === INTERNET_AIS.targets;
            }
            const current = await read(deps.authenticate(credential, controller.signal));
            if ('status' in current) return jsonResponse({ error: 'Pi relay is not authorised' }, current.status);
            if (
                current.ownerId !== owner.ownerId || current.relayId !== owner.relayId ||
                await read(deps.deleted(owner.ownerId, controller.signal))
            ) return jsonResponse({ error: 'Pi relay is not authorised' }, 401);
            if (!parseInternetAisRequest(request, deps.now()) || controller.signal.aborted || req.signal.aborted) {
                throw Error('AIS request expired');
            }
            // Empty means no admitted recent observation, never an all-clear or complete coverage claim.
            targets = targets.filter((target) =>
                deps.now() - target.at <= INTERNET_AIS.maxAgeMs && target.at <= deps.now() + INTERNET_AIS.futureMs
            );
            const response = jsonResponse({ schema: 1, targets, coverage, truncated });
            if (
                new TextEncoder().encode(JSON.stringify({ schema: 1, targets, coverage, truncated })).byteLength >
                    INTERNET_AIS.bytes
            ) throw Error('AIS response bound');
            return response;
        } catch {
            return jsonResponse({ error: 'Internet AIS observations are unavailable' }, 503);
        } finally {
            clearTimeout(timer);
            req.signal.removeEventListener('abort', abort);
            if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
            controller.abort();
            void reader?.cancel().catch(() => undefined);
        }
    };
}
