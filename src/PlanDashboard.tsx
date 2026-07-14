/**
 * PlanDashboard — the standalone public Passage Plan page
 * (<handle>.thalassawx.app/plan). A float plan for shore crew: where
 * the boat intends to go, when it departs, the planned route on a
 * chart. Deliberately NOT part of the app shell — no tabs, no nav,
 * nothing else reachable (Shane 2026-07-15: "it is a standalone page,
 * not part of the app").
 */
import React, { useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer, Marker } from 'react-map-gl/mapbox';
import type { FeatureCollection } from 'geojson';
import 'mapbox-gl/dist/mapbox-gl.css';

import { MAPBOX_TOKEN } from './voyageLogApi';
import { fetchFloatPlan, parsePlanParams, FloatPlanError, type FloatPlanData } from './planApi';

const fmtWhen = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
};

/** On a boat subdomain, the diary log lives at the BARE origin
 *  (serene-summer.thalassawx.app) — offer the door back to it. */
const logHomeHref = (): string | null => {
    const host = window.location.hostname;
    const parts = host.split('.');
    if (parts.length >= 3 && parts[0] !== 'www' && host !== 'thalassawx.app')
        return `${window.location.protocol}//${host}/`;
    return null;
};

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
        <header className="border-b border-white/10 bg-slate-900/80 px-4 py-3 backdrop-blur">
            <div className="mx-auto flex w-full max-w-4xl items-center gap-2">
                <span className="text-lg">⛵</span>
                <span className="text-sm font-black uppercase tracking-widest text-sky-300">Passage Plan</span>
                {logHomeHref() ? (
                    <a
                        href={logHomeHref() as string}
                        className="ml-auto rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-300 transition-colors hover:border-white/30 hover:text-white"
                        title="This vessel's public voyage log"
                    >
                        📖 Voyage log
                    </a>
                ) : (
                    <span className="ml-auto text-[11px] text-slate-500">thalassawx.app</span>
                )}
            </div>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-5">{children}</main>
        <footer className="border-t border-white/10 px-4 py-3 text-center text-[11px] text-slate-500">
            Float plan shared via Thalassa — not for navigation. Positions and times are the skipper's stated
            intentions, not a live feed.
        </footer>
    </div>
);

export default function PlanDashboard(): React.ReactElement {
    const [data, setData] = useState<FloatPlanData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const { handle } = parsePlanParams();
        if (!handle) {
            setError('This link is incomplete — it needs a vessel handle (boat-name.thalassawx.app/plan).');
            return;
        }
        fetchFloatPlan(handle)
            .then(setData)
            .catch((e) => setError(e instanceof FloatPlanError ? e.message : 'Could not load the plan.'));
    }, []);

    const plan = data?.plan ?? null;

    const routeGeoJSON = useMemo<FeatureCollection | null>(() => {
        if (!plan) return null;
        const coords: [number, number][] =
            plan.route && plan.route.length >= 2
                ? plan.route
                : plan.waypoints.map((w) => [w.lon, w.lat] as [number, number]);
        if (coords.length < 2) return null;
        return {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
        };
    }, [plan]);

    const bounds = useMemo(() => {
        if (!plan || plan.waypoints.length === 0) return null;
        const lats = plan.waypoints.map((w) => w.lat);
        const lons = plan.waypoints.map((w) => w.lon);
        return {
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats),
            minLon: Math.min(...lons),
            maxLon: Math.max(...lons),
        };
    }, [plan]);

    if (error) {
        return (
            <Shell>
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-200">
                    {error}
                </div>
            </Shell>
        );
    }
    if (!data) {
        return (
            <Shell>
                <div className="animate-pulse text-sm text-slate-400">Fetching the plan…</div>
            </Shell>
        );
    }
    if (!plan) {
        return (
            <Shell>
                <h1 className="mb-2 text-2xl font-black">{data.vessel.name}</h1>
                <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-sm text-slate-300">
                    No passage plan is published right now. When the skipper saves their next plan in Thalassa, it will
                    appear here.
                </div>
            </Shell>
        );
    }

    const first = plan.waypoints[0] ?? null;
    const last = plan.waypoints[plan.waypoints.length - 1] ?? null;

    return (
        <Shell>
            <h1 className="text-2xl font-black">{data.vessel.name}</h1>
            <p className="mb-4 mt-1 text-sm text-sky-300">
                {plan.name ?? 'Planned passage'}
                {data.vessel.model ? <span className="text-slate-500"> · {data.vessel.model}</span> : null}
            </p>

            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                    ['Departs', fmtWhen(plan.departure_at)],
                    ['ETA', fmtWhen(plan.eta_at)],
                    ['Distance', `${plan.planned_nm.toFixed(0)} NM`],
                    ['Waypoints', String(plan.waypoints.length)],
                ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
                        <div className="mt-0.5 text-sm font-bold text-slate-100">{value}</div>
                    </div>
                ))}
            </div>

            {MAPBOX_TOKEN && bounds && routeGeoJSON && (
                <div className="mb-4 h-[420px] overflow-hidden rounded-2xl border border-white/10">
                    <Map
                        mapboxAccessToken={MAPBOX_TOKEN}
                        initialViewState={{
                            bounds: [
                                [bounds.minLon, bounds.minLat],
                                [bounds.maxLon, bounds.maxLat],
                            ],
                            fitBoundsOptions: { padding: 48 },
                        }}
                        mapStyle="mapbox://styles/mapbox/satellite-streets-v12"
                        attributionControl={false}
                    >
                        <Source id="plan-route" type="geojson" data={routeGeoJSON}>
                            <Layer
                                id="plan-route-glow"
                                type="line"
                                paint={{
                                    'line-color': '#38bdf8',
                                    'line-width': 7,
                                    'line-blur': 6,
                                    'line-opacity': 0.5,
                                }}
                            />
                            <Layer
                                id="plan-route-line"
                                type="line"
                                paint={{ 'line-color': '#e0f2fe', 'line-width': 2.5 }}
                            />
                        </Source>
                        {first && (
                            <Marker longitude={first.lon} latitude={first.lat} anchor="center">
                                <div
                                    title={first.name ?? 'Start'}
                                    style={{
                                        width: 20,
                                        height: 20,
                                        borderRadius: 9999,
                                        border: '4px solid #34d399',
                                        background: 'rgba(15,23,42,0.85)',
                                        color: '#34d399',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        font: '800 9px sans-serif',
                                    }}
                                >
                                    1
                                </div>
                            </Marker>
                        )}
                        {last && plan.waypoints.length > 1 && (
                            <Marker longitude={last.lon} latitude={last.lat} anchor="center">
                                <div
                                    title={last.name ?? 'Finish'}
                                    style={{
                                        width: 20,
                                        height: 20,
                                        borderRadius: 9999,
                                        border: '4px solid #f87171',
                                        background: 'rgba(15,23,42,0.85)',
                                        color: '#f87171',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        font: '800 9px sans-serif',
                                    }}
                                >
                                    {plan.waypoints.length}
                                </div>
                            </Marker>
                        )}
                    </Map>
                </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-white/10">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-900/80 text-[10px] uppercase tracking-widest text-slate-500">
                        <tr>
                            <th className="px-3 py-2">#</th>
                            <th className="px-3 py-2">Waypoint</th>
                            <th className="px-3 py-2">Position</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 bg-slate-900/40">
                        {plan.waypoints.map((w, i) => (
                            <tr key={`${w.lat}-${w.lon}-${i}`}>
                                <td className="px-3 py-2 font-mono text-slate-500">{i + 1}</td>
                                <td className="px-3 py-2">
                                    {w.name ??
                                        (i === 0
                                            ? plan.origin
                                            : i === plan.waypoints.length - 1
                                              ? plan.destination
                                              : '—') ??
                                        '—'}
                                </td>
                                <td className="px-3 py-2 font-mono text-[12px] text-slate-400">
                                    {w.lat.toFixed(4)}, {w.lon.toFixed(4)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Shell>
    );
}
