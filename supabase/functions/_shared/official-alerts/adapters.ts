/**
 * One adapter per issuer of official warnings (129-05). Each reads its issuer's
 * own feed and returns NormalizedAlerts (normalize.ts); ingest.ts decides what
 * to write. An adapter runs only for a provider whose licence flag is on
 * (official_alert_providers.enabled); ingest.ts never calls one for a provider
 * that is off.
 *
 * - nws: api.weather.gov/alerts/active (GeoJSON, CAP fields), a snapshot of
 *   every alert in force. Conditional GET on the ETag. Zone-based alerts
 *   (most marine ones: Small Craft Advisory, Gale Warning) carry no polygon,
 *   only affectedZones; the zone shapes are loaded from api.weather.gov a few
 *   per run (ingest.ts). NWS lists an alert until the later of its CAP
 *   expires and its ends (36 of 224 on 13 Oct were past expires), so that is
 *   the stored expiry; and an Update names what it replaces, which NWS then
 *   stops listing (63 references that day, none to an alert still listed).
 * - meteoalarm: one country's legacy Atom feed (CAP fields inline), a
 *   snapshot; the full CAP (every language) is read once per identifier.
 *   Read on every run under MeteoAlarm's own terms (129-05b, ingest.ts):
 *   every new warning in the same run (four documents at a time, up to
 *   METEOALARM_MAX_DOCS), a feed that fails asked once more, never one that
 *   says to slow down (429, 503): that holds the whole host, every country,
 *   for the rest of the run, and as long as its Retry-After asks (HostHolds).
 *   A warning is placed by the EMMA_ID areas its full CAP and its Atom
 *   entries name (some countries send only NUTS3 or FIPS codes).
 * - jma: 気象庁防災情報XML (JMA disaster prevention XML, not CAP), from the
 *   PULL Atom feeds. Per office, the newest 気象警報・注意報（Ｈ２７） (VPWW54,
 *   municipalities) and 地方海上警報（Ｈ２８） (VPCU51, sea areas) are each a
 *   complete statement of what is in force there.
 * - eccc: Environment and Climate Change Canada's CAP files on the MSC
 *   Datamart (dd.weather.gc.ca), a stream: Update and Cancel retire the
 *   messages they reference. Files land minutes after the time in their
 *   name and the number after it is not in order, so each run lists back
 *   ECCC_LOOKBACK_MS and skips the files it has read by name.
 * - cap: any CAP feed (an Atom or RSS index of CAP documents, or one CAP
 *   document). Every such row starts OFF.
 */
import {
    type AtomEntry,
    type CapAlert,
    type CapInfo,
    capValue,
    child,
    childrenNamed,
    childText,
    parseAtom,
    parseCapAlert,
    parseXml,
    toIso,
    type XmlNode,
} from '../cap.ts';
import {
    type AlertDraft,
    capAreasGeometry,
    capZones,
    finishAlert,
    geoJsonToMultiPolygon,
    latestTime,
    type NormalizedAlert,
    type StoredInfo,
    storedInfo,
} from './normalize.ts';

export type AdapterName = 'nws' | 'meteoalarm' | 'jma' | 'eccc' | 'cap';

export interface Validators {
    etag?: string;
    lastModified?: string;
}

export type HttpResult =
    | { status: 'not-modified' }
    | { status: 'ok'; text: string; validators: Validators };

/** A GET that sends If-None-Match / If-Modified-Since when it has them, and throws on anything but 200/304. */
export interface Http {
    get(url: string, opts?: { validators?: Validators; accept?: string }): Promise<HttpResult>;
}

export interface ProviderRow {
    id: string;
    adapter: AdapterName;
    name: string;
    feedUrl: string | null;
    enabled: boolean;
    config: Record<string, unknown>;
    feedState: Record<string, unknown>;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    unavailableSince: string | null;
}

export interface Known {
    hash: string;
    /** Not withdrawn. */
    live: boolean;
    /** The stored expiry (official_alerts.expires_at): past it, the warning is not in force. */
    expiresAt: string | null;
}

export interface AdapterContext {
    provider: ProviderRow;
    known: Map<string, Known>;
    http: Http;
    nowMs: number;
    /** The most documents (CAP files, JMA reports) one run may fetch for this provider. */
    maxDocs: number;
    /**
     * Milliseconds left before this provider must stop starting requests (its
     * timeout, less the time kept for writing). An adapter that walks many
     * requests (ECCC) stops at zero and returns what it has, marked partial,
     * so the next run carries on from there instead of starting over.
     */
    timeLeft?: () => number;
    /** A pause before a retry; tests pass one that does not wait. */
    sleep?: (ms: number) => Promise<void>;
    /** Hosts that asked to slow down, shared by the whole run (ingest.ts); a fresh one when absent. */
    holds?: HostHolds;
}

/** A GET answered with something other than 200 or 304; `retryAfterMs` from its Retry-After, when it gave one. */
export class HttpError extends Error {
    constructor(readonly status: number, readonly retryAfterMs: number | null = null) {
        super(`HTTP ${status}`);
    }
}

/** The longest wait a Retry-After is taken for (a day): longer, the providers read "unavailable" all the same. */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

/** A Retry-After header (seconds, or an HTTP date) as milliseconds from `nowMs`, or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
    const v = value?.trim();
    if (!v) return null;
    const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - nowMs;
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : null;
}

/** The answer that asks a client to slow down: never retried, never worked around. */
export const isSlowDown = (err: unknown): boolean => err instanceof Error && /^HTTP (429|503)$/.test(err.message);

const hostOf = (url: string | null | undefined): string | null => {
    try {
        return url ? new URL(url).hostname : null;
    } catch {
        return null;
    }
};

/**
 * Hosts that asked Thalassa to slow down (HTTP 429 or 503), shared by every
 * provider in a run: MeteoAlarm's 39 feeds and their documents are one host,
 * feeds.meteoalarm.org, so one country told to slow down stops every
 * country's requests there for the rest of the run. A host that said how long
 * to wait (Retry-After) is left alone that long across runs too: ingest.ts
 * keeps the time in the provider's feed_state (holdUntil) and carries it into
 * the next run's holds.
 */
export class HostHolds {
    private readonly asked = new Set<string>();
    private readonly until = new Map<string, number>();
    constructor(private readonly nowMs: number) {}
    /** Whether nothing more may be asked of this URL's host now. */
    held(url: string | null | undefined): boolean {
        const host = hostOf(url);
        return !!host && (this.asked.has(host) || (this.until.get(host) ?? 0) > this.nowMs);
    }
    /** The host asked to slow down; for `retryAfterMs` more when it said how long. */
    hold(url: string, retryAfterMs: number | null = null): void {
        const host = hostOf(url);
        if (!host) return;
        this.asked.add(host);
        if (retryAfterMs && retryAfterMs > 0) this.carry(url, this.nowMs + Math.min(retryAfterMs, RETRY_AFTER_MAX_MS));
    }
    /** A wait an earlier run was asked for (feed_state.holdUntil, ISO or ms). */
    carry(url: string | null | undefined, untilAt: unknown): void {
        const host = hostOf(url);
        const ms = typeof untilAt === 'number' ? untilAt : typeof untilAt === 'string' ? Date.parse(untilAt) : NaN;
        if (!host || !Number.isFinite(ms) || ms <= this.nowMs) return;
        this.until.set(host, Math.max(this.until.get(host) ?? 0, Math.min(ms, this.nowMs + RETRY_AFTER_MAX_MS)));
    }
    /** Until when later runs must leave this URL's host alone (ms), or null. */
    untilFor(url: string | null | undefined): number | null {
        const host = hostOf(url);
        const ms = host ? this.until.get(host) : undefined;
        return ms !== undefined && ms > this.nowMs ? ms : null;
    }
}

export interface AdapterOutput {
    /** Nothing has changed at the issuer since the last run (every feed answered 304). */
    notModified: boolean;
    alerts: NormalizedAlert[];
    /**
     * Snapshot semantics. 'all': every live stored alert not in `present` has
     * been withdrawn by the issuer. prefixes: the same, only for identifiers
     * under those prefixes (one JMA office's report). null: a stream; only
     * `withdraw` retires anything.
     */
    snapshot: 'all' | { prefixes: string[] } | null;
    /** Identifiers in force in the snapshot this run, including ones not re-read (already stored). */
    present: Set<string>;
    /** Identifiers the issuer retired (Update or Cancel references). */
    withdraw: string[];
    /** The next validators and cursors. */
    feedState: Record<string, unknown>;
    /** Something in force could not be read this run; the provider is not a clean answer. */
    partial: string | null;
    /** Zone key to the issuer's URL for its shape, for zones the alerts name (NWS). */
    zoneUrls: Map<string, string>;
}

export interface ZoneShape {
    code: string;
    name: string | null;
    geometry: unknown;
}

export interface Adapter {
    run(ctx: AdapterContext): Promise<AdapterOutput>;
    /** The most documents one run may fetch, when the adapter needs more than ingest.ts's default. */
    maxDocs?: number;
    /** A zone document (GeoJSON Feature) as a shape, for adapters whose alerts name zones by URL. */
    parseZone?(text: string, code: string): ZoneShape | null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function validatorsFor(state: Record<string, unknown>, url: string): Validators | undefined {
    const all = asRecord(state.validators);
    const v = asRecord(all?.[url]);
    if (!v) return undefined;
    const out: Validators = {};
    if (typeof v.etag === 'string') out.etag = v.etag;
    if (typeof v.lastModified === 'string') out.lastModified = v.lastModified;
    return out;
}

const emptyOutput = (feedState: Record<string, unknown>): AdapterOutput => ({
    notModified: true,
    alerts: [],
    snapshot: null,
    present: new Set(),
    withdraw: [],
    feedState,
    partial: null,
    zoneUrls: new Map(),
});

/** Only https URLs on one of these hosts are ever fetched from a feed's own links. */
function onHost(url: string, hosts: readonly string[]): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && hosts.includes(u.hostname);
    } catch {
        return false;
    }
}

// ── CAP to a stored alert ──────────────────────────────────────────────

/**
 * A CAP Alert or Update as a draft: every info the issuer still has in force
 * (all of them, unless the provider says which are over), verbatim, with the
 * areas' polygons and circles as geometry and the accepted geocodes as zones.
 * Null when no info is in force.
 */
export function capDraft(
    cap: CapAlert,
    opts: { zone?: (valueName: string) => boolean; inForce?: (info: CapInfo) => boolean } = {},
): AlertDraft | null {
    const infos = cap.infos.filter(opts.inForce ?? (() => true));
    if (infos.length === 0) return null;
    const kept: CapAlert = { ...cap, infos };
    return {
        identifier: cap.identifier,
        sender: cap.sender,
        sentAt: cap.sent,
        msgType: cap.msgType === 'Update' ? 'Update' : 'Alert',
        status: cap.status,
        scope: cap.scope,
        references: cap.references.map((r) => r.identifier),
        infos: infos.map((i) => storedInfo(i)),
        zones: opts.zone ? capZones(kept, opts.zone) : [],
        geometry: capAreasGeometry(infos.flatMap((i) => i.areas)),
    };
}

// ── NWS ────────────────────────────────────────────────────────────────

export const NWS_ACTIVE = 'https://api.weather.gov/alerts/active?status=actual';
const NWS_ZONE_URL = /^https:\/\/api\.weather\.gov\/zones\/([a-z]+)\/([A-Z]{2}[CZ]\d{3})$/;

const nwsValues = (v: unknown): { valueName: string; value: string }[] => {
    const rec = asRecord(v);
    if (!rec) return [];
    const out: { valueName: string; value: string }[] = [];
    for (const [valueName, list] of Object.entries(rec)) {
        for (const value of Array.isArray(list) ? list : [list]) {
            if (typeof value === 'string' || typeof value === 'number') out.push({ valueName, value: String(value) });
        }
    }
    return out;
};

export interface NwsParsed {
    drafts: AlertDraft[];
    withdraw: string[];
    zoneUrls: Map<string, string>;
}

/** api.weather.gov's alerts GeoJSON, or null when it is not a FeatureCollection. */
export function parseNwsAlerts(body: unknown): NwsParsed | null {
    const fc = asRecord(body);
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null;
    const drafts: AlertDraft[] = [];
    const withdraw: string[] = [];
    const zoneUrls = new Map<string, string>();
    for (const feature of fc.features) {
        const p = asRecord(asRecord(feature)?.properties);
        if (!p) continue;
        const identifier = str(p.id) ?? str(p.identifier);
        const sent = str(p.sent);
        const status = str(p.status);
        const msgType = str(p.messageType);
        if (!identifier || !sent || !Number.isFinite(Date.parse(sent)) || status !== 'Actual') continue;
        const references = (Array.isArray(p.references) ? p.references : [])
            .map((r) => str(asRecord(r)?.identifier))
            .filter((r): r is string => r !== null);
        if (msgType === 'Cancel') {
            withdraw.push(...references);
            continue;
        }
        if (msgType !== 'Alert' && msgType !== 'Update') continue;
        // An Update replaces what it names: retired by name, never left to look like a mass drop.
        if (msgType === 'Update') withdraw.push(...references);
        const event = str(p.event);
        if (!event) continue;
        const zones: string[] = [];
        for (const url of strings(p.affectedZones)) {
            const m = NWS_ZONE_URL.exec(url);
            if (!m) continue;
            const key = `nws:${m[1]}:${m[2]}`;
            zones.push(key);
            zoneUrls.set(key, url);
        }
        if (zones.length === 0) {
            for (const ugc of strings(asRecord(p.geocode)?.UGC)) {
                if (/^[A-Z]{2}[CZ]\d{3}$/.test(ugc)) zones.push(`nws:${ugc[2] === 'C' ? 'county' : 'forecast'}:${ugc}`);
            }
        }
        const info: StoredInfo = {
            language: str(p.language) ?? 'en-US',
            category: str(p.category) ? [p.category as string] : [],
            event,
            urgency: str(p.urgency) ?? 'Unknown',
            severity: str(p.severity) ?? 'Unknown',
            certainty: str(p.certainty) ?? 'Unknown',
            effective: str(p.effective),
            onset: str(p.onset),
            expires: str(p.expires),
            ends: str(p.ends),
            senderName: str(p.senderName),
            headline: str(p.headline),
            description: str(p.description),
            instruction: str(p.instruction),
            web: str(p.web),
            contact: null,
            responseType: str(p.response) ? [p.response as string] : [],
            areaDesc: str(p.areaDesc) ? [p.areaDesc as string] : [],
            parameters: nwsValues(p.parameters),
            eventCodes: nwsValues(p.eventCode),
        };
        drafts.push({
            identifier,
            sender: str(p.sender),
            sentAt: sent,
            msgType,
            status,
            scope: str(p.scope),
            references,
            infos: [info],
            zones,
            geometry: geoJsonToMultiPolygon(asRecord(feature)?.geometry),
            // NWS keeps an alert in /alerts/active until its ends when that is later than its CAP expires.
            expiresAt: latestTime([info.expires, info.ends]),
        });
    }
    return { drafts, withdraw, zoneUrls };
}

/** One api.weather.gov zone (a GeoJSON Feature with its name). */
export function parseNwsZone(text: string, code: string): ZoneShape | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    const f = asRecord(body);
    if (!f || !geoJsonToMultiPolygon(f.geometry)) return null;
    return { code, name: str(asRecord(f.properties)?.name), geometry: f.geometry };
}

const nws: Adapter = {
    async run(ctx) {
        const url = ctx.provider.feedUrl ?? NWS_ACTIVE;
        if (!onHost(url, ['api.weather.gov'])) throw new Error('NWS feed must be on api.weather.gov');
        const res = await ctx.http.get(url, {
            validators: validatorsFor(ctx.provider.feedState, url),
            accept: 'application/geo+json',
        });
        if (res.status === 'not-modified') return emptyOutput(ctx.provider.feedState);
        let body: unknown;
        try {
            body = JSON.parse(res.text);
        } catch {
            throw new Error('NWS answered with something that is not JSON');
        }
        const parsed = parseNwsAlerts(body);
        if (!parsed) throw new Error('NWS answered without a FeatureCollection');
        const alerts = await Promise.all(parsed.drafts.map(finishAlert));
        return {
            notModified: false,
            alerts,
            snapshot: 'all',
            present: new Set(alerts.map((a) => a.identifier)),
            withdraw: parsed.withdraw,
            feedState: { ...ctx.provider.feedState, validators: { [url]: res.validators } },
            partial: null,
            zoneUrls: parsed.zoneUrls,
        };
    },
    parseZone: parseNwsZone,
};

// ── MeteoAlarm ─────────────────────────────────────────────────────────

const METEOALARM_HOSTS = ['feeds.meteoalarm.org'];
/** New warnings' documents read at once per country: a burst of a hundred is read in one run (rule 5). */
export const METEOALARM_DOC_CONCURRENCY = 4;
/** The most documents one country's run reads (MAX_DOCS_PER_RUN would leave a burst for later runs). */
export const METEOALARM_MAX_DOCS = 250;
/** A pause before a failed feed is asked once more. */
export const METEOALARM_RETRY_MS = 2_000;
/**
 * The Accept header for a full CAP document. feeds.meteoalarm.org answers
 * "406 Not Acceptable" to `application/cap+xml`, `application/xml` and
 * `text/xml` alone, and 200 (as text/xml) once any type is admitted: probed
 * 2026-10-14 with Thalassa's User-Agent on a Bulgarian and a German
 * document. So the CAP type is asked for first and any other accepted.
 */
export const METEOALARM_DOC_ACCEPT = 'application/cap+xml, application/xml;q=0.9, */*;q=0.8';
/** Failures worth one more ask in the same run: a gateway or network fault, never "slow down" (429, 503). */
const TRANSIENT = /^HTTP 50[024]$|timed out|aborted|network|connection|error sending request|fetch failed/i;
const EMMA_CODE = /^EMMA_ID:[A-Z]{2}\d{3,6}$/;

export interface MeteoAlarmListing {
    /** CAP identifier to the full CAP document's URL, for every Actual entry. */
    listed: Map<string, string>;
    /** CAP identifier to the latest cap:expires its entries give (ISO), or null when one gives none. */
    expires: Map<string, string | null>;
    /**
     * CAP identifier to the EMMA_ID areas its entries name ("EMMA_ID:BG002"):
     * the hub's own placement, from each entry's link
     * (https://meteoalarm.org?geocode=EMMA_ID:BG002) and its EMMA_ID geocodes.
     * Bulgaria and Romania send only NUTS3 codes, and Ireland's land warnings
     * FIPS codes, in the full CAP as well; the entries' links still name the
     * EMMA_ID area (14 Oct 2026), so their warnings can be placed.
     */
    zones: Map<string, Set<string>>;
}

/** The EMMA_ID areas one Atom entry names: its links' geocode and its own EMMA_ID geocodes. */
function entryEmmaIds(entry: AtomEntry): string[] {
    const out: string[] = [];
    for (const link of entry.links) {
        try {
            const code = new URL(link.href).searchParams.get('geocode');
            if (code && EMMA_CODE.test(code)) out.push(code);
        } catch {
            // Not a URL: nothing to place by.
        }
    }
    for (const g of childrenNamed(entry.node, 'geocode')) {
        const code = `${childText(g, 'valueName')}:${childText(g, 'value')}`;
        if (EMMA_CODE.test(code)) out.push(code);
    }
    return out;
}

/** A MeteoAlarm legacy Atom feed: the CAP identifiers in force and where each full CAP is. Null when not Atom. */
export function parseMeteoAlarmAtom(xml: string): MeteoAlarmListing | null {
    const feed = parseAtom(xml);
    if (!feed) return null;
    const listed = new Map<string, string>();
    const expires = new Map<string, string | null>();
    const zones = new Map<string, Set<string>>();
    for (const entry of feed.entries) {
        const identifier = childText(entry.node, 'identifier');
        const status = childText(entry.node, 'status');
        const link = entry.links.find((l) => l.type === 'application/cap+xml');
        if (!identifier || status !== 'Actual' || !link) continue;
        if (!listed.has(identifier)) listed.set(identifier, link.href);
        const until = toIso(childText(entry.node, 'expires'));
        const prior = expires.get(identifier);
        // One entry per area: the warning lasts until its latest area does, and one with no expiry keeps it open.
        expires.set(identifier, prior === null || !until ? null : latestTime([prior ?? null, until]));
        const named = zones.get(identifier) ?? new Set<string>();
        for (const code of entryEmmaIds(entry)) named.add(code);
        zones.set(identifier, named);
    }
    return { listed, expires, zones };
}

const meteoalarm: Adapter = {
    maxDocs: METEOALARM_MAX_DOCS,
    async run(ctx) {
        const url = ctx.provider.feedUrl;
        if (!url || !onHost(url, METEOALARM_HOSTS)) throw new Error('MeteoAlarm feed must be on feeds.meteoalarm.org');
        const timeLeft = ctx.timeLeft ?? (() => Infinity);
        const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const holds = ctx.holds ?? new HostHolds(ctx.nowMs);
        const waiting = () => new Error('waiting: feeds.meteoalarm.org asked to slow down');
        /** One GET; a 429 or 503 holds the whole host (every country) for the rest of the run. */
        const get = async (u: string, opts: { validators?: Validators; accept?: string }) => {
            try {
                return await ctx.http.get(u, opts);
            } catch (err) {
                if (isSlowDown(err)) holds.hold(u, err instanceof HttpError ? err.retryAfterMs : null);
                throw err;
            }
        };
        if (holds.held(url)) throw waiting();
        const ask = () => get(url, { validators: validatorsFor(ctx.provider.feedState, url) });
        let res: HttpResult;
        try {
            res = await ask();
        } catch (err) {
            // Once more, after a pause, for a gateway or network fault: a missed run would be 10 minutes.
            if (!TRANSIENT.test(err instanceof Error ? err.message : String(err)) || timeLeft() < 15_000) throw err;
            await sleep(METEOALARM_RETRY_MS);
            if (holds.held(url)) throw waiting();
            res = await ask();
        }
        if (res.status === 'not-modified') return emptyOutput(ctx.provider.feedState);
        const listing = parseMeteoAlarmAtom(res.text);
        if (!listing) throw new Error('MeteoAlarm answered with something that is not an Atom feed');
        const present = new Set(listing.listed.keys());
        // A warning the feed itself says is over is neither read nor stored (diffAlerts would drop it).
        const over = (id: string) => {
            const until = listing.expires.get(id);
            return !!until && Date.parse(until) <= ctx.nowMs;
        };
        const toRead = [...listing.listed].filter(([id]) => !ctx.known.get(id)?.live && !over(id));
        const alerts: NormalizedAlert[] = [];
        const withdraw: string[] = [];
        let unread = Math.max(0, toRead.length - ctx.maxDocs);
        const queue = toRead.slice(0, ctx.maxDocs);
        const readOne = async ([identifier, capUrl]: [string, string]) => {
            // Asked to slow down (by this country's reads or another's): nothing more this run, never a workaround.
            if (!onHost(capUrl, METEOALARM_HOSTS) || holds.held(capUrl) || timeLeft() <= 0) {
                unread++;
                return;
            }
            try {
                const doc = await get(capUrl, { accept: METEOALARM_DOC_ACCEPT });
                const cap = doc.status === 'ok' ? parseCapAlert(doc.text) : null;
                if (!cap || cap.identifier !== identifier) {
                    unread++;
                    return;
                }
                withdraw.push(...cap.references.map((r) => r.identifier));
                const draft = cap.msgType === 'Cancel' ? null : capDraft(cap, { zone: (n) => n === 'EMMA_ID' });
                if (draft) {
                    // The areas the hub's own entries name too: a NUTS3- or FIPS-only document is still placed.
                    draft.zones = [...draft.zones, ...(listing.zones.get(identifier) ?? [])];
                    alerts.push(await finishAlert(draft));
                } else present.delete(identifier);
            } catch {
                unread++;
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(METEOALARM_DOC_CONCURRENCY, queue.length) }, async () => {
                for (let next = queue.shift(); next; next = queue.shift()) await readOne(next);
            }),
        );
        // In the feed's order, however the reads finished.
        const order = new Map(toRead.map(([id], i) => [id, i]));
        alerts.sort((a, b) => (order.get(a.identifier) ?? 0) - (order.get(b.identifier) ?? 0));
        return {
            notModified: false,
            alerts,
            snapshot: 'all',
            present,
            withdraw,
            feedState: { ...ctx.provider.feedState, validators: { [url]: res.validators } },
            partial: unread > 0 ? `${unread} MeteoAlarm warning${unread === 1 ? '' : 's'} not read yet` : null,
            zoneUrls: new Map(),
        };
    },
};

// ── JMA (気象庁防災情報XML) ──────────────────────────────────────────

const JMA_HOSTS = ['www.data.jma.go.jp'];
const JMA_FEED = 'https://www.data.jma.go.jp/developer/xml/feed/';
export const JMA_FEEDS = [
    { key: 'extra', url: `${JMA_FEED}extra.xml`, longUrl: `${JMA_FEED}extra_l.xml`, types: ['VPWW54'] },
    { key: 'other', url: `${JMA_FEED}other.xml`, longUrl: `${JMA_FEED}other_l.xml`, types: ['VPCU51'] },
] as const;
const JMA_DOC = /\/(\d{14})_(\d+)_([A-Z]{4}\d{2})_(\d{6})\.xml$/;
/** A JMA warning in force: anything but lifted (解除) or "no warning in force" (発表警報・注意報はなし). */
const JMA_NOT_IN_FORCE = new Set(['解除', '発表警報・注意報はなし']);

export interface JmaDocRef {
    key: string;
    type: string;
    office: string;
    url: string;
    entryId: string;
    stamp: string;
}

/** The newest report per office for the wanted types, from a JMA PULL Atom feed. Null when not Atom. */
export function jmaFeedDocs(
    xml: string,
    types: readonly string[],
): { docs: JmaDocRef[]; oldest: string | null } | null {
    const feed = parseAtom(xml);
    if (!feed) return null;
    const newest = new Map<string, JmaDocRef>();
    let oldest: string | null = null;
    for (const entry of feed.entries) {
        const href = entry.links.find((l) => JMA_DOC.test(l.href))?.href ?? entry.id ?? '';
        const m = JMA_DOC.exec(href);
        if (!m) continue;
        if (oldest === null || m[1] < oldest) oldest = m[1];
        if (!types.includes(m[3])) continue;
        const ref: JmaDocRef = {
            key: `${m[3]}:${m[4]}`,
            type: m[3],
            office: m[4],
            url: href,
            entryId: entry.id ?? href,
            stamp: `${m[1]}_${m[2]}`,
        };
        const prior = newest.get(ref.key);
        if (!prior || ref.stamp > prior.stamp) newest.set(ref.key, ref);
    }
    return { docs: [...newest.values()].sort((a, b) => a.stamp.localeCompare(b.stamp)), oldest };
}

/**
 * JMA's warning class as a CAP severity, an equivalent value (JMA's notes allow
 * converting a value to another system of the same meaning): 特別警報
 * (emergency warning) Extreme, 警報 (warning) Severe, 注意報 (advisory) Moderate.
 * The issuer's own name for the warning is kept verbatim as the event.
 */
export function jmaSeverity(kind: string): string {
    if (kind.endsWith('特別警報')) return 'Extreme';
    if (kind.endsWith('警報')) return 'Severe';
    return 'Moderate';
}

export interface JmaReport {
    /** The identifiers this report states the whole truth for: `jma:<type>:<office>:`. */
    prefix: string;
    drafts: AlertDraft[];
}

const jmaInfo = (
    fields: { event: string; headline: string | null; description: string | null; expires: string | null },
    report: { reported: string; office: string | null; areas: string[] },
): StoredInfo => ({
    language: 'ja-JP',
    category: ['Met'],
    event: fields.event,
    urgency: 'Unknown',
    severity: jmaSeverity(fields.event),
    certainty: 'Unknown',
    effective: report.reported,
    onset: null,
    expires: fields.expires,
    ends: null,
    senderName: report.office,
    headline: fields.headline,
    description: fields.description,
    instruction: null,
    web: 'https://www.jma.go.jp/bosai/warning/',
    contact: null,
    responseType: [],
    areaDesc: report.areas,
    parameters: [{ valueName: 'thalassa:severity', value: 'mapped from the JMA warning class (特別警報/警報/注意報)' }],
    eventCodes: [],
});

/**
 * One JMA report (VPWW54 or VPCU51) as the warnings it says are in force, one
 * per warning kind, each naming every area it covers. A cancelled report
 * (取消) or a report with nothing in force is an empty list under its
 * prefix, which retires the office's earlier warnings. Training and test
 * telegrams are null.
 */
export function parseJmaReport(xml: string, type: string, office: string): JmaReport | null {
    const root = parseXml(xml);
    if (!root || root.name !== 'Report') return null;
    const control = child(root, 'Control');
    const head = child(root, 'Head');
    const body = child(root, 'Body');
    if (!control || !head) return null;
    if (childText(control, 'Status') !== '通常') return null;
    const reported = toIso(childText(head, 'ReportDateTime'));
    if (!reported) return null;
    const prefix = `jma:${type}:${office}:`;
    const infoType = childText(head, 'InfoType');
    if (infoType === '取消') return { prefix, drafts: [] };
    if (!body) return null;
    const officeName = childText(control, 'PublishingOffice');
    const headline = childText(head, 'Title');
    const headlineText = childText(child(head, 'Headline'), 'Text');
    const validUntil = toIso(childText(head, 'ValidDateTime'));
    const byKind = new Map<string, { name: string; zones: Set<string>; areas: string[]; sentences: string[] }>();
    const add = (code: string, name: string, zone: string, area: string, sentence: string | null) => {
        const k = byKind.get(code) ?? { name, zones: new Set<string>(), areas: [], sentences: [] };
        k.zones.add(zone);
        if (area && !k.areas.includes(area)) k.areas.push(area);
        if (sentence && !k.sentences.includes(sentence)) k.sentences.push(sentence);
        byKind.set(code, k);
    };
    if (type === 'VPWW54') {
        const warning = childrenNamed(body, 'Warning').find((w) => w.attrs.type === '気象警報・注意報（市町村等）');
        if (!warning) return null;
        for (const item of childrenNamed(warning, 'Item')) {
            const area = child(item, 'Area');
            const code = childText(area, 'Code');
            if (!code) continue;
            for (const kind of childrenNamed(item, 'Kind')) {
                const name = childText(kind, 'Name');
                const kcode = childText(kind, 'Code');
                const status = childText(kind, 'Status');
                if (!name || !kcode || !status || JMA_NOT_IN_FORCE.has(status)) continue;
                add(kcode, name, `jma-city:${code}`, childText(area, 'Name') ?? '', null);
            }
        }
    } else if (type === 'VPCU51') {
        const warning = childrenNamed(body, 'Warning').find((w) => w.attrs.type === '地方海上警報');
        if (!warning) return null;
        for (const item of childrenNamed(warning, 'Item')) {
            const kinds = childrenNamed(item, 'Kind');
            const named = kinds.find((k) => childText(k, 'Name') && childText(k, 'Code'));
            const name = childText(named, 'Name');
            const kcode = childText(named, 'Code');
            if (!name || !kcode || name.endsWith('解除') || name.endsWith('なし')) continue;
            const sentences: string[] = [];
            for (const k of kinds) collectSentences(k, sentences);
            const areas = [...childrenNamed(item, 'Area'), ...childrenNamed(child(item, 'Areas'), 'Area')];
            for (const area of areas) {
                const code = childText(area, 'Code');
                if (!code) continue;
                add(kcode, name, `jma-sea:${code}`, childText(area, 'Name') ?? '', null);
            }
            for (const s of sentences) add(kcode, name, `jma-sea:${childText(areas[0], 'Code') ?? ''}`, '', s);
        }
    } else return null;
    const drafts: AlertDraft[] = [...byKind].map(([kcode, k]) => ({
        identifier: `${prefix}${kcode}`,
        sender: 'jma.go.jp',
        sentAt: reported,
        msgType: 'Alert',
        status: 'Actual',
        scope: 'Public',
        references: [],
        infos: [
            jmaInfo(
                {
                    event: k.name,
                    headline,
                    description: k.sentences.length > 0 ? k.sentences.join('\n') : headlineText,
                    expires: type === 'VPCU51' ? validUntil : null,
                },
                { reported, office: officeName, areas: k.areas },
            ),
        ],
        zones: [...k.zones].filter((z) => !z.endsWith(':')),
        geometry: null,
        expiresAt: type === 'VPCU51' ? validUntil : null,
    }));
    return { prefix, drafts };
}

function collectSentences(node: XmlNode, out: string[]): void {
    for (const c of node.children) {
        if (c.name === 'Sentence' && c.text && !out.includes(c.text)) out.push(c.text);
        else collectSentences(c, out);
    }
}

const jma: Adapter = {
    async run(ctx) {
        const state = ctx.provider.feedState;
        const docsDone = { ...(asRecord(state.docs) ?? {}) } as Record<string, string>;
        const newest = { ...(asRecord(state.newest) ?? {}) } as Record<string, string>;
        const bad = { ...(asRecord(state.bad) ?? {}) } as Record<string, string>;
        const validators = { ...(asRecord(state.validators) ?? {}) } as Record<string, Validators>;
        const pending: (JmaDocRef & { feed: string })[] = [];
        const newestSeen: Record<string, string> = {};
        let changed = false;
        for (const feed of JMA_FEEDS) {
            const res = await ctx.http.get(feed.url, { validators: validators[feed.url] });
            if (res.status === 'not-modified') continue;
            changed = true;
            validators[feed.url] = res.validators;
            let listed = jmaFeedDocs(res.text, feed.types);
            if (!listed) throw new Error(`JMA ${feed.key} feed is not Atom`);
            // The high-frequency feed holds at least the last 10 minutes (measured 2026-10-14: about nine
            // hours, ~200 entries). When its oldest entry is newer than the newest report already read (or
            // on the first run, or while reports are still waiting), reports may have been missed: read the
            // long feed (several days) instead.
            if (!newest[feed.key] || (listed.oldest !== null && listed.oldest > newest[feed.key])) {
                const long = await ctx.http.get(feed.longUrl);
                if (long.status !== 'ok') throw new Error(`JMA ${feed.key} long feed did not answer`);
                listed = jmaFeedDocs(long.text, feed.types);
                if (!listed) throw new Error(`JMA ${feed.key} long feed is not Atom`);
            }
            for (const doc of listed.docs) {
                if (docsDone[doc.key] === doc.entryId || bad[doc.key] === doc.entryId) continue;
                if (!onHost(doc.url, JMA_HOSTS)) continue;
                pending.push({ ...doc, feed: feed.key });
            }
            const stamps = listed.docs.map((d) => d.stamp.slice(0, 14)).sort();
            if (stamps.length > 0) newestSeen[feed.key] = stamps[stamps.length - 1];
        }
        if (!changed) return emptyOutput(state);
        const alerts: NormalizedAlert[] = [];
        const prefixes: string[] = [];
        let unread = Math.max(0, pending.length - ctx.maxDocs);
        const waiting = new Set(pending.slice(ctx.maxDocs).map((d) => d.feed));
        for (const doc of pending.slice(0, ctx.maxDocs)) {
            let res: HttpResult;
            try {
                res = await ctx.http.get(doc.url);
            } catch {
                unread++;
                waiting.add(doc.feed);
                continue; // fetched again next run
            }
            const report = res.status === 'ok' ? parseJmaReport(res.text, doc.type, doc.office) : null;
            if (!report) {
                bad[doc.key] = doc.entryId; // this office's state is unknown until JMA sends a newer report
                continue;
            }
            delete bad[doc.key];
            docsDone[doc.key] = doc.entryId;
            prefixes.push(report.prefix);
            for (const d of report.drafts) alerts.push(await finishAlert(d));
        }
        // A feed's high-water mark moves only once every report it listed has been read, so a report
        // left waiting is found again (in the long feed if need be), never skipped.
        for (const [key, stamp] of Object.entries(newestSeen)) {
            if (!waiting.has(key) && (!newest[key] || stamp > newest[key])) newest[key] = stamp;
        }
        const badCount = Object.keys(bad).length;
        const partial = [
            unread > 0 ? `${unread} JMA report${unread === 1 ? '' : 's'} not read yet` : '',
            badCount > 0 ? `${badCount} JMA office report${badCount === 1 ? '' : 's'} could not be read` : '',
        ].filter(Boolean).join('; ');
        return {
            notModified: false,
            alerts,
            snapshot: { prefixes },
            present: new Set(alerts.map((a) => a.identifier)),
            withdraw: [],
            feedState: { ...state, docs: docsDone, newest, bad, validators },
            partial: partial || null,
            zoneUrls: new Map(),
        };
    },
};

// ── ECCC (MSC Datamart CAP) ─────────────────────────────────────────────

const ECCC_HOSTS = ['dd.weather.gc.ca'];
const ECCC_FILE = /^T_[A-Z0-9]+_C_([A-Z]{4})_(\d{12})_(\d+)\.cap$/;
/** ECCC marks an area set whose alert is over in its Alert_Location_Status parameter. */
const ECCC_OVER = new Set(['ended', 'cancelled', 'expired', 'terminé', 'annulé']);
const BACKFILL_MS = 24 * 3_600_000;
/**
 * Each run lists this far back before where it last finished and skips the
 * files it has read by name: files land minutes after the time in their name
 * (13 Oct: the 18:24 file landed 18:28, the 18:26 one 18:29), and the number
 * after the time is not in order, so neither the name nor the time is a cursor.
 */
export const ECCC_LOOKBACK_MS = 60 * 60_000;
/** Directory listings one run may fetch (CAP files are capped by maxDocs). A first run's backfill takes several. */
export const ECCC_MAX_LISTINGS = 60;
/** An identifier an Update or Cancel retired is remembered this long, so a file that lands late never revives it. */
const RETIRED_KEEP_MS = 6 * 3_600_000;
/**
 * Ceilings on the names and identifiers kept (the newest are kept), so
 * feed_state stays well inside its 256 KiB check. A name dropped early is at
 * worst read again, which writes nothing.
 */
const SEEN_MAX = 2000;
const RETIRED_MAX = 1500;

/** An Apache directory listing's entries (name and "YYYY-MM-DD HH:MM" UTC), or null when it is not one. */
export function parseDirectoryListing(html: string): { name: string; modified: string }[] | null {
    if (!/Index of \//.test(html)) return null;
    const out: { name: string; modified: string }[] = [];
    for (const m of html.matchAll(/<a href="([^"?/][^"]*)">[^<]*<\/a>\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g)) {
        out.push({ name: m[1], modified: m[2] });
    }
    return out;
}

/** True when an ECCC info's own status parameter says its alert is over for those areas. */
export function ecccInfoOver(info: CapInfo): boolean {
    for (const p of info.parameters) {
        if (/Alert_Location_Status$/.test(p.valueName) && ECCC_OVER.has(p.value.trim().toLowerCase())) return true;
    }
    return false;
}

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
/** YYYYMMDDHHMM, UTC: the time in an ECCC file name. */
const minuteOf = (ms: number): string => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 12);
const msOfMinute = (m: string): number =>
    Date.parse(`${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}T${m.slice(8, 10)}:${m.slice(10, 12)}:00Z`);

/**
 * The Datamart's CAP files, office by office, oldest first.
 *
 * feed_state.soft (rewritten only with another change or the status
 * heartbeat, never on its own: ingest.ts leaves it out of the comparison):
 *   listedTo  per office, the minute up to which every file has been listed
 *             and read (the run's time once an office is done; the end of the
 *             last whole hour when it stopped part way);
 *   seen      the files read that a re-list could still find;
 *   retired   identifiers Updates and Cancels retired, with the time of the
 *             file that retired them.
 * Reading a file twice is harmless (an unchanged alert is not rewritten, a
 * retired one is not revived), so soft state that is a run or two behind
 * costs a GET, never a write. feed_state.bad holds files that could not be
 * read, for a day.
 */
const eccc: Adapter = {
    async run(ctx) {
        const base = ctx.provider.feedUrl ?? 'https://dd.weather.gc.ca/';
        if (!onHost(base, ECCC_HOSTS)) throw new Error('ECCC feed must be on dd.weather.gc.ca');
        const state = ctx.provider.feedState;
        const softIn = asRecord(state.soft) ?? {};
        const listedTo = { ...(asRecord(softIn.listedTo) ?? {}) } as Record<string, string>;
        const seen = new Set(strings(softIn.seen));
        const retired = { ...(asRecord(softIn.retired) ?? {}) } as Record<string, string>;
        const bad = { ...(asRecord(state.bad) ?? {}) } as Record<string, string>;
        const timeLeft = ctx.timeLeft ?? (() => Infinity);
        const nowMinute = minuteOf(ctx.nowMs);
        const floor = minuteOf(ctx.nowMs - BACKFILL_MS);
        const listFromFor = (to: Record<string, string>, office: string): string => {
            const at = to[office];
            const from = at ? minuteOf(msOfMinute(at) - ECCC_LOOKBACK_MS) : floor;
            return from > floor ? from : floor;
        };
        const listFrom = (office: string) => listFromFor(listedTo, office);
        const today = ymd(ctx.nowMs);
        const sinceMidnight = ctx.nowMs - msOfMinute(`${today}0000`);
        // Yesterday's directory: on the first run (the backfill), while any office's window reaches back
        // into yesterday, and for two hours after 00 UTC, when a file named before midnight can still land.
        // (An office first seen after the first run starts from the days listed that run.)
        const offices = Object.keys(listedTo);
        const days = offices.length === 0 || offices.some((o) => listFrom(o) < `${today}0000`) ||
                sinceMidnight < 2 * 3_600_000
            ? [ymd(ctx.nowMs - 86_400_000), today]
            : [today];

        let listings = 0;
        let read = 0;
        const canList = () => listings < ECCC_MAX_LISTINGS && timeLeft() > 0;
        const canRead = () => read < ctx.maxDocs && timeLeft() > 0;
        const list = async (url: string, what: string) => {
            listings++;
            const res = await ctx.http.get(url);
            const entries = res.status === 'ok' ? parseDirectoryListing(res.text) : [];
            if (!entries) throw new Error(`ECCC ${what} listing is not a directory index`);
            return entries;
        };

        const alerts = new Map<string, NormalizedAlert>();
        const withdraw = new Set<string>();
        /** Per office this run: how far it got (the end of its last whole hour), and whether it stopped. */
        const progress = new Map<string, { to: string | null; stopped: boolean }>();
        const listedDays = new Set<string>();
        let waiting = 0;
        let fresh = 0;
        let failed = 0;

        const readFile = async (f: { office: string; minute: string; name: string; url: string }) => {
            const res = await ctx.http.get(f.url, { accept: 'application/cap+xml' });
            seen.add(f.name);
            const cap = res.status === 'ok' ? parseCapAlert(res.text) : null;
            if (!cap) {
                bad[f.name] = f.office;
                return;
            }
            if (cap.status !== 'Actual') return;
            for (const r of cap.references) {
                withdraw.add(r.identifier);
                alerts.delete(r.identifier);
                retired[r.identifier] = f.minute;
            }
            if (cap.msgType === 'Cancel') return;
            // Already retired by a newer message read first (this file landed late), or withdrawn: never revived.
            const prior = ctx.known.get(cap.identifier);
            if (retired[cap.identifier] || (prior && !prior.live)) return;
            const draft = capDraft(cap, {
                zone: (n) => n === 'layer:EC-MSC-SMC:1.0:CLC',
                inForce: (i) => !ecccInfoOver(i),
            });
            if (draft) {
                alerts.set(cap.identifier, await finishAlert(draft));
                withdraw.delete(cap.identifier);
            } else withdraw.add(cap.identifier);
        };

        for (const day of days) {
            if (!canList()) break;
            const dayUrl = new URL(`${day}/WXO-DD/alerts/cap/${day}/`, base).href;
            let entries: { name: string; modified: string }[];
            try {
                entries = await list(dayUrl, 'day');
            } catch (err) {
                // Yesterday that has rolled off, or today before its first file, answers 404; anything else is real.
                const missing = String(err).includes('404');
                if (missing && (day !== today || sinceMidnight < 3_600_000)) {
                    listedDays.add(day);
                    continue;
                }
                throw err;
            }
            listedDays.add(day);
            for (const office of entries.filter((e) => /^[A-Z]{4}\/$/.test(e.name)).map((e) => e.name.slice(0, 4))) {
                const from = listFrom(office);
                if (`${day}2359` < from) continue; // all of this day is before the office's window
                const p = progress.get(office) ?? { to: null, stopped: false };
                progress.set(office, p);
                if (p.stopped) continue; // later files wait until the earlier ones are read
                if (!canList()) {
                    p.stopped = true;
                    continue;
                }
                const officeUrl = new URL(`${office}/`, dayUrl).href;
                let hours: string[];
                try {
                    hours = (await list(officeUrl, 'office'))
                        .filter((e) => /^\d{2}\/$/.test(e.name))
                        .map((e) => e.name.slice(0, 2))
                        .sort();
                } catch {
                    // This office waits for the next run; the others carry on.
                    failed++;
                    p.stopped = true;
                    continue;
                }
                for (const hh of hours) {
                    if (`${day}${hh}59` < from) continue;
                    if (!canList()) {
                        p.stopped = true;
                        break;
                    }
                    const hourUrl = new URL(`${hh}/`, officeUrl).href;
                    let entries: { name: string; modified: string }[];
                    try {
                        entries = await list(hourUrl, 'hour');
                    } catch {
                        failed++;
                        p.stopped = true;
                        break;
                    }
                    const files = entries
                        .map((e) => ({ e, m: ECCC_FILE.exec(e.name) }))
                        .filter(({ m, e }) => m && m[1] === office && m[2] >= from && !seen.has(e.name))
                        .map(({ e, m }) => ({
                            office,
                            minute: m![2],
                            name: e.name,
                            url: new URL(e.name, hourUrl).href,
                        }))
                        .sort((a, b) => a.minute.localeCompare(b.minute) || a.name.localeCompare(b.name));
                    fresh += files.length;
                    for (const [i, f] of files.entries()) {
                        if (!canRead()) {
                            p.stopped = true;
                        } else {
                            read++;
                            try {
                                await readFile(f);
                            } catch {
                                p.stopped = true; // read again next run, and nothing after it from this office
                            }
                        }
                        if (p.stopped) {
                            waiting += files.length - i;
                            break;
                        }
                    }
                    if (p.stopped) break;
                    p.to = `${day}${hh}59`;
                }
            }
        }

        // Where each office is listed to now. Done (every day listed, nothing left waiting): this run's time.
        const allDays = days.every((d) => listedDays.has(d));
        const nextTo = { ...listedTo };
        for (const [office, p] of progress) {
            if (!p.stopped && allDays) nextTo[office] = nowMinute;
            else if (p.to && (!nextTo[office] || p.to > nextTo[office])) nextTo[office] = p.to;
        }
        // An office with nothing in the days listed has nothing new.
        if (allDays) { for (const office of offices) if (!progress.has(office)) nextTo[office] = nowMinute; }
        // Names older than every window that could list them again are dropped.
        for (const name of seen) {
            const m = ECCC_FILE.exec(name);
            if (!m || m[2] < listFromFor(nextTo, m[1])) seen.delete(name);
        }
        const keepRetired = minuteOf(ctx.nowMs - RETIRED_KEEP_MS);
        for (const [id, at] of Object.entries(retired)) if (at < keepRetired) delete retired[id];
        const minuteOfName = (name: string) => ECCC_FILE.exec(name)?.[2] ?? '';
        const seenKept = [...seen]
            .sort((a, b) => minuteOfName(b).localeCompare(minuteOfName(a)) || a.localeCompare(b))
            .slice(0, SEEN_MAX)
            .sort();
        const retiredKept = Object.fromEntries(
            Object.entries(retired)
                .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
                .slice(0, RETIRED_MAX),
        );
        // An unreadable file stays a reason for doubt for a day: what it said is unknown.
        for (const name of Object.keys(bad)) {
            const m = ECCC_FILE.exec(name);
            if (!m || m[2] < floor) delete bad[name];
        }
        const behind = !allDays || [...progress.values()].some((p) => p.stopped);
        const badCount = Object.keys(bad).length;
        const partial = [
            waiting > 0
                ? `catching up: ${waiting} ECCC CAP file${waiting === 1 ? '' : 's'} not read yet`
                : behind && failed === 0
                ? 'catching up: ECCC listings not finished this run'
                : '',
            failed > 0 ? `${failed} ECCC director${failed === 1 ? 'y' : 'ies'} could not be listed` : '',
            badCount > 0 ? `${badCount} ECCC CAP file${badCount === 1 ? '' : 's'} could not be read` : '',
        ].filter(Boolean).join('; ');
        return {
            notModified: fresh === 0 && !behind,
            alerts: [...alerts.values()],
            snapshot: null,
            present: new Set(alerts.keys()),
            withdraw: [...withdraw],
            feedState: {
                ...state,
                soft: { listedTo: nextTo, seen: seenKept, retired: retiredKept },
                bad,
            },
            partial: partial || null,
            zoneUrls: new Map(),
        };
    },
};

// ── Any CAP feed ────────────────────────────────────────────────────────

/** The CAP document links an Atom or RSS index lists, in order. Null when the document is neither. */
export function capIndexLinks(root: XmlNode): string[] | null {
    if (root.name === 'feed') {
        const feed = parseAtom(root);
        if (!feed) return null;
        return feed.entries
            .map((e: AtomEntry) =>
                (e.links.find((l) => l.type === 'application/cap+xml') ??
                    e.links.find((l) => l.rel === 'alternate' || l.rel === null))?.href ?? ''
            )
            .filter(Boolean);
    }
    if (root.name === 'rss') {
        return childrenNamed(child(root, 'channel'), 'item')
            .map((item) => childText(item, 'link') ?? '')
            .filter(Boolean);
    }
    return null;
}

const capFeed: Adapter = {
    async run(ctx) {
        const url = ctx.provider.feedUrl;
        if (!url) throw new Error('no feed URL configured for this CAP provider');
        const host = new URL(url).hostname;
        const hosts = [host, ...strings(ctx.provider.config.allowHosts)];
        if (!onHost(url, hosts)) throw new Error('CAP feed must be https');
        const res = await ctx.http.get(url, { validators: validatorsFor(ctx.provider.feedState, url) });
        if (res.status === 'not-modified') return emptyOutput(ctx.provider.feedState);
        const root = parseXml(res.text);
        if (!root) throw new Error('CAP feed is not XML');
        const seen = { ...(asRecord(ctx.provider.feedState.seen) ?? {}) } as Record<string, string>;
        // One alert per identifier, the newest message: an index can list one document, or one identifier,
        // twice (MeteoAlarm-style indexes list an entry per area), and one apply cannot write a row twice.
        const byId = new Map<string, NormalizedAlert>();
        const newest = new Map<string, number>();
        const withdraw: string[] = [];
        const present = new Set<string>();
        let unread = 0;
        const take = async (cap: CapAlert | null): Promise<string | null> => {
            if (!cap || cap.status !== 'Actual') return null;
            withdraw.push(...cap.references.map((r) => r.identifier));
            const draft = cap.msgType === 'Cancel' ? null : capDraft(cap, { zone: () => true });
            if (!draft) return null;
            const known = ctx.known.get(cap.identifier);
            const alert = await finishAlert(draft);
            const sent = Date.parse(alert.sentAt);
            present.add(cap.identifier);
            if ((newest.get(cap.identifier) ?? -Infinity) > sent) return cap.identifier; // an older copy
            newest.set(cap.identifier, sent);
            if (!known || known.hash !== alert.contentHash || !known.live) byId.set(cap.identifier, alert);
            else byId.delete(cap.identifier); // the newest copy is the one already stored
            return cap.identifier;
        };
        if (root.name === 'alert') {
            await take(parseCapAlert(root));
        } else {
            const links = capIndexLinks(root);
            if (!links) throw new Error('CAP feed is neither a CAP alert nor an Atom or RSS index');
            const next: Record<string, string> = {};
            let fetched = 0;
            for (const abs of new Set(links.map((link) => new URL(link, url).href))) {
                if (!onHost(abs, hosts)) continue;
                if (seen[abs]) {
                    next[abs] = seen[abs];
                    present.add(seen[abs]);
                    continue;
                }
                if (fetched >= ctx.maxDocs) {
                    unread++;
                    continue;
                }
                fetched++;
                try {
                    const doc = await ctx.http.get(abs, { accept: 'application/cap+xml' });
                    const id = doc.status === 'ok' ? await take(parseCapAlert(doc.text)) : null;
                    if (id) next[abs] = id;
                    else unread++;
                } catch {
                    unread++;
                }
            }
            for (const k of Object.keys(seen)) delete seen[k];
            Object.assign(seen, next);
        }
        return {
            notModified: false,
            alerts: [...byId.values()],
            snapshot: ctx.provider.config.snapshot === false ? null : 'all',
            present,
            withdraw,
            feedState: { ...ctx.provider.feedState, seen, validators: { [url]: res.validators } },
            partial: unread > 0 ? `${unread} CAP document${unread === 1 ? '' : 's'} not read yet` : null,
            zoneUrls: new Map(),
        };
    },
};

export const ADAPTERS: Record<AdapterName, Adapter> = { nws, meteoalarm, jma, eccc, cap: capFeed };

/** For a reader: the value of a CAP parameter by name across a stored info. */
export const storedParameter = (info: StoredInfo, name: string): string | null => capValue(info.parameters, name);
