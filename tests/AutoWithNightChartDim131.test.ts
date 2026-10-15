/**
 * 'Auto with night' drives the ENC night dim (131-03). From nautical dusk to
 * dawn the dim comes on by itself, whatever the saved moon switch says; the
 * moon still turns it off, for that night only; by day the saved switch rules
 * as before, and the clean planning surface never gets the tint.
 */
import { act, renderHook } from '@testing-library/react';
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

const map = { on: vi.fn(), off: vi.fn(), getCenter: () => ({ lat: -27.2, lng: 153.1 }) };
const mapRef = { current: map } as unknown as React.RefObject<import('mapbox-gl').Map | null>;
/** What the dim overlay was last told. */
const dimShown = () => enc.setEncNightDim.mock.calls.at(-1)?.[1];

function mount(autoNight: boolean, planningSurface = false) {
    return renderHook(({ autoNight, planningSurface }) => useTideDepthMode(mapRef, true, planningSurface, autoNight), {
        initialProps: { autoNight, planningSurface },
    });
}

beforeEach(() => {
    localStorage.clear();
    enc.setEncNightDim.mockClear();
});

describe('the ENC night dim under Auto with night', () => {
    it('comes on from dusk to dawn with the saved switch off, and goes at dawn', () => {
        const hook = mount(true);
        expect(hook.result.current.nightDim).toBe(true);
        expect(dimShown()).toBe(true);
        hook.rerender({ autoNight: false, planningSurface: false });
        expect(hook.result.current.nightDim).toBe(false);
        expect(dimShown()).toBe(false);
    });

    it('never rewrites the saved switch', () => {
        const hook = mount(true);
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
        act(() => hook.result.current.setNightDim(false));
        hook.rerender({ autoNight: false, planningSurface: false });
        expect(localStorage.getItem('thalassa_enc_night_dim')).toBe('false');
    });

    it('the moon turns it off for that night only; the next dusk brings it back', () => {
        const hook = mount(true);
        act(() => hook.result.current.setNightDim(false));
        expect(hook.result.current.nightDim).toBe(false);
        expect(dimShown()).toBe(false);
        act(() => hook.result.current.setNightDim(true));
        expect(dimShown()).toBe(true);
        act(() => hook.result.current.setNightDim(false));
        hook.rerender({ autoNight: false, planningSurface: false }); // dawn
        hook.rerender({ autoNight: true, planningSurface: false }); // next dusk
        expect(hook.result.current.nightDim).toBe(true);
        expect(dimShown()).toBe(true);
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
