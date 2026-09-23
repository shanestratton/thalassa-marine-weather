import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import mapboxgl from 'mapbox-gl';
import { createVesselElement } from '../components/map/useVesselTracker';
import { buildFlagElement } from '../components/map/useDestinationFlag';
import { buildMobElement } from '../components/map/useMobMarker';
import { createRouteGhostEl } from '../components/map/useRouteGhostMarker';

afterEach(() => document.body.replaceChildren());

describe('OBS geographic marker anchoring', () => {
    it('keeps ownship, destination, MOB and forecast outside document flow regardless of insertion order', () => {
        const css = document.createElement('style');
        css.textContent = readFileSync('node_modules/mapbox-gl/dist/mapbox-gl.css', 'utf8');
        document.head.appendChild(css);
        const elements = [
            buildFlagElement('Fixture'),
            createRouteGhostEl().root,
            buildMobElement().el,
            createVesselElement(),
        ];
        const markers: mapboxgl.Marker[] = [];
        try {
            for (const element of elements) {
                expect(element.style.position).toBe('');
                expect(element.style.transform).toBe('');
                markers.push(new mapboxgl.Marker({ element, anchor: 'center' }).setLngLat([149.225, -21.112]));
                document.body.appendChild(element);
            }
            for (const order of [elements, [...elements].reverse()]) {
                for (const el of order) document.body.appendChild(el);
                for (const el of elements) {
                    const style = getComputedStyle(el);
                    expect(style.position).toBe('absolute');
                    expect(style.left).toBe('0px');
                    expect(style.top).toBe('0px');
                }
                for (const marker of markers) {
                    expect(marker.getLngLat().toArray()).toEqual([149.225, -21.112]);
                }
            }
        } finally {
            for (const marker of markers) marker.remove();
            css.remove();
        }
    });
});
