import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpxImportPage } from '../components/vessel/GpxImportPage';

const mocks = vi.hoisted(() => ({
    setPage: vi.fn(),
    stagePassageRequest: vi.fn(),
    requestPassageMode: vi.fn(),
    scope: { key: 'user:account-a', userId: 'account-a', generation: 7 },
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage }),
}));
vi.mock('../services/gpxService', () => ({
    readGPXFile: vi.fn().mockResolvedValue('<gpx><rte /></gpx>'),
    importGPXToEntries: vi.fn(() => [
        {
            entryType: 'waypoint',
            latitude: -27.5,
            longitude: 153.1,
            timestamp: '2026-07-24T00:00:00.000Z',
            cumulativeDistanceNM: 0,
        },
        {
            entryType: 'waypoint',
            latitude: -27.3,
            longitude: 153.4,
            timestamp: '2026-07-24T01:00:00.000Z',
            cumulativeDistanceNM: 20,
        },
    ]),
    extractGPXRouteWaypoints: vi.fn(() => ({
        routeName: 'Moreton Bay Run',
        origin: { lat: -27.5, lon: 153.1, name: 'Manly' },
        destination: { lat: -27.3, lon: 153.4, name: 'Tangalooma' },
        waypoints: [
            { lat: -27.5, lon: 153.1, name: 'Manly' },
            { lat: -27.4, lon: 153.2, name: 'Hope Banks' },
            { lat: -27.3, lon: 153.4, name: 'Tangalooma' },
        ],
        totalDistanceNM: 20,
    })),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { importGPXVoyage: vi.fn() },
}));
vi.mock('../services/passageHandoff', () => ({
    stagePassageRequest: mocks.stagePassageRequest,
    requestPassageMode: mocks.requestPassageMode,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => mocks.scope,
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: () => <div>Import GPX</div>,
}));

describe('GpxImportPage passage handoff', () => {
    beforeEach(() => {
        mocks.setPage.mockClear();
        mocks.stagePassageRequest.mockClear();
        mocks.requestPassageMode.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stages the complete passage before navigating, then broadcasts it after the transition', async () => {
        const { container } = render(<GpxImportPage onBack={vi.fn()} />);
        const input = container.querySelector<HTMLInputElement>('input[type="file"]');
        expect(input).not.toBeNull();

        fireEvent.change(input!, {
            target: { files: [new File(['<gpx />'], 'route.gpx', { type: 'application/gpx+xml' })] },
        });

        const routeButton = await screen.findByRole('button', { name: /Route to Passage Planner/ });
        vi.useFakeTimers();
        fireEvent.click(routeButton);

        const expectedDetail = {
            departure: { lat: -27.5, lon: 153.1, name: 'Manly' },
            arrival: { lat: -27.3, lon: 153.4, name: 'Tangalooma' },
            via: [{ lat: -27.4, lon: 153.2, name: 'Hope Banks' }],
        };
        expect(mocks.stagePassageRequest).toHaveBeenCalledWith(expectedDetail, mocks.scope);
        expect(mocks.setPage).toHaveBeenCalledWith('map');
        expect(mocks.stagePassageRequest.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.setPage.mock.invocationCallOrder[0],
        );
        expect(mocks.requestPassageMode).not.toHaveBeenCalled();

        act(() => vi.advanceTimersByTime(300));
        expect(mocks.requestPassageMode).toHaveBeenCalledWith(expectedDetail, mocks.scope);
    });
});
