import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const overlaySource = readFileSync(resolve(process.cwd(), 'components/map/MapboxVelocityOverlay.tsx'), 'utf8');
const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');
const fieldSource = readFileSync(resolve(process.cwd(), 'components/map/MapboxWindField.ts'), 'utf8');

describe('MapboxVelocityOverlay selected-grid architecture', () => {
    it('does not run a second private GFS/cache/static wind pipeline or render its stale badge', () => {
        expect(overlaySource).not.toContain('fetchWindData');
        expect(overlaySource).not.toContain('fetch-wind-velocity');
        expect(overlaySource).not.toContain('thalassa-wind-cache');
        expect(overlaySource).not.toContain('wind_test.json');
        expect(overlaySource).not.toContain('Offline ·');
    });

    it('receives the reactive selected-model grid rather than the initial-load ref', () => {
        expect(mapHubSource).toContain('windGrid={weather.windState.grid ?? undefined}');
        expect(mapHubSource).not.toContain('windGrid={weather.windGridRef?.current ?? undefined}');
        // Close-in mode reads the boat's instruments only at the frame labelled Near now.
        expect(mapHubSource).toContain('windNowIdx={weather.windNowIdx}');
    });

    it('hands only the selected frame to the native field, including zero and missing frames', () => {
        expect(overlaySource).toContain('windGridFrameToVelocityData(windGrid, windHour)');
        expect(overlaySource).toContain('field.setData(data)');
        expect(overlaySource).toContain('field.setData(null)');
        expect(overlaySource).not.toContain('curHour > 0');
        expect(fieldSource).not.toMatch(/\bfetch\(|WeatherService|WindStore|NmeaStore|supabase/);
    });

    it('tears down its owned native field without creating another map or loading a plugin', () => {
        expect(overlaySource).toContain('field.destroy()');
        expect(overlaySource).not.toMatch(/new mapboxgl.Map|leafletRuntime|import\('leaflet/);
        expect(fieldSource).not.toMatch(/new mapboxgl.Map|setTimeout\(/);
        expect(fieldSource).toContain('this.observer?.disconnect()');
        expect(fieldSource).toContain('this.cancelFrame(this.frame)');
    });
});
