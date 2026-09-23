/**
 * The passage pane on the Obs chart — phase 1, the live pane.
 *
 * Shane, 2026-09-17: "i dont really know which screen to look at … a new layer
 * on the obs page. this layer will show cog, sog, wind speed, direction and
 * true and apparent … on a pane that can be hidden to one side (left)."
 * And on 2026-09-18, for dead boat instruments with a phone fix: "show dashes".
 *
 * What would actually mislead a skipper here: a dead instrument showing its
 * last number, a moored boat showing a course, a cloud reading passing as the
 * boat's own, a "distance to go" that is not along the route — or one that
 * quietly stops working the moment the Pi lane drops.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

// The REAL label/detail split: the label is a constant, the truth is in detail.
const receiver = vi.hoisted(() => ({
    status: {
        active: true,
        kind: 'nmea',
        label: 'On-board GPS',
        detail: 'Live via the Pi · GPS · 11 sats · HDOP 0.9',
        isNmea: true,
        satellites: 11,
        hdop: 0.8,
        avgAccuracy: null,
        qualityLabel: null,
        deviceName: 'calypso',
    },
}));
vi.mock('../services/GpsReceiverStatusService', () => ({
    GpsReceiverStatusService: {
        getStatus: () => receiver.status,
        refresh: () => Promise.resolve(receiver.status),
    },
}));

// A passive phone-GPS watch the test can drive.
type PhoneFix = { latitude: number; longitude: number; timestamp: number };
const gps = vi.hoisted(() => ({
    last: null as null | { latitude: number; longitude: number; timestamp: number },
    callbacks: new Set<(p: { latitude: number; longitude: number; timestamp: number }) => void>(),
    watchOpts: [] as unknown[],
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getLastKnownPosition: () => gps.last,
        watchPosition: (cb: (p: PhoneFix) => void, opts?: unknown) => {
            gps.callbacks.add(cb);
            gps.watchOpts.push(opts);
            return () => gps.callbacks.delete(cb);
        },
    },
}));

// The layer button offers Passage for an active voyage OR a followed route.
const voyage = vi.hoisted(() => ({ active: null as null | { id: string } }));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => voyage.active }));

import { PassageHudPane, __forgetReckoningForTests } from '../components/passage/PassageHudPane';
import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { useFollowRouteStore } from '../stores/followRouteStore';
import {
    __resetPassageHudForTests,
    isPassageHudEnabled,
    isPassageHudOpen,
    setPassageHudEnabled,
    setPassageHudOpen,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn, setPassageOverlay } from '../stores/chartPassageOverlay';
import type { VoyagePlan } from '../types';

const snapshot = (over: Partial<RemoteInstrumentSnapshot> = {}): RemoteInstrumentSnapshot => ({
    source: 'pi',
    via: 'lan',
    deviceLabel: 'calypso',
    reportedAt: Date.now() - 1_000,
    lat: -27.5,
    lon: 153,
    sogKts: 6.14,
    cogDeg: 44,
    headingDeg: 41,
    stwKts: 5.8,
    twsKts: 14.2,
    twaDeg: -48,
    twdDeg: 350,
    awsKts: 17.6,
    awaDeg: -33,
    depthM: 12.4,
    heelDeg: -9,
    pitchDeg: 1,
    waterTempC: 22.5,
    rudderDeg: 2,
    rpm: null,
    voltageV: 13.1,
    ...over,
});

const PLAN = { origin: 'Newport', destination: 'Gladstone', waypoints: [] } as unknown as VoyagePlan;
const ROUTE = [
    { lat: -28, lon: 153 },
    { lat: -27, lon: 153 },
    { lat: -27, lon: 154 },
];

const text = (id: string) => screen.getByTestId(id).textContent ?? '';

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    setPassageHudEnabled(true);
    voyage.active = null;
    NmeaStore.clearRemote();
    useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
    gps.last = null;
    gps.callbacks.clear();
    gps.watchOpts.length = 0;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    NmeaStore.clearRemote();
    useFollowRouteStore.getState().stopFollowing();
});

describe('off until the skipper enables the followed route HUD', () => {
    it('renders nothing at all by default — no tab, no strip', () => {
        setPassageHudEnabled(false);
        setPassageHudOpen(true);
        const { container } = render(<PassageHudPane />);
        expect(container.firstChild).toBeNull();
    });

    it('switching it off also closes it, so nothing stays stepped aside for a strip that is gone', () => {
        setPassageHudOpen(true);
        setPassageHudEnabled(false);
        expect(isPassageHudOpen()).toBe(false);
        expect(localStorage.getItem('thalassa_passage_hud_open_v1')).toBeNull();
    });
});

describe('hidden to one side until asked for', () => {
    it('is a small tab on the left by default, and opens and closes from it', () => {
        render(<PassageHudPane />);
        expect(screen.getByTestId('passage-hud')).not.toBeVisible();
        const tab = screen.getByRole('button', { name: 'Show passage instruments' });
        expect(tab.getAttribute('aria-label')).toBe('Show passage instruments');
        fireEvent.click(tab);
        expect(isPassageHudOpen()).toBe(true);
        expect(screen.getByTestId('passage-hud')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Hide passage instruments' }));
        expect(screen.getByTestId('passage-hud')).not.toBeVisible();
    });

    it('remembers being open on this device', () => {
        setPassageHudOpen(true);
        expect(localStorage.getItem('thalassa_passage_hud_open_v1')).toBe('1');
        __resetPassageHudForTests();
        expect(isPassageHudOpen()).toBe(true);
    });

    it('is not a dialog — the chart stays live under it', () => {
        setPassageHudOpen(true);
        render(<PassageHudPane />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByLabelText('Passage instruments').tagName).toBe('ASIDE');
    });

    it('has no page Back control and keeps the instrument collapse control', () => {
        setPassageHudOpen(true);
        render(<PassageHudPane />);
        expect(screen.queryByRole('button', { name: /^Back$/ })).toBeNull();
        expect(screen.queryByTestId('hud-back')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Hide passage instruments' }));
        expect(isPassageHudOpen()).toBe(false);
        expect(screen.getByRole('button', { name: 'Show passage instruments' })).toBeTruthy();
    });

    it('keeps the same position watch alive while minimized instead of remounting the session', () => {
        render(<PassageHudPane />);
        expect(gps.callbacks.size).toBe(1);
        const watch = [...gps.callbacks][0];
        fireEvent.click(screen.getByRole('button', { name: 'Show passage instruments' }));
        fireEvent.click(screen.getByRole('button', { name: 'Hide passage instruments' }));
        expect([...gps.callbacks]).toEqual([watch]);
    });

    it('clears overlapping chart credits and regains the space when they disappear', async () => {
        setPassageHudOpen(true);
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: HTMLElement,
        ) {
            if (this.getAttribute('aria-label')?.startsWith('Copernicus Marine data attribution')) {
                return { left: 90, right: 300, top: 62, bottom: 180, width: 210, height: 118 } as DOMRect;
            }
            const clearance = Number.parseFloat(this.style.getPropertyValue('--passage-hud-credit-clearance')) || 0;
            return { left: 0, right: 152, top: 60 + clearance, bottom: 600, width: 152, height: 540 } as DOMRect;
        });
        try {
            const chart = (creditVisible: boolean) => (
                <main>
                    {creditVisible && (
                        <aside aria-label="Copernicus Marine data attribution for waves">Marine data credit</aside>
                    )}
                    <PassageHudPane />
                </main>
            );
            const { rerender } = render(chart(true));
            expect(screen.getByTestId('passage-hud').style.getPropertyValue('--passage-hud-credit-clearance')).toBe(
                '128px',
            );
            rerender(chart(false));
            await waitFor(() =>
                expect(screen.getByTestId('passage-hud').style.getPropertyValue('--passage-hud-credit-clearance')).toBe(
                    '0px',
                ),
            );
        } finally {
            rect.mockRestore();
        }
    });
});

const phoneFix = (ageMs = 0): PhoneFix => ({ latitude: -27.5, longitude: 153, timestamp: Date.now() - ageMs });
const label = (id: string) => screen.getByTestId(id).getAttribute('aria-label') ?? '';

describe('the six numbers, live from the boat', () => {
    beforeEach(() => setPassageHudOpen(true));

    it('shows SOG, COG, true and apparent wind from the Pi over the LAN', () => {
        act(() => void NmeaStore.ingestRemote(snapshot()));
        render(<PassageHudPane />);
        expect(text('hud-sog')).toContain('6.1');
        expect(text('hud-cog')).toContain('044°');
        expect(text('hud-tws')).toContain('14');
        expect(text('hud-twd')).toContain('350°');
        expect(text('hud-aws')).toContain('18'); // 17.6 → whole knots at 10 and over
        expect(text('hud-awa')).toContain('33°P'); // negative is port
        expect(text('hud-lane')).toBe('VIA PI');
        expect(label('hud-lane')).toBe('Boat instruments, via the Pi');
    });

    it('tags what the GPS is DOING, from the resolver’s real wording', () => {
        render(<PassageHudPane />);
        expect(text('hud-gps')).toBe('GPS LIVE');
        expect(label('hud-gps')).toBe('On-board GPS · Live via the Pi · GPS · 11 sats · HDOP 0.9');
        cleanup();
        receiver.status = { ...receiver.status, detail: 'Last GPS sentence 3m ago via the Pi · GPS' };
        render(<PassageHudPane />);
        expect(text('hud-gps')).toBe('GPS 3M OLD');
        receiver.status = { ...receiver.status, detail: 'Live via the Pi · GPS · 11 sats · HDOP 0.9' };
    });

    it('shows dashes when the boat has no instruments — never the phone standing in', () => {
        gps.last = phoneFix();
        render(<PassageHudPane />);
        for (const id of ['hud-sog', 'hud-cog', 'hud-aws', 'hud-awa', 'hud-tws', 'hud-twd']) {
            expect(text(id), id).toContain('—');
            expect(screen.getByTestId(id).getAttribute('data-freshness')).toBe('none');
        }
        expect(text('hud-lane')).toBe('NO INSTR');
    });

    it('a missing sensor is a dash while the rest keep reading', () => {
        act(() => void NmeaStore.ingestRemote(snapshot({ twsKts: null, twdDeg: null })));
        render(<PassageHudPane />);
        expect(text('hud-tws')).toContain('—');
        expect(text('hud-twd')).toContain('—');
        expect(text('hud-sog')).toContain('6.1');
    });

    it('shows no course when she is not making way', () => {
        act(() => void NmeaStore.ingestRemote(snapshot({ sogKts: 0.3, cogDeg: 212 })));
        render(<PassageHudPane />);
        expect(text('hud-sog')).toContain('0.3');
        expect(text('hud-cog')).toContain('—');
        expect(text('hud-cog')).not.toContain('212');
        expect(label('hud-cog')).toContain('not making way');
    });

    it('tags a cloud reading for what it is — instruments AND position', () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ via: 'cloud' }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        expect(text('hud-lane')).toBe('CLOUD');
        expect(label('hud-lane')).toContain('not steering');
        expect(text('hud-fix-source')).toBe('BOAT · CLOUD');
    });

    it('follows the store while it is open', () => {
        render(<PassageHudPane />);
        expect(text('hud-sog')).toContain('—');
        act(() => void NmeaStore.ingestRemote(snapshot({ sogKts: 7.5 })));
        expect(text('hud-sog')).toContain('7.5');
    });
});

describe('the route she is following', () => {
    beforeEach(() => setPassageHudOpen(true));

    it('hides the HUD and disables its layer when no route is followed', () => {
        useFollowRouteStore.getState().stopFollowing();
        const { container } = render(<PassageHudPane />);
        expect(container).toBeEmptyDOMElement();
        expect(isPassageHudEnabled()).toBe(false);
        expect(gps.callbacks.size).toBe(0);
    });

    it('shows what is left ALONG the route, by the boat’s own GPS when she has one', () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ lat: -27.5, lon: 153 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        // 30 NM of the first leg left, plus ~53 NM of the second.
        expect(text('hud-route')).toMatch(/8[2-5]NM/);
        expect(text('hud-fix-source')).toBe('BOAT GPS');
        expect(label('hud-route')).toMatch(
            /Following Newport → Gladstone: 8[2-5] nautical miles to go, 30 of 11[2-5] along the route\. By the boat’s GPS\./,
        );
    });

    it('keeps working on this phone’s GPS when the boat lane is down — and says so', () => {
        // No NMEA at all: the Pi is off, or the Wednesday router reboot.
        gps.last = phoneFix();
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE));
        render(<PassageHudPane />);
        expect(text('hud-route')).toMatch(/8[2-5]NM/);
        expect(text('hud-fix-source')).toBe('PHONE GPS');
        // Passive watch only: it must never be able to raise a permission prompt.
        expect(gps.callbacks.size).toBe(1);
        expect(gps.watchOpts.every((o) => !(o as { ensureRunning?: boolean } | undefined)?.ensureRunning)).toBe(true);
        // …and the phone lends its POSITION only: the instruments stay dashes.
        expect(text('hud-sog')).toContain('—');
    });

    it('a fix is as old as its own stamp — an hours-old one is not a position, however fresh the hand-over', () => {
        gps.last = phoneFix(2 * 60 * 60_000);
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE));
        render(<PassageHudPane />);
        expect(text('hud-fix-source')).toBe('NO FIX');
        expect(label('hud-route')).toContain('No position — waiting for the boat’s GPS or this phone’s.');
        // The same goes for a stale delivery through the watch.
        act(() => gps.callbacks.forEach((cb) => cb(phoneFix(45 * 60_000))));
        expect(text('hud-fix-source')).toBe('NO FIX');
    });

    it('says when the phone fix is getting old, and lets go of it in the end', () => {
        vi.useFakeTimers();
        gps.last = phoneFix();
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE));
        render(<PassageHudPane />);
        expect(text('hud-fix-source')).toBe('PHONE GPS');
        act(() => void vi.advanceTimersByTime(3 * 60_000));
        expect(text('hud-fix-source')).toBe('PHONE 3M');
        act(() => void vi.advanceTimersByTime(8 * 60_000));
        expect(text('hud-fix-source')).toBe('NO FIX');
    });

    it('counts the way back to the line when she is off it, and flags it', () => {
        // ~5.3 NM east of the first leg.
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ lat: -27.5, lon: 153.1 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE);
        });
        render(<PassageHudPane />);
        expect(text('hud-off-line')).toMatch(/^5\.\d OFF$/);
        expect(text('hud-route')).toMatch(/(8[7-9]|9[0-1])NM/);
        expect(label('hud-route')).toMatch(/including 5\.\d back to the line/);
    });
});

describe('an out-and-back, where the same water is sailed twice', () => {
    const berth = { lat: -27.2, lon: 153.1 };
    const turn = { lat: -27.2 + 10 / 60, lon: 153.1 }; // 10 NM north
    const THERE_AND_BACK = [berth, turn, berth];
    const spot = { lat: -27.2 + 4 / 60, lon: 153.1 }; // 4 NM from the berth

    beforeEach(() => {
        setPassageHudOpen(true);
        __forgetReckoningForTests(THERE_AND_BACK);
    });

    it('her own COG decides which way she is going, from the first tick', () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ ...{ lat: spot.lat, lon: spot.lon }, sogKts: 6, cogDeg: 181 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', THERE_AND_BACK);
        });
        render(<PassageHudPane />);
        // Homeward: 4 NM to go, not 16.
        expect(text('hud-route')).toMatch(/^To go4\.0NM/);
    });

    it('outbound on the same spot she has 16 to go', () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ ...{ lat: spot.lat, lon: spot.lon }, sogKts: 6, cogDeg: 2 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', THERE_AND_BACK);
        });
        render(<PassageHudPane />);
        expect(text('hud-route')).toMatch(/^To go16NM/);
    });

    it('remembers she was homeward bound across a trip to another page, even lying stopped', () => {
        act(() => {
            void NmeaStore.ingestRemote(snapshot({ ...{ lat: spot.lat, lon: spot.lon }, sogKts: 6, cogDeg: 181 }));
            useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', THERE_AND_BACK);
        });
        const first = render(<PassageHudPane />);
        expect(text('hud-route')).toMatch(/^To go4\.0NM/);
        first.unmount(); // off to the Glass and back
        act(
            () =>
                void NmeaStore.ingestRemote(snapshot({ ...{ lat: spot.lat, lon: spot.lon }, sogKts: 0.2, cogDeg: 40 })),
        );
        render(<PassageHudPane />);
        expect(text('hud-route')).toMatch(/^To go4\.0NM/);
    });
});

describe('the chart’s Passage overlay stays the skipper’s switch', () => {
    beforeEach(() => {
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-1', ROUTE));
    });

    it('never flips it by opening, closing, mounting or unmounting', () => {
        const view = render(<PassageHudPane />);
        act(() => setPassageHudOpen(true));
        expect(isPassageOverlayOn()).toBe(false);
        act(() => setPassageHudOpen(false));
        expect(isPassageOverlayOn()).toBe(false);
        act(() => setPassageOverlay(true));
        act(() => setPassageHudOpen(true));
        act(() => setPassageHudOpen(false));
        view.unmount();
        expect(isPassageOverlayOn()).toBe(true);
    });

    it('offers one explicit button to put the route and track on the chart, and says where OFF lives', () => {
        setPassageHudOpen(true);
        render(<PassageHudPane />);
        const button = screen.getByTestId('hud-show-passage') as HTMLButtonElement;
        expect(button.getAttribute('aria-label')).toBe('Show route and track on the chart');
        fireEvent.click(button);
        expect(isPassageOverlayOn()).toBe(true);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toContain('Turn them off with Passage in the layer button');
    });

    it('keeps the HUD unavailable without a followed route, even during an active voyage', () => {
        act(() => useFollowRouteStore.getState().stopFollowing());
        setPassageHudOpen(true);
        const view = render(<PassageHudPane />);
        expect(view.container).toBeEmptyDOMElement();
        view.unmount();
        // The recording can still have its separate Passage overlay; it does
        // not supply the route geometry required by this HUD.
        voyage.active = { id: 'v1' };
        setPassageHudEnabled(true);
        const recording = render(<PassageHudPane />);
        expect(recording.container).toBeEmptyDOMElement();
        expect(isPassageHudEnabled()).toBe(false);
    });
});
