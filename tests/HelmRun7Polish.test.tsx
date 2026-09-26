/**
 * UX scorecard run 7, helm screens: the Instrument Panel, NMEA Gateway and
 * Anchor Watch polish that has to stay put.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShipsBellClock } from '../components/nmea/gauges/ShipsBellClock';
import { BarometerGauge } from '../components/nmea/gauges/BarometerGauge';
import { ScopeRadar } from '../components/anchor-watch/ScopeRadar';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const panel = read('components/nmea/TheGlassPage.tsx');
const nmea = read('components/vessel/NmeaPage.tsx');

afterEach(cleanup);

describe('ship’s bell clock', () => {
    it('sets its legends at the 12 px floor and repeats the zone where no hand can cover it', () => {
        const { container } = render(<ShipsBellClock hour={18} minute={57} second={0} zoneLabel="GMT+10" />);
        const legends = [...container.querySelectorAll('text.bell-legend')];
        expect(legends).toHaveLength(2);
        for (const legend of legends) expect(Number(legend.getAttribute('font-size'))).toBeGreaterThanOrEqual(12);
        // The HTML caption under the dial names the watch and the zone.
        expect(container.querySelector('p')!.textContent).toMatch(/watch · GMT\+10$/i);
    });

    it('keeps the bell dots clear of the 7 and the 5', () => {
        const { container } = render(<ShipsBellClock hour={18} minute={57} second={0} />);
        const dots = [...container.querySelectorAll('circle.bell-mark')];
        expect(dots).toHaveLength(8);
        // CY + 60: at CY + 72 the row touched the numerals.
        for (const dot of dots) expect(Number(dot.getAttribute('cy'))).toBe(210);
    });
});

describe('dials speak a sentence, not tick labels', () => {
    it('names the barometer with its reading, or says there is none', () => {
        render(<BarometerGauge hpa={null} readout="--" />);
        expect(screen.getByRole('img', { name: 'Barometer, no data' })).toBeInTheDocument();
        cleanup();
        render(<BarometerGauge hpa={1013.2} readout="1013.2" readoutUnit="hPa" />);
        expect(screen.getByRole('img', { name: 'Barometer, 1013.2 hPa' })).toBeInTheDocument();
        cleanup();
        // No readout: the raw hPa is spoken in hPa, not in the caller's unit.
        render(<BarometerGauge hpa={1013.2} readoutUnit="inHg" />);
        expect(screen.getByRole('img', { name: 'Barometer, 1013.2 hPa' })).toBeInTheDocument();
    });

    it('gives the true-wind dial a sentence label and hides its ticks', () => {
        expect(panel).toContain('spokenName="True wind speed"');
        expect(panel).toContain(
            "aria-label={spokenReading(spokenName, value === null ? '--' : value.toFixed(1), spokenUnit)}",
        );
        expect(panel).toContain('<g opacity={opacity} aria-hidden="true">');
    });
});

describe('Instrument Panel', () => {
    it('shows an unconfigured gateway in neutral grey, red only for a dropped one', () => {
        expect(panel).toContain("const panelAlarm = diagnosis.actionable && diagnosis.state !== 'no-gateway';");
        expect(panel).not.toMatch(/: diagnosis\.actionable\s*\?/);
    });

    it('lets the next plate heading peek, while the last page stays full height for snap', () => {
        expect(panel).toContain("const sectionHeight = 'h-[calc(100%_-_var(--thalassa-tabbar-height)_-_24px)]';");
        const sections = [...panel.matchAll(/<section\b[\s\S]*?<\/section>/g)].map(([section]) => section);
        const helm = sections.at(-1)!;
        expect(helm).toContain('<SectionPlate title="Helm"');
        expect(helm).toContain('w-full h-full snap-start snap-always');
        expect(helm).toContain('${sectionPb}');
        for (const section of sections.slice(0, -1)) expect(section).toContain('w-full ${sectionHeight} snap-start');
    });

    it('sets the plate heading at 12 px', () => {
        expect(panel).toContain('whitespace-nowrap text-xs font-black uppercase tracking-[0.35em]');
    });
});

describe('NMEA Gateway', () => {
    it('opens from the Vessel hub, so its trail says Vessel', () => {
        expect(nmea).toContain("breadcrumbs={['Vessel', 'NMEA Gateway']}");
        expect(nmea).not.toContain("Ship's Office");
    });

    it('says No gateway when none was ever saved, the Instrument Panel’s word', () => {
        expect(nmea).toContain('const gatewaySaved = NmeaListenerService.getSavedConfig() !== null;');
        expect(nmea).toMatch(/gatewaySaved\s*\?\s*'Disconnected'\s*:\s*'No gateway'/);
    });

    it('names the receiver in plain words, not Apple certification jargon', () => {
        expect(nmea).not.toContain('MFi');
        expect(nmea).toContain('A plug-in or Bluetooth GPS made for iPhone (Bad Elf and similar)');
    });
});

describe('Anchor Watch scope line', () => {
    it('keeps the quality and swing radius on one line', () => {
        const { container } = render(<ScopeRadar rodeLength={30} waterDepth={5} rodeType="chain" safetyMargin={10} />);
        const line = container.querySelector('p')!;
        expect(line.className).toContain('whitespace-nowrap');
        expect(line.textContent).toContain('ADEQUATE');
        expect(line.textContent).toMatch(/swing radius/);
    });
});
