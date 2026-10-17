import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SshObservation } from '../services/weather/api/sshObservations';
import type { ScalarOverlayOptions } from '../components/map/useScalarGridOverlay';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import SshObservedLayer from '../components/map/SshObservedLayer';

const owned = vi.hoisted(() => ({ load: vi.fn(), paint: vi.fn(), arrows: vi.fn() }));
vi.mock('../components/map/useSshObservation', () => ({
    useSshObservation: (...args: unknown[]) => owned.load(...args),
}));
vi.mock('../components/map/useScalarGridOverlay', () => ({
    useScalarGridOverlay: (...args: unknown[]) => owned.paint(...args),
}));
vi.mock('../components/map/useOwnedGeoJsonOverlay', () => ({
    useOwnedGeoJsonOverlay: (...args: unknown[]) => owned.arrows(...args),
}));
const current = () => true;
function observation(): SshObservation {
    const field = {
        width: 2,
        height: 2,
        west: -90,
        south: -30,
        dx: 180,
        dy: 60,
        values: new Float32Array(4),
        validMask: new Uint8Array(4).fill(1),
        wrapLongitude: true,
    };
    return {
        generation: 'original-day',
        sourceTimeMs: Date.UTC(2026, 9, 16),
        validUntilMs: Date.UTC(2026, 9, 19),
        adt: field,
        sla: { ...field, values: new Float32Array(4).fill(0.25) },
        eastward: field,
        northward: field,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    owned.load.mockReturnValue({ phase: 'ready', data: observation(), sourceCurrent: current });
    owned.paint.mockImplementation((_map: unknown, _ready: boolean, options: ScalarOverlayOptions) =>
        !options.enabled ? 'off' : options.grid && options.sourceCurrent() ? 'ready' : 'unavailable',
    );
    owned.arrows.mockImplementation((_map: unknown, _ready: boolean, options: { enabled: boolean; owner: unknown }) =>
        !options.enabled ? 'off' : options.owner ? 'ready' : 'unavailable',
    );
});
afterEach(cleanup);

function Picker({ offered = true }: { offered?: boolean }) {
    const [mode, setMode] = useState<'off' | 'sla' | 'adt'>('off');
    return (
        <>
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                tacticalState={
                    offered
                        ? { sshMode: mode, onChangeSshMode: setMode }
                        : { onToggleTideStations: vi.fn(), tideStationsVisible: false }
                }
            />
            <output data-testid="selected-ssh">{mode}</output>
        </>
    );
}
function sea() {
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sea layers' }));
}
it('keeps held ocean entries absent when the parent does not offer them', () => {
    render(<Picker offered={false} />);
    sea();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Eddies/ })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Sea height/ })).toBeNull();
});
it('uses the actual Sea picker to switch one original map between SLA and ADT and back off', () => {
    render(<Picker />);
    sea();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, off' }));
    expect(screen.getByTestId('selected-ssh')).toHaveTextContent('sla');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, on' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sea height · ADT, off' }));
    expect(screen.getByTestId('selected-ssh')).toHaveTextContent('adt');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, off' })).toHaveAttribute(
        'aria-checked',
        'false',
    );
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sea height · ADT, on' }));
    expect(screen.getByTestId('selected-ssh')).toHaveTextContent('off');
});
it('counts one ocean selection and includes it in the actual Clear all action', () => {
    render(<Picker />);
    sea();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Eddies · SLA, off' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Clear all · 1/ }));
    expect(screen.getByTestId('selected-ssh')).toHaveTextContent('off');
});
it('selects native metre planes from the same observed cohort and adds no DOM row', () => {
    const onCredit = vi.fn(),
        data = observation();
    owned.load.mockReturnValue({ phase: 'ready', data, sourceCurrent: current });
    const view = render(<SshObservedLayer mapRef={{ current: null }} mapReady active mode="sla" onCredit={onCredit} />);
    expect(view.container).toBeEmptyDOMElement();
    expect(owned.paint.mock.calls.at(-1)![2]).toMatchObject({ grid: data.sla, revision: 'original-day:sla' });
    expect(owned.arrows.mock.calls.at(-1)![2]).toMatchObject({
        namespace: 'observed-ssh-arrows',
        owner: data,
        revision: data.generation,
        maxFeatures: 96,
        maxVertices: 576,
        refreshOnMoveEnd: true,
        sourceCurrent: current,
    });
    expect(onCredit.mock.calls.at(-1)![0]).toMatchObject({
        warning: false,
        text: expect.stringContaining('2026-10-16 UTC'),
    });
    view.rerender(<SshObservedLayer mapRef={{ current: null }} mapReady active mode="adt" onCredit={onCredit} />);
    expect(owned.load.mock.calls.every((args) => args[0] === true)).toBe(true);
    expect(owned.paint.mock.calls.at(-1)![2]).toMatchObject({ grid: data.adt, revision: 'original-day:adt' });
    expect(onCredit.mock.calls.at(-1)![0].text).toContain('above the geoid');
});
it('does not claim off or current data when old presentation cannot be removed', () => {
    owned.load.mockReturnValue({ phase: 'off', data: null, sourceCurrent: () => false });
    owned.paint.mockReturnValue('stuck-visible');
    const onCredit = vi.fn();
    render(<SshObservedLayer mapRef={{ current: null }} mapReady active={false} mode="off" onCredit={onCredit} />);
    expect(owned.load).toHaveBeenCalledWith(false);
    expect(onCredit.mock.calls.at(-1)![0]).toMatchObject({
        warning: true,
        text: expect.stringContaining('prior ocean observation layer may still be visible'),
    });
});
it('reports an unavailable dated observation without passing an old grid to the painter', () => {
    owned.load.mockReturnValue({ phase: 'unavailable', data: null, sourceCurrent: () => false });
    const onCredit = vi.fn();
    render(<SshObservedLayer mapRef={{ current: null }} mapReady active mode="sla" onCredit={onCredit} />);
    expect(owned.paint.mock.calls.at(-1)![2]).toMatchObject({ grid: null });
    expect(onCredit.mock.calls.at(-1)![0]).toMatchObject({
        warning: true,
        text: expect.stringContaining('Original map date unavailable'),
    });
});
it('keeps the original source credit when only old geostrophic arrows cannot be retired', () => {
    owned.arrows.mockReturnValue('stuck-visible');
    const onCredit = vi.fn();
    render(<SshObservedLayer mapRef={{ current: null }} mapReady active={false} mode="off" onCredit={onCredit} />);
    expect(onCredit.mock.calls.at(-1)![0]).toMatchObject({
        warning: true,
        text: expect.stringContaining('prior ocean observation layer may still be visible'),
    });
});
it('requires actual current viewport bounds before creating geostrophic geometry', () => {
    const onCredit = vi.fn();
    render(<SshObservedLayer mapRef={{ current: null }} mapReady active mode="sla" onCredit={onCredit} />);
    const create = owned.arrows.mock.calls.at(-1)![2].createData;
    expect(() => create({ getBounds: () => undefined })).toThrow('bounds unavailable');
    const geometry = create({
        getBounds: () => ({ getWest: () => 150, getSouth: () => -30, getEast: () => 160, getNorth: () => -20 }),
    });
    expect(geometry.type).toBe('FeatureCollection');
    expect(geometry.features).toHaveLength(0); // The actual zero-current field has no fabricated arrows.
});
