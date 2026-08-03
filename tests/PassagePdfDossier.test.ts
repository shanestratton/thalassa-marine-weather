import { describe, expect, it } from 'vitest';

import { generatePassagePdf } from '../services/PassagePdfService';
import type { PassageBriefData } from '../services/PassageBriefService';

function briefFixture(overrides: Partial<PassageBriefData> = {}): PassageBriefData {
    return {
        routeName: 'Newport → Lady Musgrave',
        origin: { name: 'Newport', lat: -27.205, lon: 153.093 },
        destination: { name: 'Lady Musgrave', lat: -23.907, lon: 152.404 },
        departureTime: '2026-08-10T06:00:00+10:00',
        totalDistanceNM: 218,
        estimatedDuration: 36,
        speed: 6,
        vesselName: 'Serene Summer',
        vesselType: 'sail',
        crewCount: 2,
        turnWaypoints: [
            { name: 'Caloundra', lat: -26.8, lon: 153.15, tws: 12, bng: 20 },
            { name: 'Double Island Pt', lat: -25.93, lon: 153.19, tws: 15, bng: 10 },
        ],
        departureTides: [
            { time: '2026-08-10T04:55:00+10:00', type: 'high', height: 2.1 },
            { time: '2026-08-10T11:10:00+10:00', type: 'low', height: 0.5 },
        ],
        arrivalTides: [{ time: '2026-08-11T17:20:00+10:00', type: 'high', height: 2.4 }],
        ...overrides,
    };
}

describe('PassagePdfService dossier', () => {
    it('renders the full dossier without throwing and produces a real document', () => {
        const blob = generatePassagePdf(briefFixture());
        expect(blob.size).toBeGreaterThan(5000);
    });

    it('still renders for a minimal single-handed day sail', () => {
        const blob = generatePassagePdf(
            briefFixture({
                crewCount: 1,
                estimatedDuration: 4.5,
                totalDistanceNM: 24,
                turnWaypoints: undefined,
                departureTides: undefined,
                arrivalTides: undefined,
            }),
        );
        expect(blob.size).toBeGreaterThan(3000);
    });

    it('handles a long multi-day passage with a big crew across page breaks', () => {
        const blob = generatePassagePdf(
            briefFixture({
                crewCount: 4,
                estimatedDuration: 7 * 24,
                totalDistanceNM: 800,
                turnWaypoints: Array.from({ length: 30 }, (_, i) => ({
                    name: `WP${i + 1}`,
                    lat: -27 + i * 0.2,
                    lon: 153 + i * 0.1,
                    tws: 10 + (i % 8),
                    bng: (i * 20) % 360,
                })),
            }),
        );
        expect(blob.size).toBeGreaterThan(8000);
    });
});
