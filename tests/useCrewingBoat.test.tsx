import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shane 2026-10-05: "instead of showing their yacht, can it instead show the
 * yacht that they are now invited to". The Glass names the crewed boat from
 * the cache alone. Fictional: crew member on 'Wind Dancer' (skipper 'skipper-wd').
 */
const h = vi.hoisted(() => ({
    vessel: null as null | { ownerId: string; vesselName: string | null; instruments?: boolean },
    view: null as null | { vessel: { name: string } },
    listeners: new Set<() => void>(),
}));
vi.mock('../hooks/useCrewingVessel', () => ({
    useCrewingVessel: () => ({ vessel: h.vessel, vessels: h.vessel ? [h.vessel] : [], version: 0 }),
}));
vi.mock('../services/crew/crewVesselView', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/crew/crewVesselView')>()),
    getCachedCrewVesselView: (ownerId: string | null | undefined) => (ownerId === h.vessel?.ownerId ? h.view : null),
    subscribeCrewVesselViews: (listener: () => void) => {
        h.listeners.add(listener);
        return () => h.listeners.delete(listener);
    },
}));

import { useCrewingBoat } from '../hooks/useCrewingBoat';

beforeEach(() => {
    h.vessel = null;
    h.view = null;
});

describe('useCrewingBoat — the crewed boat, named from the cache', () => {
    it('is null when the account crews nowhere', () => {
        expect(renderHook(() => useCrewingBoat()).result.current).toBeNull();
    });

    it('with no name known: her skipper’s boat, capitalised only as a title', () => {
        h.vessel = { ownerId: 'skipper-wd', vesselName: null };
        expect(renderHook(() => useCrewingBoat()).result.current).toEqual({
            ownerId: 'skipper-wd',
            name: null,
            label: "Your skipper's boat",
            inSentence: "your skipper's boat",
            instruments: null,
        });
    });

    it('the snapshot’s name, then the cached view’s once it is stored', () => {
        h.vessel = { ownerId: 'skipper-wd', vesselName: 'Wind Dancer', instruments: false };
        const { result } = renderHook(() => useCrewingBoat());
        expect(result.current).toMatchObject({ name: 'Wind Dancer', label: 'Wind Dancer', instruments: false });
        act(() => {
            h.view = { vessel: { name: 'Wind Dancer II' } };
            for (const listener of h.listeners) listener();
        });
        expect(result.current).toMatchObject({ name: 'Wind Dancer II', inSentence: 'Wind Dancer II' });
    });

    it('stays clear of UI and realtime modules, since The Glass loads it at startup', () => {
        const source = readFileSync(resolve(process.cwd(), 'hooks/useCrewingBoat.ts'), 'utf8');
        expect(source).not.toMatch(/from '\.\.\/components\/vessel\/SharedBinderLine'/);
        expect(source).not.toMatch(/from '\.\/useCrewVesselView'/);
        expect(source).not.toMatch(/useRealtimeSync|loadCrewVesselView/);
    });
});
