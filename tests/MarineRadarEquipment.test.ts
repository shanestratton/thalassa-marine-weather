import { describe, it, expect } from 'vitest';
import { RADAR_MODELS, radarEquipment, radarEquipmentLabel } from '../services/radar/radarEquipment';
describe('optional vessel radar equipment', () => {
    it('offers 20 named choices across four manufacturers without selecting a default', () => {
        expect(RADAR_MODELS).toHaveLength(20);
        expect(new Set(RADAR_MODELS.map((m) => m.id)).size).toBe(20);
        expect(new Set(RADAR_MODELS.map((m) => m.make)).size).toBe(4);
        expect(radarEquipment(undefined)).toBeNull();
        expect(radarEquipmentLabel(null)).toBe('Not recorded');
        for (const m of RADAR_MODELS)
            expect(radarEquipment({ schema: 1, make: m.make, modelId: m.id, detail: null })?.modelId).toBe(m.id);
    });
    it('keeps make known/model unknown distinct from a confirmed model', () => {
        const unknown = { schema: 1, make: 'raymarine', modelId: null, detail: null };
        expect(radarEquipment(unknown)).toEqual(unknown);
        expect(radarEquipmentLabel(unknown)).toBe('Raymarine · model unknown');
        expect(radarEquipmentLabel({ ...unknown, modelId: 'raymarine-quantum-2' })).toBe(
            'Raymarine · Quantum 2 Doppler',
        );
        expect(radarEquipment({ ...unknown, make: 'other', detail: ' B&G model unknown ' })?.detail).toBe(
            'B&G model unknown',
        );
    });
    it.each([
        { schema: 2 },
        { make: 'guessed' },
        { modelId: 'garmin-18-hd3' },
        { detail: '' },
        { detail: 'x'.repeat(81) },
        { detail: 'a\nb' },
        { connected: true },
        { modelId: 'unreviewed-model' },
    ])('rejects malformed, cross-brand or connectivity claims %j', (patch) => {
        expect(radarEquipment({ schema: 1, make: 'raymarine', modelId: null, detail: null, ...patch })).toBeNull();
    });
});
