/**
 * Who is watching (build 126, package 126-04a): the line under the AIS key's
 * shield, from this phone's collision watch and the Pi's night watch.
 *
 * The Pi's word arrives over the boat LAN (pi-cache /api/telemetry
 * `ais_watch`) or, ashore, in the cloud row's `ais_watch*` extras. A report
 * whose last pass is over 30 s old is a Pi that is not answering, never one
 * that is watching. Until 126-04b the Pi cannot wake a locked phone, and the
 * row says so whenever the Pi is watching.
 */
import { describe, expect, it } from 'vitest';
import {
    PI_WATCH_HAND_ANCHOR_NOTE,
    PI_WATCH_LOCKED_PHONE_NOTE,
    PI_WATCH_STALE_MS,
    presentCollisionWatchRow,
    type PiWatchView,
} from '../utils/collisionWatchRow';

const NOW = Date.parse('2026-10-09T21:00:00Z');

const pi = (over: Partial<PiWatchView> = {}): PiWatchView => ({
    paired: true,
    report: null,
    reachable: false,
    pending: null,
    ...over,
});
const lan = (
    state: 'off' | 'armed' | 'blind' | 'no-fix',
    agoMs = 2_000,
    atAnchor: boolean | null = null,
): PiWatchView['report'] => ({
    state,
    lastPassAt: state === 'off' ? null : NOW - agoMs,
    via: 'lan',
    atAnchor,
});
const cloud = (state: 'off' | 'armed' | 'blind' | 'no-fix', agoMs = 6_000): PiWatchView['report'] => ({
    state,
    lastPassAt: state === 'off' ? null : NOW - agoMs,
    via: 'cloud',
});

describe('who is watching', () => {
    it('this phone and the Pi, aboard', () => {
        const row = presentCollisionWatchRow({ armed: true }, pi({ report: lan('armed'), reachable: true }), NOW);
        expect(row).toEqual({
            text: 'Watching: this phone and the Pi',
            tone: 'ok',
            note: PI_WATCH_LOCKED_PHONE_NOTE,
        });
        // Until 126-04b, said whenever the Pi is watching.
        expect(PI_WATCH_LOCKED_PHONE_NOTE).toMatch(/locked phone/);
    });

    it('a Pi whose last pass is over 30 s old is not answering, never watching', () => {
        expect(PI_WATCH_STALE_MS).toBe(30_000);
        const fresh = presentCollisionWatchRow(
            { armed: true },
            pi({ report: lan('armed', PI_WATCH_STALE_MS), reachable: true }),
            NOW,
        );
        expect(fresh?.text).toBe('Watching: this phone and the Pi');
        const stale = presentCollisionWatchRow(
            { armed: true },
            pi({ report: lan('armed', PI_WATCH_STALE_MS + 1), reachable: true }),
            NOW,
        );
        expect(stale).toMatchObject({ text: "Watching: this phone only (the Pi isn't answering)", tone: 'warn' });
        expect(stale?.note).toBeNull();
        // The phone's own watch off: the Pi was watching, and it says so.
        const alone = presentCollisionWatchRow({ armed: false }, pi({ report: cloud('armed', 120_000) }), NOW);
        expect(alone).toMatchObject({ tone: 'warn' });
        expect(alone?.text).toContain("the Pi isn't answering");
    });

    it('a blind Pi, or one with no position, is said as such', () => {
        const blind = presentCollisionWatchRow({ armed: true }, pi({ report: lan('blind'), reachable: true }), NOW);
        expect(blind).toMatchObject({ text: 'Watching: this phone and the Pi (the Pi hears no AIS)', tone: 'warn' });
        const noFix = presentCollisionWatchRow({ armed: false }, pi({ report: lan('no-fix'), reachable: true }), NOW);
        expect(noFix).toMatchObject({ text: 'Watching: the Pi (the Pi has no position)', tone: 'warn' });
    });

    it('this phone only', () => {
        expect(presentCollisionWatchRow({ armed: true }, pi(), NOW)).toEqual({
            text: "Watching: this phone only (the Pi isn't reachable)",
            tone: 'quiet',
            note: null,
        });
        // Arming while the Pi cannot be reached: the arm waits, said honestly.
        expect(presentCollisionWatchRow({ armed: true }, pi({ pending: 'arm' }), NOW)?.text).toBe(
            "Watching: this phone only (the Pi isn't reachable)",
        );
        expect(presentCollisionWatchRow({ armed: true }, pi({ pending: 'arm', reachable: true }), NOW)?.text).toBe(
            'Watching: this phone (arming the Pi)',
        );
        expect(presentCollisionWatchRow({ armed: true }, pi({ report: lan('off'), reachable: true }), NOW)?.text).toBe(
            "Watching: this phone only (the Pi's watch is off)",
        );
        // A Pi from before Pi update 2 answers the LAN without an ais_watch.
        expect(presentCollisionWatchRow({ armed: true }, pi({ reachable: true }), NOW)?.text).toBe(
            'Watching: this phone only (this Pi has no night watch yet)',
        );
    });

    it('the Pi only: aboard, or ashore from the cloud row', () => {
        expect(presentCollisionWatchRow({ armed: false }, pi({ report: lan('armed'), reachable: true }), NOW)).toEqual({
            text: 'Watching: the Pi',
            tone: 'ok',
            note: PI_WATCH_LOCKED_PHONE_NOTE,
        });
        expect(presentCollisionWatchRow({ armed: false }, pi({ report: cloud('armed') }), NOW)).toEqual({
            text: "Watching: the Pi (this phone can't reach it)",
            tone: 'ok',
            note: PI_WATCH_LOCKED_PHONE_NOTE,
        });
        expect(presentCollisionWatchRow({ armed: true }, pi({ report: cloud('armed') }), NOW)?.text).toBe(
            "Watching: this phone and the Pi (this phone can't reach it)",
        );
    });

    it('disarmed while the Pi cannot be reached: the Pi is still watching, stand it down from aboard', () => {
        expect(
            presentCollisionWatchRow({ armed: false }, pi({ report: cloud('armed'), pending: 'disarm' }), NOW),
        ).toEqual({ text: 'The Pi is still watching. Stand it down from aboard.', tone: 'warn', note: null });
        // Nothing heard from the Pi at all: it may still be watching.
        expect(presentCollisionWatchRow({ armed: false }, pi({ pending: 'disarm' }), NOW)?.text).toBe(
            'The Pi is still watching. Stand it down from aboard.',
        );
        // Reachable: on its way.
        expect(
            presentCollisionWatchRow(
                { armed: false },
                pi({ report: lan('armed'), pending: 'disarm', reachable: true }),
                NOW,
            )?.text,
        ).toBe('Standing the Pi down');
        // The Pi already says it is off: nothing to stand down.
        expect(
            presentCollisionWatchRow({ armed: false }, pi({ report: lan('off'), pending: 'disarm' }), NOW),
        ).toBeNull();
    });

    it('neither watching, or no Pi paired: no row at all (the key is as before)', () => {
        expect(presentCollisionWatchRow({ armed: false }, pi(), NOW)).toBeNull();
        expect(presentCollisionWatchRow({ armed: false }, pi({ report: lan('off'), reachable: true }), NOW)).toBeNull();
        expect(presentCollisionWatchRow({ armed: true }, pi({ paired: false, report: lan('armed') }), NOW)).toBeNull();
    });

    it('at anchor on this phone, but the Pi keeps no anchor watch: it cannot see ours, said in amber', () => {
        // The Pi counts as at anchor only with its own anchor runner (decision 2).
        const aboard = pi({ report: lan('armed', 2_000, false), reachable: true });
        expect(presentCollisionWatchRow({ armed: true, anchorWatch: 'at-anchor' }, aboard, NOW)).toEqual({
            text: "Watching: this phone and the Pi (it can't see the anchor watch)",
            tone: 'warn',
            note: PI_WATCH_HAND_ANCHOR_NOTE,
        });
        // A crew phone with its shield off, in the same anchorage, hears the same.
        expect(presentCollisionWatchRow({ armed: false, anchorWatch: 'at-anchor' }, aboard, NOW)).toMatchObject({
            text: "Watching: the Pi (it can't see the anchor watch)",
            tone: 'warn',
        });
        // Its own trouble comes first; the hand-over still asked for.
        expect(
            presentCollisionWatchRow(
                { armed: true, anchorWatch: 'at-anchor' },
                pi({ report: lan('blind', 2_000, false), reachable: true }),
                NOW,
            ),
        ).toMatchObject({
            text: 'Watching: this phone and the Pi (the Pi hears no AIS)',
            note: PI_WATCH_HAND_ANCHOR_NOTE,
        });
        // The Pi keeps the anchor watch itself, or ours is somewhere else, or there is none: no warning.
        for (const [anchorWatch, atAnchor] of [
            ['at-anchor', true],
            ['elsewhere', false],
            ['none', false],
        ] as const) {
            expect(
                presentCollisionWatchRow(
                    { armed: true, anchorWatch },
                    pi({ report: lan('armed', 2_000, atAnchor), reachable: true }),
                    NOW,
                ),
            ).toEqual({ text: 'Watching: this phone and the Pi', tone: 'ok', note: PI_WATCH_LOCKED_PHONE_NOTE });
        }
    });

    it('this phone’s shield off and the Pi watching aboard: a stand-down for everyone is offered', () => {
        const view = pi({ report: lan('armed'), reachable: true, canStandDown: true });
        expect(presentCollisionWatchRow({ armed: false }, view, NOW)).toEqual({
            text: 'Watching: the Pi',
            tone: 'ok',
            note: PI_WATCH_LOCKED_PHONE_NOTE,
            action: 'stand-down-all',
        });
        // Not while this phone is watching too, not ashore, not while a change is on its way.
        expect(presentCollisionWatchRow({ armed: true }, view, NOW)?.action).toBeUndefined();
        expect(
            presentCollisionWatchRow({ armed: false }, pi({ report: cloud('armed'), canStandDown: true }), NOW)?.action,
        ).toBeUndefined();
        expect(
            presentCollisionWatchRow(
                { armed: false },
                pi({ report: lan('armed'), reachable: true, canStandDown: true, pending: 'arm' }),
                NOW,
            )?.action,
        ).toBeUndefined();
    });

    it('a Pi with no night watch at all: said so, whatever this phone asked of it', () => {
        expect(
            presentCollisionWatchRow({ armed: true }, pi({ reachable: true, noWatch: true, pending: 'arm' }), NOW)
                ?.text,
        ).toBe('Watching: this phone only (this Pi has no night watch yet)');
        expect(
            presentCollisionWatchRow({ armed: false }, pi({ reachable: true, noWatch: true, pending: 'disarm' }), NOW),
        ).toBeNull();
    });

    it('every line is short enough for the key at 320 pt', () => {
        const views: PiWatchView[] = [
            pi({ report: lan('armed', 2_000, false), reachable: true }),
            pi({ report: lan('armed'), reachable: true }),
            pi({ report: lan('blind'), reachable: true }),
            pi({ report: cloud('no-fix') }),
            pi({ report: cloud('armed') }),
            pi({ report: lan('armed', 60_000) }),
            pi({ pending: 'disarm' }),
            pi({ reachable: true }),
        ];
        for (const armed of [true, false]) {
            for (const view of views) {
                const row = presentCollisionWatchRow({ armed, anchorWatch: 'at-anchor' }, view, NOW);
                if (row) expect(row.text.length, row.text).toBeLessThanOrEqual(64);
            }
        }
    });
});
