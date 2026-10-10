// @vitest-environment node
/**
 * S-63 never feeds Thalassa (127-C-a C5, and Shane's yes to retiring the
 * S-63 Licensing card, 2026-10-10).
 *
 * The o-charts shop terms make ChartWorld S-63 OpenCPN-only, so from 127 it
 * is used only inside OpenCPN on the Pi: OpenCPN's own S-63 plugin takes
 * delivery, does the fingerprint and the permits (Remote screen). Thalassa
 * keeps no path that unpacks, decrypts, installs or polls for S-63:
 *   - the extractor's S-63 decrypt and parser (the XOR pad code) are deleted
 *     from the public repo, with the headless installer;
 *   - the Pi's .es57 watcher and the ChartWorld FTP poller are gone;
 *   - an S-63 delivery dropped into Thalassa gets one plain answer and leaves
 *     nothing behind (pi-cache routes/encInstall.test.mts runs that job);
 *   - the S-63 Licensing card, its service and the Pi's /api/enc/s63 routes
 *     are gone.
 * The store's 's63' source value is a legacy enum entry only: the old S-63
 * path published its cells as 'pi-decrypt', so S-63 cells already on a Pi
 * cannot be told apart by source. 127-C-d's purge removes them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

function tracked(...paths: string[]): string[] {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .filter((path) => existsSync(path));
}

const RETIRED = [
    'tools/senc-extractor/src/extractS63.ts',
    'tools/senc-extractor/src/s63Decrypt.ts',
    'tools/senc-extractor/src/s63SencParser.ts',
    'tools/senc-extractor/src/installS63.ts',
    'pi-cache/src/chartworldSync.ts',
    'pi-cache/src/chartworldSync.test.mts',
    'pi-cache/src/s63Setup.ts',
    'pi-cache/src/s63Setup.test.mts',
    'components/vessel/S63LicensingCard.tsx',
    'services/enc/S63SetupService.ts',
];

describe('S-63 is retired from Thalassa (127)', () => {
    it.each(RETIRED)('%s is deleted', (path) => {
        expect(existsSync(path)).toBe(false);
    });

    it('no source imports a retired module or calls the old S-63 routes', () => {
        // App, Pi and tool code; a test that still imported a deleted module
        // would fail on its own.
        const code = tracked(
            'App.tsx',
            'components',
            'hooks',
            'services',
            'utils',
            'pi-cache/src',
            'tools',
            'scripts',
        ).filter((path) => /\.(ts|tsx|mts|mjs|js)$/.test(path) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(path));
        expect(code.length).toBeGreaterThan(1000);
        const names =
            /\b(extractS63|s63Decrypt|s63SencParser|installS63|chartworldSync|s63Setup|S63LicensingCard|S63SetupService)\b|\/api\/enc\/s63|\/s63\/(status|fingerprint|permits)/;
        expect(code.filter((path) => names.test(read(path)))).toEqual([]);
    });

    it('the Pi page no longer mounts the S-63 Licensing card', () => {
        expect(read('components/vessel/AvNavPage.tsx')).not.toMatch(/S63|S-63/);
        // Its only outbound link went with it.
        expect(read('services/externalLinks.ts')).not.toMatch(/OCHARTS_USERPERMITS_URL|ocpermits/);
    });

    it('the Pi watches .oesu only: no .es57 watcher, no poller, no S-63 settings', () => {
        const watcher = read('pi-cache/src/encWatcher.ts');
        expect(watcher).not.toMatch(/es57|ENC_S63_|ENC_CHARTWORLD|s63Watcher|startChartworldSync/);
        expect(watcher).toContain("join(EXTRACTOR_DIR, 'src', 'decryptBatch.ts')");
    });

    it('an S-63 delivery dropped into Thalassa is answered, never staged or installed', () => {
        const routes = read('pi-cache/src/routes/enc.ts');
        expect(routes).toContain('export async function detectChartworldArchive');
        expect(routes).toContain(
            "'ChartWorld S-63 charts open in OpenCPN on your Pi (Remote screen), not in Thalassa.'",
        );
        expect(routes).not.toMatch(/CHARTWORLD_INBOX|dropIntoChartworldInbox|pollChartworldOnce|ENC_CHARTWORLD_DIR/);
    });

    it("the extractor's README no longer documents the S-63 pad decrypt", () => {
        const readme = read('tools/senc-extractor/README.md');
        expect(readme).not.toMatch(/extractS63|installS63|s63Decrypt|s63SencParser|XOR|OCPNsenc -c/);
    });
});
