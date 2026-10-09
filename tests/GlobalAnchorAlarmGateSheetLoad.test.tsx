/**
 * When the alarm gate loads the Move anchor sheet (build 126, 126-07b).
 *
 * The gate mounts with the app on every page, so a sheet it imported
 * statically rode in the boot chunk for everyone, anchored or not (07a alone
 * put 12 KB there). It now loads the sheet while a watch is kept on this
 * phone: from the moment the watch is set, long before any alarm, and again
 * when an alarm sounds if that first load failed. Never with React.lazy: a
 * load that fails must never throw. The alarm screen, Silence and everything
 * else on it stay static and never wait for it; until the sheet is in, the
 * screen simply does not offer Move anchor.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';

const mocks = vi.hoisted(() => {
    const listeners = new Set<(snap: unknown) => void>();
    const state = { snapshot: null as unknown };
    return {
        listeners,
        state,
        subscribe: vi.fn((listener: (snap: unknown) => void) => {
            listeners.add(listener);
            listener(state.snapshot);
            return () => listeners.delete(listener);
        }),
        getSnapshot: vi.fn(() => state.snapshot),
        acknowledgeAlarm: vi.fn(),
        sheetLoads: 0,
    };
});

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: mocks.subscribe,
        getSnapshot: mocks.getSnapshot,
        acknowledgeAlarm: mocks.acknowledgeAlarm,
    },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { isKeeping: () => false, keepingSessionCode: () => null },
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SHEET = '../components/anchor-watch/MoveAnchorSheet';

function snap(over: Partial<AnchorWatchSnapshot> = {}): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { latitude: 38.53, longitude: -28.62, timestamp: 1_000 },
        vesselPosition: null,
        swingRadius: 43,
        distanceFromAnchor: 12,
        maxDistanceRecorded: 14,
        bearingToAnchor: 90,
        config: { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 1_000,
        gpsAccuracy: 4,
        gpsQuality: 'standard',
        gpsQualityLabel: 'Standard GPS',
        guardianStatus: 'idle',
        setupError: null,
        ...over,
    };
}
const alarmSnap = () => snap({ state: 'alarm', alarmCause: 'drag', alarmTriggeredAt: 9_000, distanceFromAnchor: 55 });

function emitSnapshot(next: AnchorWatchSnapshot) {
    mocks.state.snapshot = next;
    act(() => {
        for (const listener of [...mocks.listeners]) listener(next);
    });
}
async function settle() {
    await act(async () => {
        await vi.dynamicImportSettled();
    });
}

/** A fresh gate, with the sheet module as each test wants it. */
async function freshGate(sheet: () => Record<string, unknown>) {
    vi.resetModules();
    vi.doMock(SHEET, sheet);
    return (await import('../components/anchor-watch/GlobalAnchorAlarmGate')).GlobalAnchorAlarmGate;
}

const workingSheet = () => {
    mocks.sheetLoads += 1;
    return {
        MoveAnchorSheet: (props: { mode?: string; onClose: () => void }) => (
            <div role="dialog" aria-label="Move anchor" data-mode={props.mode ?? 'watch'}>
                <button type="button" onClick={props.onClose}>
                    Cancel
                </button>
            </div>
        ),
    };
};

beforeEach(() => {
    mocks.listeners.clear();
    mocks.state.snapshot = snap({ state: 'idle', anchorPosition: null });
    mocks.acknowledgeAlarm.mockClear();
    mocks.sheetLoads = 0;
});
afterEach(() => {
    cleanup();
    vi.doUnmock(SHEET);
});

describe('GlobalAnchorAlarmGate: the Move anchor sheet loads with a watch, not with the app', () => {
    it('is not loaded while no watch is kept, and is loaded once one is, before any alarm', async () => {
        const Gate = await freshGate(workingSheet);
        render(<Gate />);
        await settle();
        expect(mocks.sheetLoads).toBe(0);

        emitSnapshot(snap({ state: 'watching' }));
        await settle();
        expect(mocks.sheetLoads).toBe(1);

        // The alarm finds it in already: Move anchor is there at once.
        emitSnapshot(alarmSnap());
        expect(screen.getByRole('button', { name: 'Move anchor' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Move anchor' }));
        expect(screen.getByRole('dialog', { name: 'Move anchor' })).toHaveAttribute('data-mode', 'alarm');
        expect(mocks.sheetLoads).toBe(1);
    });

    it('mounted mid-alarm (a relaunch), it loads the sheet then, and the alarm is up first', async () => {
        mocks.state.snapshot = alarmSnap();
        const Gate = await freshGate(workingSheet);
        render(<Gate />);
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(await screen.findByRole('button', { name: 'Move anchor' })).toBeInTheDocument();
    });

    it('a sheet that cannot load leaves the alarm whole: Silence works, and Move anchor is not offered', async () => {
        const Gate = await freshGate(() => {
            throw new Error('Failed to fetch dynamically imported module');
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<Gate />);
        emitSnapshot(snap({ state: 'watching' }));
        await settle();
        emitSnapshot(alarmSnap());
        await settle();

        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Move anchor' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /acknowledge alarm/i }));
        expect(mocks.acknowledgeAlarm).toHaveBeenCalledTimes(1);
        errors.mockRestore();
    });

    it('is fetched with a guarded import(), never React.lazy, and the alarm screen stays static', () => {
        const gate = readFileSync(resolve(__dirname, '../components/anchor-watch/GlobalAnchorAlarmGate.tsx'), 'utf8');
        expect(gate).not.toMatch(/import \{[^}]*\bMoveAnchorSheet\b[^}]*\} from '\.\/MoveAnchorSheet'/);
        expect(gate).toMatch(/import\('\.\/MoveAnchorSheet'\)/);
        expect(gate).not.toMatch(/\blazy\(/);
        expect(gate).toMatch(/^import \{ AnchorAlarmOverlay \} from '\.\/AnchorAlarmOverlay';$/m);
    });
});
