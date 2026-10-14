/**
 * The 'boat went quiet' watchdog (129-08), modelled line for line in
 * TypeScript: supabase/held-migrations/20261014180000_vessel_quiet_watch_crew.sql
 * cannot run here (no database may be touched, and there is no local
 * PostgreSQL), so the rules are pinned twice. tests/VesselQuietWatchCrewMigration.test.ts
 * pins the SQL's text (its constants, verdict order and predicates match
 * this file's); tests/BoatQuietWatchModel.test.ts runs this model over the
 * shared cases in tests/fixtures/boat-quiet/cases.json, which a rolled-back
 * SQL replay is to run unchanged once Shane allows one.
 *
 * Each function names the SQL function it mirrors. Times are epoch ms; a
 * window's start and end are 'HH:MM' local to its IANA zone.
 */

export const GRACE_MIN_DEFAULT = 15;
export const WINDOW_ALLOWANCE_MIN = 10;
export const SETTLE_MIN = 30;
export const PI_ANSWERS_WITHIN_MIN = 5;
export const MAX_RECIPIENTS = 64;
const MIN = 60_000;

export interface QuietWindow {
    /** 0 = Sunday … 6 = Saturday, local to tz. */
    dow: number;
    start: string;
    end: string;
    tz: string;
}

export interface WatchRow {
    ownerId: string;
    enabled: boolean;
    armedAt: number | null;
    pagedAt: number | null;
    pagedLastHeardAt: number | null;
    pagedBusAt: number | null;
    pagedKind: 'pi_offline' | 'instruments_silent' | null;
    pagedRecipients: string[] | null;
    clearedAt: number | null;
    quietAfterMinutes: number | null;
    window: QuietWindow | null;
}

export interface Telemetry {
    /** updated_at, the server's receipt clock. */
    updatedAt: number;
    /**
     * reported_at: the readings' own time (the GPS clock where the bus has
     * one). Never read for the bus: a GPS clock is not the bus.
     */
    reportedAt: number;
    /** extra.bus_at_ms from a Pi updated with 129-08, else null. */
    busAtMs: number | null;
}

export type Verdict =
    | 'off'
    | 'never_heard'
    | 'recovered'
    | 'already_paged'
    | 'page_pi_offline'
    | 'page_instruments_silent'
    | 'within_grace';

// ── Local time in an IANA zone, as PostgreSQL's AT TIME ZONE reads it ────────

interface Wall {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
    s: number;
}

function wallAt(ms: number, tz: string): Wall {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** A wall clock as if it were UTC: the "timestamp without time zone" PostgreSQL computes with. */
const naive = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** timestamp AT TIME ZONE tz: the instant a local wall clock names (offset before the instant, rechecked). */
function instantOf(naiveMs: number, tz: string): number {
    const offset = (at: number) => naive(wallAt(at, tz)) - Math.floor(at / 1000) * 1000;
    let guess = naiveMs - offset(naiveMs);
    guess = naiveMs - offset(guess);
    return guess;
}

const hhmm = (text: string) => {
    const [h, m] = text.split(':').map(Number);
    return (h * 60 + m) * MIN;
};

/** vessel_quiet_watch_window_allowance: the silence since `from` inside the latest window, at most 10 min. */
export function windowAllowanceMs(from: number | null, now: number, window: QuietWindow | null): number {
    if (!window || from === null) return 0;
    const localNow = naive(wallAt(now, window.tz));
    const localDate = Math.floor(localNow / (24 * 60 * MIN)) * 24 * 60 * MIN;
    const dowNow = new Date(localNow).getUTCDay();
    const start = hhmm(window.start);
    const end = hhmm(window.end);
    let opened = localDate - ((dowNow - window.dow + 7) % 7) * 24 * 60 * MIN + start;
    if (opened > localNow) opened -= 7 * 24 * 60 * MIN;
    const length = end > start ? end - start : end - start + 24 * 60 * MIN;
    const openedAt = instantOf(opened, window.tz);
    const closesAt = instantOf(opened + length, window.tz);
    const overlap = Math.max(0, Math.min(now, closesAt) - Math.max(from, openedAt));
    return Math.min(WINDOW_ALLOWANCE_MIN * MIN, overlap);
}

/**
 * The watchdog's selection: last heard, and the bus as her Pi dates it,
 * clamped to last heard. No bus_at_ms (an older Pi): the bus is unknown.
 */
export function heardFrom(t: Telemetry | null): {
    lastHeardAt: number | null;
    busAt: number | null;
    busUnknown: boolean;
} {
    if (!t) return { lastHeardAt: null, busAt: null, busUnknown: true };
    const piBus = t.busAtMs !== null && t.busAtMs >= 1e12 && t.busAtMs <= 1e14 ? t.busAtMs : null;
    return {
        lastHeardAt: t.updatedAt,
        busAt: piBus === null ? null : Math.min(t.updatedAt, piBus),
        busUnknown: piBus === null,
    };
}

const greatest = (...values: (number | null | undefined)[]) => {
    const real = values.filter((v): v is number => typeof v === 'number');
    return real.length ? Math.max(...real) : null;
};

/** vessel_quiet_watch_verdict. */
export function verdict(now: number, row: WatchRow, lastHeardAt: number | null, busAt: number | null): Verdict {
    const grace = (row.quietAfterMinutes ?? GRACE_MIN_DEFAULT) * MIN;
    const settling = row.clearedAt !== null && row.clearedAt > now - SETTLE_MIN * MIN;
    const piFrom = greatest(lastHeardAt, row.armedAt, settling ? row.clearedAt : null);
    const busFrom = greatest(busAt, row.armedAt, settling ? row.clearedAt : null);
    const allowance = (from: number | null) => (settling ? 0 : windowAllowanceMs(from, now, row.window));
    const piSilence = piFrom === null ? null : now - piFrom - allowance(piFrom);
    const busSilence = busFrom === null ? null : now - busFrom - allowance(busFrom);

    if (!row.enabled) return 'off';
    if (lastHeardAt === null) return 'never_heard';
    if (
        row.pagedAt !== null &&
        lastHeardAt > (row.pagedLastHeardAt ?? -Infinity) &&
        (busAt ?? lastHeardAt) > (row.pagedBusAt ?? -Infinity)
    )
        return 'recovered';
    if (row.pagedAt !== null) return 'already_paged';
    if (piSilence !== null && piSilence >= grace) return 'page_pi_offline';
    if (
        busAt !== null &&
        now - lastHeardAt <= PI_ANSWERS_WITHIN_MIN * MIN &&
        busSilence !== null &&
        busSilence >= grace
    )
        return 'page_instruments_silent';
    return 'within_grace';
}

// ── Who is paged ──────────────────────────────────────────────────────────────

export interface CrewRow {
    ownerId: string;
    crewUserId: string;
    status: 'pending' | 'accepted' | 'declined';
    role: 'co-skipper' | 'navigator' | 'deckhand' | 'punter';
    canViewInstruments: boolean;
}

/** vessel_quiet_watch_crew_qualifies. */
export function crewQualifies(crew: readonly CrewRow[], ownerId: string, userId: string): boolean {
    return (
        userId !== ownerId &&
        crew.some(
            (c) =>
                c.ownerId === ownerId &&
                c.crewUserId === userId &&
                c.status === 'accepted' &&
                c.role !== 'punter' &&
                c.canViewInstruments,
        )
    );
}

/** vessel_quiet_watch_recipients: the owner first, then crew by id; never an opted-out or deleted account. */
export function recipients(
    ownerId: string,
    crew: readonly CrewRow[],
    optouts: ReadonlySet<string>,
    deleting: ReadonlySet<string>,
): string[] {
    const ids = new Set<string>();
    for (const c of crew) {
        if (c.ownerId !== ownerId || !crewQualifies(crew, ownerId, c.crewUserId)) continue;
        if (optouts.has(`${c.crewUserId}:${ownerId}`)) continue;
        ids.add(c.crewUserId);
    }
    const ordered = [ownerId, ...[...ids].sort()].filter((id) => !deleting.has(id));
    return ordered.slice(0, MAX_RECIPIENTS);
}

// ── The words ─────────────────────────────────────────────────────────────────

/** vessel_quiet_watch_duration. */
export function duration(minutes: number): string {
    if (Math.max(1, minutes) === 1) return '1 minute';
    if (minutes < 120) return `${minutes} minutes`;
    return `${Math.floor(minutes / 60)} hours`;
}

export type MessageKind =
    | 'pi_offline'
    | 'instruments_silent'
    | 'clear_pi_offline'
    | 'clear_instruments_silent'
    | 'clear_watch_off';

/** vessel_quiet_watch_message. busUnknown: her last row did not date her bus (an older Pi). */
export function message(
    kind: MessageKind,
    boatName: string | null,
    minutes: number,
    busUnknown: boolean,
): { title: string; body: string } {
    const d = duration(minutes);
    const her = boatName ? `${boatName}’s` : 'The boat’s';
    if (kind === 'pi_offline' && busUnknown) {
        return {
            title: `${her} Pi has gone quiet`,
            body: `Nothing from her Pi for ${d}. Her Pi may be off, her internet down or her instruments silent. Thalassa will tell you when she reports again.`,
        };
    }
    if (kind === 'pi_offline') {
        return {
            title: boatName
                ? `${boatName}’s Pi is offline, or the boat’s internet is down`
                : 'The boat’s Pi is offline, or her internet is down',
            body: `Nothing from her Pi for ${d}. Thalassa will tell you when she reports again.`,
        };
    }
    if (kind === 'instruments_silent') {
        return {
            title: `${her} instruments are silent`,
            body: `Her Pi is still reporting, but nothing from her GPS or instruments for ${d}. Thalassa will tell you when she reports again.`,
        };
    }
    if (kind === 'clear_watch_off') {
        return {
            title: `${her} quiet-boat watch is off`,
            body: 'The watch was switched off, so Thalassa won’t page about her, or say when she reports again, until it’s on again.',
        };
    }
    return {
        title: boatName ? `${boatName} is reporting again` : 'The boat is reporting again',
        body:
            kind === 'clear_instruments_silent'
                ? `Her instruments are reporting again, after ${d}.`
                : `Thalassa is hearing from her Pi again, after ${d}.`,
    };
}

/** vessel_quiet_watch_boat_name's tidy: at most 60 characters, control characters out, blank is none. */
export function boatName(raw: string | null): string | null {
    if (raw === null) return null;
    // The C0 controls and DEL, as PostgreSQL's [[:cntrl:]] (which may also take C1; no case has one).
    const tidy = [...raw]
        .slice(0, 60)
        .filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim();
    return tidy || null;
}

// ── One run of check_vessel_quiet_watch over one row ─────────────────────────

export interface Push {
    to: string;
    type: 'boat_quiet' | 'boat_quiet_clear';
    title: string;
    body: string;
    kind: string;
}

export interface World {
    crew: readonly CrewRow[];
    optouts: ReadonlySet<string>;
    deleting: ReadonlySet<string>;
    boatName: string | null;
}

export interface RunResult {
    verdict: Verdict;
    row: WatchRow;
    pushes: Push[];
    /** Whose unsent page the queue sets aside (done, never delivered) before the all-clear. */
    supersede: string[];
}

export function runOnce(now: number, row: WatchRow, telemetry: Telemetry | null, world: World): RunResult {
    if (!row.enabled || world.deleting.has(row.ownerId)) return { verdict: 'off', row, pushes: [], supersede: [] };
    const heard = heardFrom(telemetry);
    const v = verdict(now, row, heard.lastHeardAt, heard.busAt);
    const name = boatName(world.boatName);
    if (v === 'recovered') {
        const kind = row.pagedKind ?? 'pi_offline';
        const since = kind === 'instruments_silent' ? (row.pagedBusAt ?? row.pagedLastHeardAt) : row.pagedLastHeardAt;
        const minutes = Math.max(1, Math.floor((now - (since ?? now)) / MIN));
        const said = message(`clear_${kind}`, name, minutes, false);
        const paged = row.pagedRecipients ?? [row.ownerId];
        const to = paged.filter((id) => !world.deleting.has(id));
        return {
            verdict: v,
            row: {
                ...row,
                pagedAt: null,
                pagedLastHeardAt: null,
                pagedBusAt: null,
                pagedKind: null,
                pagedRecipients: null,
                clearedAt: now,
            },
            pushes: to.map((id) => ({ to: id, type: 'boat_quiet_clear', ...said, kind: 'boat_quiet_clear' })),
            supersede: paged,
        };
    }
    if (v === 'page_pi_offline' || v === 'page_instruments_silent') {
        const kind = v === 'page_pi_offline' ? 'pi_offline' : 'instruments_silent';
        const since = kind === 'instruments_silent' ? heard.busAt! : heard.lastHeardAt!;
        const minutes = Math.max(1, Math.floor((now - since) / MIN));
        const to = recipients(row.ownerId, world.crew, world.optouts, world.deleting);
        const said = message(kind, name, minutes, heard.busUnknown);
        return {
            verdict: v,
            row: {
                ...row,
                pagedAt: now,
                pagedLastHeardAt: heard.lastHeardAt,
                pagedBusAt: heard.busAt,
                pagedKind: kind,
                pagedRecipients: to,
            },
            pushes: to.map((id) => ({ to: id, type: 'boat_quiet', ...said, kind })),
            supersede: [],
        };
    }
    return { verdict: v, row, pushes: [], supersede: [] };
}

// ── The skipper switches it off (vessel_quiet_watch_before_write, then
//    vessel_quiet_watch_after_switch_off) ─────────────────────────────────────

export function switchOff(row: WatchRow, world: World): { row: WatchRow; pushes: Push[]; supersede: string[] } {
    const off: WatchRow = {
        ...row,
        enabled: false,
        armedAt: null,
        pagedAt: null,
        pagedLastHeardAt: null,
        pagedBusAt: null,
        pagedKind: null,
        pagedRecipients: null,
        clearedAt: null,
    };
    if (!row.enabled || row.pagedAt === null) return { row: off, pushes: [], supersede: [] };
    const paged = row.pagedRecipients ?? [row.ownerId];
    const said = message('clear_watch_off', boatName(world.boatName), 0, false);
    return {
        row: off,
        pushes: paged
            .filter((id) => !world.deleting.has(id))
            .map((id) => ({ to: id, type: 'boat_quiet_clear', ...said, kind: 'boat_quiet_clear' })),
        supersede: paged,
    };
}
