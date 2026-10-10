import { readFileSync } from 'node:fs';
import { render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { Capacitor } from '@capacitor/core';
import type { TraceLegVerdict } from '../services/routeTracer';

/**
 * Sketch legs (127-DESKMAP C3): a leg with no chart behind it on this device
 * is drawn as grey dashes on a dark edge, "sketch, not checked" — never
 * green, never the needs-tide amber. The grade stays 'caution' for every
 * consumer, so Save words, the report and the verification envelope keep
 * their meaning.
 */

const build = vi.hoisted(() => ({ mode: 'nochart' as 'nochart' | 'throw' | 'ready' }));
vi.mock('../services/routeTracer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/routeTracer')>();
    return {
        ...actual,
        buildTracerContext: vi.fn(async () => {
            if (build.mode === 'throw') throw new Error('cell store unavailable');
            if (build.mode === 'nochart') return { status: 'nochart' };
            return { status: 'ready', ctx: { gateChecksUnavailable: false, supplementalChecksUnavailable: false } };
        }),
        validateTraceLeg: vi.fn(
            (): TraceLegVerdict => ({
                grade: 'clear',
                issues: [],
                minDepthM: 6,
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            }),
        ),
    };
});

vi.mock('../components/map/TracerTidePanel', () => ({ TracerTidePanel: () => null }));

import { gradeLegs } from '../services/traceGrading';
import { mergeSubLegVerdicts, traceHealth } from '../services/routeTracer';
import { useTracerTraceLayer } from '../components/map/useTracerTraceLayer';
import { NAV_LAYER_IDS, TRACE_LAYER_IDS } from '../components/map/isobarLayerSetup';
import { SKETCH_LEG_DASH, TRACE_CASING, traceHintPaint } from '../components/map/traceLegInk';
import { LIGHT_PALETTE } from '../components/map/reliefBase';
import { ChartKeyPanel } from '../components/map/ChartKeyPanel';
import { TracerWaypointList } from '../components/map/tracer/TracerWaypointList';
import { contrast } from './helpers/colourScience';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';

// Fictional legs in public waters: Chesapeake Bay (USA) and the Solent.
const LEGS = [
    { a: { lat: 38.97, lon: -76.45 }, b: { lat: 38.975, lon: -76.44 }, key: 'a|b' },
    { a: { lat: 50.77, lon: -1.33 }, b: { lat: 50.772, lon: -1.32 }, key: 'b|c|last' },
];
async function grade() {
    const out = new Map<string, TraceLegVerdict>();
    await gradeLegs(LEGS, {
        draftM: 2.4,
        draftAssumed: false,
        clusterSpanM: 1e9,
        onLeg: (key, verdict) => out.set(key, verdict),
    });
    return out;
}

beforeEach(() => {
    build.mode = 'nochart';
});

describe('the two no-chart verdicts are sketches', () => {
    it('no chart here: caution, unchecked, in plain words', async () => {
        const verdicts = await grade();
        expect(verdicts.size).toBe(2);
        for (const v of verdicts.values()) {
            expect(v.grade).toBe('caution');
            expect(v.unchecked).toBe(true);
            expect(v.issues.map((i) => i.message)).toEqual(['Not checked: no chart for here on this device']);
        }
    });

    it('a chart that failed to load: caution, unchecked, retried', async () => {
        build.mode = 'throw';
        const verdicts = await grade();
        for (const v of verdicts.values()) {
            expect(v.grade).toBe('caution');
            expect(v.unchecked).toBe(true);
            expect(v.issues.map((i) => i.message)).toEqual(['Not checked: the chart didn’t load, trying again']);
        }
    });

    it('a real verdict never carries unchecked', async () => {
        build.mode = 'ready';
        const verdicts = await grade();
        for (const v of verdicts.values()) {
            expect(v.grade).toBe('clear');
            expect('unchecked' in v).toBe(false);
        }
    });

    it('a leg cut into pieces is a sketch only when every piece is one', () => {
        const sketch: TraceLegVerdict = {
            grade: 'caution',
            issues: [{ severity: 'caution', message: 'Not checked: no chart for here on this device' }],
            minDepthM: null,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
            unchecked: true,
        };
        const real: TraceLegVerdict = { ...sketch, grade: 'clear', issues: [], minDepthM: 8, unchecked: undefined };
        delete real.unchecked;
        expect(mergeSubLegVerdicts([sketch, sketch])?.unchecked).toBe(true);
        expect(mergeSubLegVerdicts([sketch, real])?.unchecked).toBeUndefined();
        expect(mergeSubLegVerdicts([sketch, null])?.unchecked).toBeUndefined();
    });

    it('the saved-route words for a sketch leg are unchanged: still caution', () => {
        const caution: TraceLegVerdict = {
            grade: 'caution',
            issues: [{ severity: 'caution', message: 'Not checked: no chart for here on this device' }],
            minDepthM: null,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
        };
        expect(traceHealth([{ ...caution, unchecked: true }])).toEqual(traceHealth([caution]));
    });
});

class TraceMap extends FakeMapboxMap {
    moveLayer(id: string, before?: string) {
        const at = this.layers.findIndex((l) => l.id === id);
        const [layer] = this.layers.splice(at, 1);
        const to = before ? this.layers.findIndex((l) => l.id === before) : -1;
        if (to < 0) this.layers.push(layer);
        else this.layers.splice(to, 0, layer);
    }
    triggerRepaint() {}
}

function drawn(legVerdicts: Array<TraceLegVerdict | null>) {
    const map = new TraceMap({ container: document.createElement('div') });
    map.loadStyle();
    const mapRef = { current: map as unknown as mapboxgl.Map };
    renderHook(() =>
        useTracerTraceLayer({
            mapRef,
            coordCaptureMode: true,
            capturedCoords: [
                { lat: 38.97, lon: -76.45 },
                { lat: 38.975, lon: -76.44 },
                { lat: 38.98, lon: -76.43 },
            ],
            legVerdicts,
            ghostLanes: [],
            traceOrigin: null,
            traceDest: { lat: 38.99, lon: -76.42, name: 'Fictional Creek' },
            destHint: true,
        }),
    );
    return map;
}
const sketchVerdict: TraceLegVerdict = {
    grade: 'caution',
    issues: [{ severity: 'caution', message: 'Not checked: no chart for here on this device' }],
    minDepthM: null,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
    unchecked: true,
};
const needsTide: TraceLegVerdict = { ...sketchVerdict, issues: [], needsTide: true, unchecked: undefined };

describe('sketch legs on the chart', () => {
    it('marks those legs sketch in the trace source; a real caution leg is not one', () => {
        const map = drawn([sketchVerdict, needsTide]);
        const data = map.getSource('trace-line')!.data as { features: Array<{ properties: Record<string, unknown> }> };
        expect(data.features.map((f) => f.properties.sketch)).toEqual([true, false]);
        expect(data.features.map((f) => f.properties.grade)).toEqual(['caution', 'caution']);
    });

    it('draws them as grey dashes on the dark edge, and the coloured layers leave them out', () => {
        const map = drawn([sketchVerdict, needsTide]);
        const layer = (id: string) => map.getLayer(id)!;
        const sketch = layer('trace-line-sketch');
        expect(sketch.filter).toEqual(['==', ['get', 'sketch'], true]);
        expect(sketch.paint?.['line-dasharray']).toEqual([...SKETCH_LEG_DASH.dasharray]);
        expect(sketch.paint?.['line-color']).toBe(SKETCH_LEG_DASH.ink);
        expect(sketch.paint?.['line-width']).toBe(layer('trace-line-core').paint?.['line-width']);
        expect(String(sketch.paint?.['line-color']).toLowerCase()).not.toMatch(/#00e676|#ffb300/);
        for (const id of ['trace-line-glow', 'trace-line-core'])
            expect(layer(id).filter, id).toEqual(['!=', ['get', 'sketch'], true]);
        const casing = layer('trace-line-casing');
        expect(casing.paint?.['line-color']).toBe('#1c1917');
        expect(casing.paint?.['line-width'] as number).toBeGreaterThan(
            layer('trace-line-core').paint?.['line-width'] as number,
        );
        const order = map.layers.map((l) => l.id);
        expect(order.indexOf('trace-line-casing')).toBeLessThan(order.indexOf('trace-line-core'));
        expect(order.indexOf('trace-line-casing')).toBeLessThan(order.indexOf('trace-line-sketch'));
        expect(order.indexOf('trace-line-glow')).toBeLessThan(order.indexOf('trace-line-casing'));
    });

    it('lifts the new layers with the rest of the trace, in draw order', () => {
        const ids: readonly string[] = TRACE_LAYER_IDS;
        for (const list of [ids, NAV_LAYER_IDS as readonly string[]]) {
            const at = (id: string) => list.indexOf(id);
            expect(at('trace-line-glow')).toBeLessThan(at('trace-line-casing'));
            expect(at('trace-line-casing')).toBeLessThan(at('trace-line-core'));
            expect(at('trace-line-core')).toBeLessThan(at('trace-line-sketch'));
            expect(at('trace-line-sketch')).toBeLessThan(at('trace-line-arrows'));
        }
        const nav: readonly string[] = NAV_LAYER_IDS;
        expect(nav.indexOf('route-harbour-casing')).toBeGreaterThan(-1);
        expect(nav.indexOf('route-harbour-casing')).toBeLessThan(nav.indexOf('route-harbour-dash'));
    });

    it('keys them in the plan key, worded apart from the router’s “Not checked yet”', () => {
        render(<ChartKeyPanel visible imageryOn tideDepthMode={false} draftConfigured onClose={() => undefined} />);
        expect(screen.getByText('Sketch, not checked: no chart for here on this device')).toBeInTheDocument();
        expect(screen.getByText(/^Not checked yet/)).toBeInTheDocument();
    });

    it('the tracer card’s leg list draws a sketch leg slate with a dash, never the needs-tide amber ⚠', () => {
        render(
            <TracerWaypointList
                capturedCoords={[
                    { lat: 50.77, lon: -1.33 },
                    { lat: 50.772, lon: -1.32 },
                    { lat: 50.774, lon: -1.31 },
                ]}
                legVerdicts={[sketchVerdict, needsTide]}
                tideLabels={{}}
                tideAnchor={null}
                departureMs={null}
                departureLabel={null}
                mapRef={{ current: null }}
                pulseMarkHalo={() => undefined}
            />,
        );
        const row = (text: RegExp) => screen.getByText(text).closest('.flex')!.firstElementChild as HTMLElement;
        const sketchGlyph = row(/Not checked: no chart for here on this device/);
        expect(sketchGlyph).toHaveTextContent('–');
        expect(sketchGlyph.className).toContain('text-slate-400');
        expect(sketchGlyph.className).not.toContain('amber');
        const tideGlyph = row(/^2→3/);
        expect(tideGlyph).toHaveTextContent('⚠');
        expect(tideGlyph.className).toContain('text-amber-300');
    });

    it('the tracer card says what the grey legs are', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('No chart for here on this device: these legs are a sketch, not checked.');
        expect(hub).not.toContain("No ENC charts here — legs can't be depth-checked.");
    });
});

describe('lines that read on the pale sea (127-DESKMAP A4)', () => {
    const init = readFileSync('components/map/useMapInit.ts', 'utf8');
    const added = (id: string) => init.indexOf(`id: '${id}'`);

    it('cases the harbour dashes and both model-comparison cores in the route line’s dark edge', () => {
        expect(TRACE_CASING).toBe('#1c1917');
        const harbour = added('route-harbour-casing');
        expect(harbour).toBeGreaterThan(-1);
        expect(harbour).toBeLessThan(added('route-harbour-dash'));
        expect(init.slice(harbour, harbour + 500)).toMatch(/'line-color': TRACE_CASING/);
        // The braid's casings come from one helper, added between each glow and core.
        const helper = init.indexOf('const braidCasing = ');
        expect(helper).toBeGreaterThan(-1);
        expect(init.slice(helper, helper + 400)).toMatch(
            /id: `confidence-\$\{model\}-casing`[\s\S]*'line-color': TRACE_CASING/,
        );
        for (const model of ['gfs', 'ecmwf']) {
            const at = init.indexOf(`braidCasing('${model}');`);
            expect(at, model).toBeGreaterThan(added(`confidence-${model}-glow`));
            expect(at, model).toBeLessThan(added(`confidence-${model}-core`));
        }
    });

    // The phone's Obs and planner are unchanged in 127: the casings are the
    // web's, and on the phone only a sketch leg sits on its dark edge.
    it('on the phone: no harbour or braid casings, and the trace casing carries only sketch legs', () => {
        const harbour = added('route-harbour-casing');
        expect(init.slice(harbour - 120, harbour)).toMatch(/if \(cased\)\s*map\.addLayer\(\{\s*$/);
        expect(init).toMatch(/const cased = !Capacitor\.isNativePlatform\(\);/);
        const helper = init.indexOf('const braidCasing = ');
        expect(init.slice(helper, helper + 140)).toMatch(/=>\s*cased &&\s*map\.addLayer\(/);

        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        try {
            const phone = drawn([sketchVerdict, needsTide]);
            expect(phone.getLayer('trace-line-casing')!.filter).toEqual(['==', ['get', 'sketch'], true]);
            expect(phone.getLayer('trace-line-core')!.filter).toEqual(['!=', ['get', 'sketch'], true]);
        } finally {
            vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        }
        expect(drawn([sketchVerdict]).getLayer('trace-line-casing')!.filter).toBeUndefined();
    });

    it('keeps the bearing hint and the proven-lane ghost at hint weight: no casing, thin, dotted, slate on Light', () => {
        const map = drawn([needsTide, needsTide]);
        const hint = map.getLayer('trace-dest-hint-line')!.paint!;
        const ghost = map.getLayer('trace-ghost-line')!.paint!;
        expect(hint['line-width'] as number).toBeLessThanOrEqual(1.5);
        expect(hint['line-dasharray']).toEqual([1, 3]);
        expect(ghost['line-width']).toBe(3);
        expect(map.getLayer('trace-dest-hint-casing')).toBeUndefined();
        expect(map.getLayer('trace-ghost-casing')).toBeUndefined();

        const light = new Map(traceHintPaint(true).map(([id, prop, value]) => [`${id} ${prop}`, value]));
        expect(light.get('trace-dest-hint-line line-color')).toBe('#475569');
        expect(light.get('trace-ghost-line line-color')).toBe('#475569');
        expect(light.get('trace-dest-hint-line line-opacity') as number).toBeLessThanOrEqual(0.7);
        const today = new Map(traceHintPaint(false).map(([id, prop, value]) => [`${id} ${prop}`, value]));
        expect(today.get('trace-dest-hint-line line-color')).toBe(hint['line-color']);
        expect(today.get('trace-dest-hint-line line-opacity')).toBe(hint['line-opacity']);
        expect(today.get('trace-ghost-line line-color')).toBe(ghost['line-color']);
        // The hint stays visibly lighter than any leg.
        expect(light.get('trace-dest-hint-line line-opacity') as number).toBeLessThan(0.95);
        // MapHub's base pass writes them only when the layer's paint differs.
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toMatch(
            /for \(const \[id, prop, value\] of traceHintPaint\([^)]*\)\)[\s\S]{0,200}getPaintProperty\(id, prop\) !== value/,
        );
    });

    it('every planning line’s outer ink reaches 3:1 on every Light water colour', () => {
        const waters = [...LIGHT_PALETTE.ramp.filter(([d]) => d >= 2).map(([, c]) => c), LIGHT_PALETTE.water];
        const outer = [
            TRACE_CASING,
            SKETCH_LEG_DASH.casing,
            ...traceHintPaint(true)
                .filter(([, p]) => p === 'line-color')
                .map(([, , v]) => v as string),
        ];
        for (const ink of outer)
            for (const w of waters) expect(contrast(ink, w), `${ink} on ${w}`).toBeGreaterThanOrEqual(3);
    });
});
