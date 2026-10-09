/**
 * MapHub's share of adding legs (126-16a) is wiring only; the decisions live in
 * services/tripLegAdd.ts, services/traceSave.ts and useTraceDraft, tested
 * there. MapHub is too heavy to render here (as MapHubReverseWiring.test.ts
 * explains), so this pins the wiring that would otherwise drift: the 'add-leg'
 * door opens a copy locked to the previous arrival in one draft edit, opening a
 * trip's leg keeps its place in the trip, the next-leg row and the Trip sheet
 * are on the chart, and a refused Log mirror is said in the diagnostics.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const code = readFileSync('components/map/MapHub.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** One front-door branch of the tracer-open handler. */
function branch(kind: string): string {
    const start = code.indexOf(`action?.kind === '${kind}'`);
    expect(start, `${kind} branch exists`).toBeGreaterThan(-1);
    const next = code.indexOf('} else if (action?.kind', start + 10);
    return code.slice(start, next > -1 ? next : undefined);
}

function body(name: string): string {
    const start = code.indexOf(`const ${name} = useCallback(`);
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    const next = code.indexOf('useCallback(', start + 40);
    return code.slice(start, next > -1 ? next : undefined);
}

describe("MapHub's 'add-leg' door", () => {
    it('sits beside new-leg and opens a copy, locked, in one draft edit with the departure kept', () => {
        expect(code.indexOf("action?.kind === 'add-leg'")).toBeGreaterThan(code.indexOf("action?.kind === 'new-leg'"));
        const add = branch('add-leg');
        expect(add).toContain('nextLegSeed(');
        expect(add).toContain('legInSlot(');
        expect(add).toContain('legCopyForSlot(');
        expect(add).toMatch(/openReversedLeg\([\s\S]*?legAnchor: seed[\s\S]*?\{ keepDeparture: true \},?\s*\)/);
        expect(add).toContain('rebaseHistoryRef.current = true');
        expect(add).toContain('setOverwriteArm(null)');
        expect(add).toContain('setSlotChoices(null)');
        expect(add).toContain('setSavedTraces(');
        expect(add).toContain('fitTraceBounds(mapRef.current');
        expect(add).toContain('isAuthIdentityScopeCurrent(requestScope)');
        // The lock IS the point: never dropped here, and no write path of its own.
        expect(add).not.toContain('setLegAnchor(null)');
        expect(add).not.toMatch(/\bsaveTrace\(|commitTraceSave\(|retroBadgeFirstLeg\(/);
        // It says out loud what it did and that the source is untouched.
        expect(add).toContain('The original is unchanged');
    });

    it('opening a saved leg keeps its place in the trip, from Plan and from the card', () => {
        const load = branch('load-saved');
        expect(load).toContain('slotSeedForLeg(');
        expect(load).not.toContain('setLegAnchor(null)');
        const open = body('openSavedTrace');
        expect(open).toContain('slotSeedForLeg(');
        expect(open).not.toContain('setLegAnchor(null)');
        // ...and keeps its name: the namer is re-armed only for a route that
        // opens free (useTracerAutoName; TracerAutoNameSlotLeg.test.tsx).
        for (const door of [load, open]) {
            expect(door).toContain('rearmAutoNameForOpenedRoute(lastAutoNameRef, t.name, slot)');
            expect(door).not.toContain('looksAutoNamed(');
        }
        expect(code).toContain('useTracerAutoName({');
    });

    it('the chart offers the next leg and the trip, from one lazy Trip sheet', () => {
        // The shared lazy door (components/passage/LazyTripSheet.tsx): no eager TripSheet here.
        expect(code).toMatch(/import \{ LazyTripSheet\b[^}]*\} from '\.\.\/passage\/LazyTripSheet'/);
        expect(code).not.toMatch(/from '\.\.\/passage\/TripSheet'/);
        expect(code).toMatch(/<TracerReturnStrip[\s\S]*?nextLeg=\{[\s\S]*?onNextLeg=\{[\s\S]*?onBackToTrip=\{/);
        expect(code).toMatch(/<TracerSavedRoutePicker[\s\S]*?onFillSlot=\{/);
        expect(code).toContain('<LazyTripSheet');
    });

    it('the auto-bank is told the slot, so a copy never banks onto its source', () => {
        const site = code.slice(code.indexOf('useTracerAutoBank({'));
        expect(site.slice(0, site.indexOf('});'))).toMatch(/\blegAnchor,/);
    });

    it('a Log mirror refused as this saved route’s duplicate is logged with a reason, no names', () => {
        const save = body('saveCurrentTrace');
        expect(save).toContain("log.warn('trace save → logbook: duplicate for this saved route')");
    });
});
