import React, { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { useNmeaStore } from '../nmea/useNmeaStore';
import { useInstrumentDerivations } from '../../hooks/useInstrumentDerivations';
import { useInstrumentPanelPreferences } from '../../services/instruments/panelPreferences';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { nextFollowedMark } from '../../services/instruments/nextMark';
import { instrumentLaylines, type InstrumentLaylines } from '../../services/instruments/laylines';
import type { MeasuredCurrent } from '../../services/instruments/measuredCurrent';
const SOURCE = 'own-instrument-laylines',
    LAYER = 'own-instrument-layline-guides';
export interface InstrumentOverlayFrame {
    position: { lat: number; lon: number } | null;
    current: MeasuredCurrent | null;
    laylines: InstrumentLaylines | null;
    markName: string | null;
    now: number;
}
/** One marker and one owned source; no remote source, private coordinates never leave the map. */
export class InstrumentOverlayRenderer {
    private marker: mapboxgl.Marker | null = null;
    private element: HTMLDivElement;
    private arrow: HTMLSpanElement;
    private label: HTMLSpanElement;
    private frame: InstrumentOverlayFrame | null = null;
    private idlePending = false;
    private dataSignature: string | null = null;
    private readonly afterIdle = () => {
        this.idlePending = false;
        this.paint();
    };
    private readonly repaint = () => this.paint();
    constructor(private readonly map: mapboxgl.Map) {
        this.element = document.createElement('div');
        this.element.className =
            'pointer-events-none flex max-w-44 items-center gap-1 rounded-md border border-cyan-300/40 bg-slate-950/90 px-2 py-1 text-[11px] font-bold text-cyan-200';
        this.arrow = document.createElement('span');
        this.arrow.textContent = '↑';
        this.arrow.style.fontSize = '24px';
        this.arrow.setAttribute('aria-hidden', 'true');
        this.label = document.createElement('span');
        this.element.append(this.arrow, this.label);
        map.on('style.load', this.repaint);
        map.on('move', this.repaint);
        map.on('resize', this.repaint);
    }
    update(frame: InstrumentOverlayFrame) {
        this.frame = frame;
        this.paint();
    }
    private paint() {
        const f = this.frame;
        if (!f) return;
        if (f.position && f.current && f.current.freshness === 'live' && f.current.setTrueDeg !== null) {
            const c = f.current;
            this.arrow.style.transform = `rotate(${c.setTrueDeg! - this.map.getBearing()}deg)`;
            this.label.textContent = `Instrument current ${c.driftKts.toFixed(1)} kn · ${Math.round(c.setTrueDeg!) % 360}°T · ${Math.max(0, Math.floor((f.now - c.observedAt) / 1000))} s old${c.leewayDeg === null ? ' · leeway uncorrected' : ''}`;
            this.element.title = `Samples ${new Date(c.observedAt).toISOString()} · ${Math.max(0, Math.floor((f.now - c.observedAt) / 1000))} s old · ${c.leewayDeg === null ? 'Leeway uncorrected' : 'Explicit leeway applied'}`;
            if (!this.marker)
                this.marker = new mapboxgl.Marker({ element: this.element, anchor: 'center', offset: [0, 68] })
                    .setLngLat([f.position.lon, f.position.lat])
                    .addTo(this.map);
            else this.marker.setLngLat([f.position.lon, f.position.lat]);
            const point = this.map.project([f.position.lon, f.position.lat]),
                box = this.map.getContainer();
            const width = Math.min(176, Math.max(80, box.clientWidth - 16));
            this.element.style.maxWidth = `${width}px`;
            const x = Math.max(width / 2 + 8, Math.min(box.clientWidth - width / 2 - 8, point.x));
            const y = Math.max(48, Math.min(box.clientHeight - 48, point.y + 68));
            this.marker.setOffset([x - point.x, y - point.y]);
        } else {
            this.marker?.remove();
            this.marker = null;
        }
        if (!this.map.isStyleLoaded()) {
            if (!this.idlePending) {
                this.idlePending = true;
                this.map.once('idle', this.afterIdle);
            }
            return;
        }
        const features: GeoJSON.Feature<GeoJSON.LineString>[] =
            f.laylines?.lines.map((line) => ({
                type: 'Feature',
                properties: { tack: line.tack },
                geometry: { type: 'LineString', coordinates: line.points.map((p) => [p.lon, p.lat]) },
            })) ?? [];
        const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: 'FeatureCollection', features };
        if (features.length) {
            const signature = JSON.stringify(data);
            if (!this.map.getSource(SOURCE)) this.map.addSource(SOURCE, { type: 'geojson', data });
            else if (signature !== this.dataSignature)
                (this.map.getSource(SOURCE) as mapboxgl.GeoJSONSource).setData(data);
            this.dataSignature = signature;
            if (!this.map.getLayer(LAYER))
                this.map.addLayer({
                    id: LAYER,
                    type: 'line',
                    source: SOURCE,
                    paint: {
                        'line-color': ['match', ['get', 'tack'], 'port', '#f0abfc', '#67e8f9'],
                        'line-width': 2,
                        'line-dasharray': [3, 3],
                        'line-opacity': 0.8,
                    },
                });
        } else this.clearLines();
    }
    private clearLines() {
        this.dataSignature = null;
        if (this.map.getLayer(LAYER)) this.map.removeLayer(LAYER);
        if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
    }
    destroy() {
        this.map.off('style.load', this.repaint);
        this.map.off('move', this.repaint);
        this.map.off('resize', this.repaint);
        if (this.idlePending) this.map.off('idle', this.afterIdle);
        this.idlePending = false;
        this.marker?.remove();
        this.marker = null;
        this.clearLines();
        this.frame = null;
    }
}
export default function SailingInstrumentOverlay({ mapRef }: { mapRef: MutableRefObject<mapboxgl.Map | null> }) {
    const state = useNmeaStore(),
        derived = useInstrumentDerivations(state),
        prefs = useInstrumentPanelPreferences();
    const following = useFollowRouteStore((s) => s.isFollowing),
        route = useFollowRouteStore((s) => s.routeCoords),
        plan = useFollowRouteStore((s) => s.voyagePlan);
    const renderer = useRef<InstrumentOverlayRenderer | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        renderer.current = new InstrumentOverlayRenderer(map);
        return () => {
            renderer.current?.destroy();
            renderer.current = null;
        };
    }, [mapRef]);
    const e = derived.evidence,
        p = e?.position;
    const position =
        p &&
        (e?.via === 'gateway' || e?.via === 'lan') &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lat) <= 85 &&
        Math.abs(p.lon) <= 180 &&
        p.at > 0 &&
        p.at <= derived.now + 1000 &&
        derived.now - p.at <= 6500
            ? p
            : null;
    const current =
        position &&
        derived.current.kind === 'available' &&
        derived.current.freshness === 'live' &&
        Math.abs(position.at - derived.current.observedAt) <= 6000
            ? derived.current
            : null;
    const positionLat = position?.lat,
        positionLon = position?.lon;
    const mark = useMemo(
        () =>
            positionLat !== undefined && positionLon !== undefined && following && prefs.laylines
                ? nextFollowedMark(route, plan, { lat: positionLat, lon: positionLon })
                : null,
        [positionLat, positionLon, following, prefs.laylines, route, plan],
    );
    const laylines =
        position && mark && derived.performance.kind === 'available' && (e?.via === 'gateway' || e?.via === 'lan')
            ? instrumentLaylines({
                  boat: position,
                  mark: mark.point,
                  performance: derived.performance,
                  current,
                  now: derived.now,
              })
            : null;
    useEffect(
        () => renderer.current?.update({ position, current, laylines, markName: mark?.name ?? null, now: derived.now }),
        [position, current, laylines, mark?.name, derived.now],
    );
    return laylines ? (
        <div
            className="pointer-events-none absolute bottom-32 left-12 z-540 max-w-52 rounded-lg bg-slate-950/90 p-2 text-[10px] text-cyan-100"
            role="status"
        >
            Local {laylines.mode} guides · {mark?.name}
            <br />
            {laylines.correction === 'local-instrument-current'
                ? 'Instrument current corrected'
                : 'Current uncorrected'}{' '}
            · {new Date(laylines.observedAt).toISOString().slice(11, 19)} UTC
            <br />
            {laylines.note}
        </div>
    ) : null;
}
