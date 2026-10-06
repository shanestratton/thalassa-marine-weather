/**
 * The species page: one animal at a time, showing only what the page holds.
 * Season clock from the fleet, falling back to historical public records
 * (labelled as such); time of day and water temperature from the fleet only,
 * and never for a threatened species (the hour could place the animal);
 * trend waits for effort data. Until the fleet has logged anything, the
 * fleet-only figures fold into one line. No conservation-status strings until
 * the catalogue's statuses are verified.
 */
import type { ContextSpecies, FleetSpecies } from './oceanApi';
import { BinBars, SeasonClock, monthsFrom } from './charts';
import { groupMeta } from './species';
import { fmt, yearsLabel } from './format';

export interface SpeciesChoice {
    sci: string;
    name: string;
    fleet: FleetSpecies | null;
    context: ContextSpecies | null;
}

/** Fleet species first (most logged first), then historical-only ones, by name. */
export function speciesChoices(fleet: readonly FleetSpecies[], context: readonly ContextSpecies[]): SpeciesChoice[] {
    const bySci = new Map<string, SpeciesChoice>();
    for (const f of fleet) bySci.set(f.sci, { sci: f.sci, name: f.name, fleet: f, context: null });
    for (const c of context) {
        const hit = bySci.get(c.sci);
        if (hit) hit.context = c;
        else bySci.set(c.sci, { sci: c.sci, name: c.name, fleet: null, context: c });
    }
    return [...bySci.values()].sort((a, b) => (b.fleet?.n ?? -1) - (a.fleet?.n ?? -1) || a.name.localeCompare(b.name));
}

const hourName = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function SpeciesSheet({
    choices,
    selected,
    onSelect,
    fleetEmpty = false,
}: {
    choices: readonly SpeciesChoice[];
    selected: SpeciesChoice | null;
    onSelect: (sci: string) => void;
    /** No fleet sightings at all yet: show one line instead of three empty figures. */
    fleetEmpty?: boolean;
}) {
    const fleetChoices = choices.filter((c) => c.fleet);
    const contextChoices = choices.filter((c) => !c.fleet);
    if (!selected) {
        return (
            <section className="oc-sheet" aria-labelledby="oc-sp-h">
                <div className="oc-sheet-head">
                    <span className="oc-eyebrow">Species</span>
                    <h2 id="oc-sp-h">Species pages</h2>
                </div>
                <p className="oc-empty">Species pages appear as sightings and records load.</p>
            </section>
        );
    }
    const { fleet, context } = selected;
    const group = groupMeta(fleet?.group ?? context?.group ?? 'other');
    const blurred = (fleet?.generalised ?? false) || (context?.sensitive ?? false);
    const fleetMonths = fleet ? monthsFrom(fleet.months) : null;
    const seasonFromFleet = !!fleetMonths && fleetMonths.some((v) => v > 0);
    const hours = fleet && Object.keys(fleet.hours).length > 0 ? fleet.hours : null;
    const sst = fleet?.sst && Object.keys(fleet.sst).length > 0 ? fleet.sst : null;
    const sstBins = sst ? Object.keys(sst).map(Number) : [];
    return (
        <section className="oc-sheet" aria-labelledby="oc-sp-h">
            <div className="oc-sheet-head">
                <span className="oc-eyebrow">Species page</span>
                <h2 id="oc-sp-h">{selected.name}</h2>
                <span className="oc-sci">{selected.sci}</span>
                {blurred && <span className="oc-tag">Threatened: area counts only</span>}
                <label className="oc-picker">
                    <span>Choose an animal</span>
                    <select value={selected.sci} onChange={(e) => onSelect(e.target.value)}>
                        {fleetChoices.length > 0 && (
                            <optgroup label="Logged by the fleet">
                                {fleetChoices.map((c) => (
                                    <option key={c.sci} value={c.sci}>
                                        {c.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        {contextChoices.length > 0 && (
                            <optgroup label="Historical public records">
                                {contextChoices.map((c) => (
                                    <option key={c.sci} value={c.sci}>
                                        {c.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                    </select>
                </label>
            </div>
            <p className="oc-sheet-sub">
                {fleet
                    ? `The fleet has logged ${fmt(fleet.n)} public sighting${fleet.n === 1 ? '' : 's'} of ${fmt(fleet.animals)} animal${fleet.animals === 1 ? '' : 's'}.`
                    : 'Not logged by the fleet yet.'}{' '}
                {context
                    ? `Historical public records: ${fmt(context.recordDays)} record-days, ${yearsLabel(context.years)}.`
                    : ''}
            </p>
            <div className="oc-grid4">
                <figure className="oc-fig">
                    <h3>Season clock</h3>
                    {seasonFromFleet && fleetMonths ? (
                        <SeasonClock
                            values={fleetMonths}
                            colour={group.colour}
                            label={`${selected.name} sightings by month`}
                        />
                    ) : context ? (
                        <SeasonClock
                            values={context.months}
                            colour="var(--oc-ctx)"
                            label={`${selected.name}, historical record-days by month`}
                        />
                    ) : (
                        <p className="oc-empty">No dated records yet.</p>
                    )}
                    <figcaption>
                        {seasonFromFleet
                            ? 'Sightings by month, from the fleet.'
                            : context
                              ? 'Historical public records by month (record-days), not the fleet.'
                              : ''}
                    </figcaption>
                </figure>
                {fleetEmpty ? (
                    <figure className="oc-fig is-wide">
                        <h3>From the fleet</h3>
                        <p className="oc-empty">
                            The fleet’s first sightings will appear here: time of day, water temperature and, with
                            effort data, sightings per hour watched.
                        </p>
                    </figure>
                ) : (
                    <>
                        <figure className="oc-fig">
                            <h3>Time of day</h3>
                            {hours ? (
                                <BinBars
                                    hist={hours}
                                    from={0}
                                    to={23}
                                    colour={group.colour}
                                    name={hourName}
                                    tickEvery={6}
                                    label={`${selected.name} sightings by local solar hour`}
                                />
                            ) : (
                                <p className="oc-empty">
                                    {fleet?.generalised
                                        ? 'Not shown for threatened species: the hour could place the animal.'
                                        : 'Shown once the fleet has logged this species.'}
                                </p>
                            )}
                            <figcaption>Local solar time where it was seen, so it reads the same anywhere.</figcaption>
                        </figure>
                        <figure className="oc-fig">
                            <h3>Water temperature</h3>
                            {sst ? (
                                <BinBars
                                    hist={sst}
                                    from={Math.min(...sstBins)}
                                    to={Math.max(...sstBins)}
                                    colour="var(--oc-sky)"
                                    name={(t) => `${t}°`}
                                    tickEvery={2}
                                    label={`Sea temperature at ${selected.name} sightings, 1 °C bins`}
                                />
                            ) : (
                                <p className="oc-empty">
                                    {fleet?.generalised
                                        ? 'Not shown for threatened species.'
                                        : 'Shown once 5 sightings from at least 3 boats carry a water temperature from the boat’s own sensor.'}
                                </p>
                            )}
                            <figcaption>From the boats’ own instruments, never a forecast.</figcaption>
                        </figure>
                        <figure className="oc-fig">
                            <h3>Per hour watched</h3>
                            <p className="oc-empty">Encounter rates per hour watched arrive with effort data.</p>
                            <figcaption>
                                Counting the hours boats spent looking is what tells “no whales” from “nobody looked”.
                            </figcaption>
                        </figure>
                    </>
                )}
            </div>
        </section>
    );
}
