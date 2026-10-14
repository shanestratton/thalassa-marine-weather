/**
 * The Glass counts official warnings apart from its forecast alerts (129-06).
 * The warnings row (CompactHeaderRow, above the 163 px instrument grid, which
 * it never touches) gains an official chip only once official_alerts_at has
 * answered and something is in force; tapping it opens the Warnings page. It
 * wears the official style, never the forecast pill's. Its fit at 320 px in
 * wide fonts is measured in browser-tests/official-warnings-layout.spec.ts.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setPage: vi.fn() }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: mocks.setPage }) }));

import { supabase } from '../services/supabase';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { CompactHeaderRow } from '../components/dashboard/CompactHeaderRow';
import { useOfficialWarnings } from '../hooks/useOfficialWarnings';
import { clearOfficialWarningsCache, officialInForce } from '../services/officialWarnings';
import { GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX } from '../components/dashboard/glassLayout';

const FIXTURES = JSON.parse(readFileSync('tests/fixtures/official-alerts/rpc-answers.json', 'utf8'));
const rpc = vi.mocked(supabase!.rpc);

beforeEach(() => {
    // official_alerts_at is for signed-in users; the app never asks signed out.
    setAuthIdentityScope('fixture-skipper');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXTURES.anchor));
    clearOfficialWarningsCache();
    rpc.mockReset();
    mocks.setPage.mockClear();
    sessionStorage.clear();
});
afterEach(() => {
    setAuthIdentityScope(null);
    cleanup();
    vi.useRealTimers();
});

describe('the official chip on the Glass', () => {
    it('is not there until the count is known, nor when nothing is in force', () => {
        render(<CompactHeaderRow alerts={[]} />);
        expect(screen.queryByRole('button', { name: /official warning/ })).toBeNull();
        cleanup();
        render(<CompactHeaderRow alerts={[]} officialCount={null} />);
        expect(screen.queryByRole('button', { name: /official warning/ })).toBeNull();
        cleanup();
        render(<CompactHeaderRow alerts={[]} officialCount={0} />);
        expect(screen.queryByRole('button', { name: /official warning/ })).toBeNull();
    });

    it('counts official warnings apart from forecast alerts, and opens the Warnings page', () => {
        render(<CompactHeaderRow alerts={['Forecast: strong wind, 22 kt+']} officialCount={2} />);
        const chip = screen.getByRole('button', { name: '2 official warnings in force' });
        expect(chip.textContent).toContain('2');
        expect(screen.getByRole('button', { name: '1 active forecast alert' })).toBeInTheDocument();
        fireEvent.click(chip);
        expect(mocks.setPage).toHaveBeenCalledWith('warnings');
        cleanup();
        render(<CompactHeaderRow alerts={[]} officialCount={1} />);
        expect(screen.getByRole('button', { name: '1 official warning in force' })).toBeInTheDocument();
    });

    it('alone, it takes the pill’s place: never a green "No forecast alerts" beside an official warning', () => {
        render(<CompactHeaderRow alerts={[]} officialCount={1} />);
        expect(screen.queryByRole('button', { name: 'No forecast alerts' })).toBeNull();
        expect(screen.queryByText('No forecast alerts')).toBeNull();
        expect(screen.getByRole('button', { name: '1 official warning in force' }).textContent).toBe('Official1');
    });

    it('wears the official style, never the forecast pill’s', () => {
        render(<CompactHeaderRow alerts={['Forecast: gale-force wind, 34 kt+']} officialCount={3} />);
        const chip = screen.getByRole('button', { name: '3 official warnings in force' });
        const pill = screen.getByRole('button', { name: '1 active forecast alert' });
        expect(chip).toHaveAttribute('data-alert-style', 'official');
        expect(pill).toHaveAttribute('data-alert-style', 'forecast');
        expect(chip.className).not.toMatch(/\b(?:bg|border)-(?:red|amber|emerald)-/);
        expect(pill.className).not.toMatch(/\b(?:bg|border)-sky-/);
    });

    it('leaves the 163 px instrument grid alone', () => {
        expect(GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX).toBe(163);
        const dashboard = readFileSync('components/Dashboard.tsx', 'utf8');
        const row = dashboard.slice(
            dashboard.indexOf('<CompactHeaderRow'),
            dashboard.indexOf('/>', dashboard.indexOf('<CompactHeaderRow')),
        );
        expect(row).toMatch(/officialCount=\{officialCount\}/);
        expect(dashboard).toMatch(/useOfficialWarnings\(sunMoonPlaced \? data\?\.coordinates : null\)/);
        expect(readFileSync('components/dashboard/HeroWidgets.tsx', 'utf8')).not.toMatch(/official/i);
    });
});

describe('useOfficialWarnings', () => {
    it('is null until the RPC answers, then the answer; the count drops what has expired', async () => {
        rpc.mockImplementation((async () => ({
            data: structuredClone(FIXTURES.answers.inforce),
            error: null,
        })) as never);
        const { result } = renderHook(() => useOfficialWarnings({ lat: 39.1, lon: -76.4 }));
        expect(result.current).toBeNull();
        await act(async () => undefined);
        expect(result.current?.coverage).toBe('live');
        expect(officialInForce(result.current!, Date.now())).toHaveLength(2);
        // 12:45Z: the Special Marine Warning has expired; the advisory has not.
        expect(officialInForce(result.current!, Date.parse('2026-10-14T12:46:00Z'))).toHaveLength(1);
    });

    it('a refresh that fails keeps the answer it had, marked stale: the count stays on the Glass', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date(FIXTURES.anchor));
        rpc.mockImplementation((async () => ({
            data: structuredClone(FIXTURES.answers.inforce),
            error: null,
        })) as never);
        const { result, rerender } = renderHook(({ at }) => useOfficialWarnings(at), {
            initialProps: { at: { lat: 39.1, lon: -76.4 } },
        });
        await act(async () => undefined);
        expect(officialInForce(result.current!, Date.now())).toHaveLength(2);
        // Offshore, the 5-minute refresh hits a dropout.
        rpc.mockImplementation((async () => ({ data: null, error: { message: 'Failed to fetch' } })) as never);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        });
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(result.current).not.toBeNull();
        expect(result.current!.staleSince).toBe(FIXTURES.answers.inforce.at);
        expect(officialInForce(result.current!, Date.now())).toHaveLength(2);
        // Asked again after a minute while stale; once it answers, the mark is gone.
        rpc.mockImplementation((async () => ({
            data: structuredClone(FIXTURES.answers.inforce),
            error: null,
        })) as never);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        expect(result.current!.staleSince).toBeUndefined();
        // Even with the service's memory gone, a failure keeps what the hook had.
        clearOfficialWarningsCache();
        rpc.mockImplementation((async () => ({ data: null, error: { message: 'Failed to fetch' } })) as never);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5 * 60_000);
        });
        expect(officialInForce(result.current!, Date.now())).toHaveLength(2);
        expect(result.current!.staleSince).toBeDefined();
        // A new position starts again from nothing: another place's warnings are never shown for it.
        rerender({ at: { lat: 45.5, lon: -63.2 } });
        await act(async () => undefined);
        expect(result.current).toBeNull();
    });

    it('stays null when the function is not there, and asks with the position to ~100 m', async () => {
        rpc.mockImplementation((async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } })) as never);
        const { result } = renderHook(() => useOfficialWarnings({ lat: 39.123456, lon: -76.654321 }));
        await act(async () => undefined);
        expect(result.current).toBeNull();
        expect(rpc).toHaveBeenCalledWith('official_alerts_at', { p_lat: 39.123, p_lon: -76.654 });
    });

    it('asks nothing without a position, and nothing malformed is taken as an answer', async () => {
        renderHook(() => useOfficialWarnings(undefined));
        await act(async () => undefined);
        expect(rpc).not.toHaveBeenCalled();
        rpc.mockImplementation((async () => ({ data: { coverage: 'everything is fine' }, error: null })) as never);
        const { result } = renderHook(() => useOfficialWarnings({ lat: 1, lon: 2 }));
        await act(async () => undefined);
        expect(result.current).toBeNull();
    });
});
