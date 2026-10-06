/**
 * Area report cards. Card 1: the chosen region, this month and this year from
 * the fleet's 0.1° month cells (UTC months), plus what the historical public
 * records hold there (until the fleet has logged anything, its three rows
 * fold into one line). Card 2 invites a boat aboard, with no numbers: there
 * is no "your boat" on a public page.
 */
import type { ContextFile, FleetCell } from './oceanApi';
import type { Region } from './regions';
import { regionReport } from './mapLayers';
import { MONTHS_FULL, fmt, yearsLabel } from './format';

const tally = (n: number, animals: number) =>
    n > 0 ? `${fmt(n)} sighting${n === 1 ? '' : 's'} · ${fmt(animals)} animal${animals === 1 ? '' : 's'}` : 'None yet';

export function ReportCards({
    region,
    cells,
    context,
    names,
    fleetEmpty = false,
    now = new Date(),
}: {
    region: Region;
    cells: readonly FleetCell[];
    context: ContextFile | null;
    names: ReadonlyMap<string, string>;
    fleetEmpty?: boolean;
    now?: Date;
}) {
    const report = regionReport(cells, context, region.bbox, now);
    const monthName = `${MONTHS_FULL[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    return (
        <section className="oc-two" aria-label="Report cards">
            <article className="oc-card">
                <div className="oc-kicker">Area report · {monthName}</div>
                <h2 className="oc-card-title">{region.name}</h2>
                <dl className="oc-rows">
                    {fleetEmpty ? (
                        <div className="oc-row">
                            <dt>The fleet</dt>
                            <dd>The fleet’s first sightings will appear here</dd>
                        </div>
                    ) : (
                        <>
                            <div className="oc-row">
                                <dt>Fleet this month</dt>
                                <dd>{tally(report.month.sightings, report.month.animals)}</dd>
                            </div>
                            <div className="oc-row">
                                <dt>Fleet this year</dt>
                                <dd>{tally(report.year.sightings, report.year.animals)}</dd>
                            </div>
                            <div className="oc-row">
                                <dt>New this month</dt>
                                <dd>
                                    {report.newThisMonth.length
                                        ? report.newThisMonth.map((sci) => names.get(sci) ?? sci).join(', ')
                                        : 'Nothing new yet'}
                                </dd>
                            </div>
                        </>
                    )}
                    <div className="oc-row">
                        <dt>Most recorded here, historically</dt>
                        <dd>
                            {report.historical.length
                                ? report.historical.map((h) => h.name).join(', ')
                                : 'No historical records here'}
                        </dd>
                    </div>
                    {report.historicalYears && (
                        <div className="oc-row">
                            <dt>Historical records span</dt>
                            <dd>{yearsLabel(report.historicalYears)}</dd>
                        </div>
                    )}
                </dl>
                <p className="oc-share">
                    Fleet numbers count public sightings with a place, at least 3 hours old (threatened species only
                    where 3 boats logged them). “New” means not seen here in the 3 months before.
                </p>
            </article>
            <article className="oc-card">
                <div className="oc-kicker">Every boat is a research vessel</div>
                <h2 className="oc-card-title">Get your boat on the map</h2>
                <dl className="oc-rows">
                    <div className="oc-row">
                        <dt>Logging</dt>
                        <dd>One tap under way</dd>
                    </div>
                    <div className="oc-row">
                        <dt>No signal?</dt>
                        <dd>Works offline, sends later</dd>
                    </div>
                    <div className="oc-row">
                        <dt>Who sees it</dt>
                        <dd>Public only if the skipper chooses</dd>
                    </div>
                    <div className="oc-row">
                        <dt>Position and time</dt>
                        <dd>From the boat’s GPS when it has one, else the phone’s</dd>
                    </div>
                </dl>
                <a className="oc-btn" href="https://www.thalassawx.app/beta">
                    Join the Thalassa beta
                </a>
            </article>
        </section>
    );
}
