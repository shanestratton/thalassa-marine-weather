import { createHash } from 'node:crypto';
import {
    INTERNET_AIS,
    internetAisClock,
    internetAisDelta,
    internetAisMmsi,
    internetAisSourceRef,
    parseInternetAisReply,
    type InternetAisRequest,
} from '../internetAisWire.js';
import { readWeatherPositionLeaf } from '../weatherPosition.js';

export interface InternetAisAuthority {
    key: string;
    relayId: string;
    token: string;
    anonKey: string;
}
export interface InternetAisFix {
    lat: number;
    lon: number;
    measuredAt: number;
    ownMmsi: number;
    sourceKey: string;
}
/** Actual paired configuration plus process-local ABA epoch, never a received JSON permission flag. */
export function internetAisAuthority(input: {
    enabled: boolean;
    reviewed: boolean;
    allowInternet: boolean;
    generation: number | null;
    credentials: { ownerId: string; relayId: string; token: string } | null;
    anonKey: string;
}): InternetAisAuthority | null {
    const c = input.credentials;
    if (
        !input.enabled ||
        !input.reviewed ||
        !input.allowInternet ||
        !Number.isSafeInteger(input.generation) ||
        input.generation! < 0 ||
        !c ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(c.ownerId) ||
        !/^[A-Za-z\d_-]{16,128}$/.test(c.relayId) ||
        !/^[a-f\d]{64}$/.test(c.token) ||
        !input.anonKey ||
        input.anonKey.length > 4096
    )
        return null;
    return {
        key: createHash('sha256')
            .update(JSON.stringify([1, c.ownerId, c.relayId, c.token, input.anonKey, input.generation]))
            .digest('hex'),
        relayId: c.relayId,
        token: c.token,
        anonKey: input.anonKey,
    };
}
export function internetAisFix(document: unknown, now: number): InternetAisFix | null {
    const selected = document as { navigation?: { position?: { $source?: unknown } } } | null;
    if (internetAisSourceRef(selected?.navigation?.position?.$source)) return null;
    const leaf = readWeatherPositionLeaf(document, now),
        doc = document as { uuid?: unknown; mmsi?: unknown } | null;
    const mmsi = typeof doc?.mmsi === 'string' && /^[1-9]\d{8}$/.test(doc.mmsi) ? Number(doc.mmsi) : doc?.mmsi;
    return leaf && internetAisMmsi(mmsi) && internetAisClock(leaf.position.at, now, INTERNET_AIS.fixAgeMs)
        ? {
              lat: leaf.position.lat,
              lon: leaf.position.lon,
              measuredAt: leaf.position.at,
              ownMmsi: mmsi,
              sourceKey: `${leaf.selfKey}:${leaf.sourceKey}`,
          }
        : null;
}
export class InternetAisPublisher {
    private key: string | null = null;
    private controller: AbortController | null = null;
    private busy = false;
    private closed = false;
    private sent = new Map<number, { at: number; provider: string }>();
    constructor(
        private readonly deps: {
            authority(): InternetAisAuthority | null;
            fix(signal: AbortSignal): Promise<InternetAisFix | null>;
            fetch(request: InternetAisRequest, authority: InternetAisAuthority, signal: AbortSignal): Promise<unknown>;
            emit(line: string, current: () => boolean): void;
            retire(): void;
            now?: () => number;
        },
    ) {}
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private authority() {
        try {
            return this.closed ? null : this.deps.authority();
        } catch {
            return null;
        }
    }
    refresh(): InternetAisAuthority | null {
        const authority = this.authority();
        if ((authority?.key ?? null) !== this.key) {
            this.key = authority?.key ?? null;
            this.controller?.abort();
            this.sent.clear();
            this.deps.retire();
        }
        return authority;
    }
    async poll(): Promise<void> {
        const authority = this.refresh();
        if (!authority || this.busy || this.closed) return;
        this.busy = true;
        const controller = new AbortController();
        this.controller = controller;
        const current = () =>
            !this.closed &&
            !controller.signal.aborted &&
            this.key === authority.key &&
            this.authority()?.key === authority.key;
        const abort = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(Error('AIS source retired')), { once: true });
        });
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
            const fix = await Promise.race([this.deps.fix(controller.signal), abort]);
            if (!fix || !current() || !internetAisClock(fix.measuredAt, this.now(), INTERNET_AIS.fixAgeMs)) return;
            const request: InternetAisRequest = {
                schema: 1,
                lat: fix.lat,
                lon: fix.lon,
                measuredAt: fix.measuredAt,
                ownMmsi: fix.ownMmsi,
                radiusNm: 25,
                limit: 100,
            };
            const raw = await Promise.race([this.deps.fetch(request, authority, controller.signal), abort]);
            if (!current()) return;
            const finalFix = await Promise.race([this.deps.fix(controller.signal), abort]);
            if (
                !finalFix ||
                finalFix.sourceKey !== fix.sourceKey ||
                finalFix.ownMmsi !== fix.ownMmsi ||
                !internetAisClock(finalFix.measuredAt, this.now(), INTERNET_AIS.fixAgeMs) ||
                !current()
            )
                return;
            const reply = parseInternetAisReply(raw, { ...request, lat: finalFix.lat, lon: finalFix.lon }, this.now());
            if (!reply || reply.coverage === 'held') return;
            let bytes = 0;
            const next = new Map<number, { at: number; provider: string }>();
            for (const target of reply.targets) {
                const last = this.sent.get(target.mmsi);
                if (last && last.at >= target.at) {
                    next.set(target.mmsi, last);
                    continue;
                }
                next.set(target.mmsi, { at: target.at, provider: target.provider });
                const delta = internetAisDelta(target, this.now());
                if (!delta) continue;
                const line = JSON.stringify(delta) + '\r\n';
                bytes += Buffer.byteLength(line);
                if (Buffer.byteLength(line) > 1024 || bytes > 65536) throw Error('AIS output bound');
                if (!current()) return;
                this.deps.emit(line, () => current() && internetAisClock(target.at, this.now()));
            }
            if (current()) this.sent = next;
        } catch {
            // No stored backlog or retry of a failed/retired response.
        } finally {
            clearTimeout(timer);
            if (this.controller === controller) this.controller = null;
            this.busy = false;
            controller.abort();
        }
    }
    close(): void {
        this.closed = true;
        this.refresh();
        this.controller?.abort();
    }
}
