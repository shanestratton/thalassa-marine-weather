/**
 * Vessel search must show what the database actually holds, and must never
 * present a search FAILURE as "no such ship".
 *
 * Shane, 2026-08-19: "if you enter any ship into the search button for the
 * ais, it does not show anything". Tested live: the RPC dropped every vessel
 * without a position before comparing the name (63 named ships invisible),
 * the client's "fallback" queried columns the table does not have (so an RPC
 * error became a silent empty list), and rows with no fix would have thrown
 * on `lat.toFixed`. These tests pin the client half of the fix; the RPC half
 * is pinned by the migration and was verified against production.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const rpc = vi.fn();
vi.mock('../services/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/ui/OverlayPortal', () => ({
    OverlayPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { VesselSearch } from '../components/map/VesselSearch';

const row = (over: Record<string, unknown> = {}) => ({
    mmsi: 352006376,
    name: 'AGATTI ISLAND',
    call_sign: null,
    ship_type: 70,
    sog: 0,
    lat: null,
    lon: null,
    has_position: false,
    updated_at: '2026-08-19T04:00:00Z',
    ...over,
});

const type = async (text: string) => {
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: text } });
    // Debounce is 400 ms; submit runs the search immediately.
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.submit(input.closest('form') ?? input);
};

beforeEach(() => rpc.mockReset());
afterEach(cleanup);

describe('VesselSearch shows what the table holds', () => {
    it('lists a named vessel that has no position yet, and says so', async () => {
        rpc.mockResolvedValue({ data: [row()], error: null });
        render(<VesselSearch visible onSelect={vi.fn()} onClose={vi.fn()} />);
        await type('AGATTI');
        await waitFor(() => expect(screen.getByText('AGATTI ISLAND')).toBeTruthy());
        expect(screen.getByText(/no position yet/i)).toBeTruthy();
        // And it did not throw on a null lat.
    });

    it('does not fly to (0,0) when a no-position vessel is tapped', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        rpc.mockResolvedValue({ data: [row()], error: null });
        render(<VesselSearch visible onSelect={onSelect} onClose={onClose} />);
        await type('AGATTI');
        await waitFor(() => screen.getByText('AGATTI ISLAND'));
        fireEvent.click(screen.getByText('AGATTI ISLAND'));
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toMatch(/hasn't reported a position/i);
    });

    it('flies to a vessel that does have a position', async () => {
        const onSelect = vi.fn();
        rpc.mockResolvedValue({
            data: [row({ lat: -27.2, lon: 153.1, has_position: true, sog: 6.2 })],
            error: null,
        });
        render(<VesselSearch visible onSelect={onSelect} onClose={vi.fn()} />);
        await type('AGATTI');
        await waitFor(() => screen.getByText('AGATTI ISLAND'));
        fireEvent.click(screen.getByText('AGATTI ISLAND'));
        expect(onSelect).toHaveBeenCalledWith(-27.2, 153.1, 352006376, 'AGATTI ISLAND');
    });
});

describe('VesselSearch never presents a failure as "no such ship"', () => {
    it('shows an error, NOT the empty state, when the RPC fails', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
        render(<VesselSearch visible onSelect={vi.fn()} onClose={vi.fn()} />);
        await type('BUNGAREE');
        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i);
        expect(screen.queryByText(/No Vessels Found/i)).toBeNull();
    });

    it('shows the empty state only for a genuine miss', async () => {
        rpc.mockResolvedValue({ data: [], error: null });
        render(<VesselSearch visible onSelect={vi.fn()} onClose={vi.fn()} />);
        await type('ZZZZNOTASHIP');
        await waitFor(() => expect(screen.getByText(/No Vessels Found/i)).toBeTruthy());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('sends the query to the hardened RPC, trimmed, with a bounded limit', async () => {
        rpc.mockResolvedValue({ data: [], error: null });
        render(<VesselSearch visible onSelect={vi.fn()} onClose={vi.fn()} />);
        await type('  bungaree  ');
        await waitFor(() => expect(rpc).toHaveBeenCalled());
        expect(rpc).toHaveBeenCalledWith('search_vessels', { search_query: 'bungaree', max_results: 10 });
    });
});
