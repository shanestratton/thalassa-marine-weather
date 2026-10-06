/**
 * The rules the map keeps, in plain words. Every line here is enforced in
 * code (20261006120000_ocean_public_read.sql, api/ocean/[view].ts), and the
 * page promises nothing it cannot keep while only a few boats log.
 */
export function Respect() {
    return (
        <section className="oc-sheet" aria-labelledby="oc-respect-h">
            <div className="oc-sheet-head">
                <span className="oc-eyebrow">Respect</span>
                <h2 id="oc-respect-h">A map that never helps anyone chase a whale</h2>
            </div>
            <ul className="oc-features">
                <li>
                    <span className="oc-dot" aria-hidden="true" />
                    <span>
                        <b>3 hours late in public.</b> A boat’s own crew see their sightings live. Everyone else sees
                        them at least three hours later.
                    </span>
                </li>
                <li>
                    <span className="oc-dot oc-dot-dugong" aria-hidden="true" />
                    <span>
                        <b>Positions on a grid.</b> Public sightings are snapped to a 1 km grid (within about 800 m of
                        where they were logged). Threatened species, and sightings not yet named, are shown only as area
                        counts until at least 3 boats have logged them in an area: a count in a 10 km square, once the
                        month it was seen in has ended, never a point or a time.
                    </span>
                </li>
                <li>
                    <span className="oc-dot oc-dot-amber" aria-hidden="true" />
                    <span>
                        <b>Fish (the app’s fish group) never appear; sharks and rays do.</b> Catch spots stay off this
                        map entirely, not even as area totals.
                    </span>
                </li>
                <li>
                    <span className="oc-dot oc-dot-turtle" aria-hidden="true" />
                    <span>
                        <b>Keep your distance.</b> Logging a whale or dolphin shows a keep-your-distance card, with the
                        legal approach distances where they have been checked (Queensland and the Great Barrier Reef so
                        far).
                    </span>
                </li>
                <li>
                    <span className="oc-dot oc-dot-whale" aria-hidden="true" />
                    <span>
                        <b>No photos here.</b> Photos never appear on this map, and location data is removed from every
                        photo before it leaves the phone.
                    </span>
                </li>
                <li>
                    <span className="oc-dot" aria-hidden="true" />
                    <span>
                        <b>Not anonymous while the fleet is small.</b> A sighting is credited to its boat only if the
                        skipper chooses; otherwise it says “A Thalassa sailor”. With only a few boats logging, a
                        sighting may still point to the boat that made it, which is why every one is delayed and
                        gridded. If a boat also shares a public voyage log, its track can place its sightings more
                        exactly than the grid.
                    </span>
                </li>
            </ul>
        </section>
    );
}
