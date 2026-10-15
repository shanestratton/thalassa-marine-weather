/**
 * 132-B21: the GPX import page with the real parser. Notes on what the import
 * decided, a 50,000-point track that previews instead of crashing, save
 * progress with a Cancel, failures that say why and keep the preview with a
 * Retry, and VoiceOver hearing each step. The Ship's Log save is mocked;
 * nothing touches the network.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpxImportPage } from '../components/vessel/GpxImportPage';
import { GPX_IMPORT_MAX_TRACK_POINTS } from '../services/gpxService';

const mocks = vi.hoisted(() => ({
    importGPXVoyage: vi.fn(),
    setPage: vi.fn(),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage, previousView: 'vessel' }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { importGPXVoyage: mocks.importGPXVoyage },
}));
vi.mock('../services/passageHandoff', () => ({
    stagePassageRequest: vi.fn(),
    requestPassageMode: vi.fn(),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ key: 'user:a', userId: 'a', generation: 1 }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: () => <div>Import GPX</div>,
}));

// ── Fixtures ──

const iso = (start: string, plusS: number) => new Date(Date.parse(start) + plusS * 1000).toISOString();

const gpx = (body: string, name = 'Moreton Bay weekend') => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenCPN" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
${body}
</gpx>`;

/** A run north at `kts`, one point every `stepS` s; `untimed` drops the time on those indices. */
function points(
    lat: number,
    lon: number,
    start: string,
    count: number,
    stepS: number,
    kts: number,
    untimed = new Set<number>(),
) {
    const stepDeg = (kts * (stepS / 3600)) / 60;
    let out = '';
    for (let i = 0; i < count; i++) {
        const time = untimed.has(i) ? '' : `<time>${iso(start, i * stepS)}</time>`;
        out += `<trkpt lat="${(lat + i * stepDeg).toFixed(7)}" lon="${lon}">${time}</trkpt>`;
    }
    return out;
}

// Saturday 4 h out of Manly with two untimed points; Sunday back. An untimed
// waypoint where Saturday passed.
const WEEKEND = gpx(
    `<wpt lat="-27.40" lon="153.19"><name>Fish trap</name></wpt>
    <trk><name>Moreton Bay weekend</name>
        <trkseg>${points(-27.45, 153.19, '2026-09-19T22:00:00Z', 49, 300, 5, new Set([10, 11]))}</trkseg>
        <trkseg>${points(-27.18, 153.37, '2026-09-20T21:00:00Z', 25, 300, 5)}</trkseg>
    </trk>`,
);

const FIJI = gpx(
    `<trk><name>Across 180</name><trkseg>
        <trkpt lat="-17.1" lon="179.9"><time>2026-06-01T00:00:00Z</time></trkpt>
        <trkpt lat="-17.12" lon="179.97"><time>2026-06-01T00:40:00Z</time></trkpt>
        <trkpt lat="-17.14" lon="-179.96"><time>2026-06-01T01:20:00Z</time></trkpt>
        <trkpt lat="-17.16" lon="-179.89"><time>2026-06-01T02:00:00Z</time></trkpt>
    </trkseg></trk>`,
);

const ROUTE_ONLY = gpx(
    `<rte><name>Manly to Tangalooma</name>
        <rtept lat="-27.45" lon="153.19"><name>Manly</name></rtept>
        <rtept lat="-27.18" lon="153.37"><name>Tangalooma</name></rtept>
    </rte>`,
);

const SMALL = gpx(
    `<trk><name>Short sail</name><trkseg>${points(-27.45, 153.19, '2026-09-19T22:00:00Z', 250, 60, 5)}</trkseg></trk>`,
    'Short sail',
);

async function pick(xml: string, name = 'track.gpx') {
    const view = render(<GpxImportPage onBack={vi.fn()} />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File([xml], name, { type: 'application/gpx+xml' })] } });
    return view;
}

const liveRegion = () => screen.getByRole('status');

describe('GPX import page (132-B21)', () => {
    beforeEach(() => {
        mocks.importGPXVoyage.mockReset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('previews true distance and duration, with a note for each thing the import decided', async () => {
        await pick(WEEKEND, 'weekend.gpx');
        expect(await screen.findByText('Before you import')).toBeTruthy();

        expect(screen.getByText(/2 track points have no time\. They are placed between the timed points/)).toBeTruthy();
        expect(
            screen.getByText(/1 waypoint has no time\. It is logged at the moment the track passed closest/),
        ).toBeTruthy();
        expect(
            screen.getByText("2 track segments. The gaps between them don't count as distance sailed."),
        ).toBeTruthy();
        // Duration runs from the file's first time to its last: 22:00 Sat to 23:00 Sun.
        expect(screen.getByText('25h 0m')).toBeTruthy();
        // 48 x 0.4167 NM + 24 x 0.4167 NM, the overnight gap left out.
        expect(screen.getByText('30 NM')).toBeTruthy();
    });

    it('previews a 50,000-point track instead of crashing, says it will be thinned, and saves the thinned points', async () => {
        const LONG = gpx(
            `<trk><name>Overnight passage</name><trkseg>${points(-27.6, 153.25, '2026-09-01T20:00:00Z', 50_000, 1, 6)}</trkseg></trk>`,
        );
        await pick(LONG, 'overnight.gpx');
        expect(await screen.findByText(/^Long track: 50,000 points\./, {}, { timeout: 45_000 })).toBeTruthy();
        expect(screen.getByText('50,000')).toBeTruthy();
        expect(screen.getByText('13h 53m')).toBeTruthy();

        mocks.importGPXVoyage.mockResolvedValue({ voyageId: 'v-long', savedCount: 5_001 });
        fireEvent.click(screen.getByRole('button', { name: /Import to Ship's Log/ }));
        expect(await screen.findByText('Import complete')).toBeTruthy();

        const [entries, options] = mocks.importGPXVoyage.mock.calls[0];
        expect(entries.length).toBeLessThanOrEqual(GPX_IMPORT_MAX_TRACK_POINTS + 1);
        expect(entries[entries.length - 1].cumulativeDistanceNM).toBeGreaterThan(83);
        expect(options.signal).toBeInstanceOf(AbortSignal);
    }, 60_000);

    it('shows save progress, and Cancel stops the save and keeps the preview', async () => {
        let signal: AbortSignal | undefined;
        mocks.importGPXVoyage.mockImplementation(
            (_entries, options) =>
                new Promise((_resolve, reject) => {
                    signal = options.signal;
                    options.onProgress(100, 250);
                    options.signal.addEventListener('abort', () => reject(new Error('Import cancelled')));
                }),
        );
        await pick(SMALL);
        fireEvent.click(await screen.findByRole('button', { name: /Import to Ship's Log/ }));

        const bar = await screen.findByRole('progressbar', { name: 'Saving voyage' });
        expect(bar.getAttribute('aria-valuenow')).toBe('100');
        expect(bar.getAttribute('aria-valuemax')).toBe('250');
        expect(bar.getAttribute('aria-valuetext')).toBe('100 of 250 entries saved');
        // The first chunk is already a quarter of the way.
        expect(liveRegion().textContent).toBe('Saved 100 of 250 entries.');

        fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
        expect(signal?.aborted).toBe(true);

        expect(await screen.findByRole('button', { name: /Import to Ship's Log/ })).toBeTruthy();
        // The visible notice, and the same words for VoiceOver.
        expect(screen.getAllByText("Import cancelled. Nothing was added to the Ship's Log.")).toHaveLength(2);
        expect(screen.getByText('Short sail')).toBeTruthy();
        expect(liveRegion().textContent).toBe("Import cancelled. Nothing was added to the Ship's Log.");
    });

    it('says why a save failed, keeps the preview, and Retry saves into the same voyage', async () => {
        mocks.importGPXVoyage
            .mockRejectedValueOnce(new Error('Login required to import tracks'))
            .mockResolvedValueOnce({ voyageId: 'v1', savedCount: 250 });
        await pick(SMALL);
        fireEvent.click(await screen.findByRole('button', { name: /Import to Ship's Log/ }));

        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/You're signed out, so the voyage couldn't be saved/)).toBeTruthy();
        expect(screen.getByText('Short sail')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /Retry import/ }));
        expect(await screen.findByText('Import complete')).toBeTruthy();

        const [first, second] = mocks.importGPXVoyage.mock.calls;
        expect(typeof first[1].voyageId).toBe('string');
        expect(second[1].voyageId).toBe(first[1].voyageId);
        expect(second[0]).toBe(first[0]);
        expect(liveRegion().textContent).toBe('Import complete. 250 entries saved.');
    });

    it('says when the phone is offline', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        mocks.importGPXVoyage.mockRejectedValueOnce(new Error('Import failed at entry 0: TypeError: Load failed'));
        await pick(SMALL);
        fireEvent.click(await screen.findByRole('button', { name: /Import to Ship's Log/ }));
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/No internet connection, so the voyage couldn't be saved/)).toBeTruthy();
    });

    it("says offline, not signed out, when an offline token refresh reads as 'Login required'", async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        mocks.importGPXVoyage.mockRejectedValueOnce(new Error('Login required to import tracks'));
        await pick(SMALL);
        fireEvent.click(await screen.findByRole('button', { name: /Import to Ship's Log/ }));
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/No internet connection, so the voyage couldn't be saved/)).toBeTruthy();
        expect(within(alert).queryByText(/signed out/)).toBeNull();
    });

    it('says when the save timed out', async () => {
        mocks.importGPXVoyage.mockRejectedValueOnce(new Error('Import timed out at entry 200'));
        await pick(SMALL);
        fireEvent.click(await screen.findByRole('button', { name: /Import to Ship's Log/ }));
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/Saving timed out\. The connection may be slow\./)).toBeTruthy();
        expect(screen.getByRole('button', { name: /Retry import/ })).toBeTruthy();
    });

    it('tells VoiceOver each step: reading, preview ready, saving by the quarter', async () => {
        let progress: ((saved: number, total: number) => void) | undefined;
        let finish: ((value: unknown) => void) | undefined;
        mocks.importGPXVoyage.mockImplementation(
            (_entries, options) =>
                new Promise((resolve) => {
                    progress = options.onProgress;
                    finish = resolve;
                }),
        );
        await pick(SMALL, 'short.gpx');
        expect(liveRegion().textContent).toBe('Reading short.gpx.');
        await screen.findByRole('button', { name: /Import to Ship's Log/ });
        expect(liveRegion().textContent).toBe('Preview ready. Short sail: 250 track points, 20.8 nautical miles.');

        fireEvent.click(screen.getByRole('button', { name: /Import to Ship's Log/ }));
        await screen.findByRole('progressbar');
        expect(liveRegion().textContent).toBe("Saving 250 entries to the Ship's Log.");
        act(() => progress!(100, 250));
        expect(liveRegion().textContent).toBe('Saved 100 of 250 entries.');
        // Not every chunk: 110 is in the same quarter as 100, so nothing new is said.
        act(() => progress!(110, 250));
        expect(liveRegion().textContent).toBe('Saved 100 of 250 entries.');
        act(() => progress!(200, 250));
        expect(liveRegion().textContent).toBe('Saved 200 of 250 entries.');
        await act(async () => finish!({ voyageId: 'v', savedCount: 250 }));
        expect(liveRegion().textContent).toBe('Import complete. 250 entries saved.');
    });

    it('a route-only file offers the passage planner and no log import that can only fail', async () => {
        await pick(ROUTE_ONLY, 'route.gpx');
        expect(await screen.findByRole('button', { name: /Route to passage planner/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Import to Ship's Log/ })).toBeNull();
    });

    it('reads the coverage area across the 180° line, and speaks each edge in words', async () => {
        await pick(FIJI, 'fiji.gpx');
        await screen.findByText('Coverage area');
        expect(screen.getByText('West edge: 179 degrees 54.0 minutes east')).toBeTruthy();
        expect(screen.getByText('East edge: 179 degrees 53.4 minutes west')).toBeTruthy();
        expect(screen.getByText("179°54.0'E")).toBeTruthy();
        expect(screen.getByText("179°53.4'W")).toBeTruthy();
    });

    it('announces a file it cannot read as an alert', async () => {
        const view = render(<GpxImportPage onBack={vi.fn()} />);
        const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
        // The type check rejects at once, so let that settle inside act.
        await act(async () => {
            fireEvent.change(input, { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
        });
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/That isn't a GPX file/)).toBeTruthy();
    });
});
