import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RouteReplanControl from '../components/passage/RouteReplanControl';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { setRouteReplan } from '../services/routing/routeReplanSession';

const f = vi.hoisted(() => ({
    wind: { model: 'ecmwf', grid: null as { sourceGeneration: string } | null },
    follow: { voyageId: 'fictional-passage', startedAt: 'fictional-start' },
    settings: { activeVesselId: 'fictional-boat-a', settings: { underwayAlarms: undefined } },
    request: vi.fn(async () => {}),
}));
vi.mock('../stores/WindStore', () => ({ useWindStore: () => f.wind }));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: (selector: (value: typeof f.follow) => unknown) => selector(f.follow),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (value: typeof f.settings) => unknown) => selector(f.settings),
}));
vi.mock('../services/routing/routeReplan', () => ({ requestRouteReplan: f.request }));
const eta = Date.parse('2026-10-17T12:00:00Z');
beforeEach(() => {
    f.wind = { model: 'ecmwf', grid: null };
    f.settings.activeVesselId = 'fictional-boat-a';
    f.request.mockClear();
    setAuthIdentityScope('fictional-owner-a');
    setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});
describe('suggest-only re-plan controls', () => {
    it('adopts the first actual generation without calling it a new run, then announces a changed generation', () => {
        const view = render(<RouteReplanControl xteNm={0} etaMs={eta} />);
        f.wind.grid = { sourceGeneration: 'generation-a' };
        view.rerender(<RouteReplanControl xteNm={0} etaMs={eta} />);
        expect(screen.queryByText(/new forecast run/)).toBeNull();
        f.wind.grid = { sourceGeneration: 'generation-b' };
        view.rerender(<RouteReplanControl xteNm={0} etaMs={eta} />);
        expect(screen.getByText(/new forecast run/)).toBeTruthy();
        expect(f.request).not.toHaveBeenCalled();
    });
    it('does not carry ETA or generation suggestions across account, boat or model changes', () => {
        f.wind.grid = { sourceGeneration: 'generation-a' };
        const view = render(<RouteReplanControl xteNm={0} etaMs={eta} />);
        view.rerender(<RouteReplanControl xteNm={0} etaMs={eta + 1800000} />);
        expect(screen.getByText(/ETA has slipped/)).toBeTruthy();
        act(() => setAuthIdentityScope('fictional-owner-b'));
        expect(screen.queryByText(/ETA has slipped/)).toBeNull();
        f.wind.grid = { sourceGeneration: 'generation-b' };
        f.settings.activeVesselId = 'fictional-boat-b';
        view.rerender(<RouteReplanControl xteNm={0} etaMs={eta + 3600000} />);
        expect(screen.queryByText(/new forecast run|ETA has slipped/)).toBeNull();
        f.wind = { model: 'gfs', grid: { sourceGeneration: 'generation-c' } };
        view.rerender(<RouteReplanControl xteNm={0} etaMs={eta + 5400000} />);
        expect(screen.queryByText(/new forecast run|ETA has slipped/)).toBeNull();
        expect(f.request).not.toHaveBeenCalled();
    });
    it('starts only after an explicit user action', async () => {
        render(<RouteReplanControl xteNm={1} etaMs={eta} />);
        expect(screen.getByText(/off the followed route/)).toBeTruthy();
        expect(f.request).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Re-plan from current position' }));
        await waitFor(() => expect(f.request).toHaveBeenCalledExactlyOnceWith(eta));
    });
});
