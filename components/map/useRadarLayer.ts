import { useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { RadarStore } from '../../services/radar/radarStore';
import { retainPiRadar } from '../../services/radar/radarPiSession';
import { readAisTargetPicture, subscribeAisTargetPicture } from '../../services/ais/aisTargetCache';
import { gradeCollisionTargets, readCollisionInputs } from '../../services/AisGuardWatch';
import { radarDisplayRows, type RadarDisplayRow } from '../../services/radar/radarPresentation';
import { nearLongitude } from '../../services/ais/aisDeadReckon';
import { writeAisMapData } from './aisPictureLayers';
const SOURCE = 'radar-targets',
    LABEL = 'radar-target-label';
const EMPTY: ReadonlySet<number> = new Set();
/** One source for actual radar evidence, including proven AIS+radar presentation groups. */
export function useRadarLayer(map: mapboxgl.Map | null, enabled: boolean): ReadonlySet<number> {
    const [merged, setMerged] = useState<ReadonlySet<number>>(EMPTY);
    useEffect(() => {
        if (!map || !enabled) {
            setMerged(EMPTY);
            return;
        }
        let closed = false,
            popup: mapboxgl.Popup | null = null,
            rows: RadarDisplayRow[] = [];
        let selected: string | null = null,
            paintPopup: ((row: RadarDisplayRow) => void) | null = null;
        const release = retainPiRadar();
        const show = (key: string) => {
            // Resolve from current RAM on every tap. Retired feature props never expose old-owner data.
            draw();
            const row = rows.find((r) => r.contact.contactKey === key);
            if (!row?.contact.position) return;
            popup?.remove();
            selected = key;
            const el = document.createElement('div');
            el.style.cssText = 'max-width:280px;color:#0f172a;overflow-wrap:anywhere;padding:4px';
            const line = (bold = false) => {
                const p = document.createElement('div');
                p.style.cssText = `font-size:${bold ? 14 : 12}px;font-weight:${bold ? 700 : 400};margin-top:4px`;
                el.append(p);
                return p;
            };
            const title = line(true),
                age = line(),
                distance = line(),
                risk = line(),
                unknown = line();
            const button = document.createElement('button');
            button.type = 'button';
            button.style.cssText = 'min-height:44px;text-decoration:underline';
            button.onclick = () => {
                const current = rows.find((r) => r.contact.contactKey === selected);
                if (!current?.ais) return;
                popup?.remove();
                window.dispatchEvent(
                    new CustomEvent('thalassa:select-ais-target', {
                        detail: { mmsi: Number(current.ais.properties?.mmsi) },
                    }),
                );
            };
            el.append(button);
            paintPopup = (current) => {
                const c = current.contact,
                    a = current.assessment;
                title.textContent = `${current.ais ? 'AIS + radar' : 'Radar'} · ${current.name}`;
                age.textContent = `Radar target ${c.targetNumber} · ${c.talker} · ${Math.max(0, Math.round((Date.now() - c.at) / 1000))} s old${c.fresh ? '' : ' · stale'}`;
                distance.textContent =
                    current.rangeNm === null
                        ? 'Range unknown'
                        : `${current.rangeNm.toFixed(2)} NM · ${Math.round(current.bearingDeg!).toString().padStart(3, '0')}°T`;
                risk.textContent =
                    a && !a.rangeOnly && a.cpaNm !== null && a.tcpaMin !== null
                        ? `CPA ${a.cpaNm.toFixed(2)} NM · TCPA ${a.tcpaMin.toFixed(1)} min · ${a.risk}`
                        : 'CPA unknown · range only';
                unknown.hidden = !!c.motion;
                unknown.textContent =
                    c.motionReason === 'true-reference-unknown'
                        ? 'True course reported; ground stabilization unknown.'
                        : c.motionReason === 'dependencies-stale'
                          ? 'Original navigation or target evidence is stale.'
                          : 'Ground motion not qualified.';
                button.hidden = !current.ais;
                button.textContent = current.ais ? `AIS details · MMSI ${Number(current.ais.properties?.mmsi)}` : '';
            };
            paintPopup(row);
            const c = row.contact;
            const instance = new mapboxgl.Popup({ maxWidth: '300px', offset: 12 })
                .setLngLat([nearLongitude(c.position!.lon, map.getCenter().lng), c.position!.lat])
                .setDOMContent(el)
                .addTo(map);
            popup = instance;
            instance.on('close', () => {
                if (popup !== instance) return;
                selected = null;
                paintPopup = null;
                popup = null;
            });
        };
        const draw = () => {
            if (closed) return;
            const now = Date.now(),
                features = readAisTargetPicture(),
                inputs = readCollisionInputs(now);
            const grades = inputs.own
                ? gradeCollisionTargets(
                      inputs.own,
                      inputs.motion,
                      features,
                      inputs.prefs,
                      inputs.ownMmsis,
                      now,
                      inputs.atAnchor,
                  )
                : [];
            rows = radarDisplayRows(
                RadarStore.getSnapshot(),
                features.filter((f) => !inputs.ownMmsis.has(Number(f.properties?.mmsi))),
                now,
                inputs.prefs,
                inputs.atAnchor,
                new Map(grades.map((c) => [c.mmsi, c.assessment])),
            );
            if (popup && selected) {
                const current = rows.find((r) => r.contact.contactKey === selected);
                if (current) paintPopup?.(current);
                else popup.remove();
            }
            if (!map.isStyleLoaded()) return;
            try {
                if (!map.getSource(SOURCE))
                    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                if (!map.getLayer(SOURCE))
                    map.addLayer({
                        id: SOURCE,
                        type: 'circle',
                        source: SOURCE,
                        paint: {
                            'circle-radius': 7,
                            'circle-color': '#0f172a',
                            'circle-opacity': 0.2,
                            'circle-stroke-width': 2,
                            'circle-stroke-color': [
                                'case',
                                ['==', ['get', 'risk'], 'DANGER'],
                                '#f43f5e',
                                ['==', ['get', 'risk'], 'CAUTION'],
                                '#f59e0b',
                                '#22d3ee',
                            ],
                            'circle-stroke-opacity': ['case', ['get', 'fresh'], 1, 0.4],
                        },
                    });
                if (map.getStyle?.().glyphs && !map.getLayer(LABEL))
                    map.addLayer({
                        id: LABEL,
                        type: 'symbol',
                        source: SOURCE,
                        minzoom: 9,
                        layout: {
                            'text-field': ['get', 'label'],
                            'text-size': 11,
                            'text-offset': [0, 1.3],
                            'text-anchor': 'top',
                            'text-max-width': 12,
                        },
                        paint: { 'text-color': '#f8fafc', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 },
                    });
                writeAisMapData(map, SOURCE, {
                    type: 'FeatureCollection',
                    features: rows.map((r) => ({
                        type: 'Feature',
                        id: r.contact.contactKey,
                        geometry: {
                            type: 'Point',
                            coordinates: [
                                nearLongitude(r.contact.position!.lon, map.getCenter().lng),
                                r.contact.position!.lat,
                            ],
                        },
                        properties: {
                            contactKey: r.contact.contactKey,
                            label: `${r.ais ? 'AIS + radar' : 'Radar'} ${r.name}`,
                            risk: r.assessment?.risk ?? 'NONE',
                            fresh: r.contact.fresh,
                        },
                    })),
                });
                const next = new Set(rows.flatMap((r) => (r.ais ? [Number(r.ais.properties?.mmsi)] : [])));
                setMerged((old) => (old.size === next.size && [...old].every((id) => next.has(id)) ? old : next));
            } catch {
                setMerged(EMPTY); /* AIS remains independently visible if the radar layer cannot be drawn. */
            }
        };
        const tap = (e: mapboxgl.MapLayerMouseEvent) => {
            const key = e.features?.[0]?.properties?.contactKey;
            if (typeof key === 'string') show(key);
        };
        const select = (e: Event) => {
            const key = (e as CustomEvent<{ contactKey?: string }>).detail?.contactKey;
            if (typeof key === 'string') show(key);
        };
        const enter = () => {
                map.getCanvas().style.cursor = 'pointer';
            },
            leave = () => {
                map.getCanvas().style.cursor = '';
            };
        const radar = RadarStore.subscribe(draw),
            ais = subscribeAisTargetPicture(draw);
        map.on('style.load', draw);
        map.on('idle', draw);
        map.on('moveend', draw);
        map.on('click', SOURCE, tap);
        map.on('mouseenter', SOURCE, enter);
        map.on('mouseleave', SOURCE, leave);
        window.addEventListener('thalassa:select-radar-target', select);
        draw();
        return () => {
            closed = true;
            radar();
            ais();
            release();
            popup?.remove();
            rows = [];
            setMerged(EMPTY);
            window.removeEventListener('thalassa:select-radar-target', select);
            map.off('style.load', draw);
            map.off('idle', draw);
            map.off('moveend', draw);
            map.off('click', SOURCE, tap);
            map.off('mouseenter', SOURCE, enter);
            map.off('mouseleave', SOURCE, leave);
            try {
                if (map.getLayer(LABEL)) map.removeLayer(LABEL);
                if (map.getLayer(SOURCE)) map.removeLayer(SOURCE);
                if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            } catch {
                /* Style already retired. */
            }
        };
    }, [map, enabled]);
    return merged;
}
