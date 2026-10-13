/**
 * The Glass's Locations box: saved places delete with a swipe (Shane
 * 2026-10-13, build 128): "these locations in the location box will not remove
 * when i press the remove button. however, i would prefer them to be a swipe
 * delete, like almost all of the rest of the app."
 *
 * Why Remove never deleted: it opened a 'Remove saved place?' confirm through
 * its own portal at z 1100, under the flyout's dim (z-9998) and panel (z 9999),
 * and the flyout's outside-tap listener (touchstart / mousedown on the
 * document) counted a tap on that confirm as outside the menu: the finger
 * landing closed the flyout, the confirm went with it, and the click that
 * followed landed on nothing.
 *
 * Now each saved place's row slides left to show Delete, as the saved-route
 * rows do (components/routes/SwipeableSavedRouteRow.tsx): Delete, then Confirm,
 * since a saved place has no undo here either. Set home stays a tap; Home, the
 * boats and Current Location do not slide. Fixtures are fictional and global.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Coords = Record<string, { lat: number; lon: number }>;
interface FixtureSettings {
    defaultLocation: string;
    savedLocations: string[];
    savedLocationCoords: Coords;
    homePort?: string;
    vessel?: { name?: string };
}

const h = vi.hoisted(() => ({
    initial: null as unknown as FixtureSettings,
    updateSettings: vi.fn(),
    selectLocation: vi.fn(async () => undefined),
}));

// A settings store that keeps what it is given, so a delete re-renders the
// menu exactly as the app's store does.
vi.mock('../context/SettingsContext', async () => {
    const { useState } = await import('react');
    return {
        useSettings: () => {
            const [settings, setSettings] = useState(h.initial);
            return {
                settings,
                updateSettings: (patch: Partial<FixtureSettings>) => {
                    h.updateSettings(patch);
                    setSettings((previous) => ({ ...previous, ...patch }));
                },
            };
        },
    };
});
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: { locationName: 'Annapolis, MD, US', coordinates: { lat: 38.98, lon: -76.49 } },
        selectLocation: h.selectLocation,
        positionSource: null,
    }),
}));
vi.mock('../components/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { LocationStarMenu } from '../components/LocationStarMenu';
import { buildRemoveLocationPatch } from '../utils/savedLocations';

const FALMOUTH = 'Falmouth, England, GB';
const LYTTELTON = 'Lyttelton, Canterbury, NZ';
const GRIMAUD = 'Port Grimaud, Var, FR';

const fixture = (over: Partial<FixtureSettings> = {}): FixtureSettings => ({
    defaultLocation: 'Current Location',
    savedLocations: [FALMOUTH, LYTTELTON, GRIMAUD],
    savedLocationCoords: {
        [FALMOUTH]: { lat: 50.153, lon: -5.067 },
        [LYTTELTON]: { lat: -43.603, lon: 172.72 },
        [GRIMAUD]: { lat: 43.272, lon: 6.581 },
    },
    homePort: undefined,
    vessel: { name: 'Kestrel' },
    ...over,
});

/** A thumb on the glass: touches at clientX, dispatched as the hook hears them. */
function touch(el: Element, type: string, x: number, y = 200) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : point });
    Object.defineProperty(event, 'changedTouches', { value: point });
    act(() => {
        el.dispatchEvent(event);
    });
}

/** A right-to-left swipe of `distance` px across the element. */
function swipeLeft(el: Element, distance = 90) {
    const start = 300;
    touch(el, 'touchstart', start);
    for (let step = 1; step <= 6; step++) touch(el, 'touchmove', start - (distance * step) / 6);
    touch(el, 'touchend', start - distance);
}

/** Whether a row sits in a swipeable box (useSwipeable claims the sideways pan). */
function slides(el: Element): boolean {
    for (let node: Element | null = el; node; node = node.parentElement) {
        if ((node as HTMLElement).style?.touchAction === 'pan-y') return true;
    }
    return false;
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Saved locations' }));
const row = (name: string) => screen.getByRole('menuitem', { name });
/** The pinned Home row: its name, then its 'Home' badge. */
const homeRow = () => screen.getByRole('menuitem', { name: /^Port Grimaud, Var, FR\s*Home$/ });

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.initial = fixture();
});

describe('Locations box: saved places delete with a swipe', () => {
    it('a saved row has no Remove button any more; Set home stays a tap', () => {
        render(<LocationStarMenu />);
        openMenu();
        const menu = screen.getByRole('menu', { name: 'Saved locations' });
        expect(within(menu).queryByRole('menuitem', { name: `Remove ${FALMOUTH}` })).toBeNull();
        expect(within(menu).queryByText('Remove')).toBeNull();
        // Nothing to delete shows until a row is swiped.
        expect(within(menu).queryByRole('menuitem', { name: `Delete ${FALMOUTH}` })).toBeNull();

        fireEvent.click(row(`Set home port to ${FALMOUTH}`));
        expect(h.updateSettings).toHaveBeenCalledWith({ homePort: FALMOUTH });
    });

    it('swipe left shows Delete, Delete arms Confirm, Confirm takes the place out of both stores and the menu stays open', () => {
        render(<LocationStarMenu />);
        openMenu();
        swipeLeft(row(FALMOUTH));

        const del = row(`Delete ${FALMOUTH}`);
        expect(del).toHaveTextContent('Delete');
        fireEvent.click(del);
        expect(h.updateSettings).not.toHaveBeenCalled();
        const confirm = row(`Confirm delete ${FALMOUTH}`);
        expect(confirm).toHaveTextContent('Confirm');

        fireEvent.click(confirm);
        expect(h.updateSettings).toHaveBeenCalledTimes(1);
        expect(h.updateSettings).toHaveBeenCalledWith({
            savedLocations: [LYTTELTON, GRIMAUD],
            savedLocationCoords: {
                [LYTTELTON]: { lat: -43.603, lon: 172.72 },
                [GRIMAUD]: { lat: 43.272, lon: 6.581 },
            },
        });
        expect(screen.queryByRole('menuitem', { name: FALMOUTH })).toBeNull();
        // The flyout stays open for the next one; the other places keep their rows.
        expect(screen.getByRole('menu', { name: 'Saved locations' })).toBeInTheDocument();
        expect(row(LYTTELTON)).toBeInTheDocument();
        expect(row(GRIMAUD)).toBeInTheDocument();
        expect(h.selectLocation).not.toHaveBeenCalled();
    });

    it("a swipe never fires the row's tap, and a tap on a swiped row only closes it", () => {
        render(<LocationStarMenu />);
        openMenu();

        // A short swipe that snaps back is still a swipe, not a tap.
        swipeLeft(row(LYTTELTON), 16);
        fireEvent.click(row(LYTTELTON));
        expect(h.selectLocation).not.toHaveBeenCalled();
        expect(screen.queryByRole('menuitem', { name: `Delete ${LYTTELTON}` })).toBeNull();

        // A full swipe latches open; the click the release makes does not go there.
        swipeLeft(row(LYTTELTON));
        fireEvent.click(row(LYTTELTON));
        expect(h.selectLocation).not.toHaveBeenCalled();
        expect(row(`Delete ${LYTTELTON}`)).toBeInTheDocument();

        // The next tap on the open row closes it, and still goes nowhere.
        fireEvent.click(row(LYTTELTON));
        expect(h.selectLocation).not.toHaveBeenCalled();
        expect(screen.queryByRole('menuitem', { name: `Delete ${LYTTELTON}` })).toBeNull();
        // Set home on a swiped row is not set either.
        swipeLeft(row(LYTTELTON));
        fireEvent.click(row(`Set home port to ${LYTTELTON}`));
        expect(h.updateSettings).not.toHaveBeenCalled();
    });

    it('a plain tap still goes to the place, even straight after a swipe that snapped back', () => {
        render(<LocationStarMenu />);
        openMenu();
        swipeLeft(row(GRIMAUD), 16);
        // A new touch is a new gesture: lifted where it landed, it is a tap.
        touch(row(GRIMAUD), 'touchstart', 200);
        touch(row(GRIMAUD), 'touchend', 201);
        fireEvent.click(row(GRIMAUD));
        expect(h.selectLocation).toHaveBeenCalledWith(GRIMAUD, { lat: 43.272, lon: 6.581 });
    });

    it('a tap whose thumb rolls a few px sideways still goes to the place, as on the route rows', () => {
        render(<LocationStarMenu />);
        openMenu();
        // 8 px: past useSwipeable's 6 px lock, so the row slides and snaps
        // back, but a tap's natural drift, and WebKit still calls it a click.
        touch(row(LYTTELTON), 'touchstart', 200);
        touch(row(LYTTELTON), 'touchmove', 192);
        touch(row(LYTTELTON), 'touchend', 192);
        expect(screen.queryByRole('menuitem', { name: `Delete ${LYTTELTON}` })).toBeNull();
        fireEvent.click(row(LYTTELTON));
        expect(h.selectLocation).toHaveBeenCalledWith(LYTTELTON, { lat: -43.603, lon: 172.72 });
    });

    it('Home, the boat and Current Location do not slide and offer no Delete', () => {
        h.initial = fixture({ homePort: GRIMAUD });
        render(<LocationStarMenu />);
        openMenu();
        for (const el of [homeRow(), screen.getByTestId('location-star-vessel'), row('Current Location')]) {
            swipeLeft(el);
            expect(slides(el)).toBe(false);
        }
        expect(screen.queryByRole('menuitem', { name: /^Delete / })).toBeNull();
        expect(screen.queryByRole('menuitem', { name: /^Confirm delete / })).toBeNull();
        // The saved places under them do slide.
        expect(slides(row(FALMOUTH))).toBe(true);
    });

    it('one row is armed at a time', () => {
        render(<LocationStarMenu />);
        openMenu();
        swipeLeft(row(FALMOUTH));
        fireEvent.click(row(`Delete ${FALMOUTH}`));
        expect(row(`Confirm delete ${FALMOUTH}`)).toBeInTheDocument();
        swipeLeft(row(LYTTELTON));
        fireEvent.click(row(`Delete ${LYTTELTON}`));
        expect(row(`Confirm delete ${LYTTELTON}`)).toBeInTheDocument();
        expect(row(`Delete ${FALMOUTH}`)).toHaveTextContent('Delete');
        expect(h.updateSettings).not.toHaveBeenCalled();
    });

    it('a deleted place that was home takes Home with it (home is only valid while it exists)', () => {
        // Home named with other capitals than its saved entry (a save from
        // another device): the box lists it as a place, and deleting it must
        // not leave Home pointing at a name that comes back on the next save.
        h.initial = fixture({ homePort: 'LYTTELTON, CANTERBURY, NZ' });
        render(<LocationStarMenu />);
        openMenu();
        swipeLeft(row(LYTTELTON));
        fireEvent.click(row(`Delete ${LYTTELTON}`));
        fireEvent.click(row(`Confirm delete ${LYTTELTON}`));
        expect(h.updateSettings).toHaveBeenCalledWith(
            expect.objectContaining({ savedLocations: [FALMOUTH, GRIMAUD], homePort: undefined }),
        );
    });

    it('deleting any other place leaves Home alone', () => {
        h.initial = fixture({ homePort: GRIMAUD });
        render(<LocationStarMenu />);
        openMenu();
        swipeLeft(row(FALMOUTH));
        fireEvent.click(row(`Delete ${FALMOUTH}`));
        fireEvent.click(row(`Confirm delete ${FALMOUTH}`));
        const patch = h.updateSettings.mock.calls[0][0];
        expect(patch).not.toHaveProperty('homePort');
        expect(patch.savedLocations).toEqual([LYTTELTON, GRIMAUD]);
        // Home is still pinned first.
        expect(screen.getAllByRole('menuitem')[0]).toBe(homeRow());
    });
});

describe('buildRemoveLocationPatch', () => {
    it('drops the place from the names and the coordinates, by any capitals, and keeps the rest in order', () => {
        const coords = fixture().savedLocationCoords;
        expect(buildRemoveLocationPatch([FALMOUTH, LYTTELTON, GRIMAUD], coords, 'falmouth, england, gb')).toEqual({
            savedLocations: [LYTTELTON, GRIMAUD],
            savedLocationCoords: { [LYTTELTON]: coords[LYTTELTON], [GRIMAUD]: coords[GRIMAUD] },
        });
    });
});
