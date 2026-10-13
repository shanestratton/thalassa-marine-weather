import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Honest about the boat, and only when there is one (127-DESKMAP C1/C2,
 * critic pass 3). "Licensed charts stay on …" is for an account whose paired
 * Pi holds licensed charts (settings.boatCharts.licensed, written by 127-C-c);
 * everyone else — NOAA-only, no Pi, crew, signed out — gets the open-chart
 * words, and never a boat name. Fictional boats throughout.
 */

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@capacitor/core')>();
    return {
        ...actual,
        Capacitor: { ...actual.Capacitor, isNativePlatform: () => platform.native },
    };
});
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { deskSlot0Line } from '../components/map/deskMap';
import { boatChartsLine } from '../services/enc/boatChartsWords';
import { ChartDepthControls, type ChartDepthControlsProps } from '../components/map/ChartDepthControls';

const NAMES = ['Fixture Boat', 'L’Étoile du Pacifique', 'Nordlys av Tromsø'];
const OPEN_STRIP = 'No chart for this area';
const OPEN_NOTICE = 'No chart for this area. Open charts (NOAA) show here in US waters.';
const TODAY = 'No verified ENC charts installed. Library imports are reference-only.';
// The phone's words since 127-C-c (one helper; the ENC Library is retired).
const PHONE_AWAY = "Fixture Boat's licensed charts open on the boat's Wi-Fi. Open charts only here.";

beforeEach(() => {
    platform.native = false;
});

describe('the words, one helper', () => {
    it.each(NAMES)('a licensed account sees its own boat: %s', (name) => {
        expect(boatChartsLine('web', name, 'strip')).toBe(`Licensed charts stay on ${name}`);
        expect(boatChartsLine('web', name, 'notice')).toBe(
            `Licensed charts stay on ${name}. Open charts show here where they exist (NOAA, US waters).`,
        );
    });

    it('a licensed account with no vessel name: "stay aboard"', () => {
        expect(boatChartsLine('web', null, 'strip')).toBe('Licensed charts stay aboard');
        expect(boatChartsLine('web', '  ', 'notice')).toBe(
            'Licensed charts stay aboard. Open charts show here where they exist (NOAA, US waters).',
        );
    });

    it('everyone else never sees "licensed", "stay on" or a boat name', () => {
        for (const name of [...NAMES, null]) {
            for (const form of ['strip', 'notice'] as const) {
                const line = boatChartsLine('web-open', name, form);
                expect(line).toBe(form === 'strip' ? OPEN_STRIP : OPEN_NOTICE);
                expect(line).not.toMatch(/licensed|stay on|aboard/i);
                for (const n of NAMES) expect(line).not.toContain(n);
            }
        }
    });
});

describe('MapHub’s slot-0 selector', () => {
    it('flag true + name: the licensed line, everywhere, even over an open chart', () => {
        for (const chartInView of [false, true])
            expect(deskSlot0Line({ licensed: true, boatName: 'Fixture Boat', chartInView })).toEqual({
                text: 'Licensed charts stay on Fixture Boat',
                hidden: false,
            });
        expect(deskSlot0Line({ licensed: true, boatName: null, chartInView: false }).text).toBe(
            'Licensed charts stay aboard',
        );
    });

    it.each([false, null, undefined])(
        'flag %s (NOAA-only, no Pi, crew or signed out): "No chart for this area", its box kept but blank over a chart',
        (licensed) => {
            const off = deskSlot0Line({ licensed, boatName: 'Fixture Boat', chartInView: false });
            expect(off).toEqual({ text: OPEN_STRIP, hidden: false });
            const over = deskSlot0Line({ licensed, boatName: 'Fixture Boat', chartInView: true });
            expect(over.hidden).toBe(true);
            expect(over.text).not.toContain('Fixture Boat');
        },
    );

    it('never a boat name without the flag', () => {
        for (const licensed of [false, null, undefined])
            for (const chartInView of [false, true])
                for (const name of NAMES)
                    expect(deskSlot0Line({ licensed, boatName: name, chartInView }).text).not.toContain(name);
    });

    it('reads the flag, and never writes it (127-C-c is its one writer)', () => {
        const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const hub = strip(readFileSync('components/map/MapHub.tsx', 'utf8'));
        expect(hub).toContain('settings.boatCharts?.licensed === true');
        for (const path of [
            'components/map/MapHub.tsx',
            'components/map/deskMap.ts',
            'components/map/DeskMapStrip.tsx',
            'components/map/ChartDepthControls.tsx',
            'services/enc/boatChartsWords.ts',
        ])
            expect(strip(readFileSync(path, 'utf8')), path).not.toMatch(/boatCharts\s*:/);
        expect(readFileSync('types/settings.ts', 'utf8')).toMatch(
            /boatCharts\?:\s*\{\s*licensed: boolean\s*\}\s*\|\s*null;/,
        );
    });
});

function props(overrides: Partial<ChartDepthControlsProps> = {}): ChartDepthControlsProps {
    return {
        surfaceVisible: true,
        chartKeyVisible: false,
        plotting: false,
        tideDepthMode: false,
        tideOffsetInfo: null,
        tideScrubQ: 0,
        onTideScrubChange: vi.fn(),
        onToggleTideDepth: vi.fn(),
        encCellCount: 0,
        encReferenceCellCount: 0,
        encVisible: true,
        encHydration: { total: 0, remaining: 0 },
        encNoCoverage: true,
        referenceNoticeVisible: false,
        nightDim: false,
        onNightDimChange: vi.fn(),
        onToggleChartKey: vi.fn(),
        ...overrides,
    };
}

describe('the web Obs no-charts notice (127-DESKMAP C2)', () => {
    it('a licensed account: its boat keeps the licensed charts; open charts show here', () => {
        render(<ChartDepthControls {...props({ boatChartsLicensed: true, boatName: 'Fixture Boat' })} />);
        const notice = screen.getByRole('status', { name: 'ENC coverage' });
        expect(notice).toHaveTextContent(boatChartsLine('web', 'Fixture Boat', 'notice'));
        expect(notice).not.toHaveTextContent(TODAY);
        expect(notice).not.toHaveTextContent(OPEN_NOTICE);
    });

    it.each([false, undefined])('flag %s: the open sentence, no "Licensed", no name', (licensed) => {
        render(<ChartDepthControls {...props({ boatChartsLicensed: licensed, boatName: 'Fixture Boat' })} />);
        const notice = screen.getByRole('status', { name: 'ENC coverage' });
        expect(notice).toHaveTextContent(OPEN_NOTICE);
        expect(notice).not.toHaveTextContent(/Licensed|Fixture Boat/);
        // The ENC Library is retired (127-C-c, Shane's Q1 "yes").
        expect(screen.queryByRole('button', { name: 'Open on-device ENC Library' })).not.toBeInTheDocument();
    });

    it('the phone says where her licensed charts are, from the same helper (127-C-c)', () => {
        platform.native = true;
        render(
            <ChartDepthControls
                {...props({ boatChartsLicensed: true, boatName: 'Fixture Boat', boatChartsState: 'away' })}
            />,
        );
        const notice = screen.getByRole('status', { name: 'ENC coverage' });
        expect(notice).toHaveTextContent(PHONE_AWAY);
        expect(notice).not.toHaveTextContent(TODAY);
    });

    it('takes its web sentences from the helper, with no second string in the component', () => {
        const controls = readFileSync('components/map/ChartDepthControls.tsx', 'utf8');
        expect(controls).toMatch(/import \{ boatChartsLine\b[^}]*\} from '\.\.\/\.\.\/services\/enc\/boatChartsWords'/);
        expect(controls).not.toContain('Open charts (NOAA) show here');
        expect(controls).not.toContain('Licensed charts stay');
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        const call = hub.match(/<ChartDepthControls\b[\s\S]*?\/>/)?.[0] ?? '';
        expect(call).toContain('boatChartsLicensed={boatChartsLicensed}');
        // The web words name the account's vessel; the phone's name the paired boat (127-C-c).
        expect(call).toContain('boatName={chartsBoatName}');
        expect(hub).toContain('const chartsBoatName = boatChartsNow ? boatName() : ownBoatName;');
        expect(call).toContain('boatChartsState={boatChartsNow}');
        expect(controls).not.toContain("licensed charts open on the boat's Wi-Fi");
    });
});
