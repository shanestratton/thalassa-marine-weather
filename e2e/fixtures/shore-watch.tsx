/** Real presentation and page header; no watch, push, account or telemetry services. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShoreWatchReadings } from '../../components/anchor-watch/ShoreWatchReadings';
import { ShoreWeighAnchorBar } from '../../components/anchor-watch/ShoreWeighAnchorBar';
import { MoveAnchorChip } from '../../components/anchor-watch/MoveAnchorChip';
import { PageHeader } from '../../components/ui/PageHeader';
import type { PositionBroadcast } from '../../services/AnchorWatchSyncService';
import type { SpeedUnit } from '../../types/units';
import '../../index.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || 'healthy';
const fresh = scenario !== 'stale';
const alarm = scenario === 'alarm';
/** Across the antimeridian, off Taveuni (fictional): her trail must draw beside the anchor. */
const anti = params.has('anti');
const timestamp = new Date('2026-09-24T04:06:00Z').getTime();
/** The page renders a moment after the broadcast; the live readings are fresh at it. */
const now = timestamp + 10_000;
document.documentElement.style.fontSize = params.has('largeText') ? '24px' : '16px';
const lengthUnit = params.get('units') === 'ft' ? 'ft' : 'm';
const speedUnit = (params.get('speed') as SpeedUnit | null) ?? 'kts';

type LatLon = { latitude: number; longitude: number };

/** A point `metres` from `from` on a compass bearing, its longitude wrapped into ±180°. */
function offset(from: LatLon, metres: number, bearingDeg: number): LatLon {
    const rad = (bearingDeg * Math.PI) / 180;
    const lon = from.longitude + (metres * Math.sin(rad)) / (111320 * Math.cos((from.latitude * Math.PI) / 180));
    return {
        latitude: from.latitude + (metres * Math.cos(rad)) / 110540,
        longitude: ((((lon + 180) % 360) + 360) % 360) - 180,
    };
}

/**
 * Her trail as the shore phone heard it: a swing round the anchor, `metres`
 * out, every 10°, one half-minute apart and unbroken, the last in the
 * broadcast's own half-minute.
 */
function swing(anchor: LatLon, metres: number, from: number, to: number): (LatLon & { timestamp: number })[] {
    const bearings: number[] = [];
    for (let bearing = from; bearing <= to; bearing += 10) bearings.push(bearing);
    return bearings.map((bearing, i) => ({
        ...offset(anchor, metres, bearing),
        timestamp: timestamp - (bearings.length - 1 - i) * 30_000,
    }));
}

// Fictional anchorages: off Horta, the Azores, and off Taveuni, Fiji, astride 180°.
const HORTA = { latitude: 38.53, longitude: -28.62 };
const TAVEUNI = { latitude: -16.8, longitude: 179.9998 };
const anchor = anti ? TAVEUNI : HORTA;
// Off Taveuni she lies 53 m east, at -179.9997, in a 60 m circle; the trail
// runs 42 m out from WNW through north to east (browser-tests reads it there).
const vessel = anti ? { latitude: -16.8, longitude: -179.9997 } : offset(HORTA, alarm ? 63 : 11, 120);
const trail = anti ? swing(TAVEUNI, 42, 300, 440) : swing(HORTA, 12, 40, 130);

const data: PositionBroadcast = {
    type: 'position',
    vessel: { ...vessel, accuracy: 3, heading: 0, speed: 0, timestamp },
    anchor: { ...anchor, timestamp },
    distance: anti ? 53 : alarm ? 63 : 11,
    swingRadius: anti ? 60 : 50,
    isAlarm: alarm,
    config: { rodeLength: 45, waterDepth: 4.3 },
    // The Pi's live depth and wind (126-05), each with its own time.
    ...(params.has('live')
        ? {
              live: {
                  depthM: 3.2,
                  depthReference: 'below-keel',
                  depthAt: timestamp - 4_000,
                  twsKn: 18,
                  twsAt: timestamp - 2_000,
                  twdDeg: 135,
                  twdAt: timestamp - 20_000,
              },
          }
        : {}),
    timestamp,
};

function Fixture() {
    const [muted, setMuted] = useState(false);
    const [checkingNotifications, setCheckingNotifications] = useState(false);
    const [weighed, setWeighed] = useState(false);
    const [moveOpened, setMoveOpened] = useState(false);
    return (
        <main className="flex h-dvh w-full flex-col overflow-hidden bg-slate-950 font-sans text-white">
            <header
                data-testid="brand-header"
                className="flex shrink-0 items-end justify-between px-5 pb-5"
                style={{ height: 140 }}
            >
                <div>
                    <p className="text-xl font-black tracking-widest text-sky-200">THALASSA</p>
                    <p className="text-xs tracking-wider text-slate-400">MARINE WEATHER</p>
                </div>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500 text-xl font-bold">
                    i
                </span>
            </header>
            <div className="min-h-0 flex-1">
                <div
                    data-testid="shore-watch-page"
                    className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950"
                    // Browsers do not emulate a notch inset. Substitute 34px for
                    // production env(safe-area-inset-bottom), keeping its formula.
                    style={{ paddingBottom: 'calc(4rem + 34px + 8px)' }}
                >
                    <PageHeader
                        title="Shore Watch"
                        subtitle={
                            <p className="mt-0.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest">
                                <span
                                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${fresh ? 'bg-emerald-500' : 'bg-red-500'}`}
                                />
                                <span className={fresh ? 'text-emerald-400' : 'text-red-400'}>
                                    {fresh ? 'Vessel Data Live' : 'Vessel Offline'}
                                </span>
                            </p>
                        }
                        onBack={() => undefined}
                        action={
                            <button
                                type="button"
                                aria-label="Leave Shore Watch"
                                className="min-h-11 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-1.5 text-sm font-bold text-red-400"
                            >
                                Leave
                            </button>
                        }
                    />
                    {params.has('notificationWarning') && (
                        <section
                            aria-label="Background notification readiness"
                            className="mx-4 mb-2 shrink-0 rounded-xl border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
                        >
                            {/* Wraps: at large text sizes the Retry button ran past the
                            card's right edge instead of taking its own line. */}
                            <div className="flex flex-wrap items-center justify-between gap-x-3">
                                <p role="status" aria-live="polite" className="font-bold">
                                    {checkingNotifications
                                        ? 'Checking background notifications…'
                                        : 'Background notifications not verified'}
                                </p>
                                <button
                                    type="button"
                                    disabled={checkingNotifications}
                                    onClick={() => setCheckingNotifications(true)}
                                    className="min-h-11 shrink-0 px-2 font-bold text-sky-300 disabled:opacity-50"
                                >
                                    Retry notifications
                                </button>
                            </div>
                            <p className="mt-1">Keep this app open until notification setup is verified.</p>
                        </section>
                    )}
                    {!fresh && (
                        <div className="mx-3 mt-1 flex shrink-0 items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2.5">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                            <span className="flex-1 text-sm font-bold text-red-400">
                                Vessel offline · showing last-known data from 90s ago
                            </span>
                            <span className="text-sm text-red-300">Reconnecting…</span>
                        </div>
                    )}
                    <div
                        data-testid="shore-readings-scroll"
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
                    >
                        <div className="flex min-h-full flex-col justify-center py-2">
                            <ShoreWatchReadings
                                data={data}
                                fresh={fresh}
                                isAlarm={alarm}
                                statusLabel={alarm ? 'Drag Alarm' : fresh ? 'Holding' : 'Last-known data'}
                                showMute={!fresh || alarm}
                                muted={muted}
                                onMute={() => setMuted(true)}
                                lengthUnit={lengthUnit}
                                speedUnit={speedUnit}
                                trail={trail}
                                now={now}
                                phoneWatched={params.has('quietWatch')}
                                // &piMove=1 with ?ownPi=true: the trial is on, so this
                                // phone's own Pi watch offers Move anchor (126-07a).
                                radarAction={
                                    params.has('ownPi') && params.has('piMove') ? (
                                        <MoveAnchorChip onClick={() => setMoveOpened(true)} />
                                    ) : undefined
                                }
                            />
                            {params.has('ownPi') && <ShoreWeighAnchorBar onWeighAnchor={() => setWeighed(true)} />}
                        </div>
                    </div>
                    {weighed && <p role="alert">Weigh anchor pressed</p>}
                    {moveOpened && <p role="alert">Move anchor pressed</p>}
                </div>
            </div>
            <nav
                aria-label="Main"
                className="fixed inset-x-0 bottom-0 z-10 flex items-start justify-around border-t border-white/10 bg-slate-900 px-3 pt-4 text-xs font-semibold text-slate-300"
                style={{ height: 98 }}
            >
                <span>Weather</span>
                <span>Chart</span>
                <span className="text-sky-300">Vessel</span>
                <span>Crew</span>
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
