/**
 * useRoutingPolar — the polar the routers sail by (services/routingPolar),
 * for a screen that shows ETAs: the Passage HUD and Plan Your Day (build 125,
 * package 125-08; gap register #2, routing-uses-selected-polar).
 *
 * Until now both sailed `settings.polarData ?? DEFAULT_CRUISING_POLAR`, so an
 * imported polar was squeezed to her cruising speed, a learned one never
 * reached them, and the HUD's ETA disagreed with the route's for the same boat.
 *
 * The skipper's polar settings are read live. The learned grid lives on disk,
 * so its snapshot is taken AFTER the first render — never during it: the
 * screen paints at once on the factory polar (labelled as still learning) and
 * re-resolves when the snapshot lands — and again whenever SmartPolarStore
 * says the grid changed (loaded, saved, reset). Only when routing is set to
 * Smart on a sailing boat; a factory choice never touches the learned store.
 * The same figures resolve to the same object, so an unchanged grid never
 * re-walks a plan.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    learnedPolarSnapshot,
    resolveRoutingPolarFrom,
    type LearnedPolarSnapshot,
    type ResolvedRoutingPolar,
} from '../services/routingPolar';
import { SmartPolarStore } from '../services/SmartPolarStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { VesselProfile } from '../types/vessel';
import { resolveEffectiveVessel } from '../utils/defaultVessel';

const sameLearned = (a: LearnedPolarSnapshot | null, b: LearnedPolarSnapshot | null): boolean =>
    a === b ||
    (!!a &&
        !!b &&
        a.filledCells === b.filledCells &&
        JSON.stringify(a.polar?.matrix ?? null) === JSON.stringify(b.polar?.matrix ?? null));

export function useRoutingPolar(vessel: VesselProfile | null | undefined): ResolvedRoutingPolar {
    const polarData = useSettingsStore((st) => st.settings.polarData);
    const polarBoatModel = useSettingsStore((st) => st.settings.polarBoatModel);
    const polarSourceType = useSettingsStore((st) => st.settings.polarSource_type);
    const polarSource = useSettingsStore((st) => st.settings.polarSource);
    // The learner's own switch (Preferences): it decides "Learning" vs "learning off".
    const smartPolarsEnabled = useSettingsStore((st) => st.settings.smartPolarsEnabled);
    const boat = resolveEffectiveVessel(vessel);
    const smart = polarSource === 'smart' && boat.type === 'sail';

    const [learned, setLearned] = useState<LearnedPolarSnapshot | null>(null);
    useEffect(() => {
        if (!smart) return;
        let live = true;
        const take = () => {
            if (!live) return;
            const next = learnedPolarSnapshot();
            setLearned((prev) => (sameLearned(prev, next) ? prev : next));
        };
        const unsubscribe = SmartPolarStore.subscribe(take);
        SmartPolarStore.ensureLoaded().then(take, () => {
            /* unreadable: she sails on the factory polar, as the routers do */
        });
        return () => {
            live = false;
            unsubscribe();
        };
    }, [smart]);

    const resolved = useMemo(
        () =>
            resolveRoutingPolarFrom({
                settings: {
                    polarData,
                    polarBoatModel,
                    polarSource_type: polarSourceType,
                    polarSource,
                    smartPolarsEnabled,
                },
                vessel: boat,
                learned: smart ? learned : null,
            }),
        [polarData, polarBoatModel, polarSourceType, polarSource, smartPolarsEnabled, boat, smart, learned],
    );

    // The same polar and the same words → the same object, so nothing downstream re-walks.
    const key = `${resolved.signature}|${resolved.label}|${resolved.learnedCells ?? ''}|${resolved.learning ?? ''}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `resolved`
    return useMemo(() => resolved, [key]);
}
