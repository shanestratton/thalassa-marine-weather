/**
 * AisGuardAlert — a vessel has entered the guard ring.
 *
 * NOT A TOAST, deliberately. This used to slide in and delete itself after
 * eight seconds, and a tap anywhere on the card dismissed it — so a stray
 * touch while panning the chart, or simply looking away, silently discarded
 * a collision warning. The one class of message that must never vanish on a
 * timer is the one telling you something is close.
 *
 * It now stays until explicitly acknowledged, per this project's standing
 * rule that anything the skipper must act on gets a surface that holds still
 * (Shane, twice: "i hate toast messages"). Transient status may be a toast;
 * a proximity alarm may not.
 *
 * Build 125 (125-01): it also carries the collision alarm, one card per
 * vessel — name, CPA, TCPA, bearing, range and how old the AIS report is.
 * DANGER offers a 30-minute mute; close quarters only an acknowledgement,
 * never a mute. A vessel the watch has lost before she was shown clear reads
 * CPA UNKNOWN, never 'passed'. Above the cards, the collision watch says
 * plainly when it cannot watch or cannot sound ('blind', 'paused', no fix,
 * own motion unknown, stopped at a berth; 125-01b: at anchor, where only close
 * quarters with a vessel under way sounds, blind there on its own 10 min line,
 * and stopped with the anchor watch kept elsewhere) rather than looking like
 * an empty sea. While a collision card shows, the stack rises above the night tint
 * (an alarm reads at full brightness) but stays under the anchor alarm.
 *
 * Build 125 (125-02): distress beacons go on top of everything. A beacon her
 * own radio hears going active is a red card (the IEC 62288 circle-and-cross)
 * that sounds until Silence alarm, which keeps the card; then Dismiss. With a
 * position it offers Go to it (the Man Overboard page steers to it and follows
 * it); without one it says 'Position not yet received'. One relayed over the
 * internet is the same card, silent, saying so, with its age. A caution (a
 * beacon's MMSI, neither active nor test) is amber and silent. Test beacons
 * are drawn on the chart, not carded.
 *
 * Build 126 (126-04a): the Pi keeps the night watch too. An alarm the Pi
 * raised that this phone has not carded itself (its own watch off, or not yet
 * seeing her) shows here as a card marked FROM THE PI, from the Pi's LAN word
 * (services/piNightWatchStatus.ts), silent: its button goes to the Pi, which
 * settles it for every phone aboard, and the card stands aside at once.
 *
 * Build 126 (126-02a): the under-way alarms ride the stack too, under the
 * collision cards and above guard-ring entries: shoal water, then off route
 * (services/underway/underwayAlarmStore.ts, small and static; the cards
 * themselves load lazily, only once there is one to draw). A sounding one
 * lifts the stack above the night tint like a collision card. If their chunk
 * will not load (a web tab left open across a deploy), a plain card with the
 * same button stands in, and the rest of the stack stays drawn.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { GuardAlert } from '../../services/AisGuardZone';
import { useUIStore } from '../../stores/uiStore';
import {
    AisGuardAlertStore,
    distressLines,
    type DistressBeacon,
    COLLISION_BLIND_AT_ANCHOR_NOTICE,
    COLLISION_BLIND_NOTICE,
    COLLISION_NO_FIX_NOTICE,
    COLLISION_NO_MOTION_NOTICE,
    COLLISION_PAUSED_NOTICE,
    COLLISION_AT_ANCHOR_NOTICE,
    COLLISION_STOPPED_ELSEWHERE_NOTICE,
    COLLISION_STOPPED_NOTICE,
    COLLISION_UNCHECKED_NOTICE,
    collisionLines,
    type CollisionAlertCard,
    type CollisionWatchNotice,
} from '../../services/aisGuardAlertStore';
import { NIGHT_SCRIM_Z_INDEX } from '../ui/OverlayPortal';
import { PiNightWatchStatus, type PiWatchAlarm } from '../../services/piNightWatchStatus';
import { UnderwayAlarmStore, type UnderwayAlarmCard } from '../../services/underway/underwayAlarmStore';

const UnderwayAlarmCards = React.lazy(() =>
    import('./UnderwayAlarmCards').then((m) => ({ default: m.UnderwayAlarmCards })),
);

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const CARD: React.CSSProperties = {
    background: 'var(--day-ui-danger-surface, rgba(127, 29, 29, 0.92))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(239, 68, 68, 0.4)',
    borderRadius: 14,
    padding: '12px 16px',
    color: 'var(--day-ui-danger, #fecaca)',
    fontFamily: FONT,
    boxShadow: '0 8px 32px rgba(239, 68, 68, 0.3)',
    animation: 'guardAlertIn 400ms cubic-bezier(0.16, 1, 0.3, 1) both',
};

/** 44 pt, deliberate, apart from the card body: acknowledging is never an accident. */
const ACTION: React.CSSProperties = {
    minWidth: 44,
    minHeight: 44,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: 'var(--day-ui-danger, #fecaca)',
    cursor: 'pointer',
};

/**
 * The under-way cards' stand-in (126-02a), for when their lazy chunk will not
 * load: each alarm keeps its title, its number and its one 44 pt button, and
 * the strip keeps its words, so a sounding alarm is never left without a way
 * to answer it and never takes the collision and distress cards down with it.
 */
class UnderwayCardsBoundary extends React.Component<
    { cards: UnderwayAlarmCard[]; notices: string[]; children: React.ReactNode },
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <>
                {this.props.cards.map((card) => {
                    const shoal = card.kind === 'shoal';
                    return (
                        <div key={card.kind} role="alert" data-underway={card.kind} style={CARD}>
                            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>{card.title}</div>
                            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{card.value}</div>
                            {(shoal || card.sounding) && (
                                <button
                                    type="button"
                                    style={{ ...ACTION, width: '100%', fontSize: 13, fontWeight: 800 }}
                                    aria-label={
                                        shoal
                                            ? 'Acknowledge the shoal alarm'
                                            : 'Mute the off-route alarm for 30 minutes'
                                    }
                                    onClick={() =>
                                        shoal
                                            ? UnderwayAlarmStore.acknowledge('shoal')
                                            : UnderwayAlarmStore.mute('off-route')
                                    }
                                >
                                    {shoal ? 'Acknowledge' : 'Mute 30 min'}
                                </button>
                            )}
                        </div>
                    );
                })}
                {this.props.notices.map((text) => (
                    <div key={text} role="status" style={{ ...CARD, fontSize: 13, fontWeight: 700 }}>
                        {text}
                    </div>
                ))}
            </>
        );
    }
}

function noticeText(n: CollisionWatchNotice): string | null {
    switch (n.state) {
        case 'blind':
            return COLLISION_BLIND_NOTICE;
        case 'blind-at-anchor':
            return COLLISION_BLIND_AT_ANCHOR_NOTICE;
        case 'paused':
            return COLLISION_PAUSED_NOTICE;
        case 'no-fix':
            return COLLISION_NO_FIX_NOTICE;
        case 'no-motion':
            return COLLISION_NO_MOTION_NOTICE;
        case 'stopped':
            return COLLISION_STOPPED_NOTICE;
        case 'stopped-elsewhere':
            return COLLISION_STOPPED_ELSEWHERE_NOTICE;
        case 'at-anchor':
            return COLLISION_AT_ANCHOR_NOTICE;
        case 'unchecked':
            return COLLISION_UNCHECKED_NOTICE;
        case 'resumed': {
            // The real length: a short trip to the background is seconds, never rounded up to a minute.
            const sec = Math.max(0, Math.round(((n.resumedAt ?? n.since) - (n.pausedFrom ?? n.since)) / 1000));
            const span = sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
            return `Collision watch was paused for ${span} while Thalassa was in the background.`;
        }
        default:
            return null;
    }
}

/** A number keeps its unit on its line ('0.1 NM', '60 s'): the strip wraps at 320 pt in wide fonts. */
function keepUnits(text: string): string {
    return text.replace(/(\d) (NM|kn|s|min)\b/g, '$1\u00a0$2');
}

const FROM_PI = ' · FROM THE PI';
const HEARD_BY_PI = 'Heard by the Pi’s radio';

function piSignature(alarms: PiWatchAlarm[]): string {
    return alarms.map((a) => `${a.key}|${a.cpaNm}|${a.tcpaMin}|${a.rangeNm}|${a.bearingDeg}|${a.lost}`).join(';');
}

/** A Pi collision alarm (126-04a) as the phone's own card: the same words, marked as the Pi's. */
function piCollisionCard(a: PiWatchAlarm): CollisionAlertCard {
    return {
        mmsi: a.mmsi,
        name: a.name || `MMSI ${a.mmsi}`,
        distanceNm: a.rangeNm ?? 0,
        bearing: a.bearingDeg ?? 0,
        sog: null,
        cog: null,
        shipType: '',
        timestamp: a.raisedAt,
        collision: {
            cpaNm: a.cpaNm ?? 0,
            tcpaMin: a.tcpaMin ?? 0,
            closeQuarters: a.kind === 'close-quarters',
            reportAgeSec: null,
            source: 'pi',
            ...(a.lost ? { lost: { reason: a.lost, sinceMs: a.raisedAt, lastCpaAt: a.raisedAt } } : {}),
        },
    };
}

/** A Pi distress alarm (126-04a) as the phone's own beacon card. */
function piBeacon(a: PiWatchAlarm): DistressBeacon {
    return {
        mmsi: a.mmsi,
        name: a.name,
        kind: a.distressKind ?? 'sart',
        state: 'active',
        source: 'local',
        sounds: true,
        lat: a.positionKnown === false ? null : a.lat,
        lon: a.positionKnown === false ? null : a.lon,
        heardAt: a.raisedAt,
        rangeNm: a.rangeNm,
        bearingDeg: a.bearingDeg,
    };
}

/** The IEC 62288 AIS-SART mark, as on the chart. */
function DistressGlyph() {
    return (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.2" />
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="2.2" />
        </svg>
    );
}

function DistressCard({ beacon, nowMs, fromPi }: { beacon: DistressBeacon; nowMs: number; fromPi?: PiWatchAlarm }) {
    const lines = distressLines(beacon, nowMs);
    // From the Pi (126-04a): its Silence goes to the Pi; no Go to it (the phone does not hear her itself).
    const sounding = fromPi ? true : AisGuardAlertStore.distressSounding(beacon);
    const piNote = fromPi ? ' (from the Pi)' : '';
    const caution = beacon.state === 'caution';
    const button: React.CSSProperties = {
        ...ACTION,
        flex: 1,
        minWidth: 0,
        padding: '0 8px',
        borderRadius: 10,
        border: '1px solid rgba(254, 202, 202, 0.35)',
        background: 'rgba(0, 0, 0, 0.18)',
        color: 'inherit',
        fontSize: 13,
        fontWeight: 800,
    };
    return (
        <div
            role="alert"
            data-distress={beacon.state}
            style={{
                ...CARD,
                ...(caution
                    ? {
                          background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.95))',
                          border: '2px solid rgba(245, 158, 11, 0.8)',
                          color: 'var(--day-ui-warning, #fcd34d)',
                          boxShadow: 'none',
                      }
                    : { border: '2px solid rgba(255, 26, 26, 0.9)' }),
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <DistressGlyph />
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>
                        {lines.title}
                        {fromPi ? FROM_PI : ''}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>{lines.who}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{lines.where}</div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>{fromPi ? HEARD_BY_PI : lines.heard}</div>
                </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {sounding ? (
                    <button
                        type="button"
                        style={button}
                        aria-label={`Silence the distress alarm for ${lines.who}${piNote}`}
                        onClick={() =>
                            fromPi
                                ? PiNightWatchStatus.acknowledge(fromPi)
                                : AisGuardAlertStore.silenceDistress(beacon.mmsi)
                        }
                    >
                        Silence alarm
                    </button>
                ) : (
                    <button
                        type="button"
                        style={button}
                        aria-label={`Dismiss ${lines.label}`}
                        onClick={() => AisGuardAlertStore.dismissDistress(beacon.mmsi)}
                    >
                        Dismiss
                    </button>
                )}
                {lines.canGoTo && !fromPi && (
                    <button
                        type="button"
                        style={button}
                        aria-label={`Go to ${lines.label}`}
                        onClick={() => {
                            AisGuardAlertStore.goToDistress(beacon.mmsi);
                            useUIStore.getState().setPage('mob');
                        }}
                    >
                        Go to it
                    </button>
                )}
            </div>
        </div>
    );
}

function CollisionCard({ alert, fromPi }: { alert: CollisionAlertCard; fromPi?: PiWatchAlarm }) {
    const c = alert.collision;
    const lines = collisionLines(alert);
    const piNote = fromPi ? ' (from the Pi)' : '';
    const kind = c.closeQuarters ? 'CLOSE QUARTERS' : 'COLLISION RISK';
    const heading = c.cleared
        ? c.lost
            ? 'CONTACT LOST: NOT SHOWN CLEAR'
            : 'COLLISION RISK PASSED'
        : c.lost
          ? `${kind}: CPA UNKNOWN`
          : kind;
    const label =
        (c.cleared
            ? `Dismiss collision alert for ${alert.name}`
            : c.closeQuarters
              ? `Acknowledge close quarters with ${alert.name}`
              : `Mute ${alert.name} for 30 minutes`) + piNote;
    return (
        <div role="alert" style={{ ...CARD, opacity: c.cleared ? 0.8 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ fontSize: 18, lineHeight: '20px' }} aria-hidden="true">
                    ⚠️
                </span>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>
                        {heading}
                        {fromPi ? FROM_PI : ''}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>{alert.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{lines.cpa}</div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>
                        {lines.where} · {fromPi ? HEARD_BY_PI : lines.age}
                    </div>
                </div>
            </div>
            {/* Full width under the words, so the name keeps the card's width
                and the target is easy to hit on a moving boat. */}
            <button
                type="button"
                onClick={() =>
                    fromPi ? PiNightWatchStatus.acknowledge(fromPi) : AisGuardAlertStore.muteCollision(alert.mmsi)
                }
                aria-label={label}
                style={{
                    ...ACTION,
                    width: '100%',
                    marginTop: 8,
                    borderRadius: 10,
                    border: '1px solid rgba(254, 202, 202, 0.35)',
                    background: 'rgba(0, 0, 0, 0.18)',
                    fontSize: 13,
                    fontWeight: 800,
                }}
            >
                {c.cleared ? 'Dismiss' : c.closeQuarters ? 'Acknowledge' : 'Mute 30 min'}
            </button>
        </div>
    );
}

export const AisGuardAlert: React.FC = () => {
    // Read from the STORE, not the window event. Owning the list here meant an
    // alert raised on another page was heard by nobody, and coming back to the
    // chart replayed nothing — while AisGuardZone, being edge-triggered, would
    // not raise it again for a vessel that never left the ring.
    const [alerts, setAlerts] = useState<GuardAlert[]>(() => AisGuardAlertStore.get());
    const [notice, setNotice] = useState<CollisionWatchNotice | null>(() => AisGuardAlertStore.getWatchNotice());
    const [distress, setDistress] = useState<DistressBeacon[]>(() => AisGuardAlertStore.distressCards());
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => AisGuardAlertStore.subscribe(setAlerts), []);
    useEffect(() => AisGuardAlertStore.subscribeNotice(setNotice), []);
    useEffect(
        () =>
            AisGuardAlertStore.subscribeDistress(() => {
                setDistress(AisGuardAlertStore.distressCards());
                setNowMs(Date.now());
            }),
        [],
    );
    // The Pi's own alarms this phone has not carded (126-04a), as the Pi's word and this phone's cards change.
    // The Pi answers every 2 s: re-render only when what the cards say has changed.
    const [piAlarms, setPiAlarms] = useState<PiWatchAlarm[]>(() => PiNightWatchStatus.piCards());
    const refreshPi = useCallback(() => {
        const next = PiNightWatchStatus.piCards();
        setPiAlarms((prev) => (piSignature(prev) === piSignature(next) ? prev : next));
    }, []);
    useEffect(() => {
        const stops = [
            PiNightWatchStatus.subscribe(refreshPi),
            AisGuardAlertStore.subscribe(refreshPi),
            AisGuardAlertStore.subscribeDistress(refreshPi),
        ];
        return () => stops.forEach((stop) => stop());
    }, [refreshPi]);
    // A Pi gone quiet: its cards age out with its word.
    const showingPi = piAlarms.length > 0;
    useEffect(() => {
        if (!showingPi) return;
        const timer = setInterval(refreshPi, 5_000);
        return () => clearInterval(timer);
    }, [showingPi, refreshPi]);

    // A beacon's 'heard 12 s ago' keeps counting while its card shows.
    const showingDistress = distress.length > 0;
    useEffect(() => {
        if (!showingDistress) return;
        const timer = setInterval(() => setNowMs(Date.now()), 5_000);
        return () => clearInterval(timer);
    }, [showingDistress]);

    const dismiss = useCallback((mmsi: number) => AisGuardAlertStore.dismiss(mmsi), []);

    // The under-way alarms (126-02a): off route and shoal water, and what their watch cannot see.
    const [underway, setUnderway] = useState<{ cards: UnderwayAlarmCard[]; notices: string[] }>(() => ({
        cards: UnderwayAlarmStore.getCards(),
        notices: UnderwayAlarmStore.getNotices(),
    }));
    useEffect(() => {
        const sync = () => {
            const cards = UnderwayAlarmStore.getCards();
            const notices = UnderwayAlarmStore.getNotices();
            setUnderway((prev) => (prev.cards === cards && prev.notices === notices ? prev : { cards, notices }));
        };
        sync();
        return UnderwayAlarmStore.subscribe(sync);
    }, []);
    const showingUnderway = underway.cards.length > 0 || underway.notices.length > 0;

    // On the Go to it page the followed beacon's card stands aside: it would
    // cover the bearing, and the page carries the same facts and its Silence.
    const view = useUIStore((s) => s.currentView);
    const goTo = AisGuardAlertStore.getDistressGoTo();
    const shownDistress = view === 'mob' && goTo !== null ? distress.filter((b) => b.mmsi !== goTo) : distress;

    const status = notice ? noticeText(notice) : null;
    if (alerts.length === 0 && !status && shownDistress.length === 0 && piAlarms.length === 0 && !showingUnderway) {
        return null;
    }
    const alarming =
        piAlarms.length > 0 ||
        underway.cards.some((c) => c.sounding) ||
        alerts.some((a) => a.collision && !a.collision.cleared) ||
        shownDistress.some((b) => AisGuardAlertStore.distressSounding(b));
    const piDistress = piAlarms.filter((a) => a.kind === 'distress');
    const piCollision = piAlarms.filter((a) => a.kind !== 'distress');

    return (
        <div
            data-testid="ais-guard-stack"
            style={{
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top, 0px) + 60px)',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: alarming ? NIGHT_SCRIM_Z_INDEX + 1 : 9000,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                width: '90vw',
                maxWidth: 360,
                // Never under the tab bar: a long stack scrolls inside itself.
                maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 140px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                pointerEvents: 'auto',
            }}
        >
            {/* Distress first: it outranks every other alarm (125-02). */}
            {shownDistress.map((beacon) => (
                <DistressCard key={`d-${beacon.mmsi}`} beacon={beacon} nowMs={nowMs} />
            ))}
            {piDistress.map((alarm) => (
                <DistressCard key={`p-${alarm.key}`} beacon={piBeacon(alarm)} nowMs={nowMs} fromPi={alarm} />
            ))}
            {status && (
                <div
                    role="status"
                    style={{
                        ...CARD,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 12px',
                        background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.94))',
                        border: '1px solid rgba(245, 158, 11, 0.5)',
                        color: 'var(--day-ui-warning, #fcd34d)',
                        boxShadow: 'none',
                        fontSize: 13,
                        fontWeight: 700,
                    }}
                >
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{keepUnits(status)}</span>
                    {notice?.state === 'resumed' && (
                        <button
                            type="button"
                            aria-label="Dismiss collision watch notice"
                            onClick={() => AisGuardAlertStore.setWatchNotice({ state: 'watching', since: Date.now() })}
                            style={{ ...ACTION, color: 'inherit', fontSize: 16, marginRight: -6 }}
                        >
                            ✕
                        </button>
                    )}
                </div>
            )}
            {piCollision.map((alarm) => (
                <CollisionCard key={`p-${alarm.key}`} alert={piCollisionCard(alarm)} fromPi={alarm} />
            ))}
            {alerts
                .filter((alert) => alert.collision)
                .map((alert) => (
                    <CollisionCard key={`c-${alert.mmsi}`} alert={alert as CollisionAlertCard} />
                ))}
            {/* Shoal water, then off route (126-02a): under the collision cards, above the guard ring. */}
            {showingUnderway && (
                <UnderwayCardsBoundary cards={underway.cards} notices={underway.notices}>
                    <React.Suspense fallback={null}>
                        <UnderwayAlarmCards cards={underway.cards} notices={underway.notices} />
                    </React.Suspense>
                </UnderwayCardsBoundary>
            )}
            {alerts
                .filter((alert) => !alert.collision)
                .map((alert) => (
                    <div key={`${alert.mmsi}-${alert.timestamp}`} role="alert" style={CARD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 18 }}>🛡️</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 800,
                                        color: 'var(--day-ui-danger, #fca5a5)',
                                        letterSpacing: 0.5,
                                    }}
                                >
                                    GUARD ZONE ALERT
                                </div>
                                <div
                                    style={{
                                        fontSize: 13,
                                        fontWeight: 700,
                                        color: 'var(--day-ui-danger, #fee2e2)',
                                        marginTop: 2,
                                    }}
                                >
                                    {alert.name}
                                </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div
                                    style={{
                                        fontSize: 16,
                                        fontWeight: 800,
                                        color: 'var(--day-ui-danger, #fca5a5)',
                                        fontFamily: 'monospace',
                                    }}
                                >
                                    {alert.distanceNm.toFixed(1)} NM
                                </div>
                                {/* Bearing and speed of a target inside the guard
                                    ring are the two numbers the skipper acts on —
                                    they read at the size of the vessel name, not
                                    below it. Inline fontSize is out of reach of the
                                    CSS legibility floor. An unreported speed is a
                                    dash, never 0.0. */}
                                <div style={{ fontSize: 13, color: 'var(--day-ui-danger, #fca5a5)', opacity: 0.9 }}>
                                    {alert.bearing}° • {alert.sog == null ? '—' : alert.sog.toFixed(1)} kts
                                </div>
                            </div>
                            {/* The only way out. 44x44 so it is hittable on a
                                moving boat, and separated from the card body so
                                acknowledging is deliberate rather than accidental. */}
                            <button
                                type="button"
                                onClick={() => dismiss(alert.mmsi)}
                                aria-label={`Acknowledge guard alert for ${alert.name}`}
                                style={{ ...ACTION, marginRight: -8, fontSize: 18, lineHeight: 1 }}
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                ))}
        </div>
    );
};
