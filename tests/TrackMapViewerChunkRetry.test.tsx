/**
 * The big Log track map's own code arrives with import() (125-13b). If that
 * chunk cannot load (a web build redeployed, or the link dropped, while the
 * Log page is open), the viewer says the map did not load (not that the
 * device cannot draw it) and keeps the rest of the viewer working; the next
 * opening asks for the chunk again. React.lazy alone keeps a failure for the
 * life of the page, so every later opening would show the notice for good.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';
import type { ShipLogEntry } from '../types';

const chunk = vi.hoisted(() => ({ fail: true, asked: 0 }));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        canDisplayProxiedTiles: () => false,
        passthroughTileUrl: (url: string) => url,
    },
}));

vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

vi.mock('../components/TrackMapViewerGL', async (importOriginal) => {
    chunk.asked += 1;
    if (chunk.fail) throw new TypeError('Failed to fetch dynamically imported module');
    return importOriginal();
});

import { TrackMapViewer } from '../components/TrackMapViewer';

/** Out of Ajaccio, south along the Corsican coast (fictional). */
const CORSICA: ShipLogEntry[] = [
    [41.915, 8.73],
    [41.9, 8.735],
    [41.885, 8.745],
    [41.87, 8.76],
].map(
    ([latitude, longitude], i) =>
        ({
            id: `c${i}`,
            userId: 'fixture-skipper',
            voyageId: 'fixture-corsica',
            latitude,
            longitude,
            timestamp: new Date(Date.UTC(2026, 9, 9, 8, i * 10)).toISOString(),
            positionFormatted: '',
            entryType: 'auto',
            source: 'device',
            isOnWater: true,
            speedKts: 5,
        }) as ShipLogEntry,
);

function Harness() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}>Open voyage track</button>
            <TrackMapViewer isOpen={open} onClose={() => setOpen(false)} entries={CORSICA} />
        </>
    );
}

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.attempts = 0;
    FakeMapboxMap.failWebGL = false;
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(844);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('The track map’s chunk missing', () => {
    it('says the map did not load, keeps playback, and the next opening asks for the chunk again', async () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        expect(await screen.findByText(/map didn.t load/i)).toBeInTheDocument();
        expect(screen.queryByText(/can.t draw the map/i)).not.toBeInTheDocument();
        expect(FakeMapboxMap.attempts).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'Play track' }));
        expect(screen.getByRole('button', { name: 'Pause playback' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close track map viewer' }));

        // The link is back: the next opening loads the map.
        chunk.fail = false;
        fireEvent.click(screen.getByRole('button', { name: 'Open voyage track' }));
        await waitFor(() => expect(FakeMapboxMap.instances).toHaveLength(1));
        expect(chunk.asked).toBe(2);
        expect(screen.queryByText(/map didn.t load/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});
