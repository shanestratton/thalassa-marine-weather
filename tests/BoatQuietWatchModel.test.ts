/**
 * The 'boat went quiet' watchdog's rules (129-08), on the model in
 * tests/helpers/boatQuietModel.ts that mirrors the held SQL line for line
 * (tests/VesselQuietWatchCrewMigration.test.ts pins the SQL to the same
 * constants and order). The cases in tests/fixtures/boat-quiet/cases.json are
 * the ones a rolled-back SQL replay is to run unchanged.
 *
 * Covered: crew recipients (who is and is never paged), the all-clear and who
 * gets it, the weekly window's 10-minute allowance in the boat's own zone
 * (across midnight, in four zones), the watch off, a crew member's own
 * opt-out, the flap guard, and the two message kinds with the boat's name
 * (Latin, Greek, Japanese, Arabic); an older Pi's hedged page; the closing
 * word when the watch is switched off mid-outage; and an unsent page set
 * aside before the all-clear. Fictional boats and people only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    boatName,
    message,
    recipients,
    runOnce,
    switchOff,
    verdict,
    heardFrom,
    type CrewRow,
    type MessageKind,
    type Telemetry,
    type WatchRow,
    type World,
} from './helpers/boatQuietModel';

interface CaseRow extends Partial<
    Omit<WatchRow, 'armedAt' | 'pagedAt' | 'pagedLastHeardAt' | 'pagedBusAt' | 'clearedAt'>
> {
    armedAt?: string;
    pagedAt?: string;
    pagedLastHeardAt?: string;
    pagedBusAt?: string;
    clearedAt?: string;
}
interface Cases {
    verdicts: {
        name: string;
        now: string;
        row: CaseRow;
        telemetry: { updatedAt: string; reportedAt: string; busAtMs: string | null } | null;
        expect: string;
    }[];
    recipients: {
        owner: string;
        crew: (Omit<CrewRow, 'ownerId'> & { why: string })[];
        optouts: string[];
        deleting: string[];
        expect: string[];
    };
    messages: {
        kind: MessageKind;
        boatName: string | null;
        minutes: number;
        busUnknown: boolean;
        title: string;
        body: string;
    }[];
}

const cases = JSON.parse(readFileSync('tests/fixtures/boat-quiet/cases.json', 'utf8')) as Cases;
const at = (iso: string | undefined | null) => (iso ? Date.parse(iso) : null);
const OWNER = cases.recipients.owner;

function rowOf(c: CaseRow): WatchRow {
    return {
        ownerId: OWNER,
        enabled: c.enabled ?? true,
        armedAt: at(c.armedAt ?? '2026-10-01T00:00:00Z'),
        pagedAt: at(c.pagedAt),
        pagedLastHeardAt: at(c.pagedLastHeardAt),
        pagedBusAt: at(c.pagedBusAt),
        pagedKind: c.pagedKind ?? null,
        pagedRecipients: c.pagedRecipients ?? null,
        clearedAt: at(c.clearedAt),
        quietAfterMinutes: c.quietAfterMinutes ?? 15,
        window: c.window ?? null,
    };
}

function telemetryOf(t: Cases['verdicts'][number]['telemetry']): Telemetry | null {
    return t ? { updatedAt: at(t.updatedAt)!, reportedAt: at(t.reportedAt)!, busAtMs: at(t.busAtMs) } : null;
}

const crew: CrewRow[] = cases.recipients.crew.map(({ why: _why, ...c }) => ({ ...c, ownerId: OWNER }));
const world = (extra: Partial<World> = {}): World => ({
    crew,
    optouts: new Set(cases.recipients.optouts.map((id) => `${id}:${OWNER}`)),
    deleting: new Set(cases.recipients.deleting),
    boatName: 'Αύρα',
    ...extra,
});

describe('the verdict, case by case (the replay runs these unchanged)', () => {
    it.each(cases.verdicts.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const heard = heardFrom(telemetryOf(c.telemetry));
        expect(verdict(Date.parse(c.now), rowOf(c.row), heard.lastHeardAt, heard.busAt)).toBe(c.expect);
    });

    it('covers every verdict', () => {
        expect(new Set(cases.verdicts.map((c) => c.expect))).toEqual(
            new Set([
                'off',
                'never_heard',
                'within_grace',
                'page_pi_offline',
                'page_instruments_silent',
                'recovered',
                'already_paged',
            ]),
        );
    });
});

describe('who is paged', () => {
    it('the owner, then accepted crew who share the instruments; never pending, declined, guests, opted out or deleting', () => {
        expect(recipients(OWNER, crew, world().optouts, world().deleting)).toEqual(cases.recipients.expect);
    });

    it('a crew member who turns pages off is not paged, and is again once they turn them on', () => {
        const optedOut = '00000000-0000-4000-8000-0000000000a1';
        const off = recipients(OWNER, crew, new Set([`${optedOut}:${OWNER}`]), new Set());
        expect(off).not.toContain(optedOut);
        expect(recipients(OWNER, crew, new Set(), new Set())).toContain(optedOut);
        // An opt-out is per boat: the same person's opt-out for another skipper's boat changes nothing here.
        expect(recipients(OWNER, crew, new Set([`${optedOut}:someone-else`]), new Set())).toContain(optedOut);
    });

    it('never pages more than 64', () => {
        const many: CrewRow[] = Array.from({ length: 80 }, (_, i) => ({
            ownerId: OWNER,
            crewUserId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            status: 'accepted',
            role: 'deckhand',
            canViewInstruments: true,
        }));
        const to = recipients(OWNER, many, new Set(), new Set());
        expect(to).toHaveLength(64);
        expect(to[0]).toBe(OWNER);
    });
});

describe('one outage, start to finish', () => {
    const T = Date.parse('2026-10-14T03:00:00Z');
    const MIN = 60_000;
    const quietSince = (ms: number): Telemetry => ({ updatedAt: ms, reportedAt: ms, busAtMs: ms });
    const fresh: WatchRow = rowOf({});

    it('pages each recipient once, then sends the all-clear only to those it paged, on the same collapse', () => {
        // 15 min of nothing: one page each, to the owner and the two crew.
        const paged = runOnce(T + 15 * MIN, fresh, quietSince(T), world());
        expect(paged.verdict).toBe('page_pi_offline');
        expect(paged.pushes.map((p) => p.to)).toEqual(cases.recipients.expect);
        expect(paged.pushes[0]).toMatchObject({
            type: 'boat_quiet',
            title: 'Αύρα’s Pi is offline, or the boat’s internet is down',
            body: 'Nothing from her Pi for 15 minutes. Thalassa will tell you when she reports again.',
        });

        // A minute later, still quiet: nothing more for this outage.
        const again = runOnce(T + 16 * MIN, paged.row, quietSince(T), world());
        expect(again.verdict).toBe('already_paged');
        expect(again.pushes).toEqual([]);

        // A crew member turns pages off mid-outage, and someone new joins: the
        // all-clear still goes to exactly those the page went to.
        const later = world({
            optouts: new Set([`00000000-0000-4000-8000-0000000000a1:${OWNER}`]),
            crew: [
                ...crew,
                {
                    ownerId: OWNER,
                    crewUserId: '00000000-0000-4000-8000-0000000000aa',
                    status: 'accepted',
                    role: 'deckhand',
                    canViewInstruments: true,
                },
            ],
        });
        const back = runOnce(T + 40 * MIN, again.row, quietSince(T + 40 * MIN - 5_000), later);
        expect(back.verdict).toBe('recovered');
        expect(back.pushes.map((p) => p.to)).toEqual(cases.recipients.expect);
        expect(back.pushes[0]).toMatchObject({
            type: 'boat_quiet_clear',
            title: 'Αύρα is reporting again',
            body: 'Thalassa is hearing from her Pi again, after 40 minutes.',
        });
        expect(back.row).toMatchObject({
            pagedAt: null,
            pagedRecipients: null,
            pagedKind: null,
            clearedAt: T + 40 * MIN,
        });
        // A page still unsent in the queue (its first send failed) is set aside
        // for every one paged, so the drain can never land it on the all-clear.
        expect(back.supersede).toEqual(cases.recipients.expect);
        expect(paged.supersede).toEqual([]);

        // She goes quiet again at once: the flap guard counts from the all-clear.
        const settling = runOnce(T + 54 * MIN, back.row, quietSince(T + 40 * MIN - 5_000), world());
        expect(settling.verdict).toBe('within_grace');
        expect(runOnce(T + 55 * MIN, back.row, quietSince(T + 40 * MIN - 5_000), world()).verdict).toBe(
            'page_pi_offline',
        );
    });

    it('an instruments page names what is silent, and its all-clear says the instruments are back', () => {
        const busQuiet: Telemetry = { updatedAt: T + 16 * MIN - 10_000, reportedAt: T + 16 * MIN - 10_000, busAtMs: T };
        const paged = runOnce(T + 16 * MIN, fresh, busQuiet, world({ boatName: 'Kestrel' }));
        expect(paged.verdict).toBe('page_instruments_silent');
        expect(paged.pushes[0]).toMatchObject({
            title: 'Kestrel’s instruments are silent',
            body: 'Her Pi is still reporting, but nothing from her GPS or instruments for 16 minutes. Thalassa will tell you when she reports again.',
            kind: 'instruments_silent',
        });
        const back = runOnce(
            T + 30 * MIN,
            paged.row,
            { updatedAt: T + 30 * MIN, reportedAt: T + 30 * MIN, busAtMs: T + 30 * MIN },
            world({ boatName: 'Kestrel' }),
        );
        expect(back.pushes[0]).toMatchObject({
            title: 'Kestrel is reporting again',
            body: 'Her instruments are reporting again, after 30 minutes.',
        });
    });

    it('an older Pi (no bus_at_ms) going quiet gets the hedged page: her Pi, her internet or her instruments', () => {
        const older: Telemetry = { updatedAt: T, reportedAt: T - 20 * MIN, busAtMs: null };
        const paged = runOnce(T + 25 * MIN, fresh, older, world({ boatName: '海風' }));
        expect(paged.verdict).toBe('page_pi_offline');
        expect(paged.pushes[0]).toMatchObject({
            title: '海風’s Pi has gone quiet',
            body: 'Nothing from her Pi for 25 minutes. Her Pi may be off, her internet down or her instruments silent. Thalassa will tell you when she reports again.',
        });
        // Its stalled GPS clock while rows still come is never an instruments page.
        const stalled: Telemetry = { updatedAt: T + 25 * MIN, reportedAt: T - 20 * MIN, busAtMs: null };
        expect(runOnce(T + 25 * MIN, fresh, stalled, world()).verdict).toBe('within_grace');
    });

    it('switched off: no page, however long she is quiet', () => {
        expect(runOnce(T + 600 * MIN, { ...fresh, enabled: false }, quietSince(T), world()).pushes).toEqual([]);
    });

    it('switched off while a page is open: those paged are told the watch is off, on the same notification', () => {
        const paged = runOnce(T + 15 * MIN, fresh, quietSince(T), world({ boatName: 'Kestrel' }));
        const off = switchOff(
            paged.row,
            world({ boatName: 'Kestrel', deleting: new Set(['00000000-0000-4000-8000-0000000000a8']) }),
        );
        expect(off.pushes.map((p) => p.to)).toEqual(cases.recipients.expect.slice(0, 2));
        expect(off.pushes[0]).toMatchObject({
            type: 'boat_quiet_clear',
            title: 'Kestrel’s quiet-boat watch is off',
            body: 'The watch was switched off, so Thalassa won’t page about her, or say when she reports again, until it’s on again.',
        });
        expect(`${off.pushes[0].title} ${off.pushes[0].body}`).not.toMatch(/reporting again|is back/);
        expect(off.supersede).toEqual(cases.recipients.expect);
        expect(off.row).toMatchObject({ enabled: false, pagedAt: null, pagedRecipients: null });
        // Then nothing more, whatever she does.
        expect(runOnce(T + 60 * MIN, off.row, quietSince(T + 59 * MIN), world()).pushes).toEqual([]);
        // Switched off with no page open: nothing to say.
        expect(switchOff(fresh, world()).pushes).toEqual([]);
        // A 125 page (no recipients stored) went to the owner alone.
        expect(switchOff({ ...fresh, pagedAt: T, pagedLastHeardAt: T }, world()).pushes.map((p) => p.to)).toEqual([
            OWNER,
        ]);
    });

    it('a page from build 125 gets its all-clear, to the owner alone', () => {
        const old: WatchRow = { ...fresh, pagedAt: T + 15 * MIN, pagedLastHeardAt: T };
        const back = runOnce(T + 50 * MIN, old, quietSince(T + 50 * MIN), world());
        expect(back.pushes.map((p) => p.to)).toEqual([OWNER]);
        expect(back.pushes[0].body).toBe('Thalassa is hearing from her Pi again, after 50 minutes.');
    });

    it('a recipient whose account is being deleted by the all-clear is skipped', () => {
        const paged = runOnce(T + 15 * MIN, fresh, quietSince(T), world());
        const back = runOnce(
            T + 30 * MIN,
            paged.row,
            quietSince(T + 30 * MIN),
            world({ deleting: new Set(['00000000-0000-4000-8000-0000000000a8']) }),
        );
        expect(back.pushes.map((p) => p.to)).toEqual(cases.recipients.expect.slice(0, 2));
    });
});

describe('the words', () => {
    it.each(cases.messages.map((m) => [`${m.kind} for ${m.boatName ?? 'no name'}`, m] as const))('%s', (_n, m) => {
        expect(message(m.kind, m.boatName, m.minutes, m.busUnknown)).toEqual({ title: m.title, body: m.body });
    });

    it('never claims a position, power loss or sinking, and fits send-push (title 120, body 500)', () => {
        const longest = 'x'.repeat(60);
        for (const kind of [
            'pi_offline',
            'instruments_silent',
            'clear_pi_offline',
            'clear_instruments_silent',
            'clear_watch_off',
        ] as const) {
            for (const busUnknown of [false, true]) {
                const said = message(kind, longest, 719, busUnknown);
                expect(said.title.length).toBeLessThanOrEqual(120);
                expect(said.body.length).toBeLessThanOrEqual(500);
                expect(`${said.title} ${said.body}`).not.toMatch(/sink|power|position|lat|lon|°|NM\b/i);
            }
        }
    });

    it('takes the boat’s own name, at most 60 characters, with no control characters', () => {
        expect(boatName('  Kestrel  ')).toBe('Kestrel');
        expect(boatName('\u0007')).toBeNull();
        expect(boatName('')).toBeNull();
        expect(boatName('Αύρα\nII')).toBe('ΑύραII');
        expect(boatName('ب'.repeat(80))).toHaveLength(60);
    });
});
