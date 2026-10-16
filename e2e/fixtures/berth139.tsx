/** Entirely invented chart/forecast geometry; actual bounded join core and
 * production review/save components. No provider, chart read, save or adoption. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { TrialRouteReviewPanel } from '../../components/autorouting/TrialRouteReviewPanel';
import { AutoroutingProposalSaveCard } from '../../components/autorouting/AutoroutingProposalSaveCard';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import {
    computeBerthToBerth,
    type BerthPoint,
    type BerthLegRequest,
    type BerthApproach,
} from '../../services/routing/berthToBerth';
import { berthDisclosure } from '../../services/routing/berthProposal';
import { cumulativeLegs } from '../../services/isochrone/geodesy';
import type { IsochroneResult } from '../../services/isochrone/types';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
if (!import.meta.env.DEV) throw Error('Development-only fictional fixture.');
setAuthIdentityScope('fictional-berth-browser-owner');
const clock = '2026-10-17T00:00:00.000Z';
function result(points: BerthPoint[], hours: number, departure: string): IsochroneResult {
    const distances = cumulativeLegs(points, 6),
        route = points.map((p, i) => ({
            ...p,
            timeHours: (i * hours) / (points.length - 1),
            distance: distances[i].nm,
            bearing: 90,
            speed: 6,
            tws: 10,
            twa: 90,
            parentIndex: null,
            propulsion: 'unknown' as const,
            tackSide: null,
        }));
    return {
        route,
        routeCoordinates: route.map((p) => [p.lon, p.lat]),
        shallowFlags: route.map(() => false),
        isochrones: [],
        totalDistanceNM: distances.at(-1)!.nm,
        totalDurationHours: hours,
        arrivalTime: new Date(Date.parse(departure) + hours * 3600000).toISOString(),
        motorHours: null,
    };
}
function Fixture() {
    const [proposal, setProposal] = React.useState<AutoroutingTrialRoute | null>(null),
        [error, setError] = React.useState(''),
        [busy, setBusy] = React.useState(false),
        [selected, setSelected] = React.useState(0),
        [shown, setShown] = React.useState(true);
    const epoch = React.useRef(0),
        [times, setTimes] = React.useState<string[]>([]);
    async function run(complete: boolean) {
        const mine = ++epoch.current;
        setProposal(null);
        setError('');
        setBusy(true);
        setTimes([]);
        const calls: string[] = [];
        try {
            const approach = async (req: BerthLegRequest): Promise<BerthApproach> => {
                calls.push(req.departureTime);
                const route = result(
                    [req.origin, { lat: 0, lon: (req.origin.lon + req.destination.lon) / 2 }, req.destination],
                    req.offsetHours ? 2.334567 : 2.034567,
                    req.departureTime,
                );
                return {
                    result: route,
                    states: ['green', 'green'],
                    disclosure: {
                        stateMask: ['green', 'green'],
                        cautionMask: [false, false],
                        cellsUsed: ['US5TEST1'],
                        distanceNM: route.totalDistanceNM,
                        elapsedMs: 1,
                        backstop: 'verified',
                    },
                    warnings: ['Fictional chart approach.'],
                };
            };
            const joined = await computeBerthToBerth({
                origin: { lat: 0, lon: 0 },
                destination: { lat: 0, lon: 5 },
                departureTime: clock,
                draftM: 2,
                deadlineMs: Date.now() + 90000,
                current: () => mine === epoch.current,
                portals: async (end) => ({
                    candidates: [
                        {
                            id: 'fictional-' + end,
                            at: { lat: 0, lon: end === 'departure' ? 0.2 : 4.8 },
                            depthM: 50,
                            sourceKey: 'fictional-cohort-' + end,
                        },
                    ],
                    current: () => mine === epoch.current,
                    release: () => {},
                }),
                approach,
                offshore: async (req) => {
                    calls.push(req.departureTime);
                    return result([req.origin, { lat: 0, lon: 2.5 }, req.destination], 50.765432, req.departureTime);
                },
                verify: async (candidate) => ({
                    verified: complete,
                    result: candidate,
                    reason: 'The complete final chart check is unavailable. No route was adopted.',
                }),
            });
            if (mine !== epoch.current) return;
            setTimes(calls);
            setProposal({
                id: 'fictional-berth-proposal',
                provider: 'Thalassa',
                coordinates: joined.result.routeCoordinates,
                warnings: [
                    'Fictional 300 NM proposal; no real charts or forecast were used.',
                    'Independent chart review is still incomplete.',
                ],
                createdAt: clock,
                engine: berthDisclosure(joined, 1),
            });
        } catch (reason) {
            if (mine === epoch.current) setError(reason instanceof Error ? reason.message : 'Unavailable');
        } finally {
            if (mine === epoch.current) setBusy(false);
        }
    }
    return (
        <main className="fixed inset-0 overflow-hidden bg-slate-950 text-white">
            {shown && (
                <ModalSheet
                    isOpen
                    title="Berth passage proposal"
                    fitViewport
                    onClose={() => {
                        epoch.current++;
                        setShown(false);
                    }}
                >
                    <div className="min-w-0 space-y-4">
                        <p>Fictional source test. A proposal never arms a watch or follows a route.</p>
                        <div className="flex flex-wrap gap-2">
                            <button
                                className="min-h-11 rounded bg-sky-900 px-3 py-2"
                                disabled={busy}
                                onClick={() => void run(true)}
                            >
                                Compute fictional berth route
                            </button>
                            <button
                                className="min-h-11 rounded bg-slate-700 px-3 py-2"
                                disabled={busy}
                                onClick={() => void run(false)}
                            >
                                Simulate missing final check
                            </button>
                        </div>
                        {error && (
                            <p role="alert" className="break-words text-amber-200">
                                {error}
                            </p>
                        )}
                        {proposal && (
                            <>
                                <p role="status">
                                    Both approach portals retained; exact forecast clocks advance through all three
                                    stages.
                                </p>
                                <ol aria-label="Stage departure clocks" className="break-words text-sm">
                                    {times.map((time, i) => (
                                        <li key={i}>{time}</li>
                                    ))}
                                </ol>
                                <TrialRouteReviewPanel
                                    coordinates={proposal.coordinates}
                                    route={proposal}
                                    review={null}
                                    selected={selected}
                                    onSelect={setSelected}
                                    onFocus={() => {}}
                                    onStop={() => {
                                        epoch.current++;
                                        setProposal(null);
                                    }}
                                    onRecheck={() => {}}
                                />
                                <AutoroutingProposalSaveCard
                                    route={proposal}
                                    review={null}
                                    draftM={2}
                                    draftAssumed={false}
                                />
                            </>
                        )}
                    </div>
                </ModalSheet>
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
