import { describe, it, expect } from 'vitest';
import { getPortTemplate, getAvailablePorts } from '../utils/globalClearanceEngine';
import type { PortRegion } from '../utils/globalClearanceEngine';

describe('getPortTemplate', () => {
    it('returns Australian template', () => {
        const t = getPortTemplate('AU');
        expect(t.label).toBe('Australia');
        expect(t.flag).toBe('🇦🇺');
        expect(t.requiresCrewManifest).toBe(true);
        expect(t.requiresFuelDeclaration).toBe(true);
        expect(t.requiresFirearmsDeclaration).toBe(true);
        expect(t.alcoholLimitLitres).toBe(2.25);
    });

    it('returns NZ template', () => {
        const t = getPortTemplate('NZ');
        expect(t.label).toBe('New Zealand');
        expect(t.flag).toBe('🇳🇿');
        expect(t.alcoholLimitLitres).toBe(3.0);
    });

    it('returns New Caledonia template', () => {
        const t = getPortTemplate('NC');
        expect(t.label).toBe('Nouvelle-Calédonie');
        expect(t.alcoholLimitLitres).toBe(2.0);
    });

    it('returns Fiji template', () => {
        const t = getPortTemplate('FJ');
        expect(t.label).toBe('Fiji');
        expect(t.requiresFuelDeclaration).toBe(false); // Fiji doesn't require fuel
    });

    it('returns EU template', () => {
        const t = getPortTemplate('EU');
        expect(t.label).toBe('European Union');
        expect(t.alcoholLimitLitres).toBe(4.0);
    });

    it('returns US template', () => {
        const t = getPortTemplate('US');
        expect(t.label).toBe('United States');
        expect(t.alcoholLimitLitres).toBe(1.0);
        expect(t.customNotes).toContain('CBP Form 1300 required');
    });

    it('returns GENERIC template', () => {
        const t = getPortTemplate('GENERIC');
        expect(t.label).toBe('International');
        expect(t.requiresFirearmsDeclaration).toBe(false);
    });

    it('all templates have required fields', () => {
        const regions: PortRegion[] = ['AU', 'NZ', 'NC', 'FJ', 'EU', 'US', 'GENERIC'];
        regions.forEach((r) => {
            const t = getPortTemplate(r);
            expect(t.label).toBeTruthy();
            expect(t.flag).toBeTruthy();
            expect(t.alcoholCategories).toBeInstanceOf(Array);
            expect(t.fuelCategories).toBeInstanceOf(Array);
            expect(t.foodCategories).toBeInstanceOf(Array);
            expect(t.declarableCategories).toBeInstanceOf(Array);
            expect(typeof t.requiresCrewManifest).toBe('boolean');
            expect(typeof t.requiresFuelDeclaration).toBe('boolean');
        });
    });

    it('all templates include Booze in alcohol categories', () => {
        const regions: PortRegion[] = ['AU', 'NZ', 'NC', 'FJ', 'EU', 'US', 'GENERIC'];
        regions.forEach((r) => {
            expect(getPortTemplate(r).alcoholCategories).toContain('Booze');
        });
    });

    it('all templates include Provisions in food categories', () => {
        const regions: PortRegion[] = ['AU', 'NZ', 'NC', 'FJ', 'EU', 'US', 'GENERIC'];
        regions.forEach((r) => {
            expect(getPortTemplate(r).foodCategories).toContain('Provisions');
        });
    });
});

describe('getAvailablePorts', () => {
    it('returns all 7 port regions', () => {
        const ports = getAvailablePorts();
        expect(ports.length).toBe(7);
    });

    it('each port has code, label, and flag', () => {
        const ports = getAvailablePorts();
        ports.forEach((p) => {
            expect(p.code).toBeTruthy();
            expect(p.label).toBeTruthy();
            expect(p.flag).toBeTruthy();
        });
    });

    it('includes Australia', () => {
        const ports = getAvailablePorts();
        expect(ports.some((p) => p.code === 'AU')).toBe(true);
    });

    it('includes United States', () => {
        const ports = getAvailablePorts();
        expect(ports.some((p) => p.code === 'US')).toBe(true);
    });

    it('includes GENERIC as fallback', () => {
        const ports = getAvailablePorts();
        expect(ports.some((p) => p.code === 'GENERIC')).toBe(true);
    });
});
