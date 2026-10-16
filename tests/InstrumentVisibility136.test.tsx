import React from 'react';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    INSTRUMENT_SECTIONS,
    getInstrumentPanelPreferences,
    saveInstrumentPanelPreferences,
    visibleInstrumentSections,
} from '../services/instruments/panelPreferences';
import { InstrumentPanelSettings } from '../components/settings/InstrumentPanelSettings';
import { confirmUnderSail, isUnderSailConfirmed, resetUnderSailForFeed } from '../services/instruments/underSail';
import { CurrentReadout, PerformanceReadout } from '../components/nmea/DerivedInstrumentPanels';
import { measuredCurrent } from '../services/instruments/measuredCurrent';
import { sailingPerformance } from '../services/instruments/performance';
import type { InstrumentEvidence } from '../services/instruments/measurements';
import { currentHistory } from '../services/instruments/currentHistory';
import type { PiTrackHistoryPoint } from '../services/piTrackHistory';
const NOW = Date.parse('2026-10-16T10:00:00Z');
const evidence = (): InstrumentEvidence => ({
    identity: 'fictional-boat',
    via: 'lan',
    readings: {
        sog: { value: Math.sqrt(26), at: NOW, unit: 'knots', reference: 'ground', source: 'gps' },
        cogTrue: {
            value: (Math.atan2(1, 5) * 180) / Math.PI,
            at: NOW,
            unit: 'degrees',
            reference: 'true',
            source: 'gps',
        },
        stw: { value: 5, at: NOW, unit: 'knots', reference: 'water', source: 'log' },
        headingTrue: { value: 0, at: NOW, unit: 'degrees', reference: 'true', source: 'compass' },
        tws: { value: 15, at: NOW, unit: 'knots', source: 'wind' },
        twaSigned: { value: 60, at: NOW, unit: 'degrees', reference: 'relative', source: 'wind' },
    },
});
const polar = {
    polar: {
        windSpeeds: [10, 20],
        angles: [45, 90, 135, 180],
        matrix: [
            [4, 8],
            [4, 8],
            [4, 8],
            [4, 8],
        ],
    },
    source: 'manual' as const,
    label: 'Fictional selected polar',
    signature: 'fictional',
    reason: 'Selected test data',
};
beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('fictional-a');
    saveInstrumentPanelPreferences({ hidden: [], performanceHud: false, laylines: true });
    confirmUnderSail(null);
});
afterEach(cleanup);
describe('fixed order, device/account section preferences', () => {
    it('keeps all legacy relative order with Performance immediately after Speed', () => {
        expect(
            visibleInstrumentSections(
                Object.fromEntries(INSTRUMENT_SECTIONS.map((id) => [id, true])),
                getInstrumentPanelPreferences(),
            ),
        ).toEqual([...INSTRUMENT_SECTIONS]);
    });
    it('omits missing data and hidden sections while retaining a clock for an otherwise empty panel', () => {
        saveInstrumentPanelPreferences({ hidden: ['Clock', 'Speed'] });
        expect(
            visibleInstrumentSections(
                { Clock: true, Speed: true, Heading: true, Current: false },
                getInstrumentPanelPreferences(),
            ),
        ).toEqual(['Heading']);
        expect(visibleInstrumentSections({}, getInstrumentPanelPreferences())).toEqual(['Clock']);
    });
    it('settings update mounted state, account fencing restores only that account local choices', () => {
        render(<InstrumentPanelSettings />);
        fireEvent.click(screen.getByRole('switch', { name: 'Show Depth' }));
        expect(getInstrumentPanelPreferences().hidden).toEqual(['Depth']);
        act(() => setAuthIdentityScope('fictional-b'));
        expect(screen.getByRole('switch', { name: 'Show Depth' })).toHaveAttribute('aria-checked', 'true');
        act(() => setAuthIdentityScope('fictional-a'));
        expect(screen.getByRole('switch', { name: 'Show Depth' })).toHaveAttribute('aria-checked', 'false');
        expect(localStorage.getItem('thalassa_instrument_panel_v1')).toBeNull();
    });
    it('never claims a failed persistence changed the setting', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw Error('quota');
        });
        expect(saveInstrumentPanelPreferences({ hidden: ['Depth'] })).toBe(false);
        expect(getInstrumentPanelPreferences().hidden).toEqual([]);
        spy.mockRestore();
    });
});
describe('explicit sailing and instrument readouts', () => {
    it('only explicit confirmation qualifies sail, then engine/source/account changes clear it', () => {
        expect(isUnderSailConfirmed('fictional-boat')).toBe(false);
        confirmUnderSail('fictional-boat');
        expect(isUnderSailConfirmed('fictional-boat')).toBe(true);
        resetUnderSailForFeed('fictional-boat', true);
        expect(isUnderSailConfirmed('fictional-boat')).toBe(false);
        confirmUnderSail('fictional-boat');
        resetUnderSailForFeed('different-boat', false);
        expect(isUnderSailConfirmed('fictional-boat')).toBe(false);
        confirmUnderSail('fictional-boat');
        setAuthIdentityScope('fictional-b');
        expect(isUnderSailConfirmed('fictional-boat')).toBe(false);
    });
    it('shows no fake percent with unknown propulsion, preserves the selected polar label and explicit confirmation action', () => {
        const p = sailingPerformance({
            evidence: evidence(),
            polar,
            vessel: { type: 'sail' },
            propulsion: 'unknown',
            now: NOW,
        });
        if (p.kind !== 'available') throw Error('Expected performance');
        render(<PerformanceReadout performance={p} now={NOW} confirmed={false} engineRunning={false} />);
        expect(screen.getByText(/Fictional selected polar/)).toBeVisible();
        expect(screen.getByText('Actual / polar').nextElementSibling).toHaveTextContent('—');
        fireEvent.click(screen.getByRole('button', { name: 'Under sail' }));
        expect(isUnderSailConfirmed('fictional-boat')).toBe(true);
    });
    it('labels true current direction, source age and missing leeway without claiming forecast current', () => {
        const c = measuredCurrent(evidence(), NOW);
        if (c.kind !== 'available') throw Error('Expected current');
        render(<CurrentReadout current={c} now={NOW + 5000} />);
        expect(screen.getByText('Set 090°T')).toBeVisible();
        expect(screen.getByText(/5 s old/)).toBeVisible();
        expect(screen.getByText(/Leeway uncorrected/)).toBeVisible();
    });
    it('historical row time evaluates original sensor clocks and refuses legacy heading or stale input', () => {
        const row = {
            at_ms: NOW,
            sog_kts: Math.sqrt(26),
            cog_deg: (Math.atan2(1, 5) * 180) / Math.PI,
            stw_kts: 5,
            hdg_deg: 0,
            sog_at_ms: NOW,
            cog_true_at_ms: NOW,
            stw_at_ms: NOW,
            heading_true_deg: 0,
            heading_true_at_ms: NOW,
        } as PiTrackHistoryPoint;
        const legacy = { ...row, heading_true_at_ms: null };
        const stale = { ...row, stw_at_ms: NOW - 20000 };
        const result = currentHistory([row, legacy, stale]);
        expect(result.samples).toHaveLength(1);
        expect(result.samples[0].current.driftKts).toBeCloseTo(1);
        expect(result.unqualified).toBe(2);
    });
});
