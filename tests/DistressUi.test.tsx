/**
 * What the skipper sees of a distress beacon (build 125, package 125-02):
 *
 *  - A beacon her own radio hears going active: a red card above every other
 *    alarm, naming the beacon, where it is and how long ago it was heard, with
 *    Silence alarm (the card stays) and Go to it. With no position yet it says
 *    'Position not yet received' and offers no Go-to.
 *  - One relayed over the internet: a silent card that says it was relayed,
 *    not heard by her radio, and how old the report is.
 *  - Go to it hands off to the Man Overboard page, which steers to the
 *    beacon and follows it as it drifts, bearing and range from her own
 *    position, across the antimeridian too.
 *  - Her own MOB is never out of reach: Go to it lasts one visit, the beacon
 *    view marks a MOB at once, and her own MOB marked later (here or on the
 *    Watch) shows first.
 *
 * Fictional MMSIs only (970/972/974 with manufacturer 00; MID 123).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
    type Active = { fixLat: number; fixLon: number; fixAccuracy: number; activatedAt: number };
    const mob = {
        active: null as Active | null,
        listeners: new Set<(state: unknown) => void>(),
        state() {
            return {
                active: mob.active,
                own: null,
                distanceMeters: null,
                bearingDeg: null,
                ownPositionAgeMs: null,
                ownPositionFresh: false,
                elapsedSec: 0,
                fixQuality: null,
                persistenceStatus: mob.active ? 'confirmed' : 'idle',
            };
        },
        /** Her own MOB marked (here, on the Watch or from the chart), as MobService announces it. */
        mark(at: number) {
            mob.active = { fixLat: -17.2, fixLon: 179.95, fixAccuracy: 8, activatedAt: at };
            for (const listener of mob.listeners) listener(mob.state());
            return mob.active;
        },
    };
    return {
        radio: { lat: -17.2, lon: 179.95 } as { lat: number; lon: number } | null,
        mob,
        activate: vi.fn(),
    };
});

vi.mock('../hooks/useRadioPosition', () => ({
    useRadioPosition: () => ({
        position: hoisted.radio
            ? {
                  latitude: hoisted.radio.lat,
                  longitude: hoisted.radio.lon,
                  timestamp: Date.now(),
                  source: 'bus',
                  sourceLabel: 'Boat GPS',
                  isVessel: true,
              }
            : null,
        ageMs: hoisted.radio ? 1_000 : null,
        isLive: !!hoisted.radio,
        isFresh: !!hoisted.radio,
        acquiring: false,
        refreshing: false,
        error: false,
        refresh: async () => {},
        requestGpsAccess: async () => {},
    }),
}));
vi.mock('../services/MobService', () => ({
    MOB_PRECISE_FIX_ACCURACY_M: 100,
    MobService: {
        activate: (...args: unknown[]) => hoisted.activate(...args),
        clear: vi.fn(),
        currentState: () => hoisted.mob.state(),
        subscribe: (listener: (state: unknown) => void) => {
            hoisted.mob.listeners.add(listener);
            return () => hoisted.mob.listeners.delete(listener);
        },
    },
}));
vi.mock('../services/voice/safetyTts', () => ({
    prewarmSafetyMessage: vi.fn(),
    speakSafetyMessage: vi.fn(() => ({ done: Promise.resolve(), cancel: vi.fn(), engineUsed: () => 'none' })),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: { name: 'Fictional Ketch', type: 'sail' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { AisGuardAlert } from '../components/map/AisGuardAlert';
import { MobPage } from '../components/vessel/MobPage';
import { AisGuardAlertStore, type CollisionAlertCard, type DistressBeacon } from '../services/aisGuardAlertStore';
import { useUIStore } from '../stores/uiStore';

const T0 = Date.UTC(2026, 9, 9, 6, 0, 0);

function beacon(over: Partial<DistressBeacon>): DistressBeacon {
    return {
        mmsi: 970_000_401,
        name: '',
        kind: 'sart',
        state: 'active',
        source: 'local',
        sounds: true,
        lat: -17.25,
        lon: 179.9,
        heardAt: T0 - 12_000,
        rangeNm: 4.2,
        bearingDeg: 230,
        ...over,
    };
}

const collisionCard: CollisionAlertCard = {
    mmsi: 123_400_402,
    name: 'FICTIONAL TRADER',
    distanceNm: 1.4,
    bearing: 44,
    sog: 11.5,
    cog: 230,
    shipType: '70',
    timestamp: T0,
    collision: { cpaNm: 0.2, tcpaMin: 7.5, closeQuarters: false, reportAgeSec: 12, source: 'local' },
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    AisGuardAlertStore.clear();
    hoisted.radio = { lat: -17.2, lon: 179.95 };
    hoisted.mob.active = null;
    hoisted.mob.listeners.clear();
    hoisted.activate.mockReset();
    hoisted.activate.mockImplementation(async () => hoisted.mob.mark(Date.now()));
    useUIStore.setState({ currentView: 'map', previousView: 'map' });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('the distress card', () => {
    it('an active beacon her radio hears: red, above a collision card, naming it, where and how long ago', () => {
        act(() => {
            AisGuardAlertStore.setCollision([collisionCard], T0);
            AisGuardAlertStore.setDistress([beacon({})], T0);
        });
        render(<AisGuardAlert />);
        const cards = screen.getAllByRole('alert');
        expect(cards).toHaveLength(2);
        const distress = cards[0];
        expect(distress).toHaveTextContent('DISTRESS: AIS-SART ACTIVE');
        expect(distress).toHaveTextContent('MMSI 970000401');
        expect(distress).toHaveTextContent('230° · 4.2 NM');
        expect(distress).toHaveTextContent('Heard by your radio, 12 s ago');
        expect(cards[1]).toHaveTextContent('COLLISION RISK');
        // A sounding distress card lifts the stack above the night tint, as an alarm.
        expect(Number(screen.getByTestId('ais-guard-stack').style.zIndex)).toBeGreaterThan(9000);
    });

    it('Silence alarm keeps the card, then offers Dismiss; Go to it stays', () => {
        act(() => AisGuardAlertStore.setDistress([beacon({})], T0));
        render(<AisGuardAlert />);
        const card = screen.getByRole('alert');
        fireEvent.click(within(card).getByRole('button', { name: 'Silence the distress alarm for MMSI 970000401' }));
        const after = screen.getByRole('alert');
        expect(after).toHaveTextContent('DISTRESS: AIS-SART ACTIVE');
        expect(within(after).queryByRole('button', { name: /Silence/ })).toBeNull();
        expect(within(after).getByRole('button', { name: 'Go to AIS-SART MMSI 970000401' })).toBeInTheDocument();
        fireEvent.click(within(after).getByRole('button', { name: 'Dismiss AIS-SART MMSI 970000401' }));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it("a beacon with no position: 'Position not yet received', and no Go-to", () => {
        act(() =>
            AisGuardAlertStore.setDistress(
                [beacon({ mmsi: 972_000_403, kind: 'mob', lat: null, lon: null, rangeNm: null, bearingDeg: null })],
                T0,
            ),
        );
        render(<AisGuardAlert />);
        const card = screen.getByRole('alert');
        expect(card).toHaveTextContent('DISTRESS: MAN OVERBOARD BEACON ACTIVE');
        expect(card).toHaveTextContent('Position not yet received');
        expect(within(card).queryByRole('button', { name: /^Go to/ })).toBeNull();
        expect(
            within(card).getByRole('button', { name: 'Silence the distress alarm for MMSI 972000403' }),
        ).toBeInTheDocument();
    });

    it('relayed over the internet: silent, says so, with the age; no Silence button', () => {
        act(() =>
            AisGuardAlertStore.setDistress(
                [beacon({ mmsi: 974_000_404, kind: 'epirb', source: 'cloud', sounds: false, heardAt: T0 - 360_000 })],
                T0,
            ),
        );
        render(<AisGuardAlert />);
        const card = screen.getByRole('alert');
        expect(card).toHaveTextContent('DISTRESS: EPIRB-AIS ACTIVE');
        expect(card).toHaveTextContent('Relayed via internet, not heard by your radio, 6 min old');
        expect(within(card).queryByRole('button', { name: /Silence/ })).toBeNull();
        expect(within(card).getByRole('button', { name: 'Go to EPIRB-AIS MMSI 974000404' })).toBeInTheDocument();
        // Silent: the stack is not an alarm.
        expect(Number(screen.getByTestId('ais-guard-stack').style.zIndex)).toBe(9000);
    });

    it('a test beacon is drawn on the chart but not carded; a caution is carded quietly', () => {
        act(() =>
            AisGuardAlertStore.setDistress(
                [
                    beacon({ state: 'test', sounds: false }),
                    beacon({ mmsi: 972_000_405, kind: 'mob', state: 'caution', sounds: false }),
                ],
                T0,
            ),
        );
        render(<AisGuardAlert />);
        const cards = screen.getAllByRole('alert');
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveTextContent('MAN OVERBOARD BEACON HEARD: NOT ACTIVE OR TEST');
        expect(within(cards[0]).queryByRole('button', { name: /Silence/ })).toBeNull();
    });

    it('Go to it hands off to the Man Overboard page with that beacon', () => {
        act(() => AisGuardAlertStore.setDistress([beacon({})], T0));
        render(<AisGuardAlert />);
        fireEvent.click(screen.getByRole('button', { name: 'Go to AIS-SART MMSI 970000401' }));
        expect(AisGuardAlertStore.getDistressGoTo()).toBe(970_000_401);
        expect(useUIStore.getState().currentView).toBe('mob');
    });
});

describe('Go to it, on the Man Overboard page', () => {
    function goTo(b: DistressBeacon) {
        act(() => {
            AisGuardAlertStore.setDistress([b], T0);
            AisGuardAlertStore.goToDistress(b.mmsi);
        });
    }

    it('steers to the beacon from her own position, across the antimeridian (Fiji)', () => {
        // Her GPS at 179.95E, the SART at 179.95W: 0.1° of longitude east, not 359.9° west.
        goTo(beacon({ lat: -17.2, lon: -179.95 }));
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByText('Bearing to beacon')).toBeInTheDocument();
        expect(screen.getByTestId('beacon-bearing')).toHaveTextContent('090°');
        // 0.1° of longitude at 17.2°S is 5.74 NM.
        expect(screen.getByTestId('beacon-range')).toHaveTextContent('5.74 NM');
        expect(screen.getByRole('status')).toHaveTextContent('Heard by your radio, 12 s ago');
    });

    it('follows the beacon as it drifts: a new report moves the bearing and range', () => {
        hoisted.radio = { lat: 57.14, lon: -2.08 };
        goTo(beacon({ mmsi: 972_000_406, kind: 'mob', lat: 57.15, lon: -2.08 }));
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByTestId('beacon-bearing')).toHaveTextContent('000°');
        expect(screen.getByTestId('beacon-range')).toHaveTextContent('1112 m');
        act(() => {
            vi.setSystemTime(T0 + 60_000);
            AisGuardAlertStore.setDistress(
                [beacon({ mmsi: 972_000_406, kind: 'mob', lat: 57.14, lon: -2.06, heardAt: T0 + 58_000 })],
                T0 + 60_000,
            );
        });
        expect(screen.getByTestId('beacon-bearing')).toHaveTextContent('090°');
        expect(screen.getByTestId('beacon-range')).toHaveTextContent('1207 m');
        expect(screen.getByRole('status')).toHaveTextContent('Heard by your radio, 2 s ago');
    });

    it('without a fresh fix of her own, hides bearing and range rather than guess', () => {
        hoisted.radio = null;
        goTo(beacon({}));
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByTestId('beacon-bearing')).toHaveTextContent('—');
        expect(screen.getByText(/No fresh position of our own/)).toBeInTheDocument();
    });

    it("on this page the followed beacon's card stands aside, others stay; the page carries Silence", () => {
        act(() => {
            AisGuardAlertStore.setDistress(
                [beacon({}), beacon({ mmsi: 972_000_407, kind: 'mob', lat: -17.3, lon: 179.8 })],
                T0,
            );
            AisGuardAlertStore.goToDistress(970_000_401);
            useUIStore.setState({ currentView: 'mob' });
        });
        render(
            <>
                <AisGuardAlert />
                <MobPage onBack={() => undefined} />
            </>,
        );
        const cards = screen.getAllByRole('alert');
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveTextContent('MMSI 972000407');
        fireEvent.click(screen.getByRole('button', { name: 'Silence the distress alarm for MMSI 970000401' }));
        expect(AisGuardAlertStore.distressSilenced(970_000_401)).toBe(true);
        expect(screen.queryByRole('button', { name: 'Silence the distress alarm for MMSI 970000401' })).toBeNull();
        // Back on the chart, its card returns (silenced: Dismiss, not Silence).
        act(() => useUIStore.setState({ currentView: 'map' }));
        expect(screen.getAllByRole('alert')).toHaveLength(2);
    });

    it('Stop going to it returns to the Man Overboard page', () => {
        goTo(beacon({}));
        render(<MobPage onBack={() => undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'Stop going to it' }));
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
        expect(screen.getByRole('button', { name: /^MOB, mark position/ })).toBeInTheDocument();
    });
});

describe('her own MOB is never out of reach from Go to it', () => {
    /** The deferred release of the page's hold (it waits a tick for React's dev remount). */
    const nextTick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    function goTo(b: DistressBeacon) {
        act(() => {
            AisGuardAlertStore.setDistress([b], T0);
            AisGuardAlertStore.goToDistress(b.mmsi);
        });
    }

    it('leaving by the back button ends Go to it: next time the page opens on the MOB button', async () => {
        goTo(beacon({}));
        const onBack = vi.fn();
        const first = render(<MobPage onBack={onBack} backLabel="Back to Obs" />);
        expect(screen.getByText('Bearing to beacon')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to Obs' }));
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
        first.unmount();
        await nextTick();

        // Hours later, from the Vessel MOB tile.
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByRole('button', { name: /^MOB, mark position/ })).toBeInTheDocument();
        expect(screen.queryByText('Bearing to beacon')).toBeNull();
    });

    it('leaving any other way (the tab bar, the chart) ends it too; a remount at once (dev StrictMode) does not', async () => {
        goTo(beacon({}));
        const first = render(<MobPage onBack={() => undefined} />);
        first.unmount();
        // React's development double mount: unmounted and mounted again in the same tick.
        const again = render(<MobPage onBack={() => undefined} />);
        await nextTick();
        expect(AisGuardAlertStore.getDistressGoTo()).toBe(970_000_401);
        expect(screen.getByText('Bearing to beacon')).toBeInTheDocument();

        again.unmount();
        await nextTick();
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByRole('button', { name: /^MOB, mark position/ })).toBeInTheDocument();
    });

    it('the beacon view marks her own MOB at once, and her MOB then shows', async () => {
        goTo(beacon({}));
        render(<MobPage onBack={() => undefined} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'MOB, mark position' }));
        });
        expect(hoisted.activate).toHaveBeenCalledTimes(1);
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
        expect(screen.getByText('MOB ACTIVE')).toBeInTheDocument();
        expect(screen.queryByText('Bearing to beacon')).toBeNull();
    });

    it("her own MOB marked on the Watch while going to a beacon shows first, and the beacon's card returns", () => {
        act(() => useUIStore.setState({ currentView: 'mob' }));
        goTo(beacon({}));
        render(
            <>
                <AisGuardAlert />
                <MobPage onBack={() => undefined} />
            </>,
        );
        expect(screen.queryAllByRole('alert')).toHaveLength(0);
        act(() => {
            vi.setSystemTime(T0 + 5_000);
            hoisted.mob.mark(Date.now());
        });
        expect(screen.getByText('MOB ACTIVE')).toBeInTheDocument();
        expect(screen.queryByText('Bearing to beacon')).toBeNull();
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
        // The beacon's card is back in the stack, with Go to it: the way back to the beacon.
        expect(screen.getByRole('button', { name: 'Go to AIS-SART MMSI 970000401' })).toBeInTheDocument();
    });

    it('Go to it chosen with her own MOB already marked shows the beacon, and Back to your MOB returns', () => {
        hoisted.mob.mark(T0 - 60_000);
        goTo(beacon({ mmsi: 972_000_408, kind: 'mob' }));
        render(<MobPage onBack={() => undefined} />);
        expect(screen.getByText('Bearing to beacon')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'MOB, mark position' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Back to your MOB' }));
        expect(hoisted.activate).not.toHaveBeenCalled();
        expect(screen.getByText('MOB ACTIVE')).toBeInTheDocument();
        expect(AisGuardAlertStore.getDistressGoTo()).toBeNull();
    });
});
