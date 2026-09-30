/**
 * Phase 1 (inshore router): "Show the leads Auto follows" — a chart overlay
 * of the compiled lead graph, OFF by default, switched in Settings →
 * Preferences → Chart. Registration and teardown follow the other ENC-derived
 * overlays (useBuoyageDirectionLayer).
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type mapboxgl from 'mapbox-gl';
import type { Feature } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    compileLeadGraph,
    LEAD_UKC_M,
    type LeadCompilerLayers,
    type LeadGraph,
} from '../services/routing/leadCompiler';

const data = vi.hoisted(() => ({ leadGraphForView: vi.fn() }));
vi.mock('../services/routing/leadOverlayData', () => ({ leadGraphForView: data.leadGraphForView }));
const cells = vi.hoisted(() => ({ unsubscribe: vi.fn(), subscribe: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ subscribe: cells.subscribe }));

import {
    BLOCKED_INK,
    CHART_LEADS_LAYER_IDS,
    CHART_LEADS_MIN_ZOOM,
    CHART_LEADS_SOURCE_ID,
    useChartLeadsLayer,
} from '../components/map/useChartLeadsLayer';

// A tiny real graph: one 5 m track (clear for 2 m) and one 1 m track (needs tide).
const W = 150.1;
const S = -24.1;
const band = (x0: number, x1: number, d: number): Feature => ({
    type: 'Feature',
    properties: { acronym: 'DEPARE', DRVAL1: d },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [W + x0, S - 0.01],
                [W + x1, S - 0.01],
                [W + x1, S + 0.01],
                [W + x0, S + 0.01],
                [W + x0, S - 0.01],
            ],
        ],
    },
});
const track = (x0: number, x1: number, rcid: number): Feature => ({
    type: 'Feature',
    properties: { acronym: 'RECTRC', rcid, CATTRK: 1, TRAFIC: 4 },
    geometry: {
        type: 'LineString',
        coordinates: [
            [W + x0, S],
            [W + x1, S],
        ],
    },
});
const chart: LeadCompilerLayers = {
    DEPARE: { features: [band(-0.01, 0.01, 5), band(0.01, 0.03, 1)] },
    // An A1 survey zone over both: without a graded M_QUAL nothing is clear
    // ('survey not graded', owner decision 4, 2026-09-30).
    M_QUAL: { features: [{ ...band(-0.01, 0.03, 0), properties: { acronym: 'M_QUAL', CATZOC: 1 } }] },
    RECTRC: { features: [track(0, 0.009, 1), track(0.011, 0.02, 2)] },
    // Carried empty, as a re-extracted cell will ("extracted, none charted");
    // without them nothing is clear (tests/leadCompiler.test.ts, the end).
    BRIDGE: { features: [] },
    PONTON: { features: [] },
    CBLOHD: { features: [] },
    PIPOHD: { features: [] },
    CONVYR: { features: [] },
};
const graph: LeadGraph = compileLeadGraph(chart, 2);

function makeMap(zoom = 13) {
    const sources = new Map<
        string,
        { data: GeoJSON.FeatureCollection; setData: (d: GeoJSON.FeatureCollection) => void }
    >();
    const layers = new Map<string, { id: string; type: string; paint?: Record<string, unknown>; filter?: unknown }>();
    const order: string[] = [];
    const handlers = new Map<string, Set<() => void>>();
    const map = {
        getZoom: () => zoom,
        getBounds: () => ({
            getWest: () => W - 0.02,
            getEast: () => W + 0.04,
            getSouth: () => S - 0.02,
            getNorth: () => S + 0.02,
        }),
        getStyle: () => ({ layers: order.map((id) => ({ id })) }),
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, opts: { data: GeoJSON.FeatureCollection }) => {
            const s = {
                data: opts.data,
                setData(d: GeoJSON.FeatureCollection) {
                    s.data = d;
                },
            };
            sources.set(id, s);
        },
        removeSource: (id: string) => sources.delete(id),
        getLayer: (id: string) => layers.get(id),
        addLayer: vi.fn((l: { id: string; type: string }) => {
            layers.set(l.id, l);
            order.push(l.id);
        }),
        removeLayer: (id: string) => {
            layers.delete(id);
            order.splice(order.indexOf(id), 1);
        },
        moveLayer: vi.fn(),
        on: (event: string, fn: () => void) => {
            const set = handlers.get(event) ?? new Set();
            set.add(fn);
            handlers.set(event, set);
        },
        off: (event: string, fn: () => void) => handlers.get(event)?.delete(fn),
    };
    return { ref: { current: map as unknown as mapboxgl.Map }, map, sources, layers, handlers };
}

beforeEach(() => {
    data.leadGraphForView.mockReset().mockResolvedValue(graph);
    cells.unsubscribe.mockReset();
    cells.subscribe.mockReset().mockReturnValue(cells.unsubscribe);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('useChartLeadsLayer — the lead graph on the chart', () => {
    it('off (the default) mounts nothing and compiles nothing', () => {
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, false, 2));
        expect(m.sources.size).toBe(0);
        expect(m.layers.size).toBe(0);
        expect(data.leadGraphForView).not.toHaveBeenCalled();
        expect(cells.subscribe).not.toHaveBeenCalled();
    });

    it('passes the air draft to the classifier, so bridges are read against this mast (Part B)', async () => {
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, true, 2.4, false, 18));
        await waitFor(() => expect(data.leadGraphForView).toHaveBeenCalled());
        expect(data.leadGraphForView).toHaveBeenCalledWith([W - 0.02, S - 0.02, W + 0.04, S + 0.02], 2.4, false, 18);
    });

    it('on draws the compiled leads: one source, four layers, one line per span', async () => {
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, true, 2));
        expect(m.sources.has(CHART_LEADS_SOURCE_ID)).toBe(true);
        expect([...m.layers.keys()].sort()).toEqual(Object.values(CHART_LEADS_LAYER_IDS).sort());
        await waitFor(() => expect(m.sources.get(CHART_LEADS_SOURCE_ID)!.data.features).toHaveLength(2));
        expect(data.leadGraphForView).toHaveBeenCalledWith([W - 0.02, S - 0.02, W + 0.04, S + 0.02], 2, false, null);
        const props = m.sources.get(CHART_LEADS_SOURCE_ID)!.data.features.map((f) => f.properties);
        expect(props).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ink: 'lead', depthClass: 'clear', label: 'Lead' }),
                expect.objectContaining({ ink: 'lead', depthClass: 'needs-tide', label: 'Lead · needs tide' }),
            ]),
        );
        // Only its own layers: never Mapbox's controls (logo / attribution).
        for (const id of m.layers.keys()) expect(id.startsWith('thalassa-chart-leads')).toBe(true);
        expect(cells.subscribe).toHaveBeenCalledTimes(1);
    });

    it('turning it off removes every layer and the source, and stops listening', async () => {
        const m = makeMap();
        const hook = renderHook(({ on }) => useChartLeadsLayer(m.ref, true, on, 2), { initialProps: { on: true } });
        await waitFor(() => expect(m.sources.get(CHART_LEADS_SOURCE_ID)?.data.features.length).toBe(2));
        hook.rerender({ on: false });
        expect(m.layers.size).toBe(0);
        expect(m.sources.size).toBe(0);
        expect(cells.unsubscribe).toHaveBeenCalledTimes(1);
        expect(m.handlers.get('moveend')?.size ?? 0).toBe(0);
    });

    it('draws nothing below its zoom (harbour furniture) and re-classes on a new draft', async () => {
        const far = makeMap(CHART_LEADS_MIN_ZOOM - 1);
        renderHook(() => useChartLeadsLayer(far.ref, true, true, 2));
        await act(async () => {});
        expect(data.leadGraphForView).not.toHaveBeenCalled();
        expect(far.sources.get(CHART_LEADS_SOURCE_ID)!.data.features).toHaveLength(0);

        const m = makeMap();
        const hook = renderHook(({ draft }) => useChartLeadsLayer(m.ref, true, true, draft), {
            initialProps: { draft: 2 },
        });
        await waitFor(() => expect(data.leadGraphForView).toHaveBeenCalledTimes(1));
        hook.rerender({ draft: 3.5 });
        await waitFor(() =>
            expect(data.leadGraphForView).toHaveBeenLastCalledWith(expect.any(Array), 3.5, false, null),
        );
    });

    // Phase 1 review (medium): with no draft entered, MapHub's
    // vesselDraftMetres falls back to 2.5 m (or onboarding's length × 0.16
    // guess) and the overlay inked leads 'clear' against that guess. The hook
    // now carries vesselDraftIsAssumed through: nothing is drawn clear, and
    // the lines say the draft is not set.
    it('with the draft not set, draws no clear ink and labels the lines "draft not set"', async () => {
        data.leadGraphForView.mockImplementation(async (_bbox: unknown, draft: number, assumed: boolean) =>
            compileLeadGraph(chart, draft, {}, LEAD_UKC_M, { draftAssumed: assumed }),
        );
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, true, 2.5, true));
        await waitFor(() => expect(m.sources.get(CHART_LEADS_SOURCE_ID)!.data.features).toHaveLength(2));
        expect(data.leadGraphForView).toHaveBeenCalledWith(expect.any(Array), 2.5, true, null);
        const props = m.sources.get(CHART_LEADS_SOURCE_ID)!.data.features.map((f) => f.properties);
        expect(props.some((p) => p?.depthClass === 'clear')).toBe(false);
        expect(props.map((p) => p?.label).sort()).toEqual([
            'Lead · draft not set',
            'Lead · needs tide · draft not set',
        ]);
        // A measured draft still draws the deep track clear (control).
        const n = makeMap();
        renderHook(() => useChartLeadsLayer(n.ref, true, true, 2.5, false));
        await waitFor(() => expect(n.sources.get(CHART_LEADS_SOURCE_ID)!.data.features).toHaveLength(2));
        expect(n.sources.get(CHART_LEADS_SOURCE_ID)!.data.features.map((f) => f.properties?.depthClass)).toContain(
            'clear',
        );
    });

    // Phase 1 review (integrity, medium): the base ENC chart already draws
    // every recommended track and leading line as an amber dash, overlay or
    // not. The overlay's 'needs tide' used the same amber and a similar dash,
    // so a needs-tide line sitting on a track looked like the chart's own
    // furniture. It is now a different ink on a dark casing.
    it('needs tide is drawn apart from the base chart’s amber lead dash: its own ink, on a dark casing', () => {
        const enc = readFileSync('components/map/EncVectorLayer.ts', 'utf8');
        const rectrc = enc.slice(enc.indexOf('id: ENC_VEC_LAYERS.RECTRC'));
        const encInk = /'line-color':\s*'(#[0-9a-fA-F]{6})'/.exec(rectrc)?.[1];
        expect(encInk).toMatch(/^#/);
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, true, 2));
        const amber = m.layers.get(CHART_LEADS_LAYER_IDS.amber)!;
        const casing = m.layers.get(CHART_LEADS_LAYER_IDS.amberCasing)!;
        expect(String(amber.paint?.['line-color']).toLowerCase()).not.toBe(encInk!.toLowerCase());
        expect(casing).toBeDefined();
        expect(casing.paint?.['line-color']).not.toBe(amber.paint?.['line-color']);
        // The casing sits under the amber line.
        const order = m.map.getStyle().layers.map((l) => l.id);
        expect(order.indexOf(CHART_LEADS_LAYER_IDS.amberCasing)).toBeLessThan(
            order.indexOf(CHART_LEADS_LAYER_IDS.amber),
        );
    });

    // Owner decision 5 (round 2, 2026-09-30): a lead under a structure the
    // mast cannot clear is 'blocked' — red dashes on the same dark casing,
    // never the amber "check this".
    it('a blocked lead is its own red dash on the dark casing, never amber', () => {
        const m = makeMap();
        renderHook(() => useChartLeadsLayer(m.ref, true, true, 2));
        const blocked = m.layers.get(CHART_LEADS_LAYER_IDS.blocked)!;
        const amber = m.layers.get(CHART_LEADS_LAYER_IDS.amber)!;
        const casing = m.layers.get(CHART_LEADS_LAYER_IDS.amberCasing)!;
        expect(blocked).toBeDefined();
        expect(blocked.filter).toEqual(['==', ['get', 'depthClass'], 'blocked']);
        expect(String(blocked.paint?.['line-color']).toLowerCase()).toBe(BLOCKED_INK);
        expect(blocked.paint?.['line-color']).not.toBe(amber.paint?.['line-color']);
        expect(blocked.paint?.['line-dasharray']).toBeDefined();
        expect(JSON.stringify(amber.filter)).not.toContain('blocked');
        expect(JSON.stringify(casing.filter)).toContain('blocked');
        const order = m.map.getStyle().layers.map((l) => l.id);
        expect(order.indexOf(CHART_LEADS_LAYER_IDS.amberCasing)).toBeLessThan(
            order.indexOf(CHART_LEADS_LAYER_IDS.blocked),
        );
    });
});

describe('Settings → Preferences → Chart — the switch, off by default', () => {
    it('Preferences has a Chart section with the switch, reading and saving showChartLeads', async () => {
        // Vite's build-time define, absent under vitest.
        vi.stubGlobal('__BUILD_STAMP__', '2026-09-29 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS, awaitSettingsLoaded, useSettingsStore } = await import('../stores/settingsStore');
        expect(DEFAULT_SETTINGS.showChartLeads).not.toBe(true);
        // A confirmed draft: the switch then turns on at once. An unconfirmed
        // one asks first (tests/DraftConfirmGates.test.tsx).
        await awaitSettingsLoaded();
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                vessel: {
                    name: 'Leads boat',
                    type: 'sail',
                    length: 40,
                    beam: 13,
                    draft: 7.87,
                    draftConfirmedFt: 7.87,
                    displacement: 20000,
                    maxWaveHeight: 10,
                    cruisingSpeed: 6,
                },
            },
        });
        const onSave = vi.fn();
        render(
            React.createElement(GeneralTab, {
                settings: DEFAULT_SETTINGS,
                onSave,
                onLocationSelect: vi.fn(),
                onDetectLocation: vi.fn(),
                onShowFactoryReset: vi.fn(),
            }),
        );
        // Phase 1 review (low): Auto does not follow the lead graph yet, so the
        // switch no longer promises that it does.
        expect(screen.queryByRole('switch', { name: 'Show the leads Auto follows' })).toBeNull();
        const toggle = screen.getByRole('switch', { name: 'Show charted leads' });
        // The legend names the overlay's own inks for every state, and does
        // not call the chart's ordinary amber track dash 'needs tide'.
        const legend = screen.getByText(/Not for navigation/).textContent ?? '';
        expect(legend).toMatch(/pink/i);
        expect(legend).toMatch(/indigo/i);
        expect(legend).toMatch(/dark edge/i);
        expect(legend).toMatch(/grey dots/i);
        expect(legend).toMatch(/Auto routing does not follow/i);
        expect(legend).not.toMatch(/Dashed amber/i);
        // Phase 1 review (medium, 2026-09-29): a chart without its bridges,
        // pontoons and overhead lines is never solid, and the legend says why.
        // Round 2 (2026-09-30): true before AND after the Pi re-reads the
        // charts with them — it no longer says no chart shows them.
        expect(legend).not.toMatch(/charted deep enough, nothing charted on the line/i);
        expect(legend).not.toMatch(/none is solid yet/i);
        expect(legend).not.toMatch(/these charts do not show bridges/i);
        expect(legend).toMatch(/not yet re-read with its\s+bridges and power lines is never solid/i);
        expect(legend).toMatch(/bridges not in chart data/i);
        // Owner decision 5: a structure the mast cannot clear blocks the line.
        expect(legend).toMatch(/red dashes: blocked/i);
        expect(legend).toMatch(/mast cannot clear/i);
        // Owner decisions 1, 3 and 4 (2026-09-30), in plain words: solid
        // allows for the survey's accuracy; a rough or ungraded survey, or a
        // coarser chart's land, is something the label names.
        expect(legend).toMatch(/allowing for how accurate the chart's survey is/i);
        expect(legend).toMatch(/rough or\s+ungraded survey/i);
        expect(legend).toMatch(/coarser chart that shows land/i);
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        expect(screen.getByText('Chart')).toBeTruthy();
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ showChartLeads: true });
    });

    it('the chart reads the setting, and never on a picker', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain("import { useChartLeadsLayer } from './useChartLeadsLayer';");
        expect(hub.replace(/\s+/g, '')).toContain(
            'useChartLeadsLayer(mapRef,mapReady,settings.showChartLeads===true&&!pickerMode,vesselDraftMetres(settings.vessel),vesselDraftIsAssumed(settings.vessel),vesselAirDraftMetres(settings.vessel),);',
        );
        const hook = readFileSync('components/map/useChartLeadsLayer.ts', 'utf8');
        expect(hook).not.toMatch(/mapboxgl-ctrl-(attrib|logo)/);
    });
});
