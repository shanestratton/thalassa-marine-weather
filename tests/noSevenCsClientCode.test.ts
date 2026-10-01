/**
 * The client no longer talks to SevenCs (2026-10-01).
 *
 * Shane 2026-09-30: "sevenc's has never been connected properly, it does not
 * work, it can go at your leisure". Auto routes on the phone with Thalassa's
 * own router (services/autoroutingThalassa), and Plan My Day with it. The
 * deployed edge function, its _shared modules and secrets stay until Shane
 * deletes them (docs/AUTOROUTING_TRIAL.md), so this pins only the client:
 * nothing under these paths names the provider, invokes the function or
 * imports its server modules — except the legacy evidence normaliser, which
 * must still read rows saved before today.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
// All of services/ since the 2026-10-01 review (it scanned only
// services/autorouting* and services/dayPlanner, so the retired modules
// below went unseen).
const CLIENT_DIRS = ['components', 'hooks', 'stores', 'types', 'services'];
const CLIENT_FILES = ['e2e/fixtures/autorouting-trial.tsx'];
/** Reads legacy 'sevencs-trial' evidence (provider report, canal handover). */
const LEGACY_NORMALISER = 'services/autoroutingProposalEvidence.ts';
/** May name the legacy origin 'sevencs-trial' (and nothing else of it): the
 *  normaliser, and the sync's note on the live CHECK that still names it. */
const LEGACY_ORIGIN_FILES = [LEGACY_NORMALISER, 'services/savedRoutesSync.ts'];
/**
 * Retired with SevenCs, no production importers since 2026-10-01, and still
 * on disk — guarded by the Phase 0 real-clock test until their deletion (a
 * follow-up: automaticCanalExit, verifyCanalExitChart, newportCanalExitProfile
 * and these three). They name SevenCs in comments and in one retirement
 * record's fallback text. Take each off this list when it is deleted.
 */
const RETIRED_UNTIL_DELETED = [
    'services/canalDepartureGeometry.ts',
    'services/channelTrackGuidance.ts',
    'services/newportChannelTrackPolicy.ts',
];
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;

function walk(relative: string): string[] {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) return [];
    const stat = fs.statSync(absolute);
    if (stat.isFile()) return SOURCE.test(relative) ? [relative] : [];
    return fs.readdirSync(absolute).flatMap((name) => walk(path.join(relative, name)));
}

function clientFiles(): string[] {
    return [...new Set([...CLIENT_DIRS.flatMap(walk), ...CLIENT_FILES.flatMap(walk)])].sort();
}

describe('no SevenCs client code', () => {
    const files = clientFiles();

    it('scans the whole client surface', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain('services/autoroutingThalassa.ts');
        expect(files).toContain('components/autorouting/AutoroutingTrialWorkspace.tsx');
        expect(files).toContain('services/dayPlanner/runtime.ts');
        expect(files).toContain('services/InshoreRouter.ts');
        expect(files).toContain('e2e/fixtures/autorouting-trial.tsx');
        for (const retired of RETIRED_UNTIL_DELETED) expect(files).toContain(retired);
    });

    it('never names the provider', () => {
        const named = files.filter((file) => {
            if (RETIRED_UNTIL_DELETED.includes(file)) return false;
            let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            if (LEGACY_ORIGIN_FILES.includes(file)) text = text.replaceAll('sevencs-trial', '');
            return /sevencs/i.test(text);
        });
        expect(named).toEqual([]);
    });

    it('nothing in production imports a module retired with SevenCs', () => {
        const retired = [
            ...RETIRED_UNTIL_DELETED,
            'services/automaticCanalExit.ts',
            'services/verifyCanalExitChart.ts',
            'services/newportCanalExitProfile.ts',
        ].map((file) => path.basename(file, '.ts'));
        const importing = files.filter((file) => {
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            return retired.some(
                (name) =>
                    path.basename(file, path.extname(file)) !== name &&
                    !retired.includes(path.basename(file, path.extname(file))) &&
                    new RegExp(`(?:from\\s+|import\\(\\s*)['"][./]*(?:services/)?${name}['"]`).test(text),
            );
        });
        expect(importing).toEqual([]);
    });

    it('never invokes the autorouting-trial edge function', () => {
        const invoking = files.filter((file) =>
            /invoke\(\s*['"`]autorouting-trial/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
        );
        expect(invoking).toEqual([]);
    });

    it('imports the server trial modules only for the legacy evidence normaliser', () => {
        const importing = files.filter(
            (file) =>
                file !== LEGACY_NORMALISER &&
                /_shared\/autorouting-(trial|provider-check)['"]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
        );
        expect(importing).toEqual([]);
    });

    it('the SevenCs client modules are gone', () => {
        for (const file of [
            'services/autoroutingTrial.ts',
            'services/chartGuidedAutorouting.ts',
            'services/autoroutingCanalDeparture.ts',
            'services/canalDepartureWorker.ts',
            'services/providerHazardGeometry.ts',
        ])
            expect(fs.existsSync(path.join(ROOT, file)), file).toBe(false);
    });
});
