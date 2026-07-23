import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeatherWindowResult } from '../services/WeatherWindowService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const readinessMocks = vi.hoisted(() => ({
    loadCardChecks: vi.fn(),
    upsertCheck: vi.fn(),
    clearChecks: vi.fn(),
}));

const weatherMocks = vi.hoisted(() => ({
    analyse: vi.fn(),
}));

const watchMocks = vi.hoisted(() => ({
    list: vi.fn(),
    subscribeToUpdates: vi.fn(() => vi.fn()),
    publishToCrew: vi.fn(),
    assign: vi.fn(),
    clear: vi.fn(),
    getMyCrew: vi.fn(),
}));

vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: readinessMocks,
}));

vi.mock('../services/WeatherWindowService', () => ({
    WeatherWindowService: {
        analyse: weatherMocks.analyse,
    },
}));

vi.mock('../services/WatchAssignmentService', () => ({
    WatchAssignmentService: {
        list: watchMocks.list,
        subscribeToUpdates: watchMocks.subscribeToUpdates,
        publishToCrew: watchMocks.publishToCrew,
        assign: watchMocks.assign,
        clear: watchMocks.clear,
    },
}));

vi.mock('../services/CrewService', () => ({
    getMyCrew: watchMocks.getMyCrew,
}));

vi.mock('../components/passage/WatchAssignSheet', () => ({
    WatchAssignSheet: () => null,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { readinessStorageKey, useReadinessSync, useScopedReadinessStorageState } from '../hooks/useReadinessSync';
import { WeatherWindowCard } from '../components/passage/WeatherWindowCard';
import { WatchScheduleCard } from '../components/passage/WatchScheduleCard';

const CHECKLIST_KEY = 'test_readiness_checklist';

function ChecklistHarness({ voyageId }: { voyageId: string }) {
    const [checks, setChecks] = useScopedReadinessStorageState<Record<string, boolean>>(CHECKLIST_KEY, voyageId, {});
    const { syncCheck } = useReadinessSync(voyageId, 'test_card', checks, setChecks, CHECKLIST_KEY);

    return (
        <div>
            <output data-testid="checks">{JSON.stringify(checks)}</output>
            <button
                type="button"
                onClick={() =>
                    setChecks((previous) => {
                        const next = { ...previous, engine: !previous.engine };
                        syncCheck('engine', next.engine);
                        return next;
                    })
                }
            >
                Toggle engine
            </button>
        </div>
    );
}

function weatherResult(label: string): WeatherWindowResult {
    return {
        windows: [
            {
                time: '2026-08-01T00:00:00.000Z',
                label,
                rating: 'go',
                score: 95,
                summary: {
                    maxWindKts: 15,
                    avgWindKts: 10,
                    maxWaveM: 1.2,
                    avgWaveM: 0.8,
                    dominantWindDir: 'SE',
                    rainProbability: 10,
                },
                description: `${label} description`,
            },
        ],
        bestWindowIndex: 0,
        analysisTime: '2026-07-23T00:00:00.000Z',
        source: 'live',
    };
}

function watchAssignment(voyageId: string, name: string) {
    return {
        id: `${voyageId}-assignment`,
        voyage_id: voyageId,
        watch_index: 0,
        watch_label: 'First Watch',
        watch_time_label: '2000–0000',
        assigned_crew_email: `${name.toLowerCase().replace(/\s/g, '.')}@example.com`,
        assigned_crew_name: name,
        assigned_at: '2026-07-23T00:00:00.000Z',
        assigned_by: 'skipper',
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

describe('passage readiness identity and voyage isolation', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        readinessMocks.loadCardChecks.mockReset().mockResolvedValue({});
        readinessMocks.upsertCheck.mockReset().mockResolvedValue(undefined);
        readinessMocks.clearChecks.mockReset().mockResolvedValue(undefined);
        weatherMocks.analyse.mockReset();
        watchMocks.list.mockReset().mockResolvedValue([]);
        watchMocks.subscribeToUpdates.mockClear();
        watchMocks.publishToCrew.mockReset().mockResolvedValue(0);
        watchMocks.assign.mockReset().mockResolvedValue(null);
        watchMocks.clear.mockReset().mockResolvedValue(undefined);
        watchMocks.getMyCrew.mockReset().mockResolvedValue([]);
    });

    it('isolates checklist state by account and voyage, restores A, and ignores unowned legacy data', async () => {
        localStorage.setItem(CHECKLIST_KEY, JSON.stringify({ engine: true }));

        const { rerender } = render(<ChecklistHarness voyageId="voyage-1" />);
        expect(screen.getByTestId('checks')).toHaveTextContent('{}');

        fireEvent.click(screen.getByRole('button', { name: 'Toggle engine' }));
        expect(screen.getByTestId('checks')).toHaveTextContent('{"engine":true}');

        const accountAScope = getAuthIdentityScope();
        expect(localStorage.getItem(readinessStorageKey(CHECKLIST_KEY, 'voyage-1', accountAScope))).toBe(
            '{"engine":true}',
        );

        rerender(<ChecklistHarness voyageId="voyage-2" />);
        await waitFor(() => expect(screen.getByTestId('checks')).toHaveTextContent('{}'));

        rerender(<ChecklistHarness voyageId="voyage-1" />);
        await waitFor(() => expect(screen.getByTestId('checks')).toHaveTextContent('{"engine":true}'));

        await act(async () => {
            setAuthIdentityScope('account-b');
        });
        await waitFor(() => expect(screen.getByTestId('checks')).toHaveTextContent('{}'));

        await act(async () => {
            setAuthIdentityScope('account-a');
        });
        await waitFor(() => expect(screen.getByTestId('checks')).toHaveTextContent('{"engine":true}'));
    });

    it('drops a checklist server load that resolves after the account changes', async () => {
        let resolveAccountA!: (value: Record<string, { checked: boolean }>) => void;
        readinessMocks.loadCardChecks
            .mockReturnValueOnce(
                new Promise<Record<string, { checked: boolean }>>((resolve) => {
                    resolveAccountA = resolve;
                }),
            )
            .mockResolvedValueOnce({ b_only: { checked: true } });

        render(<ChecklistHarness voyageId="voyage-1" />);
        await waitFor(() => expect(readinessMocks.loadCardChecks).toHaveBeenCalledTimes(1));

        await act(async () => {
            setAuthIdentityScope('account-b');
        });
        await waitFor(() => expect(screen.getByTestId('checks')).toHaveTextContent('{"b_only":true}'));

        await act(async () => {
            resolveAccountA({ a_secret: { checked: true } });
            await Promise.resolve();
        });

        expect(screen.getByTestId('checks')).toHaveTextContent('{"b_only":true}');
        expect(screen.getByTestId('checks')).not.toHaveTextContent('a_secret');
    });

    it('does not roll back a checklist tap made while its initial load is in flight', async () => {
        let resolveInitialLoad!: (value: Record<string, { checked: boolean }>) => void;
        readinessMocks.loadCardChecks.mockReturnValueOnce(
            new Promise<Record<string, { checked: boolean }>>((resolve) => {
                resolveInitialLoad = resolve;
            }),
        );

        render(<ChecklistHarness voyageId="voyage-1" />);
        await waitFor(() => expect(readinessMocks.loadCardChecks).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole('button', { name: 'Toggle engine' }));
        expect(screen.getByTestId('checks')).toHaveTextContent('{"engine":true}');

        await act(async () => {
            resolveInitialLoad({ engine: { checked: false } });
            await Promise.resolve();
        });

        expect(screen.getByTestId('checks')).toHaveTextContent('{"engine":true}');
    });

    it('does not let a deferred weather analysis for voyage A repaint voyage B', async () => {
        let resolveVoyageA!: (value: WeatherWindowResult) => void;
        weatherMocks.analyse
            .mockReturnValueOnce(
                new Promise<WeatherWindowResult>((resolve) => {
                    resolveVoyageA = resolve;
                }),
            )
            .mockResolvedValueOnce(weatherResult('Voyage B window'));

        const { rerender } = render(
            <WeatherWindowCard
                voyageId="voyage-a"
                departure={{ lat: -27.47, lon: 153.03 }}
                destination={{ lat: -22.27, lon: 166.44 }}
            />,
        );
        await waitFor(() => expect(weatherMocks.analyse).toHaveBeenCalledTimes(1));

        rerender(
            <WeatherWindowCard
                voyageId="voyage-b"
                departure={{ lat: -16.92, lon: 145.78 }}
                destination={{ lat: -12.46, lon: 130.84 }}
            />,
        );
        await screen.findByText('Voyage B window');

        await act(async () => {
            resolveVoyageA(weatherResult('Late voyage A window'));
            await Promise.resolve();
        });

        expect(screen.getByText('Voyage B window')).toBeInTheDocument();
        expect(screen.queryByText('Late voyage A window')).not.toBeInTheDocument();
    });

    it('does not let a deferred watch roster for voyage A repaint voyage B', async () => {
        let resolveVoyageA!: (value: ReturnType<typeof watchAssignment>[]) => void;
        watchMocks.list
            .mockReturnValueOnce(
                new Promise<ReturnType<typeof watchAssignment>[]>((resolve) => {
                    resolveVoyageA = resolve;
                }),
            )
            .mockResolvedValueOnce([watchAssignment('voyage-b', 'Voyage B Crew')]);

        const { rerender } = render(<WatchScheduleCard voyageId="voyage-a" crewCount={2} />);
        await waitFor(() => expect(watchMocks.list).toHaveBeenCalledTimes(1));

        rerender(<WatchScheduleCard voyageId="voyage-b" crewCount={2} />);
        await screen.findByText(/Voyage B Crew/);

        await act(async () => {
            resolveVoyageA([watchAssignment('voyage-a', 'Late Voyage A Crew')]);
            await Promise.resolve();
        });

        expect(screen.getByText(/Voyage B Crew/)).toBeInTheDocument();
        expect(screen.queryByText(/Late Voyage A Crew/)).not.toBeInTheDocument();
    });
});
