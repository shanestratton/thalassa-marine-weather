import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ownedFiles = [
    'components/CrewManagement.tsx',
    'components/VesselHub.tsx',
    'components/settings/CalypsoIntegrationsTab.tsx',
    'components/vessel/EncCellManager.tsx',
];

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('native browser dialog removal contract', () => {
    it.each(ownedFiles)('%s contains no production confirm, prompt, or alert call', (path) => {
        expect(source(path)).not.toMatch(/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/);
    });

    it('uses app confirmation dialogs with duplicate-action and identity fences', () => {
        const crew = source('components/CrewManagement.tsx');
        expect(crew).toContain('<ConfirmDialog');
        expect(crew).toContain('clearPassagesInFlight.current');
        expect(crew).toContain('scopeStillOwnsPage(request.scope)');

        const vessel = source('components/VesselHub.tsx');
        expect(vessel).toContain('<ConfirmDialog');
        expect(vessel).toContain('actionInFlight.current');
        expect(vessel).toContain('isAuthIdentityScopeCurrent(request.scope)');
        expect(vessel).toContain('sameClaim');
    });

    it('uses accessible inline Gmail errors and a labelled ENC URL sheet', () => {
        const calypso = source('components/settings/CalypsoIntegrationsTab.tsx');
        expect(calypso).toContain('role="alert"');
        expect(calypso).toContain('emailOperationInFlight.current');
        expect(calypso).toContain("'browserFinished'");

        const enc = source('components/vessel/EncCellManager.tsx');
        expect(enc).toContain('title="Install ENC from URL"');
        expect(enc).toContain('htmlFor="enc-install-url"');
        expect(enc).toContain('role="alert"');
        expect(enc).toContain('urlInstallInFlight.current');
    });
});
