/**
 * CrewCastOffPanel — the Cast Off sheet launched from Passage Planning, plus
 * everything that happens when the skipper casts off from here.
 *
 * Moved verbatim out of components/CrewManagement.tsx (the lazy chunk name
 * "CastOffPanel_Crew" is unchanged, so it is still its own chunk). The
 * `showCastOff && isSelectedPassageOwner` guard stays at the call site.
 */
import React from 'react';
import { lazyRetry } from '../../utils/lazyRetry';
import { followCastOffRoute } from '../../services/shiplog/followCastOffRoute';
import { peekCastOffHandoff, updateCastOffHandoff } from '../../services/castOffHandoff';
import { type AuthIdentityScope } from '../../services/authIdentityScope';
import { savedRouteDisplayName } from './routeLabels';

const CastOffPanel = lazyRetry(
    () => import('../vessel/CastOffPanel').then((m) => ({ default: m.CastOffPanel })),
    'CastOffPanel_Crew',
);

interface CrewCastOffPanelProps {
    scopeStillOwnsPage: (scope: AuthIdentityScope) => boolean;
    renderScope: AuthIdentityScope;
    setShowCastOff: (open: boolean) => void;
    setPage: (page: string) => void;
    selectedPassageId: string;
    setActiveVoyageName: (name: string | null) => void;
}

export const CrewCastOffPanel: React.FC<CrewCastOffPanelProps> = ({
    scopeStillOwnsPage,
    renderScope,
    setShowCastOff,
    setPage,
    selectedPassageId,
    setActiveVoyageName,
}) => {
    return (
        <CastOffPanel
            onClose={() => {
                if (scopeStillOwnsPage(renderScope)) setShowCastOff(false);
            }}
            onOpenLog={() => {
                if (!scopeStillOwnsPage(renderScope)) return;
                setShowCastOff(false);
                setPage('details');
            }}
            initialVoyageId={selectedPassageId || undefined}
            onCastOff={(voyage) => {
                if (!scopeStillOwnsPage(renderScope)) return;
                setActiveVoyageName(savedRouteDisplayName(voyage));
                setShowCastOff(false);
                // Cast Off ends where the Log page's slide-to-start
                // ends (Shane 2026-08-25: "they end up in the same
                // place, but just took a detour through the passage
                // planning page"). Tracking is already verified live
                // by the panel. The passage IS its route, so follow
                // it and put the line on the public page without
                // asking a one-answer question — the verification
                // gate inside refuses anything unproven, and the Log
                // page's own follow sheet stays as the fallback ask.
                {
                    // The handoff carries the SELECTED row's canonical
                    // trace link, which is backfilled even when the
                    // table row predates saved_route_id.
                    const handoff = peekCastOffHandoff();
                    void followCastOffRoute(
                        voyage.id,
                        handoff?.savedRouteId ?? voyage.saved_route_id,
                        handoff?.publishRoute ?? true,
                        voyage.voyage_name,
                    ).then((reason) => {
                        // Silent failures cost a night of guessing —
                        // record why the line is not up so the Log
                        // page can SAY it (Shane 2026-08-26: "it is
                        // not showing the route").
                        if (reason) updateCastOffHandoff({ followNote: reason });
                    });
                }
                // 'details' is the Log tab's registry key — there is
                // no 'log' view. The old 'log' literal rendered the
                // blank search-bar chrome App.tsx keeps for
                // unregistered views (Shane's 2026-08-26 screenshot);
                // tests/ViewKeysExist.test.ts now outlaws the class.
                setPage('details');
            }}
        />
    );
};
