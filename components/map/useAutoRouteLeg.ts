/**
 * useAutoRouteLeg — ⚡ Auto route, extracted from MapHub.
 *
 * Shane 2026-07-15: "follow deep water. if there is a place we cannot cross,
 * then check that against tide times. we cannot cross land."
 *
 * Drives the REAL inshore routing engine (tryInshoreRoute) between two pins —
 * the same engine ⚡ Auto-to-destination uses. It follows navigable/deep
 * water, treats LNDARE as a hard wall, and will route a shallow that clears
 * with the tide rather than detour miles. The engine's polyline drops back as
 * editable, re-graded pins.
 *
 * HARD RULE, and the reason this file is worth reading before touching it: on
 * ANY engine failure — no route, no charts, too far — auto route CHANGES
 * NOTHING and says so. It must NEVER fall back to a straight line. A straight
 * line crosses land, which is exactly the failure the first cut shipped.
 * Every branch below that ends without pins ends in a setDiag() explaining
 * why, and that is deliberate: the punter must never be left guessing whether
 * ⚡ did something.
 *
 * The two-profile ladder is the other thing not to re-derive. 'safest' prices
 * sub-keel water 40× rather than blocking it, so in a nearly-all-shallow bay
 * (Deception Bay for a 2.4 m keel) it does not fail — it returns an absurd
 * deep-channel dogleg, a 30 NM tour for a 5 NM hop. THAT is the "can't cross"
 * signal. So 'safest' is taken only while it stays within NEAR_DIRECT_CAP× the
 * straight line; past that we run 'tideDirect' (recoverable banks at 1.5×, so
 * A* commits to the near-direct crossing on the tide, while land and drying
 * stay hard-blocked) and adopt it only when it is materially straighter
 * (TIDE_ADOPT_FACTOR). A genuine deep detour — Newport→Rivergate at ~1.35× —
 * stays on 'safest'.
 *
 * A coverage gap syncs the CHARTS first and retries, from the CLOUD rather
 * than the Pi: this also runs on the web over HTTPS, where the Pi at
 * http://…:3001 is unreachable behind the page's origin. Downloading a cell
 * also fixes its hazardCount, which is what actually makes the router's
 * coverage gate accept it.
 */

import { useCallback } from 'react';
import { triggerHaptic } from '../../utils/system';
import { tryInshoreRoute } from '../../services/InshoreRouter';
import { vesselDraftMetres, vesselAirDraftMetres } from '../../services/units';
import { rdpTracePoints, capSegmentLength } from '../../services/routeTracer';
import { AUTO_MAX_LEG_M, NEAR_DIRECT_CAP, TIDE_ADOPT_FACTOR, distMetres } from './mapHubHelpers';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

export interface AutoRouteLegDeps {
    capturedCoords: { lat: number; lon: number }[];
    setCapturedCoords: (pins: { lat: number; lon: number }[]) => void;
    /** The leg routed is the one INTO the highlighted pin (Shane 2026-07-15
     *  "whichever waypoint is highlighted, the leg between it and the
     *  waypoint before"). No selection → the last leg. */
    selectedPin: number | null;
    setSelectedPin: (i: number | null) => void;
    setInsertAfter: (i: number | null) => void;
    insertAfterRef: { current: number | null };
    /** Doubles as the busy latch — non-null means a fix or route is running. */
    fixBusyLeg: number | null;
    setFixBusyLeg: (i: number | null) => void;
    setAutoRouteDiag: (msg: string | null) => void;
    flashTraceFeedback: (msg: string) => void;
    /** Structural, so it satisfies both draft helpers — the profile
     *  stores these in FEET and the helpers do the conversion. */
    vessel: { draft?: number; airDraft?: number } | null | undefined;
}

export function useAutoRouteLeg(deps: AutoRouteLegDeps): () => void {
    const {
        capturedCoords,
        setCapturedCoords,
        selectedPin,
        setSelectedPin,
        setInsertAfter,
        insertAfterRef,
        fixBusyLeg,
        setFixBusyLeg,
        setAutoRouteDiag,
        flashTraceFeedback,
        vessel,
    } = deps;

    return useCallback(() => {
        if (capturedCoords.length < 2 || fixBusyLeg !== null) return;
        const iLeg =
            selectedPin !== null && selectedPin > 0 && selectedPin < capturedCoords.length
                ? selectedPin - 1
                : capturedCoords.length - 2;
        const a = capturedCoords[iLeg];
        const b = capturedCoords[iLeg + 1];
        triggerHaptic('medium');
        setFixBusyLeg(iLeg);
        setAutoRouteDiag(null);
        flashTraceFeedback('Following deep water…');
        setTimeout(() => {
            void (async () => {
                try {
                    const draftM = vesselDraftMetres(vessel);
                    const airM = vesselAirDraftMetres(vessel);
                    const O = { lat: a.lat, lon: a.lon };
                    const D = { lat: b.lat, lon: b.lon };
                    // DEEPEST WATER FIRST — but only when the deep line is
                    // SENSIBLE (Shane 2026-07-15: "follow the deepest water it
                    // can, if it CAN'T, tide-check where we must cross"). 'safest'
                    // prices sub-keel water 40× rather than blocking it, so in a
                    // nearly-all-shallow bay (Deception Bay for a 2.4 m keel) it
                    // doesn't fail — it returns an absurd deep-channel dogleg (a
                    // 30 NM tour for a 5 NM hop). THAT is the "can't cross"
                    // signal. So: take 'safest' only when its route stays within
                    // NEAR_DIRECT_CAP× the straight line; past that, run
                    // 'tideDirect' (recoverable banks at 1.5× so A* commits to
                    // the near-direct crossing on the tide) and take it when it's
                    // materially straighter (TIDE_ADOPT_FACTOR). A genuine deep
                    // detour (Newport→Rivergate ~1.35×) stays on safest.
                    const directNM = distMetres(a, b) / 1852;
                    const ratio = (nm: number) => (nm / directNM).toFixed(2);
                    const runEngine = async (): Promise<{
                        res: Awaited<ReturnType<typeof tryInshoreRoute>>;
                        viaTide: boolean;
                        diag: string | null;
                    }> => {
                        const safe = await tryInshoreRoute(O, D, draftM, airM, 'safest');
                        const safeOk = !!safe && 'polyline' in safe;
                        // Deep water already lines up near-direct → keep it, no
                        // tide crossing needed.
                        if (safeOk && safe.distanceNM <= directNM * NEAR_DIRECT_CAP) {
                            return {
                                res: safe,
                                viaTide: false,
                                diag: `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}) — near-direct, no tide crossing needed.`,
                            };
                        }
                        // 'safest' doglegged (or failed) → try 'tideDirect': the
                        // recoverable banks price at 1.5× so A* commits to the
                        // near-direct crossing rather than a marina detour
                        // (land + drying stay hard-blocked, never crossed).
                        const direct = await tryInshoreRoute(O, D, draftM, airM, 'tideDirect');
                        const directOk = !!direct && 'polyline' in direct;
                        if (directOk && (!safeOk || direct.distanceNM < safe.distanceNM * TIDE_ADOPT_FACTOR)) {
                            return {
                                res: direct,
                                viaTide: true,
                                diag: safeOk
                                    ? `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}) vs tide-direct ${direct.distanceNM.toFixed(1)} NM (${ratio(direct.distanceNM)}×) → CROSSING the banks on the tide. Cross near HW — see the red legs for the window.`
                                    : `⚡ No all-deep route — tide-direct ${direct.distanceNM.toFixed(1)} NM (${ratio(direct.distanceNM)}× direct) CROSSES the banks on the tide. Cross near HW — see the red legs.`,
                            };
                        }
                        // Neither near-direct deep nor a materially-straighter
                        // crossing → keep the safe deep route (a genuine detour:
                        // land/drying blocks the direct line) or the failure.
                        return {
                            res: safeOk ? safe : (safe ?? direct),
                            viaTide: false,
                            diag: safeOk
                                ? `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}); tide-direct ${directOk ? `${direct.distanceNM.toFixed(1)} NM not materially shorter` : 'unavailable'} (direct line blocked by land/drying) → kept the deep route.`
                                : null,
                        };
                    };
                    let { res, viaTide, diag } = await runEngine();

                    // Coverage-gap → SYNC THE CHARTS FIRST, then retry (Shane
                    // 2026-07-15 chose this). The router refuses to cross a
                    // stretch with no routing-grade chart; the missing detail
                    // cell almost always lives on the boat's Pi (confirmed
                    // OC-61-10ENB5 for Deception Bay). Pull the cells nearest
                    // this leg from the Pi and route again — no menu-diving.
                    if (res && 'error' in res && res.code === 'coverage-gap') {
                        setAutoRouteDiag('⚡ Missing charts for part of this leg — fetching them from the cloud…');
                        try {
                            // Fetch from the CLOUD, not the Pi: this runs on the
                            // web (thalassawx.app over HTTPS), where the Pi at
                            // http://…:3001 is unreachable behind the page's HTTPS
                            // origin (mixed-content block). The cloud bucket is
                            // HTTPS and holds the same cells. Downloading a cell
                            // also fixes its hazardCount so the router's coverage
                            // gate finally accepts it (the real bug — see
                            // cloudCellSync).
                            const { downloadCloudCellsForBBox } = await import('../../services/enc/cloudCellSync');
                            const pad = 0.03;
                            const bbox: [number, number, number, number] = [
                                Math.min(a.lon, b.lon) - pad,
                                Math.min(a.lat, b.lat) - pad,
                                Math.max(a.lon, b.lon) + pad,
                                Math.max(a.lat, b.lat) + pad,
                            ];
                            const fill = await downloadCloudCellsForBBox(bbox);
                            log.warn(
                                `auto-route: cloud fill downloaded=${fill.downloaded} needed=${fill.needed} bucket=${fill.bucketAvailable}`,
                            );
                            if (!fill.bucketAvailable) {
                                setAutoRouteDiag(
                                    "⚡ This leg needs charts your session doesn't have, and the chart cloud isn't reachable. Check your connection and that you're signed in (the charts are licensed).",
                                );
                                return;
                            }
                            if (fill.downloaded === 0 && fill.needed > 0) {
                                setAutoRouteDiag(
                                    "⚡ The missing charts wouldn't download — you're probably not signed in (the chart bucket is licensed-access). Sign in and try again.",
                                );
                                return;
                            }
                            if (fill.downloaded > 0) {
                                ({ res, viaTide, diag } = await runEngine());
                            }
                        } catch (syncErr) {
                            setAutoRouteDiag(
                                `⚡ Couldn't fetch the missing charts (${syncErr instanceof Error ? syncErr.message.slice(0, 50) : 'error'}). Check your connection / sign-in and try again.`,
                            );
                            return;
                        }
                    }
                    if (res && 'polyline' in res) {
                        const pts = res.polyline.map(([lon, lat]) => ({ lat, lon }));
                        const prof = viaTide ? 'tideDirect' : 'safest';
                        log.warn(
                            `auto-route: engine returned ${pts.length} pts, ${res.distanceNM.toFixed(1)} NM (${prof}); direct ${directNM.toFixed(1)} NM`,
                        );
                        // RDP to the bends, THEN cap every straight run to
                        // AUTO_MAX_LEG_M so a long open-water stretch becomes a
                        // chain of DEPTH-CHECKABLE legs — the added pins sit ON
                        // the engine's water line, so they can't cross land.
                        const followed = capSegmentLength(rdpTracePoints(pts, 40), AUTO_MAX_LEG_M);
                        const interior = followed.slice(1, -1);
                        const base = capturedCoords;
                        const newPins = [...base.slice(0, iLeg + 1), ...interior, ...base.slice(iLeg + 1)];
                        setCapturedCoords(newPins);
                        setSelectedPin(null); // indices shifted; drop the highlight
                        setInsertAfter(null);
                        insertAfterRef.current = null;
                        if (interior.length > 0) {
                            flashTraceFeedback(
                                viaTide
                                    ? `Routed with a tide gate — ${interior.length} pin${interior.length > 1 ? 's' : ''} added, checking the window`
                                    : `Routed through deep water — ${interior.length} pin${interior.length > 1 ? 's' : ''} added, checking now`,
                            );
                            // Persist the decision + ratios (not null) so an
                            // on-water run gives ground truth to calibrate the
                            // NEAR_DIRECT_CAP / TIDE_ADOPT_FACTOR dials.
                            setAutoRouteDiag(diag);
                        } else {
                            // Engine returned the straight line — it can't see a
                            // better path even on 'safest'. Persist WHY.
                            setAutoRouteDiag(
                                `⚡ Engine kept the straight line (${prof}, ${pts.length} pts, ${res.distanceNM.toFixed(1)} NM). It sees no deeper detour it can reach — the shallow may sit in a coverage gap or between charts.`,
                            );
                        }
                    } else if (res && 'error' in res) {
                        // A coverage-gap that survived the Pi sync = the detail
                        // cell isn't on the Pi either, so it's genuinely uncharted.
                        setAutoRouteDiag(
                            res.code === 'coverage-gap'
                                ? `⚡ Still no detailed chart for part of this leg even after fetching — that stretch isn't charted to routing grade in the cloud set. Trace it by hand or drop a pin past the gap. (${res.error.slice(0, 60)})`
                                : `⚡ Engine couldn't route: ${res.error}`,
                        );
                    } else {
                        setAutoRouteDiag(
                            '⚡ Engine declined this leg (returned nothing) — usually no ENC chart coverage at one end, or over the 50 NM cap. Nothing changed.',
                        );
                    }
                } catch (err) {
                    log.warn(`auto-route failed: ${err instanceof Error ? err.message : String(err)}`);
                    setAutoRouteDiag(`⚡ Auto-route threw: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    setFixBusyLeg(null);
                }
            })();
        }, 30);
    }, [
        capturedCoords,
        setCapturedCoords,
        selectedPin,
        setSelectedPin,
        setInsertAfter,
        insertAfterRef,
        fixBusyLeg,
        setFixBusyLeg,
        setAutoRouteDiag,
        flashTraceFeedback,
        vessel,
    ]);
}
