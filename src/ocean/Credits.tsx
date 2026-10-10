/**
 * Credits. Attribution is a licence condition (CC BY 4.0 for GEBCO-derived
 * relief, GA's GBR 30 m grid and most OBIS datasets), so every dataset the
 * historical layer uses is listed with its own citation, a link to its
 * licence and a note of how we changed it (CC BY 4.0 section 3(a)(1)).
 * Region-specific caveats come from the context file, not this component.
 */
import { LICENCE_DEEDS, type ContextFile } from './oceanApi';
import { fmt } from './format';

function Licence({ name, url }: { name: string; url?: string }) {
    const href = url || LICENCE_DEEDS[name];
    return href ? (
        <a href={href} rel="noopener noreferrer license">
            {name}
        </a>
    ) : (
        <>{name}</>
    );
}

export function Credits({ context }: { context: ContextFile | null }) {
    return (
        <footer className="oc-credits">
            <h2 className="oc-credits-h">Credits</h2>
            <p>
                Seafloor relief derived from{' '}
                <a href="https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa" rel="noopener noreferrer">
                    GEBCO Compilation Group (2026) GEBCO 2026 Grid
                </a>
                ; and based on{' '}
                <a href="https://pid.geoscience.gov.au/dataset/ga/115066" rel="noopener noreferrer">
                    AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C)
                </a>
                , version 10 Nov 2020, by Geoscience Australia which is © Commonwealth of Australia and is provided
                under a <Licence name="CC BY 4.0" url="https://creativecommons.org/licenses/by/4.0/" /> (Creative
                Commons Attribution 4.0 International) licence and is subject to the disclaimer of warranties in section
                5 of that licence. Both recoloured and shaded into map tiles by Thalassa. Coastline © OpenStreetMap
                contributors. Base map ©{' '}
                <a href="https://www.mapbox.com/about/maps/" rel="noopener noreferrer">
                    Mapbox
                </a>{' '}
                ©{' '}
                <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">
                    OpenStreetMap
                </a>
                . <strong>Not for navigation.</strong>
            </p>
            {context ? (
                <>
                    <p>
                        Historical public records: {context.citation}. Only datasets licensed <Licence name="CC0 1.0" />{' '}
                        or <Licence name="CC BY 4.0" /> are used; machine-recorded detections (acoustic receivers,
                        satellite tags), tracking and eDNA datasets, absence records, undated records and the Queensland
                        and Northern Territory turtle nesting census are left out. Shown as record-days (one dataset,
                        one day, one cell). Taxon names and IDs from WoRMS, via OBIS. Built {context.built}.
                    </p>
                    {context.modification && <p>Changes from the originals: {context.modification}</p>}
                    {context.notes.map((note) => (
                        <p key={note}>{note}</p>
                    ))}
                    {context.dropped.length > 0 && (
                        <p>
                            Not shown, too few licence-clean records (at least {context.minRecords} needed):{' '}
                            {context.dropped.map((d) => `${d.name} (${d.reason})`).join('; ')}.
                        </p>
                    )}
                    <details className="oc-datasets">
                        <summary>All {context.datasets.length} datasets, with their citations</summary>
                        <ol>
                            {context.datasets.map((d) => (
                                <li key={d.id}>
                                    <a href={d.url} rel="noopener noreferrer">
                                        {d.title}
                                    </a>
                                    {d.institutes.length > 0 && <> · {d.institutes.join(', ')}</>} ·{' '}
                                    <Licence name={d.licence} url={d.licenceUrl} /> · {fmt(d.records)} record
                                    {d.records === 1 ? '' : 's'} used, aggregated
                                    <span className="oc-cite">{d.citation}</span>
                                </li>
                            ))}
                        </ol>
                    </details>
                </>
            ) : (
                <p>Historical public records from OBIS, the Ocean Biodiversity Information System (loading).</p>
            )}
            <p>Type: Archivo and IBM Plex, via Google Fonts (SIL Open Font License).</p>
            <p>Thalassa Ocean · ocean.thalassawx.app · Fleet sightings are shown at least 3 hours late, on a grid.</p>
        </footer>
    );
}
