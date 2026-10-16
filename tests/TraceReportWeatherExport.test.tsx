import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    generate: vi.fn<(data: unknown) => Blob>(() => new Blob(['synthetic PDF'], { type: 'application/pdf' })),
    share: vi.fn(async () => 'downloaded'),
}));
vi.mock('../services/RouteReportPdfService', () => ({
    generateRouteReportPdf: h.generate,
    getRouteReportFileName: () => 'route.pdf',
}));
vi.mock('../utils/sharePdf', () => ({ sharePdfBlob: h.share, shareFileBlob: h.share }));
vi.mock('../components/weather/RouteMeteogram', async () => {
    const { routeWeatherFixture } = await import('./fixtures/routeWeatherFixture');
    return {
        default: (p: { identity: string; onReport: (v: ReturnType<typeof routeWeatherFixture>) => void }) => (
            <button onClick={() => p.onReport(routeWeatherFixture(p.identity))}>Use synthetic report rows</button>
        ),
    };
});
import { TraceReportModal } from '../components/map/TraceReportModal';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { routeWeatherFixturePins as pins, routeWeatherFixtureStart } from './fixtures/routeWeatherFixture';
import { traceGeometryKey } from '../services/traceVerification';
function props(): React.ComponentProps<typeof TraceReportModal> {
    return {
        open: true,
        onClose: vi.fn(),
        pins,
        routeName: 'Fictional passage',
        verdicts: [],
        tideLabels: {},
        departureLabel: '',
        ackedLegs: new Set(),
        fixBusy: null,
        onAckLeg: vi.fn(),
        cruisingSpeedKts: 6,
        departureMs: null,
        releaseGate: {
            allowed: true,
            reason: '',
            verification: {
                version: 1,
                graderVersion: 'route-tracer-v1',
                geometryKey: traceGeometryKey(pins),
                checkedAt: new Date(routeWeatherFixtureStart).toISOString(),
                result: 'verified',
                legGrades: [],
                acknowledgedDangerLegs: [],
                draftM: 1.8,
                draftAssumed: false,
                encRegistryVersion: 0,
                encRegistryFingerprint: '',
                departureMs: routeWeatherFixtureStart,
                tideWindowLabel: '',
            },
        },
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('synthetic-export-account');
});
async function sample() {
    fireEvent.click(screen.getByRole('button', { name: 'Route meteogram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use synthetic report rows' }));
}

it('exports exactly the sampled clock/rows, even when the original departure was now', async () => {
    render(<TraceReportModal {...props()} />);
    await sample();
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(h.share).toHaveBeenCalledOnce());
    const data = h.generate.mock.calls[0][0] as unknown as {
        departureMs: number;
        routeWeather: { departureMs: number; rows: unknown[] };
    };
    expect(data.departureMs).toBe(routeWeatherFixtureStart);
    expect(data.departureMs).toBe(data.routeWeather.departureMs);
    expect(data.routeWeather.rows.length).toBeGreaterThan(24);
});
it.each(['geometry', 'account', 'close'])('does not export after %s changes while PDF code loads', async (change) => {
    const input = props(),
        view = render(<TraceReportModal {...input} />);
    await sample();
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    if (change === 'geometry') view.rerender(<TraceReportModal {...input} pins={[pins[0], pins[2]]} />);
    if (change === 'account')
        act(() => {
            setAuthIdentityScope('different-export-account');
        });
    if (change === 'close') view.rerender(<TraceReportModal {...input} open={false} />);
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.share).not.toHaveBeenCalled();
});

it('also refuses a GPX from the previous account after its share module loads', async () => {
    render(<TraceReportModal {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /GPX/ }));
    act(() => {
        setAuthIdentityScope('different-gpx-account');
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.share).not.toHaveBeenCalled();
});
