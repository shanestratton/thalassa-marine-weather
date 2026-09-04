/**
 * The whole trip's route label — "Newport → Whitsundays", not "Newport →
 * Coral Sea".
 *
 * A multi-leg trip is not one row: the voyage record holds LEG ONE's ports,
 * and the rest lives in sailed legs plus chained draft voyages. Every label in
 * the app read the voyage's own two fields and so described the first hop as
 * the whole passage (Shane 2026-09-04). This does the reassembly once, so a
 * caller only has to render a string.
 */
import { useEffect, useState } from 'react';
import { getDraftVoyages, type Voyage } from '../services/VoyageService';
import { getLegsForVoyage } from '../services/VoyageLegService';
import { chainDraftsOntoActive, tripRouteLabel } from '../services/tripEndpoints';

export function useTripRoute(voyage: Voyage | null): string | null {
    const [label, setLabel] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        if (!voyage?.id) {
            setLabel(null);
            return;
        }
        // Legs are local and synchronous, so the common case paints without a
        // round trip; only the draft chain needs the network.
        const legs = getLegsForVoyage(voyage.id);
        setLabel(tripRouteLabel(voyage, legs));
        void (async () => {
            try {
                const drafts = (await getDraftVoyages()).filter((d) => d.id !== voyage.id);
                const { consumed } = chainDraftsOntoActive(voyage, drafts);
                if (alive) setLabel(tripRouteLabel(voyage, legs, consumed));
            } catch {
                /* keep the legs-only label rather than blanking a good one */
            }
        })();
        return () => {
            alive = false;
        };
    }, [voyage]);

    return label;
}
