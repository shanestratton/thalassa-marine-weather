/**
 * Go to it (build 125, package 125-02): the Man Overboard page steering to a
 * distress beacon. An AIS-SART in a liferaft, a crew member's AIS-MOB or an
 * EPIRB-AIS drifts, so this follows the beacon's every report (the distress
 * watch updates it in the alert store) and gives the bearing and range from
 * her own position (the boat's GPS first, as the radio page reads it, else
 * this phone). Without a fresh fix of our own it hides them rather than guess.
 * Antimeridian-safe: the bearing and range are the collision rule's great
 * circle, which wraps longitude.
 *
 * While it is open the beacon's own card stands aside in the alert stack (it
 * would cover the bearing), so the page carries Silence alarm while the
 * beacon sounds. Her own MOB is never out of reach (125-02 review): the red
 * 'MOB, mark position' button marks one at once, or, when hers is already
 * marked, 'Back to your MOB' returns to it. One screen at 320 x 568 with wide
 * fonts, every button above the tab bar
 * (browser-tests/distress-beacon-layout.spec.ts).
 */
import React, { useEffect, useReducer, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { AisGuardAlertStore, distressLines, type DistressBeacon } from '../../services/aisGuardAlertStore';
import type { RadioPositionState } from '../../hooks/useRadioPosition';
import { rangeBearing } from '../../utils/collisionRule';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import { triggerHaptic } from '../../utils/system';

const KIND_TITLE: Record<DistressBeacon['kind'], string> = {
    sart: 'AIS-SART',
    mob: 'Man overboard beacon',
    epirb: 'EPIRB-AIS',
};
const STATE_WORD: Record<DistressBeacon['state'], string> = {
    active: 'active',
    test: 'test',
    caution: 'status unclear',
};

function formatRange(nm: number | null): string {
    if (nm === null) return '—';
    return nm >= 1 ? `${nm.toFixed(2)} NM` : `${Math.round(nm * 1852)} m`;
}

export const DistressGoToView: React.FC<{
    mmsi: number;
    radio: RadioPositionState;
    /** Her own MOB mark is active too: the MOB button returns to it rather than marking one. */
    mobActive: boolean;
    /** Leave the beacon for her own MOB: mark one now, or return to the one marked. */
    onOwnMob: () => void;
    onBack: () => void;
    backLabel?: string;
    breadcrumbs?: string[];
}> = ({ mmsi, radio, mobActive, onOwnMob, onBack, backLabel, breadcrumbs }) => {
    // The beacon as of its latest report (kept if it ever drops from the list),
    // and a clock so its age keeps counting between reports.
    const [beacon, setBeacon] = useState<DistressBeacon | null>(
        () => AisGuardAlertStore.getDistress().find((b) => b.mmsi === mmsi) ?? null,
    );
    const [nowMs, setNowMs] = useState(() => Date.now());
    // Silence changes the store, not the beacon: re-read on every store change.
    const [, storeChanged] = useReducer((n: number) => n + 1, 0);
    useEffect(
        () =>
            AisGuardAlertStore.subscribeDistress((list) => {
                const next = list.find((b) => b.mmsi === mmsi);
                if (next) setBeacon(next);
                setNowMs(Date.now());
                storeChanged();
            }),
        [mmsi],
    );
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    const shownNow = Math.max(nowMs, beacon?.heardAt ?? 0);

    const own = radio.position && radio.isFresh && !radio.error ? radio.position : null;
    const target = beacon && beacon.lat !== null && beacon.lon !== null ? { lat: beacon.lat, lon: beacon.lon } : null;
    const vector = own && target ? rangeBearing(own.latitude, own.longitude, target.lat, target.lon) : null;
    const lines = beacon ? distressLines(beacon, shownNow) : null;
    const sounding = beacon ? AisGuardAlertStore.distressSounding(beacon) : false;
    const subtitle = beacon ? `${KIND_TITLE[beacon.kind]} ${STATE_WORD[beacon.state]}` : `MMSI ${mmsi}`;

    return (
        <div
            data-testid="beacon-goto"
            className="w-full h-full flex flex-col overflow-y-auto slide-up-enter"
            style={{ background: 'var(--day-ui-alarm-surface, linear-gradient(180deg, #450a0a 0%, #020617 60%))' }}
        >
            <PageHeader
                title="Go to beacon"
                subtitle={subtitle}
                onBack={onBack}
                backLabel={backLabel}
                breadcrumbs={breadcrumbs ? [breadcrumbs[0], 'Go to beacon'] : undefined}
            />

            <p
                role="status"
                className="shrink-0 mx-5 mt-1 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold leading-snug text-red-100"
            >
                {lines ? lines.heard : 'Waiting for the beacon’s next report'}
            </p>

            <div className="shrink-0 px-5 pt-2 text-center">
                <div className="text-xs font-extrabold tracking-[0.25em] uppercase text-red-300/70">
                    Bearing to beacon
                </div>
                <div
                    data-testid="beacon-bearing"
                    className="text-[44px] font-black text-white leading-none font-mono tracking-tight"
                >
                    {vector ? `${String(Math.round(vector.bearingDeg) % 360).padStart(3, '0')}°` : '—'}
                </div>
                <div className="text-xs font-bold tracking-widest uppercase text-red-300/70">True</div>
            </div>

            <div className="shrink-0 mx-5 mt-2 rounded-2xl border border-red-400/20 bg-red-950/30 grid grid-cols-2 divide-x divide-red-400/15">
                <div className="px-2 py-2 text-center">
                    <div className="text-xs font-extrabold tracking-[0.15em] uppercase text-red-300/70">Distance</div>
                    <div data-testid="beacon-range" className="text-[20px] font-black text-white font-mono">
                        {formatRange(vector ? vector.rangeNm : null)}
                    </div>
                </div>
                <div className="px-2 py-2 text-center min-w-0">
                    <div className="text-xs font-extrabold tracking-[0.15em] uppercase text-red-300/70">Beacon</div>
                    <div className="text-[13px] font-bold text-white break-words">
                        {lines ? lines.who : `MMSI ${mmsi}`}
                    </div>
                </div>
            </div>

            <div className="shrink-0 mx-5 mt-2 rounded-2xl border border-white/6 bg-white/2 px-3 py-2 text-xs font-semibold leading-snug text-slate-200">
                <div>
                    <span className="font-extrabold uppercase tracking-wider text-red-300/80">Beacon </span>
                    <span className="font-mono">
                        {target
                            ? `${formatLatDegMin(target.lat)} ${formatLonDegMin(target.lon)}`
                            : 'Position not yet received'}
                    </span>
                </div>
                <div className="mt-1">
                    <span className="font-extrabold uppercase tracking-wider text-sky-400/80">From </span>
                    {own
                        ? `${own.sourceLabel}, ${formatLatDegMin(own.latitude)} ${formatLonDegMin(own.longitude)}`
                        : 'No fresh position of our own: bearing and distance hidden until a fix arrives.'}
                </div>
            </div>

            <div
                className="shrink-0 grid grid-cols-2 gap-2 px-5 pt-3"
                style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
            >
                {/* Her own MOB first, whatever the beacon is doing. White on
                    the MOB button's red in both palettes, set inline. */}
                <button
                    type="button"
                    aria-label={mobActive ? 'Back to your MOB' : 'MOB, mark position'}
                    onClick={() => {
                        triggerHaptic('heavy');
                        onOwnMob();
                    }}
                    className="col-span-2 min-h-11 rounded-xl border border-white/15 px-2 py-2.5 text-sm font-black uppercase tracking-widest"
                    style={{ background: '#b91c1c', color: '#ffffff' }}
                >
                    {mobActive ? 'Back to your MOB' : 'MOB, mark position'}
                </button>
                {/* While this page is open the beacon's card stands aside (it
                    would cover the bearing), so its Silence lives here. */}
                {sounding && beacon && (
                    <button
                        type="button"
                        aria-label={`Silence the distress alarm for ${lines?.who ?? `MMSI ${mmsi}`}`}
                        onClick={() => AisGuardAlertStore.silenceDistress(beacon.mmsi)}
                        className="min-h-11 rounded-xl border border-red-400/50 bg-red-500/20 px-2 py-3 text-xs font-extrabold uppercase tracking-widest text-red-100"
                    >
                        Silence alarm
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => {
                        triggerHaptic('light');
                        AisGuardAlertStore.stopDistressGoTo();
                    }}
                    className={`${sounding && beacon ? '' : 'col-span-2 '}min-h-11 rounded-xl border border-white/10 bg-white/5 px-2 py-3 text-xs font-extrabold uppercase tracking-widest text-slate-200`}
                >
                    Stop going to it
                </button>
            </div>
        </div>
    );
};
