/**
 * What the skipper sees of the under-way alarms (build 126, 126-02a):
 *  - the cards ride the app-wide alarm stack (components/map/AisGuardAlert.tsx)
 *    under the collision cards: distress, collision, shoal, then off route;
 *    each says the number and what it is measured from, with one 44 pt button
 *    (shoal: Acknowledge; off route: Mute 30 min, then 'Muted until');
 *  - the strip says when the watch cannot see;
 *  - Settings → Preferences → "Under-way alarms", right after "Collision
 *    alarm": two switches (ON by default, for every account), the off-route
 *    limits, the margin under the keel, the draft-not-set warning when it
 *    applies, and the honest "only while Thalassa is running" line.
 *
 * Fictional boats and vessel names only.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => ({ enabled: false, radiusNm: 2, alerts: [] }),
        subscribe: () => () => undefined,
        setEnabled: vi.fn(),
        armAfterSoundCheck: vi.fn(),
        setRadius: vi.fn(),
    },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { AisGuardAlert } from '../components/map/AisGuardAlert';
import { AisGuardAlertStore, type CollisionAlertCard } from '../services/aisGuardAlertStore';
import { UnderwayAlarmStore, type UnderwayAlarmCard } from '../services/underway/underwayAlarmStore';
import { NIGHT_SCRIM_Z_INDEX } from '../components/ui/OverlayPortal';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);

const COLLISION: CollisionAlertCard = {
    mmsi: 123400801,
    name: 'FICTIONAL TRADER',
    distanceNm: 1.4,
    bearing: 44,
    sog: 11.5,
    cog: 230,
    shipType: '70',
    timestamp: T0,
    collision: { cpaNm: 0.2, tcpaMin: 7.5, closeQuarters: false, reportAgeSec: 12, source: 'local' },
};

const SHOAL: UnderwayAlarmCard = {
    kind: 'shoal',
    title: 'SHOAL WATER',
    value: 'about 0.4 m under the keel',
    detail: 'Your sounder reads 2.8 m below the waterline, minus your 2.4 m draft.',
    note: 'Margin under the keel: 0.5 m',
    sounding: true,
    mutedUntil: null,
};

const OFF_ROUTE: UnderwayAlarmCard = {
    kind: 'off-route',
    title: 'OFF ROUTE',
    value: '0.40 NM off the line',
    detail: 'Limit 0.25 NM inshore.',
    sounding: true,
    mutedUntil: null,
};

const WATCH_SOUNDING: UnderwayAlarmCard = {
    kind: 'watch-check',
    title: 'WATCH CHECK',
    value: "Tap I'm on watch",
    detail: "Nobody has tapped I'm on watch for 15 min",
    sounding: true,
    mutedUntil: null,
};

const WATCH_WARNING: UnderwayAlarmCard = {
    kind: 'watch-check',
    title: 'WATCH CHECK',
    value: 'Watch check in 1 min',
    detail: 'Every 15 min while the track records',
    sounding: false,
    mutedUntil: null,
};

beforeEach(() => {
    AisGuardAlertStore.clear();
    UnderwayAlarmStore.clear();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the under-way cards in the alarm stack', () => {
    it('stack under the collision cards: collision, shoal, then off route', async () => {
        act(() => {
            AisGuardAlertStore.setCollision([COLLISION], T0);
            UnderwayAlarmStore.set([OFF_ROUTE, SHOAL], []);
        });
        render(<AisGuardAlert />);
        const shoal = await screen.findByText('SHOAL WATER');
        const offRoute = screen.getByText('OFF ROUTE');
        const collision = screen.getByText('FICTIONAL TRADER');
        expect(collision.compareDocumentPosition(shoal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(shoal.compareDocumentPosition(offRoute) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getAllByRole('alert')).toHaveLength(3);
    });

    it('a shoal card gives the number, what it is measured from, and Acknowledge', async () => {
        const actions: string[] = [];
        UnderwayAlarmStore.subscribeActions((a) => actions.push(a.kind));
        act(() => UnderwayAlarmStore.set([SHOAL], []));
        render(<AisGuardAlert />);
        const card = (await screen.findByText('SHOAL WATER')).closest('[role="alert"]') as HTMLElement;
        expect(card).toHaveTextContent('about 0.4 m under the keel');
        expect(card).toHaveTextContent('Your sounder reads 2.8 m below the waterline, minus your 2.4 m draft.');
        expect(card).toHaveTextContent('Margin under the keel: 0.5 m');
        const button = within(card).getByRole('button', { name: 'Acknowledge the shoal alarm' });
        expect(button.style.minHeight).toBe('44px');
        expect(button.style.minWidth).toBe('44px');
        fireEvent.click(button);
        expect(actions).toEqual(['shoal']);
        // Acknowledged: the card stands aside until the water deepens and it re-arms.
        expect(screen.queryByText('SHOAL WATER')).toBeNull();
    });

    it('an off-route card mutes for 30 minutes and then says until when, with no button', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(T0);
        const actions: string[] = [];
        UnderwayAlarmStore.subscribeActions((a) => actions.push(a.kind));
        act(() => UnderwayAlarmStore.set([OFF_ROUTE], []));
        render(<AisGuardAlert />);
        const card = (await screen.findByText('OFF ROUTE')).closest('[role="alert"]') as HTMLElement;
        expect(card).toHaveTextContent('0.40 NM off the line');
        expect(card).toHaveTextContent('Limit 0.25 NM inshore.');
        const mute = within(card).getByRole('button', { name: 'Mute the off-route alarm for 30 minutes' });
        expect(mute.style.minHeight).toBe('44px');
        fireEvent.click(mute);
        expect(actions).toEqual(['off-route']);
        const muted = screen.getByText('OFF ROUTE').closest('[role="alert"]') as HTMLElement;
        expect(muted).toHaveTextContent(/Muted until \d{2}:\d{2}/);
        expect(within(muted).queryByRole('button')).toBeNull();
    });

    it('a sounding under-way card lifts the stack above the night tint', async () => {
        act(() => UnderwayAlarmStore.set([SHOAL], []));
        render(<AisGuardAlert />);
        await screen.findByText('SHOAL WATER');
        expect(Number(screen.getByTestId('ais-guard-stack').style.zIndex)).toBe(NIGHT_SCRIM_Z_INDEX + 1);
    });

    it('says when the watch cannot see, in the strip', async () => {
        act(() => UnderwayAlarmStore.set([], ['Off-route alarm arms once you are on the route.']));
        render(<AisGuardAlert />);
        expect(await screen.findByRole('status')).toHaveTextContent('Off-route alarm arms once you are on the route.');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    // 126-02b: the watch check rides last, after off route.
    it('the watch check sits last, after off route, and only I’m on watch answers it', async () => {
        const actions: string[] = [];
        UnderwayAlarmStore.subscribeActions((a) => actions.push(a.kind));
        act(() => {
            UnderwayAlarmStore.setWatchCheck(WATCH_SOUNDING, []);
            UnderwayAlarmStore.set([OFF_ROUTE, SHOAL], []);
        });
        render(<AisGuardAlert />);
        const watch = (await screen.findByText("Tap I'm on watch")).closest('[role="alert"]') as HTMLElement;
        const offRoute = screen.getByText('OFF ROUTE');
        expect(offRoute.compareDocumentPosition(watch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(watch).toHaveTextContent('WATCH CHECK');
        expect(watch).toHaveTextContent("Nobody has tapped I'm on watch for 15 min.");
        expect(UnderwayAlarmStore.getCards().map((c) => c.kind)).toEqual(['shoal', 'off-route', 'watch-check']);
        const button = within(watch).getByRole('button', { name: "I'm on watch" });
        expect(button.style.minHeight).toBe('44px');
        expect(button.style.minWidth).toBe('44px');
        expect(within(watch).getAllByRole('button')).toHaveLength(1);
        fireEvent.click(button);
        expect(actions).toEqual(['watch-check']);
        // The under-way watch's own cards are its to set: the watch check's stays beside them.
        act(() => UnderwayAlarmStore.set([], []));
        expect(UnderwayAlarmStore.getCards().map((c) => c.kind)).toEqual(['watch-check']);
    });

    it('a minute ahead, the watch check is a calm heads-up with the same button, not an alarm', async () => {
        act(() => UnderwayAlarmStore.setWatchCheck(WATCH_WARNING, []));
        render(<AisGuardAlert />);
        const card = (await screen.findByText('Watch check in 1 min')).closest('[role="status"]') as HTMLElement;
        expect(card).toHaveTextContent('Every 15 min while the track records.');
        expect(within(card).getByRole('button', { name: "I'm on watch" }).style.minHeight).toBe('44px');
        expect(screen.queryByRole('alert')).toBeNull();
        // Not sounding: the stack stays under the night tint.
        expect(Number(screen.getByTestId('ais-guard-stack').style.zIndex)).not.toBe(NIGHT_SCRIM_Z_INDEX + 1);
    });

    it('nothing at all: the stack is not drawn', () => {
        const { container } = render(<AisGuardAlert />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('Settings → Preferences → Under-way alarms', () => {
    async function renderPreferences(vessel?: { draft?: number }) {
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-10 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        const onSave = vi.fn();
        render(
            <GeneralTab
                settings={{ ...DEFAULT_SETTINGS, vessel: vessel as never }}
                onSave={onSave}
                onLocationSelect={vi.fn()}
                onDetectLocation={vi.fn()}
                onShowFactoryReset={vi.fn()}
            />,
        );
        return onSave;
    }

    it('sits right after the collision alarm, both switches ON, for a free account', async () => {
        await renderPreferences({ draft: 2.4 * 3.28084 });
        const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
        expect(headings[headings.indexOf('Collision alarm') + 1]).toBe('Under-way alarms');
        expect(screen.getByRole('switch', { name: 'Off-route alarm' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('switch', { name: 'Shoal alarm' })).toHaveAttribute('aria-checked', 'true');
        const inshore = screen.getByLabelText('Off route inshore') as HTMLSelectElement;
        const offshore = screen.getByLabelText('Off route offshore') as HTMLSelectElement;
        expect(inshore.value).toBe('0.25');
        expect(offshore.value).toBe('1');
        expect([...inshore.options].map((o) => o.textContent)).toEqual(['0.1 NM', '0.25 NM', '0.5 NM']);
        expect([...offshore.options].map((o) => o.textContent)).toEqual(['0.5 NM', '1 NM', '2 NM']);
        const section = inshore.closest('.space-y-4') as HTMLElement;
        expect(section).toHaveTextContent('Margin under the keel: 0.5 m');
        expect(section).toHaveTextContent(
            'These alarms work only while Thalassa is running. A voyage track keeps it running under way.',
        );
        expect(section).toHaveTextContent(/Time Sensitive/);
        expect(section).not.toHaveTextContent(/draft not set/i);
    });

    it('says the draft is not set when it is not', async () => {
        await renderPreferences(undefined);
        const section = (screen.getByLabelText('Off route inshore') as HTMLElement).closest(
            '.space-y-4',
        ) as HTMLElement;
        expect(section).toHaveTextContent(/Draft not set: set it in Vessel/);
    });

    it('saves the switches and the limits', async () => {
        const onSave = await renderPreferences({ draft: 2.4 * 3.28084 });
        fireEvent.click(screen.getByRole('switch', { name: 'Off-route alarm' }));
        expect(onSave).toHaveBeenLastCalledWith({
            underwayAlarms: {
                offRoute: { enabled: false, inshoreNm: 0.25, offshoreNm: 1 },
                shoal: { enabled: true },
                watchCheck: { enabled: false, intervalMin: 15 },
            },
        });
        fireEvent.click(screen.getByRole('switch', { name: 'Shoal alarm' }));
        expect(onSave).toHaveBeenLastCalledWith({
            underwayAlarms: {
                offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
                shoal: { enabled: false },
                watchCheck: { enabled: false, intervalMin: 15 },
            },
        });
        fireEvent.change(screen.getByLabelText('Off route offshore'), { target: { value: '2' } });
        expect(onSave).toHaveBeenLastCalledWith({
            underwayAlarms: {
                offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 2 },
                shoal: { enabled: true },
                watchCheck: { enabled: false, intervalMin: 15 },
            },
        });
    });

    // 126-02b: the watch check, OFF by default (it asks for a tap every interval).
    it('has the watch check, OFF by default, every 15 min, with the honest line', async () => {
        await renderPreferences({ draft: 2.4 * 3.28084 });
        const watch = screen.getByRole('switch', { name: 'Watch check' });
        expect(watch).toHaveAttribute('aria-checked', 'false');
        const every = screen.getByLabelText('Watch check every') as HTMLSelectElement;
        expect(every.value).toBe('15');
        expect([...every.options].map((o) => o.textContent)).toEqual(['10 min', '15 min', '20 min', '30 min']);
        const section = every.closest('.space-y-4') as HTMLElement;
        expect(section).toHaveTextContent(
            "While a voyage track records, Thalassa asks whoever is on watch to tap I'm on watch. If nobody does, it sounds, on the lock screen too.",
        );
        expect(section).toHaveTextContent(/starts once you are under way and runs until the track ends/);
        expect(section).toHaveTextContent(/waits while the track is paused or an anchor watch is on/);
        // Stage-3 review: a berth holds it only once somebody there has answered.
        expect(section).toHaveTextContent(
            /when she has stopped \(at a berth, say\) once somebody there has tapped I'm on watch/,
        );
        expect(section).toHaveTextContent(/booked with iOS ahead/);
    });

    it('saves the watch check and its interval, keeping the other alarms as they are', async () => {
        const onSave = await renderPreferences({ draft: 2.4 * 3.28084 });
        fireEvent.click(screen.getByRole('switch', { name: 'Watch check' }));
        expect(onSave).toHaveBeenLastCalledWith({
            underwayAlarms: {
                offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
                shoal: { enabled: true },
                watchCheck: { enabled: true, intervalMin: 15 },
            },
        });
        fireEvent.change(screen.getByLabelText('Watch check every'), { target: { value: '30' } });
        expect(onSave).toHaveBeenLastCalledWith({
            underwayAlarms: {
                offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
                shoal: { enabled: true },
                watchCheck: { enabled: false, intervalMin: 30 },
            },
        });
    });
});
