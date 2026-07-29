import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERLAY_Z_INDEX } from '../components/ui/OverlayPortal';

/**
 * The night-vision scrim must be the topmost layer in the app.
 *
 * It is a thin red wash over everything, and its whole job is protecting the
 * helm's dark adaptation on a night watch. It sat at z-[9999] while twelve
 * overlays lived at z >= 10000 — the Chart depth controls and trip leg picker
 * at 10060, the Plan-on-web hint at 10070, the departure prompt at 10055, the
 * trace report at 10050, onboarding at 10000. Each of those painted at full
 * brightness straight through the scrim, worst of all on the chart at night.
 *
 * Raising the number alone would just lose the race to whatever overlay gets
 * added next, which is why this exists: the ceiling is a checked invariant, not
 * a convention. If you need a new overlay above everything else, the scrim goes
 * higher first and this test tells you so.
 */

const ROOT = resolve(process.cwd());
const SCAN_DIRS = ['components', 'pages'];
const SCAN_FILES = ['App.tsx'];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
    }
    return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...SCAN_FILES.map((f) => join(ROOT, f))];

/** The scrim's own z-index, derived in source from the overlay scale. */
const scrimZ = (): number => OVERLAY_Z_INDEX.critical - 1000;

/**
 * Two layers are allowed at or above the scrim, each for a stated reason:
 *
 *  - the `critical` overlay tier (OverlayPortal), reserved for alarms that must
 *    outrank every in-app surface. A drag alarm at 3am punches through the
 *    scrim on purpose.
 *  - EncVectorLayer's own chart night dim, which is itself a night-vision
 *    treatment (a stronger one, ~45% against the scrim's 25%) rendered onto
 *    document.body.
 *
 * Anything else appearing here is a real regression: it paints at full
 * brightness over a helm that has spent 20 minutes getting dark-adapted.
 */
const ALLOWED_ABOVE: { file: string; z: number; why: string }[] = [
    { file: 'components/ui/OverlayPortal.tsx', z: 2147483000, why: 'critical alarm tier' },
    { file: 'components/map/EncVectorLayer.ts', z: 2147483000, why: 'chart night dim overlay' },
];

describe('night-vision scrim is the top layer', () => {
    it('is still rendered, and still covers the viewport without eating taps', () => {
        const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
        const block = app.slice(app.indexOf("effectiveMode === 'night' && ("), app.indexOf('</div>\n    );'));
        expect(block).toContain('fixed inset-0');
        expect(block).toContain('NIGHT_SCRIM_Z_INDEX');
        expect(block).toContain('pointer-events-none');
        expect(block).toContain('aria-hidden="true"');
    });

    it('outranks every other z-index in the app', () => {
        const ceiling = scrimZ();
        const offenders: string[] = [];

        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            // Tailwind arbitrary values and plain CSS declarations alike.
            for (const m of src.matchAll(/z-\[(\d+)\]|z-index:\s*(\d+)/g)) {
                const z = Number(m[1] ?? m[2]);
                if (!Number.isFinite(z) || z < ceiling) continue;
                const rel = file.replace(`${ROOT}/`, '');
                if (ALLOWED_ABOVE.some((a) => a.file === rel && a.z === z)) continue;
                offenders.push(`${rel} → ${z}`);
            }
        }

        expect(
            offenders,
            `These layers sit at or above the night scrim (${ceiling}) and would paint at full ` +
                `brightness on a night watch. Raise the scrim in App.tsx if the new layer genuinely ` +
                `belongs on top:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });
});
