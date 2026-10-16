import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    load: vi.fn(),
    share: vi.fn(),
    pairing: {
        publicKeySpki: 'synthetic-pin',
        deviceId: 'synthetic-boat',
        pairedAt: '2026-01-01',
    },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => mocks.pairing }));
vi.mock('../services/piTrackHistory', async (original) => ({
    ...(await original<typeof import('../services/piTrackHistory')>()),
    loadPiTrackHistory: mocks.load,
}));
vi.mock('../utils/sharePdf', () => ({ shareFileBlob: mocks.share }));
vi.mock('../services/piTrackRecorder', () => ({
    getPiTrackStatus: async () => ({
        enabled: true,
        running: true,
        lastOutcome: 'logged',
        writtenThisSession: 2,
        stored: { points: 2, firstMs: T - 86_400_000, lastMs: T, bytes: 4096 },
    }),
    setPiTrackRecording: vi.fn(),
}));
vi.mock('../components/TrackMapViewer', () => ({
    TrackMapViewer: ({ onClose }: { onClose: () => void }) => (
        <div role="dialog" aria-label="Synthetic local map">
            <button onClick={onClose}>Return from map</button>
        </div>
    ),
}));
import PiTrackHistorySheet from '../components/settings/PiTrackHistorySheet';
import { PiTrackRecorderCard } from '../components/settings/PiTrackRecorderCard';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { PiTrackHistory, PiTrackHistoryPoint } from '../services/piTrackHistory';
const T = Date.parse('2026-01-02T00:00:00Z');
const point = (sample_id: number, over = {}): PiTrackHistoryPoint => ({
    sample_id,
    at_ms: T - 120_000 + sample_id * 60_000,
    lat: 0,
    lon: 179.9,
    reason: 'first',
    sog_kts: 0,
    cog_deg: null,
    stw_kts: null,
    hdg_deg: null,
    depth_m: null,
    tws_kts: null,
    twd_deg: null,
    water_temp_c: null,
    pressure_hpa: null,
    heel_deg: null,
    engine_rpm: null,
    twa_deg: null,
    ...over,
});
const history = (over = {}): PiTrackHistory => ({
    from: T - 86_400_000,
    to: T,
    points: [point(1), point(2, { sog_kts: 5, tws_kts: 12 })],
    truncated: false,
    snapshot: 2,
    nextCursor: null,
    ...over,
});
beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue(history());
    mocks.share.mockReset().mockResolvedValue('downloaded');
    mocks.pairing = { publicKeySpki: 'synthetic-pin', deviceId: 'synthetic-boat', pairedAt: '2026-01-01' };
    setAuthIdentityScope('synthetic-track-owner');
});
afterEach(() => vi.clearAllMocks());
it('loads only on opening or explicit selection; shows actual UTC, missing measurements and selected fixes', async () => {
    render(<PiTrackHistorySheet lastMs={T} onClose={vi.fn()} />);
    expect(await screen.findByText(/2 loaded fixes/)).toBeVisible();
    expect(screen.getByTestId('track-selected-time')).toHaveTextContent('2026-01-01 23:59:00.000 UTC');
    expect(screen.getAllByText('No recorded measurements')).toHaveLength(3);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
    expect(screen.getByTestId('track-selected-time')).toHaveTextContent('2026-01-02 00:00:00.000 UTC');
    fireEvent.change(screen.getByLabelText('Track from UTC'), { target: { value: '2026-01-01T12:00' } });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Window edited/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load window' }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(mocks.load.mock.calls[1][0].from).toBe(Date.parse('2026-01-01T12:00:00Z'));
});
it('states partial scope and exports only the loaded partial batch through the existing share helper', async () => {
    mocks.load.mockResolvedValue(history({ truncated: true, nextCursor: `${T}:2:20` }));
    render(<PiTrackHistorySheet lastMs={T} onClose={vi.fn()} />);
    expect(await screen.findByText(/Partial window:/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Export GPX' }));
    await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
    expect(mocks.share.mock.calls[0][1]).toMatch(/partial-1-\d+\.gpx$/);
    expect(mocks.share.mock.calls[0][3]).toBe('application/gpx+xml');
    const reader = new FileReader();
    const contents = new Promise((resolve) => {
        reader.onload = () => resolve(reader.result);
    });
    reader.readAsText(mocks.share.mock.calls[0][0]);
    expect(await contents).toContain('PARTIAL: remaining data is not included');
    mocks.load.mockResolvedValueOnce(history({ points: [point(3)], truncated: true, nextCursor: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Load remaining batch' }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(mocks.load.mock.calls[1][0].cursor).toBe(`${T}:2:20`);
    expect(await screen.findByText(/1 loaded fixes/)).toBeVisible();
});
it('opens real track history from the existing recorder card and focuses its opener', async () => {
    render(<PiTrackRecorderCard />);
    const opener = await screen.findByRole('button', { name: 'View track' });
    fireEvent.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Boat track history' })).toBeVisible();
    expect(await screen.findByText(/2 loaded fixes/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
});
it('cancels pending reads and ignores their eventual native reply', async () => {
    let resolve!: (result: PiTrackHistory) => void;
    mocks.load.mockImplementation(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
    );
    render(<PiTrackHistorySheet lastMs={T} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel read' }));
    expect(mocks.load.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => resolve(history()));
    expect(screen.queryByText(/loaded fixes/)).toBeNull();
    expect(screen.getByText('Read cancelled; no track loaded.')).toBeVisible();
});
it.each(['account', 'pair'])('clears retained rows and closes on %s change', async (change) => {
    const close = vi.fn();
    render(<PiTrackHistorySheet lastMs={T} onClose={close} />);
    await screen.findByText(/2 loaded fixes/);
    act(() => {
        if (change === 'account') setAuthIdentityScope('another-synthetic-owner');
        else {
            mocks.pairing = { ...mocks.pairing, publicKeySpki: 'another-pin' };
            window.dispatchEvent(new StorageEvent('storage'));
        }
    });
    expect(close).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
});
it('opens the reused map only on explicit tap and keeps the loaded graphs on return', async () => {
    render(<PiTrackHistorySheet lastMs={T} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View track map' }));
    expect(await screen.findByRole('dialog', { name: 'Synthetic local map' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Return from map' }));
    expect(screen.queryByRole('dialog', { name: 'Synthetic local map' })).toBeNull();
    expect(screen.getByText(/2 loaded fixes/)).toBeVisible();
});
