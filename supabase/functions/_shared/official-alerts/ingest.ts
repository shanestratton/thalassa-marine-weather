/**
 * The official-warnings ingest (129-05): every provider whose licence flag is
 * on, every 5 minutes, writing only what changed.
 *
 * Write volume comes first (the project's Supabase Disk IO trouble was a
 * writer that rewrote unchanged rows):
 * - Conditional GET for every feed (createHttp). A 304 writes nothing.
 * - An alert is written only when it is new, its content hash moved, or it
 *   comes back after being withdrawn. A re-ingest of the same feed writes
 *   zero rows (tests/OfficialAlertsIngest.test.ts).
 * - Withdrawals (gone from a snapshot, or retired by an Update or Cancel) are
 *   one write each, once. A warning already past its own expiry is neither
 *   stored nor withdrawn: it is not shown, and the hourly prune removes it, so
 *   a feed that keeps listing one never makes a prune and re-insert loop.
 * - The provider's status row is written when its cursors or health change,
 *   and otherwise at most every HEARTBEAT_MS, so official_alerts_at() can
 *   tell a live provider from a stopped one (it reads one as stopped 30 min
 *   after its last success). Validators and feed_state.soft (ECCC's listing
 *   progress) alone never force a write; soft state rides along with any
 *   alert or zone write.
 * - A real-time provider (MeteoAlarm) is the exception: its last success is
 *   written on every successful run (REALTIME_HEARTBEAT_MS is under one run
 *   period), because official_alerts_at() reads it as stopped once that is
 *   REALTIME_LIVE_MS old. That is 39 one-row status writes a run (468 an
 *   hour) on a 45-row table whose updated columns carry no index.
 * - Nothing is written at all when nothing changed: the store is not called.
 *
 * Sharding and isolation: a run takes at most MAX_PER_RUN providers (the
 * rest by a fixed rotation of 5-minute slots, never by a written cursor),
 * runs CONCURRENCY at a time, and gives each PROVIDER_TIMEOUT_MS. A slow or
 * failing provider is recorded as unavailable and never blocks another. An
 * adapter that walks many requests stops APPLY_RESERVE_MS before its timeout
 * and writes what it has read, so a long backfill makes progress run by run.
 *
 * Real time (129-05b): MeteoAlarm's terms ask that a warning reach Thalassa's
 * readers on average in under 5 minutes and never in over 10. Its providers
 * are read on every run and never sharded, only the others share the slots,
 * and they are started first, so the run's budget reaches them before any
 * other. A feed that fails is asked once more in the same run (adapters.ts).
 * The 10 minutes are kept end to end by one rule: official_alerts_at() calls
 * a MeteoAlarm country "live" only while its last success (the start of the
 * run that read it, so no later than the read) is under REALTIME_LIVE_MS
 * (8 min) old, and the app shows an answer at most REALTIME_APP_MS (90 s)
 * after it was given (services/officialWarnings.ts, hooks/useOfficialWarnings.ts).
 * A warning missing from anything shown as live was therefore published
 * under 9.5 minutes before; once a country is older than that, the app says
 * it could not check, never an all-clear. A healthy run's last success is at
 * most one period plus the run's own time (RUN_BUDGET_MS + PROVIDER_TIMEOUT_MS,
 * 145 s) old, 7.4 minutes, so a healthy country never trips it. Measured
 * 2026-10-14: the 39 legacy
 * Atom feeds were 1.99 MB together (Switzerland 519 KB, Germany 338 KB; a
 * stormy day's Germany was 503 KB), 81 s one after another from Australia
 * (about 1.1 s to the first byte each), so about 15 s six at a time, and
 * parsing all 39 took 15 ms of CPU in Deno, far inside the edge runtime's 2 s
 * CPU and 150 s wall clock. A warning published just after a run starts waits
 * 5 minutes for the next; on average 2.5, plus the run's own seconds.
 * WebSub was weighed and not built: MeteoAlarm's feeds name Google's hub
 * (pubsubhubbub.appspot.com), which was pinged within a minute of a change on
 * 2026-10-14, but a hub sends only new entries and MeteoAlarm drops a
 * cancelled warning from its feed rather than publishing a Cancel, so a
 * 5-minute poll is needed for removals and the 10-minute guarantee anyway,
 * and WebSub would add a public endpoint, a shared secret and 39 leases to
 * renew for an average that the poll already keeps under 5 minutes.
 *
 * The mass-drop guard: a snapshot that would silently withdraw (no Update or
 * Cancel naming them) more than MASS_DROP_MIN warnings still in force, and
 * most of them, is refused, so a broken feed is never a mass false all-clear.
 * Warnings already past their expiry do not count. A refused run still writes
 * the new warnings the feed lists, and the provider reads "unavailable"; once
 * the feed has said the same for MASS_DROP_RELEASE_MS, it is believed.
 */
import type {
    Adapter,
    AdapterName,
    AdapterOutput,
    Http,
    HttpResult,
    Known,
    ProviderRow,
    Validators,
} from './adapters.ts';
import { ADAPTERS, HostHolds, HttpError, parseRetryAfter } from './adapters.ts';
import { canonicalJson, geoJsonToMultiPolygon, type NormalizedAlert, prepareGeometry } from './normalize.ts';

export const RUN_PERIOD_MS = 5 * 60_000;
export const MAX_PER_RUN = 24;
export const CONCURRENCY = 6;
export const PROVIDER_TIMEOUT_MS = 45_000;
/** No provider is started after this much of the run (the edge wall clock is 150 s; the cron waits 120 s). */
export const RUN_BUDGET_MS = 100_000;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_DOCS_PER_RUN = 40;
export const ZONES_PER_RUN = 25;
/** A healthy provider's status row is refreshed at least this often (4 writes an hour). */
export const HEARTBEAT_MS = 15 * 60_000;
/** A real-time provider's: every run (a period less a minute, so a run started a little early still writes). */
export const REALTIME_HEARTBEAT_MS = RUN_PERIOD_MS - 60_000;
/**
 * How old a real-time provider's last success may be while official_alerts_at()
 * calls it live (the held migration's interval '8 minutes' for adapter
 * 'meteoalarm'; tests/OfficialAlertsMigration.test.ts keeps them equal).
 */
export const REALTIME_LIVE_MS = 8 * 60_000;
/** The most an app shows a real-time answer after it was given: its 60 s refresh and 30 s cache. */
export const REALTIME_APP_MS = 90_000;
/** A snapshot that would withdraw more than this many alerts, and most of what is live, is refused. */
export const MASS_DROP_MIN = 50;
export const MASS_DROP_SHARE = 0.75;
/** A refusal that has held this long (the feed has said the same on every run since) is accepted. */
export const MASS_DROP_RELEASE_MS = 60 * 60_000;
/** Kept from each provider's time for writing what it read (at most a quarter of its time). */
export const APPLY_RESERVE_MS = 10_000;

export interface ProviderStatus {
    lastSuccessAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    unavailableSince: string | null;
    feedState: Record<string, unknown>;
}

export interface ZoneRow {
    code: string;
    name: string | null;
    /** Simplified MultiPolygon coordinates. */
    geometry: number[][][][];
    sourceUrl: string;
}

export interface ChangeSet {
    upserts: NormalizedAlert[];
    withdraw: string[];
    zones: ZoneRow[];
    status: ProviderStatus | null;
}

export interface AlertStore {
    providers(): Promise<ProviderRow[]>;
    /** Every stored alert of the provider (withdrawn ones too, until pruned): identifier to hash and liveness. */
    known(providerId: string): Promise<Map<string, Known>>;
    /** Which of these zone keys have no stored shape. */
    missingZones(providerId: string, keys: string[]): Promise<string[]>;
    /** One call, only when there is something to write. */
    apply(providerId: string, change: ChangeSet): Promise<void>;
}

export const writeCount = (c: ChangeSet): number =>
    c.upserts.length + c.withdraw.length + c.zones.length + (c.status ? 1 : 0);

/** A conditional-GET client: sends the validators it is given, says not-modified on 304, throws otherwise. */
export function createHttp(
    fetchImpl: typeof fetch,
    opts: { userAgent: string; timeoutMs?: number; maxBytes?: number },
): Http {
    return {
        async get(url, { validators, accept } = {}): Promise<HttpResult> {
            const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
            if (accept) headers.Accept = accept;
            if (validators?.etag) headers['If-None-Match'] = validators.etag;
            if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
            const res = await fetchImpl(url, {
                headers,
                redirect: 'error',
                signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
            });
            if (res.status === 304) {
                await res.body?.cancel();
                return { status: 'not-modified' };
            }
            if (res.status !== 200) {
                await res.body?.cancel();
                throw new HttpError(res.status, parseRetryAfter(res.headers.get('retry-after'), Date.now()));
            }
            const declared = Number(res.headers.get('content-length') ?? NaN);
            const max = opts.maxBytes ?? MAX_BODY_BYTES;
            if (Number.isFinite(declared) && declared > max) {
                await res.body?.cancel();
                throw new Error('response too large');
            }
            const text = await res.text();
            if (text.length > max) throw new Error('response too large');
            const next: Validators = {};
            const etag = res.headers.get('etag');
            const lastModified = res.headers.get('last-modified');
            if (etag) next.etag = etag;
            if (lastModified) next.lastModified = lastModified;
            return { status: 'ok', text, validators: next };
        },
    };
}

/** The feed state that must be kept (cursors, read reports); validators and soft state are excluded. */
const cursorState = (s: Record<string, unknown>): string => {
    const { validators: _v, soft: _s, ...rest } = s;
    return canonicalJson(rest);
};

const shortError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    // Never store a URL's query or anything long: the status row is read by the app.
    return (raw.replace(/https?:\/\/\S+/g, '<url>').trim() || 'failed').slice(0, 200);
};

/** The next status, or null when the stored one is still true and its heartbeat is fresh. */
export function nextStatus(
    prev: ProviderRow,
    outcome:
        | { ok: true; partial: string | null; feedState: Record<string, unknown> }
        | { ok: false; error: string; feedState?: Record<string, unknown> },
    nowMs: number,
    forced = false,
): ProviderStatus | null {
    const now = new Date(nowMs).toISOString();
    const age = (iso: string | null) => (iso ? nowMs - Date.parse(iso) : Infinity);
    const heartbeat = isRealtime(prev) ? REALTIME_HEARTBEAT_MS : HEARTBEAT_MS;
    if (outcome.ok && !outcome.partial) {
        const status: ProviderStatus = {
            lastSuccessAt: now,
            lastError: prev.lastError,
            lastErrorAt: prev.lastErrorAt,
            unavailableSince: null,
            feedState: outcome.feedState,
        };
        const due = forced || prev.unavailableSince !== null || age(prev.lastSuccessAt) >= heartbeat ||
            cursorState(prev.feedState) !== cursorState(outcome.feedState);
        return due ? status : null;
    }
    const error = outcome.ok ? `partial: ${outcome.partial}` : outcome.error;
    const feedState = outcome.feedState ?? prev.feedState;
    const status: ProviderStatus = {
        lastSuccessAt: prev.lastSuccessAt,
        lastError: error,
        lastErrorAt: now,
        unavailableSince: prev.unavailableSince ?? now,
        feedState,
    };
    const due = forced || prev.unavailableSince === null || prev.lastError !== error ||
        age(prev.lastErrorAt) >= heartbeat || cursorState(prev.feedState) !== cursorState(feedState);
    return due ? status : null;
}

export interface Diff {
    upserts: NormalizedAlert[];
    /** Every withdrawal: the ones the issuer named (Update, Cancel) and the ones gone from a snapshot. */
    withdraw: string[];
    /** The ones gone from a snapshot with nothing naming them: what the mass-drop guard weighs. */
    silent: string[];
    /** Stored warnings still in force (not withdrawn, not past their expiry). */
    live: number;
}

const passed = (expiresAt: string | null, nowMs: number): boolean =>
    expiresAt !== null && Date.parse(expiresAt) <= nowMs;

/** What the adapter's answer changes in the store: new or changed alerts, and the ones the issuer retired. */
export function diffAlerts(known: Map<string, Known>, out: AdapterOutput, nowMs = Date.now()): Diff {
    // One row per identifier, the newest message: one official_alerts_apply() cannot write a row twice.
    const byId = new Map<string, NormalizedAlert>();
    for (const a of out.alerts) {
        const prior = byId.get(a.identifier);
        if (!prior || Date.parse(a.sentAt) >= Date.parse(prior.sentAt)) byId.set(a.identifier, a);
    }
    const upserts = [...byId.values()].filter((a) => {
        // Over by its own end time: not shown, and it would only be pruned (and the feed's next answer
        // would put it back). Never stored.
        if (passed(a.expiresAt, nowMs)) return false;
        const k = known.get(a.identifier);
        return !k || k.hash !== a.contentHash || !k.live;
    });
    const inForce = (k: Known) => k.live && !passed(k.expiresAt, nowMs);
    const named = new Set<string>();
    for (const id of out.withdraw) {
        const k = known.get(id);
        if (k && inForce(k) && !byId.has(id)) named.add(id);
    }
    const silent = new Set<string>();
    let live = 0;
    for (const [id, k] of known) {
        // A warning past its expiry is left to the prune: not withdrawn, and not weighed by the guard.
        if (!inForce(k)) continue;
        live++;
        if (out.present.has(id) || byId.has(id) || named.has(id)) continue;
        if (out.snapshot === 'all') silent.add(id);
        else if (out.snapshot && out.snapshot.prefixes.some((p) => id.startsWith(p))) silent.add(id);
    }
    return { upserts, withdraw: [...named, ...silent].sort(), silent: [...silent].sort(), live };
}

const NO_CHANGE: Diff = { upserts: [], withdraw: [], silent: [], live: 0 };

/**
 * A provider whose licence asks for real-time redistribution: read on every
 * run, first, never sharded (MeteoAlarm: on average under 5 minutes, never
 * over 10).
 */
export const isRealtime = (p: ProviderRow): boolean => p.adapter === 'meteoalarm' || p.config.realtime === true;

/**
 * The feed state with the wait its host asked for (Retry-After) as holdUntil,
 * so the next runs leave the host alone that long; without one, none.
 */
function withHold(state: Record<string, unknown>, provider: ProviderRow, holds: HostHolds): Record<string, unknown> {
    const until = holds.untilFor(provider.feedUrl);
    const { holdUntil: _prior, ...rest } = state;
    return until === null ? rest : { ...rest, holdUntil: new Date(until).toISOString() };
}

export interface ProviderResult {
    provider: string;
    ok: boolean;
    notModified: boolean;
    writes: number;
    upserts: number;
    withdrawn: number;
    zones: number;
    error: string | null;
}

/** One provider, start to finish. Errors are recorded on the provider, never thrown. */
export async function ingestProvider(
    provider: ProviderRow,
    deps: {
        store: AlertStore;
        http: Http;
        nowMs: number;
        adapters?: Record<AdapterName, Adapter>;
        /** Set when the run has given up on this provider: nothing more is written for it. */
        signal?: AbortSignal;
        /** Milliseconds left before the provider must stop starting requests (see AdapterContext). */
        timeLeft?: () => number;
        /** A pause before a retry (AdapterContext.sleep). */
        sleep?: (ms: number) => Promise<void>;
        /** Hosts that asked to slow down, shared by the run (adapters.ts HostHolds). */
        holds?: HostHolds;
    },
): Promise<ProviderResult> {
    const result: ProviderResult = {
        provider: provider.id,
        ok: false,
        notModified: false,
        writes: 0,
        upserts: 0,
        withdrawn: 0,
        zones: 0,
        error: null,
    };
    const adapter = (deps.adapters ?? ADAPTERS)[provider.adapter];
    const holds = deps.holds ?? new HostHolds(deps.nowMs);
    try {
        if (!provider.enabled) throw new Error('licence flag is off'); // never reached from runIngest
        if (!adapter) throw new Error(`no adapter ${provider.adapter}`);
        const timeLeft = deps.timeLeft ?? (() => Infinity);
        const known = await deps.store.known(provider.id);
        const out = await adapter.run({
            provider,
            known,
            http: deps.http,
            nowMs: deps.nowMs,
            maxDocs: adapter.maxDocs ?? MAX_DOCS_PER_RUN,
            timeLeft,
            sleep: deps.sleep,
            holds,
        });
        const diff = out.notModified ? NO_CHANGE : diffAlerts(known, out, deps.nowMs);
        const { massDropSince: _since, ...feedState } = withHold(out.feedState, provider, holds);
        let withdraw = diff.withdraw;
        let refusal: { error: string; feedState: Record<string, unknown> } | null = null;
        if (
            out.snapshot === 'all' && diff.silent.length > MASS_DROP_MIN &&
            diff.silent.length > diff.live * MASS_DROP_SHARE
        ) {
            const since = typeof provider.feedState.massDropSince === 'string'
                ? provider.feedState.massDropSince
                : null;
            if (!since || deps.nowMs - Date.parse(since) < MASS_DROP_RELEASE_MS) {
                // Withdraw only what the issuer named; write the new warnings; keep the validators as they
                // were, so the next run reads the feed again rather than taking a 304 as all clear.
                const silent = new Set(diff.silent);
                withdraw = diff.withdraw.filter((id) => !silent.has(id));
                refusal = {
                    error:
                        `refused: the feed would withdraw ${diff.silent.length} of ${diff.live} warnings in force at once`,
                    feedState: withHold(
                        { ...provider.feedState, massDropSince: since ?? new Date(deps.nowMs).toISOString() },
                        provider,
                        holds,
                    ),
                };
            }
        }
        // Zone shapes for the alerts that name zones and carry no polygon (NWS), a few per run.
        const zones: ZoneRow[] = [];
        if (adapter.parseZone && out.zoneUrls.size > 0) {
            const wanted = new Set<string>();
            for (const a of out.alerts) {
                if (!a.geometry) { for (const z of a.zones) if (out.zoneUrls.has(z)) wanted.add(z); }
            }
            const missing = wanted.size > 0 ? await deps.store.missingZones(provider.id, [...wanted].sort()) : [];
            // Rotated by run, so zones that keep failing never starve the rest.
            const from = missing.length > ZONES_PER_RUN
                ? (Math.floor(deps.nowMs / RUN_PERIOD_MS) * ZONES_PER_RUN) % missing.length
                : 0;
            const batch = [...missing.slice(from), ...missing.slice(0, from)].slice(0, ZONES_PER_RUN);
            for (const code of batch) {
                if (timeLeft() <= 0) break; // the rest next run
                const url = out.zoneUrls.get(code)!;
                try {
                    const res = await deps.http.get(url, { accept: 'application/geo+json' });
                    if (res.status !== 'ok') continue;
                    const shape = adapter.parseZone(res.text, code);
                    const geometry = prepareGeometry(geoJsonToMultiPolygon(shape?.geometry));
                    if (shape && geometry) zones.push({ code, name: shape.name, geometry, sourceUrl: url });
                } catch {
                    // Left unplaced; tried again next run.
                }
            }
        }
        const outcome = refusal
            ? { ok: false as const, ...refusal }
            : { ok: true as const, partial: out.partial, feedState };
        let status = nextStatus(provider, outcome, deps.nowMs);
        // Rows are being written anyway: the soft state (ECCC's listing progress) rides along, so what
        // was read is not fetched again next run. On its own it waits for the heartbeat.
        const writing = diff.upserts.length + withdraw.length + zones.length > 0;
        const nextSoft = (refusal ? refusal.feedState : feedState).soft;
        if (!status && writing && canonicalJson(provider.feedState.soft ?? null) !== canonicalJson(nextSoft ?? null)) {
            status = nextStatus(provider, outcome, deps.nowMs, true);
        }
        const change: ChangeSet = { upserts: diff.upserts, withdraw, zones, status };
        result.ok = !refusal && !out.partial;
        result.error = refusal?.error ?? out.partial;
        result.notModified = out.notModified;
        result.upserts = change.upserts.length;
        result.withdrawn = change.withdraw.length;
        result.zones = change.zones.length;
        result.writes = writeCount(change);
        if (deps.signal?.aborted) throw new Error('abandoned after the provider timeout');
        if (result.writes > 0) await deps.store.apply(provider.id, change);
        return result;
    } catch (err) {
        const error = shortError(err);
        result.ok = false;
        result.error = error;
        const feedState = withHold(provider.feedState, provider, holds);
        const status = nextStatus(provider, { ok: false, error, feedState }, deps.nowMs);
        if (status && !deps.signal?.aborted) {
            try {
                await deps.store.apply(provider.id, { upserts: [], withdraw: [], zones: [], status });
                result.writes = 1;
            } catch {
                // The store itself is down; the next run records it.
            }
        }
        return result;
    }
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });

/**
 * The providers this run takes: every real-time one, first, then every other
 * enabled one, or, past MAX_PER_RUN of those, this 5-minute slot's share.
 */
export function shardFor(enabled: ProviderRow[], nowMs: number, maxPerRun = MAX_PER_RUN): ProviderRow[] {
    const sorted = [...enabled].sort((a, b) => a.id.localeCompare(b.id));
    const realtime = sorted.filter(isRealtime);
    const rest = sorted.filter((p) => !isRealtime(p));
    if (rest.length <= maxPerRun) return [...realtime, ...rest];
    const shards = Math.ceil(rest.length / maxPerRun);
    const slot = Math.floor(nowMs / RUN_PERIOD_MS) % shards;
    return [...realtime, ...rest.filter((_, i) => i % shards === slot)];
}

export interface RunSummary {
    ran: ProviderResult[];
    /** Providers whose licence flag is off: never fetched. */
    off: string[];
    /** Enabled providers left for another slot. */
    deferred: string[];
}

export async function runIngest(deps: {
    store: AlertStore;
    http: Http;
    nowMs: number;
    adapters?: Record<AdapterName, Adapter>;
    concurrency?: number;
    providerTimeoutMs?: number;
    maxPerRun?: number;
    runBudgetMs?: number;
    /** Elapsed-time clock for the run budget (milliseconds). */
    clock?: () => number;
    /** A pause before a retry (tests pass one that does not wait). */
    sleep?: (ms: number) => Promise<void>;
}): Promise<RunSummary> {
    const clock = deps.clock ?? (() => Date.now());
    const started = clock();
    const budget = deps.runBudgetMs ?? RUN_BUDGET_MS;
    const all = await deps.store.providers();
    const off = all.filter((p) => !p.enabled).map((p) => p.id).sort();
    const enabled = all.filter((p) => p.enabled);
    const chosen = shardFor(enabled, deps.nowMs, deps.maxPerRun);
    const deferred = enabled.filter((p) => !chosen.includes(p)).map((p) => p.id);
    const timeout = deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
    // One host's "slow down" is every provider's on that host, this run and as long as it asked.
    const holds = new HostHolds(deps.nowMs);
    for (const p of enabled) holds.carry(p.feedUrl, p.feedState.holdUntil);
    // Real-time providers first, so the budget never leaves one for the next run; each group started in a
    // rotating order, so the provider left for last is not always the same one.
    const rotate = (list: ProviderRow[]) => {
        const turn = list.length > 0 ? Math.floor(deps.nowMs / RUN_PERIOD_MS) % list.length : 0;
        return [...list.slice(turn), ...list.slice(0, turn)];
    };
    const queue = [...rotate(chosen.filter(isRealtime)), ...rotate(chosen.filter((p) => !isRealtime(p)))];
    const ran: ProviderResult[] = [];
    const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
            const provider = p;
            const left = budget - (clock() - started);
            if (left <= 0) {
                deferred.push(provider.id); // out of time: its turn comes next run
                continue;
            }
            const abandon = new AbortController();
            const allowed = Math.min(timeout, left);
            const begun = clock();
            const reserve = Math.min(APPLY_RESERVE_MS, allowed / 4);
            const r = await withTimeout(
                ingestProvider(provider, {
                    ...deps,
                    holds,
                    signal: abandon.signal,
                    timeLeft: () => allowed - reserve - (clock() - begun),
                }),
                allowed,
                provider.id,
            ).catch(async (err) => {
                // The provider's own run is abandoned (it writes nothing more); record it as unavailable.
                abandon.abort();
                const error = shortError(err);
                const status = nextStatus(provider, { ok: false, error }, deps.nowMs, true);
                await deps.store.apply(provider.id, { upserts: [], withdraw: [], zones: [], status }).catch(() => {});
                return {
                    provider: provider.id,
                    ok: false,
                    notModified: false,
                    writes: 1,
                    upserts: 0,
                    withdrawn: 0,
                    zones: 0,
                    error,
                } as ProviderResult;
            });
            ran.push(r);
        }
    };
    await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? CONCURRENCY, chosen.length) }, worker));
    ran.sort((a, b) => a.provider.localeCompare(b.provider));
    return { ran, off, deferred: deferred.sort() };
}

export const USER_AGENT = 'Thalassa official warnings (+https://thalassawx.com)';
/** Alerts per official_alerts_apply() call, so a first run on a busy day is several modest requests. */
export const APPLY_BATCH = 200;

/** official_alerts_apply()'s arguments. */
export interface ApplyArgs {
    p_provider: string;
    p_upserts: Record<string, unknown>[];
    p_withdraw: string[];
    p_zones: Record<string, unknown>[];
    p_status: Record<string, unknown> | null;
}

/**
 * The change as official_alerts_apply() calls, in batches of APPLY_BATCH alerts.
 * The status (cursors, health) rides on the last call only, so a failure part
 * way through never records feeds as read whose alerts were not written.
 */
export function applyBatches(providerId: string, c: ChangeSet, batch = APPLY_BATCH): ApplyArgs[] {
    const upserts = c.upserts.map((a) => ({
        identifier: a.identifier,
        sender: a.sender,
        sent_at: a.sentAt,
        msg_type: a.msgType,
        status: a.status,
        scope: a.scope,
        refs: a.references,
        infos: a.infos,
        zones: a.zones,
        geometry: a.geometry ? { type: 'MultiPolygon', coordinates: a.geometry } : null,
        effective_at: a.effectiveAt,
        onset_at: a.onsetAt,
        expires_at: a.expiresAt,
        content_hash: a.contentHash,
    }));
    const zones = c.zones.map((z) => ({
        code: z.code,
        name: z.name,
        geometry: { type: 'MultiPolygon', coordinates: z.geometry },
        source_url: z.sourceUrl,
    }));
    const status = c.status
        ? {
            last_success_at: c.status.lastSuccessAt,
            last_error: c.status.lastError,
            last_error_at: c.status.lastErrorAt,
            unavailable_since: c.status.unavailableSince,
            feed_state: c.status.feedState,
        }
        : null;
    const calls: ApplyArgs[] = [];
    for (let i = 0; i < Math.max(upserts.length, 1); i += batch) {
        calls.push({
            p_provider: providerId,
            p_upserts: upserts.slice(i, i + batch),
            p_withdraw: [],
            p_zones: [],
            p_status: null,
        });
    }
    const last = calls[calls.length - 1];
    last.p_withdraw = c.withdraw;
    last.p_zones = zones;
    last.p_status = status;
    return calls;
}
