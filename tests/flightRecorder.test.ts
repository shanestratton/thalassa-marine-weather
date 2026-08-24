/**
 * The flight recorder's verdict has to be worth believing.
 *
 * It is the instrument that finally located the planning-screen crash after
 * six fixes missed — but on 2026-08-09 it also produced a trail claiming a
 * foreground death on a session whose last crumb was a weather call two
 * minutes earlier. That session was backgrounded and reaped, which iOS does
 * to every app, constantly, at no cost to the skipper.
 *
 * The blind spot: the clean-exit marker was written on pagehide, and pagehide
 * does not fire when a Capacitor app is backgrounded. So a suspended
 * termination was indistinguishable from the crash being hunted. Same bug the
 * kill detector had, fixed the same way — Capacitor's appStateChange is the
 * signal that actually fires.
 *
 * These tests pin the four verdicts apart, because an instrument that cries
 * PROCESS-DIED on routine reaping sends the investigation back to memory —
 * where this hunt already lost a full day.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
    handler: null as ((state: { isActive: boolean }) => void) | null,
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: (_event: string, handler: (state: { isActive: boolean }) => void) => {
            appState.handler = handler;
            return Promise.resolve({ remove: () => undefined });
        },
    },
}));

import { crumb, getLastFlightReport, startFlightRecorder } from '../utils/flightRecorder';

const TRAIL = 'thalassa_flight_trail';
const CLEAN = 'thalassa_flight_clean_exit';
const SUSPENDED = 'thalassa_flight_suspended';

const seedTrail = () =>
    localStorage.setItem(
        TRAIL,
        JSON.stringify([
            { t: 100, tag: 'boot' },
            { t: 4200, tag: 'map:create' },
        ]),
    );

describe('the four verdicts', () => {
    beforeEach(() => {
        localStorage.clear();
        appState.handler = null;
    });

    it('clean start — no prior trail', () => {
        const report = startFlightRecorder();
        expect(report.verdict).toBe('clean-start');
        expect(report.trail).toEqual([]);
    });

    it('process-died — a trail with no exit marker of any kind', () => {
        seedTrail();
        const report = startFlightRecorder();
        expect(report.verdict).toBe('process-died');
        expect(report.summary).toContain('map:create');
        expect(report.summary).toContain('FOREGROUND');
    });

    it('controlled-reload — pagehide ran before the end', () => {
        seedTrail();
        localStorage.setItem(CLEAN, '1');
        expect(startFlightRecorder().verdict).toBe('controlled-reload');
    });

    it('suspended-kill — the app left the foreground and never came back', () => {
        // The 2026-08-09 ghost: last crumb shelter:done, two minutes idle,
        // then "PROCESS-DIED". It was a background reap and must say so.
        seedTrail();
        localStorage.setItem(SUSPENDED, '1');
        const report = startFlightRecorder();
        expect(report.verdict).toBe('suspended-kill');
        expect(report.summary).toContain('BACKGROUNDED');
        expect(report.summary).toContain('not a foreground crash');
    });

    it('a controlled reload outranks the suspend marker', () => {
        // Both can be true (backgrounded, then a reload fired on return).
        // The reload is the more specific fact.
        seedTrail();
        localStorage.setItem(CLEAN, '1');
        localStorage.setItem(SUSPENDED, '1');
        expect(startFlightRecorder().verdict).toBe('controlled-reload');
    });

    it('consumes all markers, so one exit cannot colour the next boot', () => {
        seedTrail();
        localStorage.setItem(SUSPENDED, '1');
        startFlightRecorder();
        expect(localStorage.getItem(TRAIL)).toBeNull();
        expect(localStorage.getItem(SUSPENDED)).toBeNull();
        expect(localStorage.getItem(CLEAN)).toBeNull();
    });
});

describe('the suspend marker follows the app state', () => {
    beforeEach(() => {
        localStorage.clear();
        appState.handler = null;
    });

    it('raises on background, lowers on return to foreground', async () => {
        startFlightRecorder();
        await vi.waitFor(() => expect(appState.handler).not.toBeNull());

        appState.handler!({ isActive: false });
        expect(localStorage.getItem(SUSPENDED)).toBe('1');

        // Back in the foreground: a death NOW is the real thing again.
        appState.handler!({ isActive: true });
        expect(localStorage.getItem(SUSPENDED)).toBeNull();
    });
});

describe('crumbs', () => {
    beforeEach(() => {
        localStorage.clear();
        appState.handler = null;
    });

    it('accumulate once armed and surface on the next boot', () => {
        startFlightRecorder();
        crumb('map:create', '#1 z5');
        crumb('enc:merge-start', '14cells');

        const next = startFlightRecorder();
        expect(next.trail.map((c) => c.tag)).toEqual(['map:create', 'enc:merge-start']);
        expect(next.trail[0].info).toBe('#1 z5');
    });
});

describe('getLastFlightReport', () => {
    it('hands the boot verdict to the status modal, so a crash is a screenshot not a cable', () => {
        // A prior trail with no clean-exit flag = the process died without
        // running JS. The card in SystemStatusModal renders exactly this
        // object — the couch-readable half the recorder always lacked: the
        // crumbs survived every kill, but the verdict only ever printed to
        // the Xcode console (Shane 2026-08-24, phone-only Musgrave crash).
        localStorage.setItem(
            'thalassa_flight_trail',
            JSON.stringify([
                { t: 1000, tag: 'boot' },
                { t: 90_000, tag: 'enc:geo-dispatch', info: '3glaze' },
            ]),
        );
        const report = startFlightRecorder();
        expect(getLastFlightReport()).toBe(report);
        expect(report.verdict).toBe('process-died');
        expect(report.trail).toHaveLength(2);
        expect(report.trail[1].tag).toBe('enc:geo-dispatch');
    });

    it('reports a clean start as nothing to confess', () => {
        localStorage.clear();
        const report = startFlightRecorder();
        expect(report.verdict).toBe('clean-start');
        expect(getLastFlightReport()?.verdict).toBe('clean-start');
    });
});
