import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadarFeed } from '../utils/radarFeed';
import type { RadarPictureSnapshot } from '../services/radar/radarStore';

const fixtures = vi.hoisted(() => ({
    features: [] as GeoJSON.Feature<GeoJSON.Point>[],
    filters: { source: 'local', minSpeedKn: 10 },
    radar: { version: 0, contacts: [], feeds: [] } as RadarPictureSnapshot,
}));
vi.mock('../services/radar/radarStore', () => ({
    RadarStore: { getSnapshot: () => fixtures.radar, subscribe: () => () => undefined },
}));
vi.mock('../services/AisStore', () => ({ AisStore: { subscribe: () => () => undefined } }));
vi.mock('../services/ais/aisTargetCache', () => ({
    readAisTargetPicture: () => fixtures.features,
    subscribeAisTargetPicture: () => () => undefined,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: unknown) => unknown) =>
        selector({ settings: { aisDisplayFilters: fixtures.filters } }),
}));
vi.mock('../services/AisGuardWatch', () => ({
    readCollisionInputs: () => ({
        own: { lat: -27, lon: 153 },
        motion: {},
        prefs: { offshore: { cpaNm: 0.5, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } },
        ownMmsis: new Set(),
        atAnchor: false,
    }),
    gradeCollisionTargets: () => [{ mmsi: 503000002, assessment: { risk: 'CAUTION', cpaNm: 0.25 } }],
}));
import { AisTargetsSheet } from '../components/map/AisTargetsSheet';
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    fixtures.radar = { version: 0, contacts: [], feeds: [] };
});

describe('the lazy AIS Targets sheet', () => {
    it('uses display choices while keeping caution and distress, shows measurements and selects the actual report', () => {
        fixtures.features = [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.99] },
                properties: {
                    mmsi: 503000001,
                    name: 'HIDDEN SLOW BOAT',
                    source: 'cloud',
                    sog: 0,
                    lastUpdated: Date.now(),
                },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.98] },
                properties: {
                    mmsi: 503000002,
                    name: 'CLOSE SHIP',
                    source: 'cloud',
                    sog: 5,
                    lastUpdated: Date.now() - 120000,
                },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [153, -26.97] },
                properties: { mmsi: 970000001, name: 'AIS SART', source: 'cloud', sog: 0, lastUpdated: Date.now() },
            },
        ];
        const onSelect = vi.fn();
        const onClose = vi.fn();
        render(<AisTargetsSheet onSelect={onSelect} onClose={onClose} />);
        expect(screen.queryByText('HIDDEN SLOW BOAT')).toBeNull();
        const close = screen.getByRole('button', { name: /CLOSE SHIP/ });
        expect(close).toHaveTextContent('CAUTION');
        expect(close).toHaveTextContent('000°T');
        expect(close).toHaveTextContent('CPA 0.25 NM');
        expect(close).toHaveTextContent('2 min old');
        expect(screen.getByText('AIS SART')).toBeTruthy();
        fireEvent.click(close);
        expect(onSelect).toHaveBeenCalledWith(fixtures.features[1]);
        fireEvent.click(screen.getByRole('button', { name: 'Close targets' }));
        expect(onClose).toHaveBeenCalledOnce();
    });
});

it('shows actual radar separately or one proven AIS+radar row, with no fabricated MMSI', () => {
    const at = Date.UTC(2026, 0, 2, 12);
    vi.spyOn(Date, 'now').mockReturnValue(at);
    const frame = (body: string) =>
        `$${body}*${[...body]
            .reduce((v, c) => v ^ c.charCodeAt(0), 0)
            .toString(16)
            .padStart(2, '0')}`;
    const feed = new RadarFeed('gateway:generated');
    for (const body of [
        'GPRMC,120000,A,0000.000,N,00000.000,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A',
        'RATLL,2,0002.000,N,00000.000,E,<img src=x>,120000,T,',
    ])
        feed.ingest(frame(body), at, at);
    fixtures.radar = {
        version: 1,
        contacts: feed.contacts(at),
        feeds: [
            {
                feedId: feed.feedId,
                source: 'gateway',
                ownship: feed.ownshipSnapshot(),
                lastFrameAt: at,
                lastTargetAt: at,
            },
        ],
    };
    const contact = fixtures.radar.contacts[0];
    fixtures.features = [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [contact.position!.lon, contact.position!.lat] },
            properties: {
                mmsi: 123456789,
                name: 'Generated match',
                source: 'local',
                lastUpdated: at,
                sog: contact.motion!.sogKn,
                cog: contact.motion!.cogTrueDeg,
            },
        },
    ];
    const select = vi.fn();
    render(<AisTargetsSheet onClose={() => undefined} onSelect={select} />);
    expect(screen.getByText('Targets · 2')).toBeTruthy();
    const merged = screen.getByRole('button', { name: /AIS \+ radar · Generated match/ });
    expect(merged).toHaveTextContent('MMSI 123456789');
    expect(merged).toHaveTextContent('DANGER');
    expect(screen.getAllByRole('button', { name: /Generated match/ })).toHaveLength(1);
    const independent = screen.getByRole('button', { name: /Radar · <img src=x>/ });
    expect(independent).toHaveTextContent('CPA unknown');
    expect(independent).toHaveTextContent('ground motion unknown');
    expect(independent.textContent).not.toContain('MMSI');
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(independent);
    expect(select.mock.calls[0][0].properties).toEqual({
        source: 'radar',
        radarContactKey: 'radar:gateway:generated:RA:2',
    });
});
