import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    PI_DISABLED_BASE_URL,
    PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE,
    resolvePiIntegrationEnabled,
} from '../services/piPublicBetaBoundary';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('Pi public-beta client boundary', () => {
    it('is enabled only for a development build', () => {
        expect(resolvePiIntegrationEnabled({ dev: true })).toBe(true);
        expect(resolvePiIntegrationEnabled({ dev: false })).toBe(false);
        expect(PI_DISABLED_BASE_URL.startsWith('http')).toBe(false);
    });

    it('uses one honest unavailable message across production UI and services', () => {
        expect(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE).toMatch(/unavailable in the public beta/i);
        expect(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE).toMatch(/authenticated, encrypted/i);
        expect(read('components/ui/PiPublicBetaUnavailable.tsx')).toContain(
            'Pi integration unavailable in public beta',
        );
        expect(read('components/ui/PiPublicBetaUnavailable.tsx')).toContain('chart/ENC sync');
        expect(read('components/ui/PiPublicBetaUnavailable.tsx')).toContain('Open reference ENC Library');
    });

    it('prevents boot discovery, health connections, configuration, and URL fallback', () => {
        const service = read('services/PiCacheService.ts');
        expect(service).toContain('if (!PI_INTEGRATION_ENABLED)');
        expect(service).toContain("this.configure({ enabled: false, host: '', port: 3001 })");
        expect(service).toContain('return PI_INTEGRATION_ENABLED && this.config.enabled && this.status.reachable');
        expect(service).toContain('return PI_DISABLED_BASE_URL');
        expect(service).toContain('/api/admin/status');
    });

    it('blocks unified boat discovery and private diary/token handoff', () => {
        const discovery = read('services/BoatNetworkService.ts');
        const diary = read('services/DiaryRelayTransport.ts');
        expect(discovery).toContain('if (!PI_INTEGRATION_ENABLED) return null');
        expect(discovery).toContain('if (!PI_INTEGRATION_ENABLED) return;');
        expect(diary).toContain('if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable()) return null');
        expect(diary).toContain('if (!PI_INTEGRATION_ENABLED) return false');
        expect(diary).toContain('diaryRelayToken: relay.token');
    });

    it('replaces Pi setup/control surfaces and disables background ENC/N2K work', () => {
        expect(read('hooks/useAppBootstrap.ts')).toContain('if (!PI_INTEGRATION_ENABLED) return;');
        expect(read('components/settings/PiCacheTab.tsx')).toContain(
            'PI_INTEGRATION_ENABLED ? <PiCacheTabDevelopment {...props} /> : <PiPublicBetaUnavailable />',
        );
        expect(read('components/vessel/AvNavPage.tsx')).toContain('if (PI_INTEGRATION_ENABLED)');
        expect(read('components/SystemStatusButton.tsx')).toContain('PI_INTEGRATION_ENABLED &&');
        expect(read('services/enc/autoSyncFromPi.ts')).toContain('if (!PI_INTEGRATION_ENABLED) return;');
        expect(read('services/n2kStatus.ts')).toContain('if (!PI_INTEGRATION_ENABLED) return;');
    });

    it('keeps the production ENC Library independent from every Pi module', () => {
        const page = read('components/vessel/EncLibraryPage.tsx');
        const importer = read('services/enc/localEncPackImport.ts');
        expect(page).not.toMatch(/EncCellManager|EncImportService|PiCacheService/);
        expect(importer).not.toMatch(/EncImportService|PiCacheService|piCache|CapacitorHttp/);
        expect(importer).toContain("url.protocol !== 'https:'");
        expect(importer).toContain("{ usage: 'reference' }");
        expect(read('viewRegistry.tsx')).toContain('encLibrary: {');
        expect(read('components/map/MapHub.tsx')).toContain("onOpenEncLibrary={() => setPage('encLibrary')}");
    });

    it('quarantines unsigned packs from every safety-authority path', () => {
        const metadata = read('services/enc/EncCellMetadata.ts');
        const merge = read('services/enc/EncHazardService.ts');
        expect(metadata).toContain("if (cell.usage === 'reference') return false");
        expect(metadata).toMatch(/listCells\(\)[\s\S]*?isLiveNavigationCell\(cell\)/);
        expect(merge).toContain('const includeReferences = options.includeReferences === true');
        expect(read('components/map/useEncVectorLayer.ts')).toContain('{ includeReferences: true }');
        expect(read('services/seaway/compileFromCells.ts')).not.toContain('includeReferences');
        expect(read('components/map/ChartDepthControls.tsx')).toContain('cannot establish chart coverage');
    });
});
