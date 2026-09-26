/**
 * The chart's scale bar is spoken as a scale in nautical miles, not a bare
 * "300 nm" (nanometres, to VoiceOver) — UX scorecard run 7. Plus the registry
 * that lets the Locate/zoom controls reach the map they sit beside.
 */
import type mapboxgl from 'mapbox-gl';
import { describe, expect, it, vi } from 'vitest';
import { installScaleBarLabel, scaleBarLabel } from '../components/map/scaleBarLabel';
import { chartMapBeside, onChartMapsChanged, registerChartMap } from '../components/map/chartMapRegistry';

describe('scaleBarLabel', () => {
    it('reads nautical miles in full, singular and plural', () => {
        expect(scaleBarLabel('300 nm')).toBe('Scale: 300 nautical miles');
        expect(scaleBarLabel('1 nm')).toBe('Scale: 1 nautical mile');
        expect(scaleBarLabel('0.5 nm')).toBe('Scale: 0.5 nautical miles');
        expect(scaleBarLabel('')).toBeNull();
        expect(scaleBarLabel('2 km')).toBe('Scale: 2 km');
    });

    it('labels the bar as an image and follows the text Mapbox rewrites', async () => {
        const container = document.createElement('div');
        const bar = document.createElement('div');
        bar.className = 'mapboxgl-ctrl mapboxgl-ctrl-scale';
        container.appendChild(bar);
        const release = installScaleBarLabel(container);
        // Empty until Mapbox's first DOM task: no nameless image in between.
        expect(bar.hasAttribute('role')).toBe(false);
        bar.innerHTML = '300&nbsp;nm';
        await Promise.resolve();
        expect(bar.getAttribute('role')).toBe('img');
        expect(bar.getAttribute('aria-label')).toBe('Scale: 300 nautical miles');
        bar.innerHTML = '50&nbsp;nm';
        await Promise.resolve();
        expect(bar.getAttribute('aria-label')).toBe('Scale: 50 nautical miles');
        release();
    });

    it('is a no-op without a scale bar', () => {
        expect(() => installScaleBarLabel(document.createElement('div'))()).not.toThrow();
        expect(() => installScaleBarLabel(null)()).not.toThrow();
    });
});

describe('chartMapRegistry', () => {
    it('finds the map drawn beside a control, and forgets it on release', () => {
        const wrapper = document.createElement('div');
        const chart = document.createElement('div');
        chart.className = 'mapboxgl-map';
        const control = document.createElement('button');
        wrapper.append(chart, control);
        const map = {} as mapboxgl.Map;
        const changed = vi.fn();
        const unsubscribe = onChartMapsChanged(changed);

        expect(chartMapBeside(control)).toBeNull();
        const release = registerChartMap(chart, map);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(chartMapBeside(control)).toBe(map);
        release();
        expect(chartMapBeside(control)).toBeNull();
        expect(changed).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('never answers with another container’s map', () => {
        const left = document.createElement('div');
        const right = document.createElement('div');
        const leftChart = document.createElement('div');
        leftChart.className = 'mapboxgl-map';
        const rightControl = document.createElement('button');
        left.append(leftChart);
        right.append(rightControl);
        const release = registerChartMap(leftChart, {} as mapboxgl.Map);
        expect(chartMapBeside(rightControl)).toBeNull();
        release();
    });
});
