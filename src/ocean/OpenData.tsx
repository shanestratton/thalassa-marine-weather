/**
 * Open data, honestly: what exists today (Darwin Core-shaped records, the live
 * feed behind this page) and what is still to come (downloads, effort, DOI
 * snapshots, embeds, seabed).
 */
import type { FleetState } from './oceanApi';
import { SUMMARY_URL } from './oceanApi';

function excerpt(fleet: FleetState): string {
    if (fleet.status === 'ok') {
        const t = fleet.summary.totals;
        return JSON.stringify(
            {
                v: 1,
                status: 'ok',
                delay_hours: fleet.summary.delayHours,
                totals: {
                    sightings: t.sightings,
                    animals: t.animals,
                    species: t.species,
                    boats: t.boats,
                    boats_min_shown: t.boatsMinShown,
                },
                cells: `[${fleet.summary.cells.length} cells]`,
                recent: `[${fleet.summary.recent.length} sightings]`,
            },
            null,
            2,
        );
    }
    if (fleet.status === 'not-ready') return JSON.stringify({ v: 1, status: 'not-ready' }, null, 2);
    if (fleet.status === 'error') return '// The feed is not reachable right now.';
    return '// Loading…';
}

export function OpenData({ fleet }: { fleet: FleetState }) {
    return (
        <section className="oc-sheet" aria-labelledby="oc-open-h">
            <div className="oc-sheet-head">
                <span className="oc-eyebrow">Open data</span>
                <h2 id="oc-open-h">Built for science, open to everyone</h2>
            </div>
            <div className="oc-two">
                <ul className="oc-features">
                    <li>
                        <span className="oc-dot" aria-hidden="true" />
                        <span>
                            <b>Darwin Core records.</b> Every sighting is stored in the shape of Darwin Core, the
                            international standard for species records. Sharing public records with the Atlas of Living
                            Australia, GBIF and OBIS is planned.
                        </span>
                    </li>
                    <li>
                        <span className="oc-dot oc-dot-whale" aria-hidden="true" />
                        <span>
                            <b>Effort is coming: it needs a watch log in the app and at least 3 boats in an area.</b>{' '}
                            Hours watched by area and month, so “no whales” can be told from “nobody looked”.
                        </span>
                    </li>
                    <li>
                        <span className="oc-dot oc-dot-turtle" aria-hidden="true" />
                        <span>
                            <b>Downloads and citable snapshots, coming.</b> CSV, GeoJSON and Darwin Core downloads, and
                            a frozen yearly copy with a DOI. The licence for fleet records will be agreed with the
                            skippers before downloads open.
                        </span>
                    </li>
                    <li>
                        <span className="oc-dot oc-dot-amber" aria-hidden="true" />
                        <span>
                            <b>Seabed soundings.</b> Opt-in depth and position from boats’ sounders, in the IHO
                            crowdsourced bathymetry format. Kept private for now; shared with Seabed 2030 later.
                        </span>
                    </li>
                    <li>
                        <span className="oc-dot oc-dot-dugong" aria-hidden="true" />
                        <span>
                            <b>Embeds, coming.</b> A live panel marinas, councils, schools and whale-watch operators can
                            put on their own sites.
                        </span>
                    </li>
                </ul>
                <div className="oc-feed">
                    <p>
                        <b>The feed behind this page</b> (not a stable API yet; fields may change; refreshed every 5
                        minutes):{' '}
                        <a href={SUMMARY_URL}>
                            <code>{SUMMARY_URL}</code>
                        </a>
                    </p>
                    <pre className="oc-code" aria-label="The live feed, summarised">
                        {excerpt(fleet)}
                    </pre>
                </div>
            </div>
        </section>
    );
}
