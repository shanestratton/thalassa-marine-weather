/**
 * The chart mounts once per process. Navigation hides it; nothing rebuilds it.
 *
 * Sealed 2026-08-09, after six fixes chased memory that was never there:
 * chart → plan → chart → SIT STILL kills the WebContent process. No plotting,
 * no zooming, no input. The flight trail showed the clean pair —
 *
 *     map:create(#1 z5 full dark-v11)@868 → map:remove(#1)@8841
 *     → map:create(#2 z5 full dark-v11)@30937 → … → DEAD
 *
 * — and a full Mapbox spin-up is the one mechanism in this codebase with a
 * documented body count (PassageRouteMap, 2026-08-04: "WebKit does not
 * promptly return that memory", JetsamEvent ~2.0 GB, monotonic). Two spin-ups
 * in one process is over the line. One, kept alive and hidden, is the steady
 * state the skipper already sails with all day.
 *
 * These tests pin the structure, because the tempting "simplification" —
 * folding the map back into the view ternary — reintroduces a crash that
 * took two weeks and seven commits to locate.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
const mapInit = readFileSync(resolve(process.cwd(), 'components/map/useMapInit.ts'), 'utf8');

describe('chart keep-alive', () => {
    it('renders the chart OUTSIDE the view ternary, latched once visited', () => {
        // The ternary's map branch must be gone — a `) : (<main` there means
        // navigation unmounts the chart again.
        expect(app).toMatch(/\) : null\}/);
        expect(app).toMatch(/\{\(chartKeepAlive \|\| chartVisible\) && \(/);
        expect(app).toMatch(/const \[chartKeepAlive, setChartKeepAlive\] = useState\(false\)/);
    });

    it('hides with display:none rather than unmounting', () => {
        expect(app).toMatch(/style=\{chartVisible \? undefined : \{ display: 'none' \}\}/);
    });

    it('never lowers the latch — once alive, alive for the process', () => {
        // setChartKeepAlive(false) anywhere would bring back a remount path.
        expect(app.match(/setChartKeepAlive\(false\)/g)).toBeNull();
        expect(app.match(/setChartKeepAlive\(true\)/g)).toHaveLength(1);
    });

    it('moves the main-content id with visibility, so it is never duplicated', () => {
        // Both <main> elements can now exist at once; two id="main-content"
        // would break skip-links and any getElementById caller.
        expect(app).toMatch(/id=\{chartVisible \? 'main-content' : undefined\}/);
    });

    it('keeps the lifecycle crumbs that would expose a regression', () => {
        // If the chart ever starts remounting again, the flight trail must
        // say so: a second map:create(#2) after a map:remove(#1) is the
        // signature that found this bug. Removing the crumbs blinds the
        // instrument that watches the fix.
        expect(mapInit).toMatch(/crumb\(\s*'map:create'/);
        expect(mapInit).toMatch(/crumb\('map:remove'/);
        expect(mapInit).toMatch(/mapInstanceSeq \+= 1/);
    });

    it('documents why, at the latch', () => {
        // The reasoning must live next to the code — this structure looks
        // like an accident without it.
        expect(app).toMatch(/Chart keep-alive/);
        expect(app).toMatch(/WebKit does not promptly\s+\/\/ return that memory/);
    });
});
