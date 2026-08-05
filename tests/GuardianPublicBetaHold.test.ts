import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const registry = readFileSync('viewRegistry.tsx', 'utf8');
const anchor = readFileSync('services/AnchorWatchService.ts', 'utf8');
const service = readFileSync('services/GuardianService.ts', 'utf8');
const vesselHub = readFileSync('components/VesselHub.tsx', 'utf8');

describe('Guardian public-beta hold', () => {
    it('keeps every public client entry and auto-arm path held', () => {
        expect(FEATURE_VISIBILITY.guardian).toBe(false);
        expect(registry).toContain('FEATURE_VISIBILITY.guardian ? LiveGuardianPage : GuardianBetaHoldPage');
        expect(anchor).toContain('if (!FEATURE_VISIBILITY.guardian) return;');
        expect(service).toContain('FEATURE_VISIBILITY.guardian || import.meta.env.MODE');
        expect(vesselHub).toContain('{FEATURE_VISIBILITY.guardian && (');
    });
});
