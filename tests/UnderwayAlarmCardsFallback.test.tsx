/**
 * The under-way cards load lazily (126-02a). If their chunk will not load (a
 * web tab left open across a deploy, so the old chunk is gone), the alarm must
 * not take the whole app down with it: the stack keeps a plain card for each
 * alarm with the same button (Acknowledge, Mute 30 min), and the strip, while
 * the collision cards above stay drawn.
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
// The cards' chunk is gone: its import rejects.
vi.mock('../components/map/UnderwayAlarmCards', () => {
    throw new Error('Failed to fetch dynamically imported module: UnderwayAlarmCards-0ld.js');
});

import { AisGuardAlert } from '../components/map/AisGuardAlert';
import { AisGuardAlertStore, type CollisionAlertCard } from '../services/aisGuardAlertStore';
import { UnderwayAlarmStore, type UnderwayAlarmCard } from '../services/underway/underwayAlarmStore';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);

const COLLISION: CollisionAlertCard = {
    mmsi: 123400802,
    name: 'FICTIONAL FERRY',
    distanceNm: 1.2,
    bearing: 30,
    sog: 14,
    cog: 210,
    shipType: '60',
    timestamp: T0,
    collision: { cpaNm: 0.15, tcpaMin: 6, closeQuarters: false, reportAgeSec: 8, source: 'local' },
};

const SHOAL: UnderwayAlarmCard = {
    kind: 'shoal',
    title: 'SHOAL WATER',
    value: '0.3 m under the keel',
    detail: 'your sounder measures from the keel',
    note: 'Margin under the keel: 0.5 m',
    sounding: true,
    mutedUntil: null,
};

const OFF_ROUTE: UnderwayAlarmCard = {
    kind: 'off-route',
    title: 'OFF ROUTE',
    value: '0.40 NM off the line',
    detail: 'limit 0.25 NM inshore',
    sounding: true,
    mutedUntil: null,
};

/** React (dev) re-raises the caught error on window before the boundary takes it: expected here. */
const swallow = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
    AisGuardAlertStore.clear();
    UnderwayAlarmStore.clear();
    // React reports the caught error to the console; the boundary is the point of the test.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('error', swallow);
});

afterEach(() => {
    window.removeEventListener('error', swallow);
    cleanup();
    vi.restoreAllMocks();
});

describe('the under-way cards when their chunk will not load', () => {
    it('keeps a plain card and its button for each alarm, and the collision card above', async () => {
        const actions: string[] = [];
        UnderwayAlarmStore.subscribeActions((a) => actions.push(a.kind));
        act(() => {
            AisGuardAlertStore.setCollision([COLLISION], T0);
            UnderwayAlarmStore.set([SHOAL, OFF_ROUTE], ['Off-route alarm: no position fix']);
        });
        render(<AisGuardAlert />);

        const shoal = (await screen.findByText(/SHOAL WATER/)).closest('[role="alert"]') as HTMLElement;
        expect(shoal).toHaveTextContent('0.3 m under the keel');
        const offRoute = screen.getByText(/OFF ROUTE/).closest('[role="alert"]') as HTMLElement;
        expect(offRoute).toHaveTextContent('0.40 NM off the line');
        expect(screen.getByText('FICTIONAL FERRY')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Off-route alarm: no position fix');

        const acknowledge = within(shoal).getByRole('button', { name: 'Acknowledge the shoal alarm' });
        const mute = within(offRoute).getByRole('button', { name: 'Mute the off-route alarm for 30 minutes' });
        for (const button of [acknowledge, mute]) {
            expect(button.style.minHeight).toBe('44px');
            expect(button.style.minWidth).toBe('44px');
        }
        fireEvent.click(acknowledge);
        fireEvent.click(mute);
        expect(actions).toEqual(['shoal', 'off-route']);
    });
});
