import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mapHub = readFileSync('components/map/MapHub.tsx', 'utf8');
const app = readFileSync('App.tsx', 'utf8');

describe('map location picker guidance', () => {
    it('renders the host label and explains the immediate tap action', () => {
        expect(mapHub).toContain('pickerLabel,');
        expect(mapHub).toContain("pickerLabel || 'Tap the chart to choose a location'");
        expect(mapHub).toContain('Your tap is marked and saved immediately. Use Back to cancel.');
    });

    it('labels the first-use weather-location picker explicitly', () => {
        expect(app).toContain('pickerLabel="Tap the chart to choose your weather location"');
    });
});
