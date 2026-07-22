/**
 * The chart's wind-overlay models must stay identical to the Glass picker.
 *
 * Shane 2026-07-22: "the models do not match our models in the glass page."
 * They had drifted into two separate sets — the chart offered GFS / ECMWF IFS
 * / ICON / ACCESS-G / GEM while the Glass offered ICON / ECMWF / AIFS / UKMO /
 * JMA. Worse than cosmetic: a chip labelled ICON fetched icon_seamless on the
 * chart and dwd_icon on the Glass, so the same name meant different physics
 * depending which page you were on.
 *
 * These lock the join. The chip label is looked up from SELECTABLE_MODELS by
 * openMeteoModel, so if anyone re-points a chart model at a different domain
 * the label silently falls back to the long name — which the label test here
 * catches rather than letting it ship.
 */
import { describe, expect, it } from 'vitest';

import { AVAILABLE_MODELS, WIND_OVERLAY_MODELS } from '../services/weather/MultiModelWeatherService';
import { SELECTABLE_MODELS } from '../services/weather/forecastModels';

const overlay = WIND_OVERLAY_MODELS.map((id) => AVAILABLE_MODELS.find((m) => m.id === id)!);

describe('wind overlay models mirror the Glass picker', () => {
    it('every overlay id resolves to a real model', () => {
        expect(overlay.every(Boolean)).toBe(true);
        expect(overlay).toHaveLength(WIND_OVERLAY_MODELS.length);
    });

    it('offers exactly the Glass set, in the Glass order', () => {
        expect(overlay.map((m) => m.openMeteoModel)).toEqual(SELECTABLE_MODELS.map((g) => g.id));
    });

    it('every chip resolves a Glass LABEL — no silent fallback to the long name', () => {
        for (const m of overlay) {
            const glass = SELECTABLE_MODELS.find((g) => g.id === m.openMeteoModel);
            expect(glass, `no Glass entry for ${m.id} (openMeteoModel=${m.openMeteoModel})`).toBeTruthy();
            expect(glass!.label.length).toBeGreaterThan(0);
        }
    });

    it('ICON points at dwd_icon, the domain the Glass grades against', () => {
        // The specific drift that made one name mean two models.
        const icon = AVAILABLE_MODELS.find((m) => m.id === 'icon')!;
        expect(icon.openMeteoModel).toBe('dwd_icon');
    });

    it('does NOT offer GFS — it publishes no 10 m wind, which is what this draws', () => {
        // Dropped from the Glass 2026-07-21 for exactly this reason. The wind
        // overlay would render an empty grid.
        expect(WIND_OVERLAY_MODELS).not.toContain('gfs');
        expect(SELECTABLE_MODELS.map((g) => g.id)).not.toContain('ncep_gfs025');
    });

    it('keeps GFS/ACCESS-G/GEM available to the ensemble paths', () => {
        // Narrowing the OVERLAY list must not narrow AVAILABLE_MODELS, which
        // recommendModels() and the routing/ensemble code still draw from.
        const ids = AVAILABLE_MODELS.map((m) => m.id);
        expect(ids).toContain('gfs');
        expect(ids).toContain('access_g');
        expect(ids).toContain('gem');
    });
});
