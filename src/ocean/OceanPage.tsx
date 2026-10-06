/**
 * Thalassa Ocean — ocean.thalassawx.app (Shane 2026-10-05: "a public page for
 * all boats … best in class"). What the fleet saw, three hours late and
 * blurred, over historical public records, on our Relief sea.
 *
 * Honest by construction: there are no sample numbers on this page. With no
 * fleet sightings it says so ("The first sightings arrive as boats log
 * them"), and the layers that need more boats say why they are waiting.
 * Threatened species are counted, never placed, until at least 3 boats have
 * logged them in an area (20261006120000_ocean_public_read.sql), and the
 * panel says how many sightings are counted that way.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
    fetchContext,
    fetchSummary,
    type ContextState,
    type FleetCell,
    type FleetRow,
    type FleetState,
    type Group,
} from './oceanApi';
import { monthBars, tallyCells, tallyContext } from './mapLayers';
import { REGIONS, START_REGION, inBox, type Region } from './regions';
import { STORIES } from './stories';
import { DEFAULT_GROUPS, GROUPS, groupMeta, speciesSlug } from './species';
import { MONTHS_FULL, MONTHS_SHORT, clock, fmt, precision, when, yearsLabel } from './format';
import { SpeciesSheet, speciesChoices } from './SpeciesSheet';
import { ReportCards } from './ReportCards';
import { OpenData } from './OpenData';
import { Respect } from './Respect';
import { Credits } from './Credits';

const OceanMap = lazy(() => import('./OceanMap'));

const MAPBOX_TOKEN = String(import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '');
const REFRESH_MS = 5 * 60_000;
const EMPTY_CELLS: FleetCell[] = [];
const EMPTY_ROWS: FleetRow[] = [];

export interface OceanBoot {
    summary: Promise<FleetState>;
    context: Promise<ContextState>;
    /** Which context file `context` is (regions.ts contextRegion). */
    contextId?: string;
}

type Layer = 'sightings' | 'rate' | 'effort' | 'seabed';

const LAYERS: Array<{ id: Layer; name: string; sub: string }> = [
    { id: 'sightings', name: 'Sightings', sub: 'Where animals were seen' },
    { id: 'rate', name: 'Per hour watched', sub: 'Needs a watch log and 3 boats' },
    { id: 'effort', name: 'Where we looked', sub: 'Needs a watch log and 3 boats' },
    { id: 'seabed', name: 'Seabed mapped', sub: 'Collected privately for now' },
];

export function layerExplanation(layer: Layer, boats: number | null): string {
    if (layer === 'seabed') return 'Collected privately for now; shared with Seabed 2030 later.';
    const why =
        'Needs watching time from at least 3 boats in an area, so no single boat’s track can be picked out. The app does not record watching time yet.';
    return boats === null
        ? `${why} Fewer than 3 boats are logging so far.`
        : `${why} The watch log that records it arrives in a later app update.`;
}

function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    );
    useEffect(() => {
        const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!mq) return;
        const on = () => setReduced(mq.matches);
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, []);
    return reduced;
}

/** /species/<slug> on ocean.thalassawx.app, /ocean/species/<slug> on the apex. */
function pathSpeciesSlug(): string | null {
    const m = window.location.pathname.match(/^(?:\/ocean)?\/species\/([a-z0-9-]+)\/?$/);
    return m ? m[1] : null;
}
const pathBase = () => (window.location.pathname.startsWith('/ocean') ? '/ocean' : '');

function StatusPill({ fleet }: { fleet: FleetState }) {
    let text = 'Loading';
    let tone = 'wait';
    if (fleet.status === 'ok' && fleet.summary.totals.sightings > 0) {
        text = `Live · ${fleet.summary.delayHours} h behind`;
        tone = 'live';
    } else if (fleet.status === 'ok' || fleet.status === 'not-ready') text = 'Waiting for the first sightings';
    else if (fleet.status === 'error') {
        text = 'Fleet data offline';
        tone = 'off';
    }
    return <span className={`oc-pill is-${tone}`}>{text}</span>;
}

function Stat({ n, label, words = false }: { n: string; label: string; words?: boolean }) {
    return (
        <div className="oc-stat">
            <div className={words ? 'oc-stat-n is-words' : 'oc-stat-n'}>{n}</div>
            <div className="oc-stat-l">{label}</div>
        </div>
    );
}

function Latest({
    rows,
    fleet,
    fleetEmpty,
    historyShown,
}: {
    rows: readonly FleetRow[];
    fleet: FleetState;
    fleetEmpty: boolean;
    historyShown: boolean;
}) {
    const [all, setAll] = useState(false);
    const shown = all ? rows : rows.slice(0, 8);
    return (
        <section className="oc-sheet" aria-labelledby="oc-latest-h">
            <div className="oc-sheet-head">
                <span className="oc-eyebrow">Latest</span>
                <h2 id="oc-latest-h">Latest public sightings</h2>
            </div>
            {rows.length === 0 ? (
                <p className="oc-empty">
                    {fleet.status === 'error'
                        ? historyShown
                            ? 'Fleet data is not reachable right now; historical records are still shown on the map.'
                            : 'Fleet data is not reachable right now.'
                        : fleetEmpty
                          ? 'The fleet’s first sightings will appear here, each at least 3 hours after it is logged.'
                          : 'Nothing to list yet: threatened species are counted, not listed, so they never get a place or a time here.'}
                </p>
            ) : (
                <>
                    <ul className="oc-latest">
                        {shown.map((r) => {
                            const g = groupMeta(r.group);
                            return (
                                <li key={r.id}>
                                    <i style={{ background: g.colour }} aria-hidden="true" />
                                    <span className="oc-latest-name">{r.name ?? g.one}</span>
                                    <span>
                                        {fmt(r.count)}
                                        {r.calf ? ', with calf' : ''}
                                    </span>
                                    <span>{when(r.time)}</span>
                                    <span>{precision(r.uncertaintyM, r.generalised)}</span>
                                    <span>
                                        {r.credit ? (
                                            <a href={`https://${r.credit}.thalassawx.app`} rel="noopener noreferrer">
                                                Logged aboard {r.credit}
                                            </a>
                                        ) : (
                                            'A Thalassa sailor'
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    {rows.length > 8 && (
                        <button type="button" className="oc-btn is-ghost" onClick={() => setAll(!all)}>
                            {all ? 'Show fewer' : `Show all ${rows.length}`}
                        </button>
                    )}
                    <p className="oc-share">
                        Times are in your own time zone, floored to 10 minutes. Positions are on a 1 km grid.
                    </p>
                </>
            )}
        </section>
    );
}

export default function OceanPage({ boot }: { boot: OceanBoot }) {
    const [fleet, setFleet] = useState<FleetState>({ status: 'loading' });
    const [refreshFailed, setRefreshFailed] = useState(false);
    const bootContextId = boot.contextId ?? START_REGION.contextRegion ?? 'au-east';
    const [contexts, setContexts] = useState<Record<string, ContextState>>({});
    const [ctxId, setCtxId] = useState(bootContextId);
    const [mapKey, setMapKey] = useState(0);
    const [groups, setGroups] = useState<Group[]>(() => [...DEFAULT_GROUPS]);
    const [month, setMonth] = useState(0);
    const [contextOn, setContextOn] = useState(true);
    const [region, setRegion] = useState<Region>(START_REGION);
    const [regionActive, setRegionActive] = useState(true);
    const [flyNonce, setFlyNonce] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [mapFailed, setMapFailed] = useState(!MAPBOX_TOKEN);
    const [layerNote, setLayerNote] = useState<string | null>(null);
    const [speciesSci, setSpeciesSci] = useState<string | null>(null);
    const reduced = useReducedMotion();

    useEffect(() => {
        let alive = true;
        boot.summary.then((s) => alive && setFleet(s));
        boot.context.then((c) => alive && setContexts((m) => ({ ...m, [bootContextId]: c })));
        // A failed refresh keeps the last good summary on screen (with its
        // time), instead of blanking the counters for five minutes.
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            fetchSummary().then((s) => {
                if (!alive) return;
                setRefreshFailed(s.status === 'error');
                setFleet((current) => (s.status === 'error' && current.status === 'ok' ? current : s));
            });
        };
        const timer = window.setInterval(refresh, REFRESH_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [boot, bootContextId]);

    // GLOBAL: each region names its context file; the World view keeps the last one.
    useEffect(() => {
        const id = region.contextRegion;
        if (!id) return;
        setCtxId(id);
        if (id === bootContextId || contexts[id]) return;
        setContexts((m) => ({ ...m, [id]: { status: 'loading' } }));
        fetchContext(id).then((c) => setContexts((m) => ({ ...m, [id]: c })));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- contexts is a cache, read once per region
    }, [region.contextRegion, bootContextId]);
    const ctx: ContextState = contexts[ctxId] ?? { status: 'loading' };

    const summary = fleet.status === 'ok' ? fleet.summary : null;
    const context = ctx.status === 'ok' ? ctx.context : null;
    const cells = summary?.cells ?? EMPTY_CELLS;
    const recent = summary?.recent ?? EMPTY_ROWS;
    const names = useMemo(() => {
        const m = new Map<string, string>();
        for (const s of context?.species ?? []) m.set(s.sci, s.name);
        for (const s of summary?.species ?? []) m.set(s.sci, s.name);
        return m;
    }, [summary, context]);

    // Counters follow the filters and the region shown, so Play the year moves them.
    const regionBox = region.id === 'world' ? null : region.bbox;
    const shown = useMemo(
        () =>
            tallyCells(
                cells,
                (c) =>
                    groups.includes(c.group) &&
                    (!month || c.month === month) &&
                    (!regionBox || inBox(c.lat, c.lon, regionBox)),
            ),
        [cells, groups, month, regionBox],
    );
    const history = useMemo(
        () => tallyContext(context, groups, month, regionBox ?? undefined),
        [context, groups, month, regionBox],
    );
    // Counted with no place: threatened species (and unnamed sightings)
    // before 3 boats have logged them in an area.
    const unplaced = useMemo(
        () =>
            summary && !summary.cellsTruncated
                ? Math.max(0, summary.totals.sightings - tallyCells(summary.cells).sightings)
                : 0,
        [summary],
    );
    const bars = useMemo(() => monthBars(cells, context, groups), [cells, context, groups]);
    const barMax = Math.max(1, ...bars.values);

    // Play the year.
    useEffect(() => {
        if (!playing) return;
        const timer = window.setInterval(() => setMonth((m) => (m % 12) + 1), reduced ? 2200 : 1300);
        return () => window.clearInterval(timer);
    }, [playing, reduced]);
    const play = () => {
        if (playing) {
            setPlaying(false);
            return;
        }
        setLayerNote(null);
        setMonth((m) => (m && m < 12 ? m + 1 : 1));
        setPlaying(true);
    };
    const chooseMonth = (m: number) => {
        setPlaying(false);
        setMonth(m);
    };
    const toggleGroup = (g: Group) =>
        setGroups((current) => (current.includes(g) ? current.filter((x) => x !== g) : [...current, g]));
    const flyTo = (r: Region) => {
        setRegion(r);
        setRegionActive(true);
        setFlyNonce((n) => n + 1);
    };
    const onUserMove = useCallback(() => setRegionActive(false), []);
    const onMapFailed = useCallback(() => setMapFailed(true), []);
    const retryMap = () => {
        setMapFailed(false);
        setMapKey((k) => k + 1);
    };

    // Species page, with a deep link.
    const choices = useMemo(() => speciesChoices(summary?.species ?? [], context?.species ?? []), [summary, context]);
    useEffect(() => {
        if (speciesSci || choices.length === 0) return;
        const slug = pathSpeciesSlug();
        const fromPath = slug ? choices.find((c) => speciesSlug(c.sci) === slug) : null;
        const fallback = choices.find((c) => c.sci === STORIES['humpback-au-east'].species) ?? choices[0];
        setSpeciesSci((fromPath ?? fallback).sci);
    }, [choices, speciesSci]);
    const selected = choices.find((c) => c.sci === speciesSci) ?? null;
    const pickSpecies = (sci: string) => {
        setSpeciesSci(sci);
        const choice = choices.find((c) => c.sci === sci);
        try {
            window.history.replaceState(null, '', `${pathBase()}/species/${speciesSlug(sci)}`);
            if (choice) document.title = `${choice.name} — Thalassa Ocean`;
        } catch {
            /* a sandboxed frame may refuse history writes */
        }
    };

    const story = region.story ? STORIES[region.story] : null;
    const whalesOn = groups.includes('whale');
    const fleetEmpty = !summary || summary.totals.sightings === 0;
    const caption = month
        ? story && whalesOn
            ? story.months[month - 1]
            : `${MONTHS_FULL[month - 1]}, every year`
        : story && whalesOn
          ? 'Press Play the year to watch the humpback migration.'
          : 'All months, all years.';
    const showing = [fleetEmpty ? null : 'Thalassa fleet sightings', contextOn ? 'historical public records' : null]
        .filter(Boolean)
        .join(' + ');
    const historyShown = ctx.status === 'ok' && contextOn && !mapFailed;

    return (
        <div className="oc-wrap">
            <a className="oc-skip" href="#main">
                Skip to the content
            </a>
            <header className="oc-top">
                <a className="oc-brand" href="/" aria-label="Thalassa Ocean, home">
                    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
                        <g fill="none" stroke="currentColor" strokeWidth="1.4">
                            <circle cx="16" cy="16" r="12.5" opacity=".5" />
                            <path
                                d="M16 2.5 L18.6 13.4 L29.5 16 L18.6 18.6 L16 29.5 L13.4 18.6 L2.5 16 L13.4 13.4 Z"
                                fill="currentColor"
                                fillOpacity=".18"
                            />
                        </g>
                    </svg>
                    <span className="oc-wordmark">
                        Thalassa <span>Ocean</span>
                    </span>
                </a>
                <span className="oc-url">ocean.thalassawx.app</span>
                <StatusPill fleet={fleet} />
            </header>

            <main id="main">
                <section className="oc-hero-head" aria-labelledby="oc-h1">
                    <div className="oc-eyebrow">What the fleet saw · {region.name}</div>
                    <h1 id="oc-h1">Every boat is a research vessel.</h1>
                    <p className="oc-lede">
                        Thalassa sailors log the whales, dolphins, dugongs, turtles and seabirds they meet. Each
                        sighting carries the boat’s position, the time and the sea it was seen in. Because Thalassa can
                        record where each boat looked, the map will show sightings for every hour spent watching as the
                        fleet grows, not only where people happened to be.
                    </p>
                </section>

                <section className="oc-hero" aria-label="Sightings map">
                    <div className="oc-mapcol">
                        <div
                            className="oc-map-wrap"
                            role="region"
                            aria-label={`Map of ${region.name}: ${showing || 'no layers shown'}. The counts and lists below describe what it shows.`}
                        >
                            {mapFailed ? (
                                <div className="oc-map-fallback">
                                    <b>The map can’t load here.</b>
                                    <span>
                                        Everything below still works: the counts, the species pages and the lists.
                                    </span>
                                    {MAPBOX_TOKEN && (
                                        <button type="button" className="oc-btn" onClick={retryMap}>
                                            Try again
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <Suspense fallback={<div className="oc-map-loading">Loading the chart…</div>}>
                                    <OceanMap
                                        key={mapKey}
                                        token={MAPBOX_TOKEN}
                                        cells={cells}
                                        rowsEnabled={!fleetEmpty}
                                        names={names}
                                        context={context}
                                        groups={groups}
                                        month={month}
                                        contextOn={contextOn}
                                        region={region}
                                        flyNonce={flyNonce}
                                        reducedMotion={reduced}
                                        onFailed={onMapFailed}
                                        onUserMove={onUserMove}
                                    />
                                </Suspense>
                            )}
                            <div className="oc-regions" role="group" aria-label="Jump to an area">
                                {REGIONS.map((r) => (
                                    <button
                                        key={r.id}
                                        type="button"
                                        className="oc-chip"
                                        aria-pressed={regionActive && region.id === r.id}
                                        aria-label={r.name}
                                        onClick={() => flyTo(r)}
                                    >
                                        {r.short}
                                    </button>
                                ))}
                            </div>
                            {/* Announced on a chosen month, not every 1.3 s while the year plays. */}
                            <div className="oc-readout" aria-live={playing ? 'off' : 'polite'}>
                                <div className="oc-mon">{month ? MONTHS_FULL[month - 1] : 'All year'}</div>
                                <div className="oc-cap">{caption}</div>
                                <div className="oc-cap is-layer">
                                    {showing ? `Showing ${showing}` : 'All layers off'}
                                </div>
                            </div>
                        </div>
                        <div className="oc-legend" aria-hidden="true">
                            <span>
                                <i className="oc-key is-fleet" /> Thalassa fleet sighting
                            </span>
                            <span>
                                <i className="oc-key is-blur" /> Threatened: 10 km area count, 3+ boats
                            </span>
                            <span>
                                <i className="oc-key is-ctx" /> Historical public records (OBIS)
                            </span>
                            <span>Not for navigation</span>
                        </div>
                    </div>

                    <aside className="oc-panel" aria-label="Map controls">
                        <div className="oc-group">
                            <h2>The fleet</h2>
                            {fleet.status === 'loading' ? (
                                <p className="oc-empty">Loading…</p>
                            ) : fleet.status === 'error' ? (
                                <p className="oc-empty">
                                    {historyShown
                                        ? 'Fleet data is not reachable right now; historical records are still shown.'
                                        : 'Fleet data is not reachable right now.'}
                                </p>
                            ) : fleetEmpty ? (
                                <p className="oc-empty is-strong">The first sightings arrive as boats log them.</p>
                            ) : (
                                <div className="oc-stats">
                                    <Stat n={fmt(shown.sightings)} label="sightings" />
                                    <Stat n={fmt(shown.animals)} label="animals counted" />
                                    <Stat n={fmt(shown.species)} label="species" />
                                    <Stat
                                        n={summary?.totals.boats ? fmt(summary.totals.boats) : 'fewer than 3'}
                                        words={!summary?.totals.boats}
                                        label="boats logging"
                                    />
                                </div>
                            )}
                            {!fleetEmpty && summary && (
                                <>
                                    <p className="oc-small">
                                        Counts for {region.id === 'world' ? 'the whole world' : region.name}, for the
                                        animals and month chosen below.
                                    </p>
                                    {unplaced > 0 && (
                                        <p className="oc-small">
                                            Plus {fmt(unplaced)} sighting{unplaced === 1 ? '' : 's'} of threatened
                                            species, or not yet named, counted with no place until at least 3 boats have
                                            logged them in an area.
                                        </p>
                                    )}
                                    {summary.cellsTruncated && (
                                        <p className="oc-small">
                                            The busiest 20,000 areas are mapped; {fmt(summary.totals.sightings)}{' '}
                                            sightings in all.
                                        </p>
                                    )}
                                </>
                            )}
                            {summary && (
                                <p className="oc-small">
                                    {refreshFailed ? 'Last updated ' : 'Updated '}
                                    {clock(summary.generatedAt)}
                                </p>
                            )}
                        </div>
                        <div className="oc-group">
                            <h2>Historical public records</h2>
                            {ctx.status === 'ok' ? (
                                <div className="oc-stats">
                                    <Stat n={fmt(history.recordDays)} label="record-days" />
                                    <Stat
                                        n={fmt(history.species)}
                                        label={history.years ? `species, ${yearsLabel(history.years)}` : 'species'}
                                    />
                                </div>
                            ) : (
                                <p className="oc-empty">
                                    {ctx.status === 'error' ? 'Historical records could not load.' : 'Loading…'}
                                </p>
                            )}
                            <label className="oc-switch">
                                <input
                                    type="checkbox"
                                    checked={contextOn}
                                    onChange={(e) => setContextOn(e.target.checked)}
                                />
                                <span>
                                    Show historical records
                                    <small>OBIS, CC0 and CC BY datasets only</small>
                                </span>
                            </label>
                        </div>

                        <div className="oc-group">
                            <h2>Show</h2>
                            <div className="oc-seg" role="group" aria-label="Map layer">
                                {LAYERS.map((l) => {
                                    const active = l.id === 'sightings';
                                    return (
                                        <button
                                            key={l.id}
                                            type="button"
                                            aria-pressed={active}
                                            aria-disabled={!active}
                                            className={active ? undefined : 'is-waiting'}
                                            onClick={() =>
                                                setLayerNote(
                                                    active
                                                        ? null
                                                        : layerExplanation(l.id, summary?.totals.boats ?? null),
                                                )
                                            }
                                        >
                                            {l.name}
                                            <small>{l.sub}</small>
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="oc-note" aria-live="polite">
                                {layerNote}
                            </p>
                        </div>

                        <div className="oc-group">
                            <h2>Animals</h2>
                            <div className="oc-spp" role="group" aria-label="Animals shown">
                                {GROUPS.map((g) => {
                                    const n = summary?.groups[g.id]?.[0];
                                    return (
                                        <button
                                            key={g.id}
                                            type="button"
                                            className="oc-sp"
                                            aria-pressed={groups.includes(g.id)}
                                            style={{ '--c': g.colour } as CSSProperties}
                                            onClick={() => toggleGroup(g.id)}
                                        >
                                            <i aria-hidden="true" />
                                            {g.label}
                                            {n ? <em>{fmt(n)}</em> : null}
                                            {g.blurred && <em>area counts</em>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="oc-group">
                            <h2>Month</h2>
                            <div className="oc-months" role="group" aria-label="Month">
                                {MONTHS_SHORT.map((m, i) => (
                                    <button
                                        key={m}
                                        type="button"
                                        aria-label={MONTHS_FULL[i]}
                                        aria-pressed={month === i + 1}
                                        onClick={() => chooseMonth(i + 1)}
                                    >
                                        <span
                                            className="oc-bar"
                                            style={{ height: `${Math.round((bars.values[i] / barMax) * 100)}%` }}
                                        />
                                        <span className="oc-m">{m[0]}</span>
                                    </button>
                                ))}
                            </div>
                            <p className="oc-small">
                                {bars.source === 'fleet'
                                    ? 'Bars: fleet sightings by month.'
                                    : bars.source === 'context'
                                      ? 'Bars: historical record-days by month (no fleet sightings yet).'
                                      : 'No dated records for these animals.'}
                            </p>
                            <div className="oc-playrow">
                                <button type="button" className="oc-btn" onClick={play} aria-pressed={playing}>
                                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                                        <path
                                            d={playing ? 'M3 1.5h3v11H3zM8 1.5h3v11H8z' : 'M3 1.5v11l9-5.5z'}
                                            fill="currentColor"
                                        />
                                    </svg>
                                    {playing ? 'Pause' : 'Play the year'}
                                </button>
                                <button
                                    type="button"
                                    className="oc-btn is-ghost"
                                    aria-pressed={!month}
                                    onClick={() => chooseMonth(0)}
                                >
                                    All year
                                </button>
                            </div>
                        </div>
                        <p className="oc-honest">
                            Positions appear at least 3 hours after a sighting, on a 1 km grid. Threatened species, and
                            sightings not yet named, are only counted in 10 km squares once at least 3 boats have logged
                            them there, after the month ends. Fish (the app’s fish group) never appear; sharks and rays
                            do.
                        </p>
                    </aside>
                </section>

                <Latest rows={recent} fleet={fleet} fleetEmpty={fleetEmpty} historyShown={historyShown} />
                <SpeciesSheet choices={choices} selected={selected} onSelect={pickSpecies} fleetEmpty={fleetEmpty} />
                <ReportCards region={region} cells={cells} context={context} names={names} fleetEmpty={fleetEmpty} />
                <OpenData fleet={fleet} />
                <Respect />
            </main>
            <Credits context={context} />
        </div>
    );
}

export const bootOcean = (): OceanBoot => {
    const contextId = START_REGION.contextRegion ?? 'au-east';
    return { summary: fetchSummary(), context: fetchContext(contextId), contextId };
};
