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
import { TraceReportModal, formatWaypointEtaUTC } from '../components/map/TraceReportModal';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { clearAlongRouteReport, getAlongRouteReport, publishAlongRouteReport } from '../stores/alongRouteReportStore';
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
    clearAlongRouteReport();
    setAuthIdentityScope('synthetic-export-account');
});
async function sample() {
    fireEvent.click(screen.getByRole('button', { name: 'Route meteogram' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use synthetic report rows' }));
}

it('retains waypoint timings with minute carry, explicit UTC and no invented default speed', async () => {
    expect(formatWaypointEtaUTC({ etaMs: Date.UTC(2026, 9, 17, 2, 30), hoursFromDep: 2.999 })).toBe('+3h · 02:30 UTC');
    expect(formatWaypointEtaUTC({ etaMs: NaN, hoursFromDep: 3 })).toBe('Unknown');
    const input = props();
    const view = render(<TraceReportModal {...input} cruisingSpeedKts={undefined} />);
    expect(screen.queryAllByText(/ UTC$/)).toHaveLength(0);
    view.rerender(<TraceReportModal {...input} />);
    expect(screen.getByText(/^dep · \d\d:\d\d UTC$/)).toBeInTheDocument();
    await sample();
    expect(screen.getByText('dep · 23:30 UTC')).toBeInTheDocument();
});

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

it('keeps an explicitly loaded private chart reference out of both PDF inputs and GPX bytes', async () => {
    publishAlongRouteReport(
        {
            ownerScope: getAuthIdentityScope(),
            boatId: 'fictional-boat',
            identity: 'fictional-route',
            routeIdentity: 'fictional-route',
            departureMs: routeWeatherFixtureStart,
            speedKts: 6,
            loadedAtMs: Date.now(),
            totalNm: 10,
            chartVersion: 0,
            rows: [
                {
                    id: 'bridge:fictional-private',
                    name: 'FICTIONAL PRIVATE BRIDGE SUMMARY',
                    kind: 'bridge',
                    lat: 0.1234567,
                    lon: 0.7654321,
                    source: 'Fictional protected chart',
                    sourceUrl: null,
                    sourceAt: null,
                    aboardOnly: true,
                    note: 'Fictional chart-derived clearance detail',
                    alongNm: 5,
                    offRouteNm: 0,
                    etaMs: null,
                    ambiguousVisit: false,
                    weather: { windKts: null, windDeg: null, gustKts: null, pressureHpa: null },
                },
            ],
            limited: false,
            cachedOnly: true,
            sources: [],
            weatherSource: 'Unknown',
            weatherCredit: '',
            weatherRun: null,
            weatherNote: null,
        },
        () => true,
    );
    render(<TraceReportModal {...props()} />);
    await sample();
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(h.share).toHaveBeenCalledOnce());
    const pdf = JSON.stringify(h.generate.mock.calls[0][0]);
    expect(pdf).not.toContain('FICTIONAL PRIVATE BRIDGE');
    expect(pdf).not.toContain('0.1234567');
    expect(pdf).not.toContain('alongRoute');
    await waitFor(() => expect(screen.getByRole('button', { name: /GPX/ })).toBeEnabled());
    h.share.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /GPX/ }));
    await waitFor(() => expect(h.share).toHaveBeenCalledOnce());
    const blob = (h.share.mock.calls as unknown as [Blob][])[0][0];
    const gpx = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
    expect(gpx).not.toContain('FICTIONAL PRIVATE BRIDGE');
    expect(gpx).not.toContain('0.1234567');
    expect(getAlongRouteReport()?.rows[0].name).toBe('FICTIONAL PRIVATE BRIDGE SUMMARY');
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
