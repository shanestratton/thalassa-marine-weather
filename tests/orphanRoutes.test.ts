/**
 * orphanRoutes — guardrail test that fails CI when a route registered
 * in viewRegistry.tsx has zero UI call sites elsewhere in the codebase.
 *
 * Why this exists
 * ---------------
 * We've shipped two orphan-route bugs in 48 hours:
 *   - 2026-05-16: Diary (registered, gated as paid feature, but the
 *     VesselHub tile that called setPage('diary') had been silently
 *     deleted in a Quick-Actions cleanup).
 *   - 2026-05-17: Galley (identical pattern — registered + advertised
 *     in UpgradeModal as a Skipper feature, but no UI button called
 *     onNavigate('galley')).
 *
 * Both bugs are silent: TypeScript compiles, lint passes, runtime
 * tests pass, the app loads — the only symptom is users not being
 * able to reach a feature. This test runs `audit-orphan-routes.mjs`
 * as part of the normal test suite so the next one fails CI instead
 * of shipping.
 *
 * If this test fails, see the audit script's error message — there
 * are three fixes (add a UI entry point, delete the dead route, or
 * allow-list it as intentionally indirect).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(__filename, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/audit-orphan-routes.mjs');

describe('viewRegistry — no orphan routes', () => {
    it('every registered route has at least one UI call site', () => {
        // Run the audit script in JSON mode. It exits 0 even when
        // orphans exist (--strict gates that); we read the JSON to
        // produce a friendly assertion failure with the orphan
        // names rather than a raw non-zero exit.
        const out = execSync(`node ${SCRIPT} --json`, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        const result = JSON.parse(out);

        // The route count should be sane — if the parser broke, all
        // routes would look orphaned, so guard against that case
        // before checking orphans.
        expect(result.totalRoutes).toBeGreaterThanOrEqual(20);

        // The actual assertion. If this fails, the error message
        // includes the orphan names so you can see them in CI logs
        // without re-running the script locally.
        expect(
            result.orphans,
            `Found ${result.orphans} orphan route(s): ${result.orphanList.join(', ')}. ` +
                `Either add a UI entry point, delete the route from ` +
                `viewRegistry.tsx, or allow-list it in ` +
                `INTENTIONAL_INDIRECT_ROUTES inside ` +
                `scripts/audit-orphan-routes.mjs.`,
        ).toBe(0);
    });
});
