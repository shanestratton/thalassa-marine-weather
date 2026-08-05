import { describe, expect, it, vi } from 'vitest';
import {
    ChartLockerService,
    chartPackageDistributionBlockReason,
    type ChartPackage,
} from '../services/ChartLockerService';

describe('Chart Locker package trust boundary', () => {
    it('restricts every reachable beta catalog to official NOAA and licensed LINZ packages', () => {
        const community = ChartLockerService.getCommunityCatalog();
        const full = ChartLockerService.getFullCatalog('test-linz-key');

        expect(community).toEqual([]);
        expect(full.every((pkg) => pkg.source === 'noaa' || pkg.source === 'linz')).toBe(true);
        expect(full.some((pkg) => /mediafire|navionics/i.test(`${pkg.name} ${pkg.url}`))).toBe(false);
        expect(full.map((pkg) => pkg.id)).not.toContain('tcl-vanuatu');
    });

    it('attaches explicit publisher, source, licence and distribution metadata to every package', () => {
        const catalog = ChartLockerService.getFullCatalog('test-linz-key');
        expect(catalog.length).toBeGreaterThan(0);

        for (const pkg of catalog) {
            expect(pkg.provenance.publisher).not.toBe('');
            expect(pkg.provenance.sourceUrl).toMatch(/^https:\/\//);
            expect(pkg.provenance.licenseName).not.toBe('');
            expect(pkg.provenance.distributionStatus).toMatch(
                /^(official-public-release|licensed-provider-download|source-hosted-unverified)$/,
            );
        }
    });

    it('defensively rejects a quarantined package even when an old caller passes it directly', async () => {
        const pkg: ChartPackage = {
            id: 'tcl-vanuatu',
            name: 'Vanuatu (Navionics)',
            region: 'sp-vanuatu',
            regionLabel: 'Vanuatu',
            sizeMB: 164,
            url: 'https://example.test/Vanuatu_Navionics.zip',
            format: 'zip',
            source: 'community',
            provenance: {
                publisher: 'Unverified community source',
                sourceUrl: 'https://example.test/source',
                licenseName: 'No documented redistribution licence',
                distributionStatus: 'source-hosted-unverified',
            },
        };
        const onProgress = vi.fn();

        expect(chartPackageDistributionBlockReason(pkg)).toMatch(/redistribution rights/i);
        await expect(
            ChartLockerService.downloadChart(pkg, 'pi-direct', '127.0.0.1', 8080, true, onProgress),
        ).resolves.toMatchObject({ success: false, error: expect.stringMatching(/redistribution rights/i) });
        expect(onProgress).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'error', error: expect.stringMatching(/redistribution rights/i) }),
        );
    });

    it('defensively rejects every source-hosted or MediaFire package, even without a known legacy id', () => {
        expect(
            chartPackageDistributionBlockReason({
                id: 'new-community-pack',
                name: 'Cruising charts',
                url: 'https://www.mediafire.com/file/example/charts.zip/file',
                source: 'noaa',
                provenance: {
                    publisher: 'Unknown',
                    sourceUrl: 'https://example.test',
                    licenseName: 'Unknown',
                    distributionStatus: 'source-hosted-unverified',
                },
            }),
        ).toMatch(/public beta/i);
    });
});
