import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function runtimeTypeScriptSources(): Array<{ path: string; source: string }> {
    const files: Array<{ path: string; source: string }> = [];
    const visit = (relativeDirectory: string) => {
        const directory = join(process.cwd(), relativeDirectory);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const relative = join(relativeDirectory, entry.name);
            if (entry.isDirectory()) visit(relative);
            else if (entry.isFile() && /\.tsx?$/.test(entry.name))
                files.push({ path: relative, source: read(relative) });
        }
    };
    for (const root of ['components', 'context', 'hooks', 'pages', 'services', 'stores']) visit(root);
    return files;
}

describe('foreground location privacy boundary', () => {
    it('keeps passive screen and background-convenience reads already-granted-only', () => {
        for (const path of [
            'components/vessel/NoticesPage.tsx',
            'components/vessel/RadioConsolePage.tsx',
            'components/VesselHub.tsx',
            'services/enc/autoSyncFromPi.ts',
        ]) {
            const source = read(path);
            expect(source, path).toContain('GpsService.getCurrentPositionIfGranted(');
            expect(source, path).not.toContain('GpsService.getCurrentPosition(');
        }

        for (const path of [
            'hooks/useLiveLocationName.ts',
            'components/SystemStatusButton.tsx',
            'components/VesselHub.tsx',
            'components/map/useVesselTracker.ts',
            'components/map/useLocationDot.ts',
            'components/map/useDestinationFlag.ts',
        ]) {
            expect(read(path), path).not.toContain('ensureRunning: true');
        }
    });

    it('routes ordinary user-requested fixes through foreground-only geolocation', () => {
        for (const path of [
            'components/SettingsModal.tsx',
            'hooks/useVoyageForm.ts',
            'hooks/useAppController.ts',
            'hooks/chat/usePinDrop.ts',
            'components/chat/PinMapViewer.tsx',
            'services/DiaryService.ts',
            'components/WeatherMap.tsx',
            'components/AddEntryModal.tsx',
            'components/map/useVesselTracker.ts',
            'components/map/MapHub.tsx',
            'components/map/usePinViewMode.ts',
            'components/OnboardingWizard.tsx',
        ]) {
            const source = read(path);
            expect(source, path).toContain('GpsService.requestCurrentForegroundPosition(');
            expect(source, path).not.toContain('GpsService.getCurrentPosition(');
        }
    });

    it('keeps prompt/background-capable location calls on a reviewed allowlist', () => {
        const sources = runtimeTypeScriptSources();
        const filesUsingBackgroundOneShot = sources
            .filter(
                ({ path, source }) =>
                    path !== 'services/GpsService.ts' && source.includes('GpsService.getCurrentPosition('),
            )
            .map(({ path }) => path)
            .sort();
        const filesInitializingBgGeo = sources
            .filter(
                ({ path, source }) =>
                    path !== 'services/BgGeoManager.ts' && source.includes('BgGeoManager.ensureReady('),
            )
            .map(({ path }) => path)
            .sort();
        const filesStartingSafetyWatch = sources
            .filter(({ source }) => source.includes('ensureRunning: true'))
            .map(({ path }) => path)
            .sort();
        const warmUpCallers = sources
            .filter(({ path, source }) => path !== 'services/gpsWarmUp.ts' && source.includes('warmUpGps('))
            .map(({ path }) => path)
            .sort();

        expect(filesUsingBackgroundOneShot).toEqual([
            'services/MobService.ts',
            'services/ownshipPosition.ts',
            'services/shiplog/EntrySave.ts',
            'services/shiplog/PositionResolver.ts',
        ]);
        expect(filesInitializingBgGeo).toEqual([
            'services/AnchorWatchService.ts',
            'services/GpsService.ts',
            'services/ShipLogService.ts',
        ]);
        expect(filesStartingSafetyWatch).toEqual(['services/MobService.ts']);
        expect(warmUpCallers).toEqual([]);
    });

    it('does not initialize background GPS merely because the account identity changes', () => {
        const source = read('services/ShipLogService.ts');
        const transitionStart = source.indexOf('private handleIdentityTransition(');
        const transitionEnd = source.indexOf('async initialize()', transitionStart);
        const transition = source.slice(transitionStart, transitionEnd);

        expect(transitionStart).toBeGreaterThan(-1);
        expect(transitionEnd).toBeGreaterThan(transitionStart);
        expect(transition).toMatch(
            /if \(releaseNativeLease\) \{\s*void BgGeoManager\.setSamplingMode\('default'\)\.catch\(\(\) => \{\}\);\s*\}/,
        );

        const bgGeo = read('services/BgGeoManager.ts');
        const samplingBody = bgGeo.slice(
            bgGeo.indexOf('async setSamplingMode('),
            bgGeo.indexOf('/**\n     * Undo a sampling-mode change'),
        );
        expect(samplingBody).toContain('if (!this.ready)');
        expect(samplingBody).not.toContain('ensureReady()');
    });

    it('separates passive, foreground-requested, and safety ownship fixes', () => {
        const ownship = read('services/ownshipPosition.ts');
        const guardian = read('services/GuardianService.ts');
        const guardianPage = read('components/GuardianPage.tsx');
        const logPage = read('pages/LogPage.tsx');
        const heartbeat = guardian.slice(
            guardian.indexOf('private async sendHeartbeat('),
            guardian.indexOf('private startHeartbeat('),
        );

        expect(ownship).toContain("options.locationAccess ?? 'already-granted'");
        expect(ownship).toContain('GpsService.getCurrentPositionIfGranted(requestOptions)');
        expect(ownship).toContain('GpsService.requestCurrentForegroundPosition(requestOptions)');
        expect(ownship).toContain('GpsService.getCurrentPosition(requestOptions)');
        expect(guardianPage).toContain("locationAccess: 'foreground-request'");
        expect(heartbeat).not.toContain("locationAccess: 'foreground-request'");
        expect(logPage).toContain("locationAccess: 'background-safety'");
    });

    it('preserves background-engine ownership for actual safety features', () => {
        const mob = read('services/MobService.ts');
        const anchor = read('services/AnchorWatchService.ts');
        const shipLog = read('services/ShipLogService.ts');

        expect(mob).toContain('GpsService.getCurrentPosition(');
        expect(mob).toContain('{ ensureRunning: true }');
        expect(anchor).toContain("BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch')");
        expect(anchor).toContain('BgGeoManager.requestStart()');
        expect(anchor).toContain('GpsService.getCurrentPositionIfGranted(');
        expect(shipLog).toContain("BgGeoManager.requireAlwaysLocationAuthorization('voyage-log')");
        expect(shipLog).toContain('BgGeoManager.requestStart()');
    });
});
