/**
 * 'Auto with night' drives the ENC night dim (131-03). From nautical dusk to
 * dawn the dim comes on by itself, whatever the saved switch says; by day the
 * saved switch rules as before, and the clean planning surface never gets the
 * tint.
 *
 * The 131-03 review, which this file pins:
 *   - the switch a skipper can reach is the Night dim row in the chart's
 *     map-base menu (the moon in ChartDepthControls needs plotting and the
 *     browsing chart at once, which never happens); it turns the auto dim off
 *     for that night only;
 *   - the dim is a full-screen layer on document.body, and the chart is kept
 *     alive hidden once opened, so it is drawn only while the chart is on
 *     screen: the Glass at night looks the same before and after the chart
 *     has been visited.
 */
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enc = vi.hoisted(() => ({ setEncNightDim: vi.fn(), setEncTideOffset: vi.fn() }));
vi.mock('../components/map/EncVectorLayer', () => ({
    ENC_NIGHT_DIM_KEY: 'thalassa_enc_night_dim',
    setEncNightDim: enc.setEncNightDim,
    setEncTideOffset: enc.setEncTideOffset,
}));
vi.mock('../components/map/ChartDepthControls', () => ({ TIDE_DEPTH_ACK_KEY: 'thalassa_tide_depth_ack_v1' }));
vi.mock('../services/TideOffsetService', () => ({ readTideCurveWindow: vi.fn(), tideReadAt: vi.fn() }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { useTideDepthMode } from '../components/map/useTideDepthMode';
import { MapBaseSelector } from '../components/map/MapBaseSelector';

const map = { on: vi.fn(), off: vi.fn(), getCenter: () => ({ lat: -27.2, lng: 153.1 }) };
const mapRef = { current: map } as unknown as React.RefObject<import('mapbox-gl').Map | null>;
/** What the dim overlay was last told. */
const dimShown = () => enc.setEncNightDim.mock.calls.at(-1)?.[1];

function mount(autoNight: boolean, planningSurface = false, onScreen = true) {
    return renderHook(
        ({ autoNight, planningSurface, onScreen }) =>
            useTideDepthMode(mapRef, true, planningSurface, autoNight, onScreen),
        { initialProps: { autoNight, planningSurface, onScreen } },
    );
}

/** The browsing chart's map-base menu, wired as MapHub wires it. */
function ChartMenu({ autoNight }: { autoNight: boolean }) {
    const { nightDimRow } = useTideDepthMode(mapRef, true, false, autoNight, true);
    return (
        <MapBaseSelector
            visible
            value="relief"
            onChange={() => undefined}
            encCellCount={0}
            encVisible={false}
            onToggleEnc={() => undefined}
            toggles={nightDimRow ? [nightDimRow] : []}
        />
    );
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^Map base:/ }));
const nightRow = () => screen.queryByRole('menuitemcheckbox', { name: /^Night dim/ });

beforeEach(() => {
    localStorage.clear();
    enc.setEncNightDim.mockClear();
});

describe('the ENC night dim under Auto with night', () => {
    it('comes on from dusk to dawn with the saved switch off, and goes at dawn', () => {
        const hook = mount(true);
        expect(hook.result.current.nightDim).toBe(true);
        expect(dimShown()).toBe(true);
        hook.rerender({ autoNight: false, planningSurface: false, onScreen: true });
        expect(hook.result.current.nightDim).toBe(false);
        expect(dimShown()).toBe(false);
    });

    it('never rewrites the saved switch', () => {
        const hook = mount(true);
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
        act(() => hook.result.current.setNightDim(false));
        hook.rerender({ autoNight: false, planningSurface: false, onScreen: true });
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
    });

    it('by day, and in every other mode, the saved switch rules as before', () => {
        localStorage.setItem('thalassa_enc_night_dim', 'true');
        const hook = mount(false);
        expect(hook.result.current.nightDim).toBe(true);
        expect(dimShown()).toBe(true);
        act(() => hook.result.current.setNightDim(false));
        expect(dimShown()).toBe(false);
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
    });

    it('never tints the clean planning surface', () => {
        mount(true, true);
        expect(dimShown()).toBe(false);
    });
});

describe('the Night dim row on the chart’s map-base menu', () => {
    it('turns the auto dim off for that night only; the next dusk brings it back', () => {
        const { rerender } = render(<ChartMenu autoNight />);
        openMenu();
        let row = nightRow()!;
        expect(row).toHaveAttribute('aria-checked', 'true');
        expect(row).toHaveTextContent('Auto + night, till nautical dawn');
        expect(row).toHaveTextContent('ON');
        expect(dimShown()).toBe(true);

        fireEvent.click(row);
        expect(dimShown()).toBe(false);
        openMenu();
        row = nightRow()!;
        expect(row).toHaveAttribute('aria-checked', 'false');
        expect(row).toHaveTextContent('Off for now, on again at the next dusk');
        // Still offered while off, so the skipper can have it back tonight.
        fireEvent.click(row);
        expect(dimShown()).toBe(true);
        openMenu();
        fireEvent.click(nightRow()!);
        expect(dimShown()).toBe(false);

        rerender(<ChartMenu autoNight={false} />); // dawn
        expect(dimShown()).toBe(false);
        openMenu();
        expect(nightRow()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^Map base:/ }));

        rerender(<ChartMenu autoNight />); // the next dusk
        expect(dimShown()).toBe(true);
        openMenu();
        expect(nightRow()).toHaveAttribute('aria-checked', 'true');
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
    });

    it('a saved dim is on the menu too, and the row turns it off for good', () => {
        localStorage.setItem('thalassa_enc_night_dim', 'true');
        render(<ChartMenu autoNight={false} />);
        openMenu();
        const row = nightRow()!;
        expect(row).toHaveTextContent('On till you turn it off');
        fireEvent.click(row);
        expect(dimShown()).toBe(false);
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
        openMenu();
        expect(nightRow()).toBeNull();
    });

    it('is not offered by day with no dim on', () => {
        render(<ChartMenu autoNight={false} />);
        openMenu();
        expect(nightRow()).toBeNull();
        expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1); // the ENC row alone
    });

    it('is wired into the browsing chart’s menu, the one shown where the dim is drawn', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        const call = hub.slice(hub.indexOf('<MapBaseSelector'));
        const props = call.slice(0, call.indexOf('/>'));
        expect(props).toContain('visible={!planningSurface && !embedded && !pickerMode && !isPinView}');
        expect(props).toContain('toggles={nightDimRow ? [nightDimRow] : []}');
        expect(hub).toMatch(/\bnightDimRow,[\s\S]*?\} = useTideDepthMode\(/);
    });
});

describe('the dim is drawn only while the chart is on screen', () => {
    it('leaves the Glass at night as it was before the chart was opened', () => {
        // The chart is opened at night: dimmed.
        const hook = mount(true, false, true);
        expect(dimShown()).toBe(true);
        // Back to the Glass, the chart kept alive behind it: no dim layer.
        hook.rerender({ autoNight: true, planningSurface: false, onScreen: false });
        expect(dimShown()).toBe(false);
        // And back to the chart: dimmed again, still by itself.
        hook.rerender({ autoNight: true, planningSurface: false, onScreen: true });
        expect(dimShown()).toBe(true);
    });

    it('a chart kept alive hidden never draws it, nor a saved one', () => {
        mount(true, false, false);
        expect(dimShown()).toBe(false);
        enc.setEncNightDim.mockClear();
        localStorage.setItem('thalassa_enc_night_dim', 'true');
        mount(false, false, false);
        expect(dimShown()).toBe(false);
    });

    it('MapHub tells it whether the chart is the page on screen', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toMatch(
            /useTideDepthMode\(\s*mapRef,\s*mapReady,\s*planningSurface,\s*nightMode && settings\.displayMode === 'auto-night',\s*currentView === 'map',\s*\)/,
        );
    });
});
