import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ search: vi.fn(), read: vi.fn(), select: vi.fn(), event: null as (() => void) | null }));
vi.mock('../services/enc/chartFind', () => ({
    findChartObjects: h.search,
    readDownloadedChartFind: h.read,
    chartFindSelectionCurrent: h.select,
    subscribeChartFindAccess: (fn: () => void) => {
        h.event = fn;
        return () => {
            h.event = null;
        };
    },
}));
import ChartFindSheet from '../components/map/ChartFindSheet';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const result = {
    key: 'fixture',
    cellId: 'US5TEST1',
    name: 'A <script> bay',
    kind: 'place' as const,
    character: null,
    lon: 151,
    lat: -27,
    licence: 'open' as const,
};
beforeEach(() => {
    vi.stubGlobal('scrollBy', vi.fn());
    setAuthIdentityScope('sheet-owner');
    h.search
        .mockReset()
        .mockResolvedValue({ matches: [result], cells: 1, limited: true, consent: true, aboard: false });
    h.read.mockReset();
    h.select.mockReset().mockResolvedValue(true);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
describe('Find on chart sheet', () => {
    it('searches locally without automatic reads, renders names as text and rechecks before flying', async () => {
        const fly = vi.fn();
        render(<ChartFindSheet onClose={vi.fn()} onFly={fly} bounds={[150, -28, 152, -26]} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Fl.G 3s' } });
        await screen.findByRole('button', { name: /A <script> bay/ });
        expect(document.querySelector('script')).toBeNull();
        expect(h.read).not.toHaveBeenCalled();
        expect(screen.getByText(/Partial index/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: /A <script> bay/ }));
        await waitFor(() => expect(fly).toHaveBeenCalledWith(result));
        expect(h.select).toHaveBeenCalledWith(result);
    });
    it('will not fly an obsolete selection or late async result after access/account changes', async () => {
        let finish!: (v: boolean) => void;
        h.select.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const fly = vi.fn(),
            close = vi.fn();
        render(<ChartFindSheet onClose={close} onFly={fly} bounds={null} />);
        fireEvent.click(await screen.findByRole('button', { name: /A <script> bay/ }));
        act(() => {
            h.event!();
            setAuthIdentityScope('new-sheet-owner');
        });
        await act(async () => {
            finish(true);
        });
        expect(fly).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });
    it('only reads on explicit action and aborts the actual local read when cancelled/unmounted', async () => {
        let signal: AbortSignal | undefined;
        h.read.mockImplementation((_bounds, options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise(() => {});
        });
        const ui = render(<ChartFindSheet onClose={vi.fn()} onFly={vi.fn()} bounds={[150, -28, 152, -26]} />);
        const read = await screen.findByRole('button', { name: 'Read downloaded NOAA around view' });
        await waitFor(() => expect(read).toBeEnabled());
        fireEvent.click(read);
        expect(h.read).toHaveBeenCalledOnce();
        fireEvent.click(await screen.findByRole('button', { name: 'Cancel read' }));
        expect(signal!.aborted).toBe(true);
        fireEvent.click(read);
        expect(signal!.aborted).toBe(false);
        ui.unmount();
        expect(signal!.aborted).toBe(true);
    });
});
