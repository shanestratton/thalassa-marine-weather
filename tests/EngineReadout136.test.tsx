import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EngineReadout, enginePanelAvailable } from '../components/nmea/EngineReadout';
import type { InstrumentEvidence } from '../services/instruments/measurements';
const T = 1_800_000_000_000;
const evidence = (): InstrumentEvidence => ({
    identity: 'boat',
    via: 'lan',
    readings: { rpm: { value: 1200, at: T, unit: 'rpm', source: 'measured', engineCount: 1, engineId: 'main' } },
    engine: {
        engineId: 'main',
        runTime: { value: 36000, at: T - 1000 },
        coolant: { value: 80, at: T - 2000 },
        oilPressure: { value: 300, at: T - 3000 },
    },
});
afterEach(cleanup);
it('shows source-labelled measured engine units and their own age', () => {
    render(<EngineReadout evidence={evidence()} now={T} />);
    expect(screen.getByText('Engine: main')).toBeInTheDocument();
    expect(screen.getByText('10 h')).toBeInTheDocument();
    expect(screen.getByText('80.0 °C')).toBeInTheDocument();
    expect(screen.getByText('300 kPa')).toBeInTheDocument();
    expect(screen.getByText('3s ago')).toBeInTheDocument();
});
it('never paints expired metrics or another engine under a fresh RPM gauge', () => {
    const e = evidence();
    const ui = render(<EngineReadout evidence={e} now={T + 12_000} />);
    expect(screen.queryByText('80.0 °C')).not.toBeInTheDocument();
    e.engine!.engineId = 'other';
    ui.rerender(<EngineReadout evidence={e} now={T} />);
    expect(screen.getAllByText('Not reporting')).toHaveLength(3);
    expect(screen.queryByText('10 h')).not.toBeInTheDocument();
    expect(enginePanelAvailable(e, T + 14_000)).toBe(false);
});
it('labels multiple reported engines without assigning their aggregate to an individual meter', () => {
    const e = evidence();
    e.readings.rpm!.engineCount = 2;
    render(<EngineReadout evidence={e} now={T} />);
    expect(screen.getByText('2 reported engines; meters are not combined.')).toBeInTheDocument();
    expect(screen.getAllByText('Not reporting')).toHaveLength(3);
});
