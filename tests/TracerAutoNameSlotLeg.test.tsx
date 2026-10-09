/**
 * A trip's leg opened in its place keeps its name (126-16a review). Opening a
 * leg locks it to its slot, and Save finds the row in that slot under the name
 * on screen. The auto-namer used to be re-armed for any "X - Y" name, so the
 * first pin drag renamed "Mackay - Whitsundays (3rd Leg)" to "Mackay - Airlie
 * Beach", and Save then refused: slot 3 was taken by the old name. These tests
 * drive the real namer (useTracerAutoName) and the real Save decision.
 *
 * Fictional trips: Newport → Mackay → Airlie, the Solent, and lone routes in
 * Moreton Bay and the Bay of Islands.
 */
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextLegSeed, SavedTrace, TracePoint } from '../services/routeTracer';

vi.mock('../services/routeAutoName', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/routeAutoName')>()),
    // What a geocoder would say for the dragged destination: never the stored name.
    placeLabelFor: vi.fn(async () => 'Airlie Beach'),
    autoRouteName: vi.fn(async () => 'Tangalooma - Lady Musgrave'),
}));

import {
    AUTO_NAME_DEBOUNCE_MS,
    rearmAutoNameForOpenedRoute,
    useTracerAutoName,
} from '../components/map/useTracerAutoName';
import { decideTraceSave } from '../services/traceSave';
import { slotSeedForLeg } from '../services/tripLegAdd';

const row = (id: string, name: string, points: TracePoint[], extra: Partial<SavedTrace> = {}) =>
    ({ id, name, createdAt: '2026-09-20T08:00:00.000Z', points, ...extra }) as SavedTrace;

const NEWPORT = { lat: -27.21, lon: 153.09 };
const GLADSTONE = { lat: -23.83, lon: 151.26 };
const MACKAY = { lat: -21.1, lon: 149.23 };
const WHITSUNDAYS = { lat: -20.27, lon: 148.72 };
const LYMINGTON = { lat: 50.75, lon: -1.53 };
const COWES = { lat: 50.765, lon: -1.3 };
const BEMBRIDGE = { lat: 50.69, lon: -1.08 };

function library(): SavedTrace[] {
    return [
        row('y', 'Newport - Gladstone (1st Leg)', [NEWPORT, { lat: -25.5, lon: 153.4 }, GLADSTONE], {
            tripId: 'y',
            legOrdinal: 1,
        }),
        row('y-2', 'Gladstone - Mackay (2nd Leg)', [GLADSTONE, { lat: -22.4, lon: 150.6 }, MACKAY], {
            tripId: 'y',
            legOrdinal: 2,
        }),
        row('y-3', 'Mackay - Whitsundays (3rd Leg)', [MACKAY, { lat: -20.7, lon: 149.1 }, WHITSUNDAYS], {
            tripId: 'y',
            legOrdinal: 3,
        }),
        row('s', 'Lymington - Cowes (1st Leg)', [LYMINGTON, { lat: 50.77, lon: -1.42 }, COWES], {
            tripId: 's',
            legOrdinal: 1,
        }),
        row('s-2', 'Cowes - Bembridge (2nd Leg)', [COWES, { lat: 50.74, lon: -1.2 }, BEMBRIDGE], {
            tripId: 's',
            legOrdinal: 2,
        }),
        row('lone', 'Tangalooma - Lady Elliot', [
            { lat: -27.18, lon: 153.37 },
            { lat: -24.11, lon: 152.71 },
        ]),
        row('boi', 'Opua - Russell', [
            { lat: -35.31, lon: 174.12 },
            { lat: -35.26, lon: 174.12 },
        ]),
    ];
}

/** MapHub's draft, reduced to what the namer reads and writes. */
function useDraft(opened: SavedTrace, slot: NextLegSeed | null, staleAuto: string) {
    const [capturedCoords, setCapturedCoords] = useState<TracePoint[]>(opened.points);
    const [traceName, setTraceName] = useState(opened.name);
    // Whatever the last draft left behind, as after any earlier route.
    const lastAutoNameRef = useRef(staleAuto);
    useTracerAutoName({
        coordCaptureMode: true,
        capturedCoords,
        traceName,
        legAnchor: slot,
        lastAutoNameRef,
        setTraceName,
    });
    return { capturedCoords, setCapturedCoords, traceName, lastAutoNameRef };
}

/** Open a saved route the way MapHub's two doors do, then drag one pin. */
async function openAndDrag(id: string, pinIndex: number, to: TracePoint, staleAuto = '') {
    const traces = library();
    const opened = traces.find((t) => t.id === id)!;
    const slot = slotSeedForLeg(traces, opened);
    const { result } = renderHook(() => useDraft(opened, slot, staleAuto));
    await act(async () => {
        rearmAutoNameForOpenedRoute(result.current.lastAutoNameRef, opened.name, slot);
        await vi.dynamicImportSettled();
    });
    const moved = result.current.capturedCoords.map((p, i) => (i === pinIndex ? to : p));
    act(() => result.current.setCapturedCoords(moved));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_NAME_DEBOUNCE_MS + 50);
    });
    await vi.dynamicImportSettled();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
    });
    return { traces, opened, slot, moved, name: result.current.traceName };
}

beforeAll(async () => {
    // Loaded once up front, as on a phone that has named a route before: the
    // namer's chunk is then a cached import, not a cold fetch.
    await import('../services/routeAutoName');
});
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    vi.useRealTimers();
});

describe('a trip leg opened in its place keeps its name, so Save updates it', () => {
    it.each([
        ['leg 3 of Newport → Mackay → Airlie, a middle pin round a reef', 'y-3', 1, { lat: -20.62, lon: 149.02 }],
        ['leg 3, the destination dragged up the passage', 'y-3', 2, { lat: -20.25, lon: 148.75 }],
        ['leg 2 in the Solent, a middle pin', 's-2', 1, { lat: 50.73, lon: -1.18 }],
    ])('%s', async (_label, id, pinIndex, to) => {
        const { traces, opened, slot, moved, name } = await openAndDrag(id, pinIndex, to);
        expect(slot).not.toBeNull();
        expect(name).toBe(opened.name);
        // The Save the skipper taps next: "Overwrite?" for exactly this leg.
        const decision = decideTraceSave({
            name,
            points: moved,
            anchor: slot,
            savedTraces: traces,
            overwriteArm: null,
        });
        expect(decision).toMatchObject({ kind: 'confirm-overwrite', existing: { id } });
    });

    it('even when the last draft left this very name armed', async () => {
        const { name, opened } = await openAndDrag(
            'y-3',
            1,
            { lat: -20.62, lon: 149.02 },
            'Mackay - Whitsundays (3rd Leg)',
        );
        expect(name).toBe(opened.name);
    });

    it.each([
        ['a lone Moreton Bay route', 'lone', 1],
        ['a lone Bay of Islands route', 'boi', 1],
    ])('%s opens free and still retitles when its destination is dragged', async (_label, id, pinIndex) => {
        const { slot, name } = await openAndDrag(id, pinIndex, { lat: -24.12, lon: 152.72 });
        expect(slot).toBeNull();
        expect(name).toBe('Tangalooma - Lady Musgrave');
    });

    it('leg 1 of a trip opens free, as before (it has no previous leg to join)', async () => {
        const { slot, name } = await openAndDrag('y', 2, { lat: -23.8, lon: 151.3 });
        expect(slot).toBeNull();
        expect(name).toBe('Tangalooma - Lady Musgrave');
    });
});
