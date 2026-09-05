/**
 * Audit item 21: production errors must carry an exact build identity, and
 * source maps must exist for Sentry without ever shipping to users.
 *
 * Two halves that must move together: the build emits hidden maps ONLY for an
 * upload run, and the upload script deletes them whether or not the upload
 * happened — because 'hidden' maps still land in dist/, and dist/ is what
 * Vercel serves and what cap copy ships inside the app.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (s: string) =>
    s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*#.*$/gm, '');
// vite.config.ts carries glob strings ('**\/*.ts') that a block-comment stripper
// reads as a comment opener and swallows the file with. Line comments only.
const stripLines = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

describe('source maps never ship', () => {
    const vite = stripLines(readFileSync('vite.config.ts', 'utf8'));
    const ci = strip(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const script = strip(readFileSync('scripts/upload-sourcemaps.mjs', 'utf8'));

    it('production emits maps only when SENTRY_SOURCEMAPS=1, and only hidden ones', () => {
        expect(vite).toContain(
            "sourcemap: mode !== 'production' ? true : process.env.SENTRY_SOURCEMAPS === '1' ? 'hidden' : false",
        );
    });

    it('CI uploads and deletes the maps before any dist verification runs', () => {
        const build = ci.indexOf('- name: Build');
        const upload = ci.indexOf('- name: Upload hidden source maps to Sentry, then delete them');
        const verify = ci.indexOf('- name: Verify production preview routes and artifacts');
        expect(build).toBeGreaterThan(0);
        expect(upload).toBeGreaterThan(build);
        expect(verify).toBeGreaterThan(upload);
        expect(ci.slice(build, upload)).toContain("SENTRY_SOURCEMAPS: '1'");
        expect(ci.slice(upload, verify)).toContain('run: npm run sourcemaps:upload');
    });

    it('the upload script deletes maps in a finally, and when no token is set', () => {
        // finally → deleted even when the upload throws.
        expect(script).toMatch(/\} finally \{\s*deleteMaps\(maps\);/);
        // No token → still deleted.
        const noToken = script.indexOf('if (!token || !org || !project)');
        expect(noToken).toBeGreaterThan(0);
        expect(script.slice(noToken, noToken + 400)).toContain('deleteMaps(maps);');
        // A failed upload never fails the build.
        expect(script).toContain('process.exit(0)');
    });
});

describe('errors are tagged with the exact build', () => {
    const sentry = strip(readFileSync('services/sentry.ts', 'utf8'));

    it('release is version+build and dist is the build number', () => {
        expect(sentry).toContain('release: buildRelease()');
        expect(sentry).toContain('dist: __APP_BUILD__ || undefined');
        expect(sentry).toContain('`thalassa@${version}+${__APP_BUILD__}`');
    });

    it('tags carry platform, commit and build', () => {
        expect(sentry).toContain('platform: Capacitor.getPlatform()');
        expect(sentry).toContain('commit: __COMMIT_SHA__');
        expect(sentry).toContain("build: __APP_BUILD__ || 'unset'");
        expect(sentry).not.toContain("platform: 'web'");
    });

    it('the build defines the commit and build identity without ever failing the build', () => {
        const vite = stripLines(readFileSync('vite.config.ts', 'utf8'));
        expect(vite).toContain('__COMMIT_SHA__: JSON.stringify(resolveCommitSha())');
        expect(vite).toContain("__APP_BUILD__: JSON.stringify(String(process.env.VITE_APP_BUILD ?? '').trim())");
        expect(vite).toContain("return 'unknown';");
    });
});
