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
 * own motion unknown, stopped) rather than looking like an empty sea. While a collision card shows, the stack rises above the night tint
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
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { GuardAlert } from '../../services/AisGuardZone';
import { useUIStore } from '../../stores/uiStore';
import {
    AisGuardAlertStore,
    distressLines,
    type DistressBeacon,
    COLLISION_BLIND_NOTICE,
    COLLISION_NO_FIX_NOTICE,
    COLLISION_NO_MOTION_NOTICE,
    COLLISION_PAUSED_NOTICE,
    COLLISION_STOPPED_NOTICE,
    COLLISION_UNCHECKED_NOTICE,
    collisionLines,
    type CollisionAlertCard,
    type CollisionWatchNotice,
} from '../../services/aisGuardAlertStore';
import { NIGHT_SCRIM_Z_INDEX } from '../ui/OverlayPortal';

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

function noticeText(n: CollisionWatchNotice): string | null {
    switch (n.state) {
        case 'blind':
            return COLLISION_BLIND_NOTICE;
        case 'paused':
            return COLLISION_PAUSED_NOTICE;
        case 'no-fix':
            return COLLISION_NO_FIX_NOTICE;
        case 'no-motion':
            return COLLISION_NO_MOTION_NOTICE;
        case 'stopped':
            return COLLISION_STOPPED_NOTICE;
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

/** The IEC 62288 AIS-SART mark, as on the chart. */
function DistressGlyph() {
    return (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.2" />
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="2.2" />
        </svg>
    );
}

function DistressCard({ beacon, nowMs }: { beacon: DistressBeacon; nowMs: number }) {
    const lines = distressLines(beacon, nowMs);
    const sounding = AisGuardAlertStore.distressSounding(beacon);
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
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>{lines.title}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>{lines.who}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{lines.where}</div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>{lines.heard}</div>
                </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {sounding ? (
                    <button
                        type="button"
                        style={button}
                        aria-label={`Silence the distress alarm for ${lines.who}`}
                        onClick={() => AisGuardAlertStore.silenceDistress(beacon.mmsi)}
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
                {lines.canGoTo && (
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

function CollisionCard({ alert }: { alert: CollisionAlertCard }) {
    const c = alert.collision;
    const lines = collisionLines(alert);
    const kind = c.closeQuarters ? 'CLOSE QUARTERS' : 'COLLISION RISK';
    const heading = c.cleared
        ? c.lost
            ? 'CONTACT LOST: NOT SHOWN CLEAR'
            : 'COLLISION RISK PASSED'
        : c.lost
          ? `${kind}: CPA UNKNOWN`
          : kind;
    const label = c.cleared
        ? `Dismiss collision alert for ${alert.name}`
        : c.closeQuarters
          ? `Acknowledge close quarters with ${alert.name}`
          : `Mute ${alert.name} for 30 minutes`;
    return (
        <div role="alert" style={{ ...CARD, opacity: c.cleared ? 0.8 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ fontSize: 18, lineHeight: '20px' }} aria-hidden="true">
                    ⚠️
                </span>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>{heading}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>{alert.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{lines.cpa}</div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>
                        {lines.where} · {lines.age}
                    </div>
                </div>
            </div>
            {/* Full width under the words, so the name keeps the card's width
                and the target is easy to hit on a moving boat. */}
            <button
                type="button"
                onClick={() => AisGuardAlertStore.muteCollision(alert.mmsi)}
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
    // A beacon's 'heard 12 s ago' keeps counting while its card shows.
    const showingDistress = distress.length > 0;
    useEffect(() => {
        if (!showingDistress) return;
        const timer = setInterval(() => setNowMs(Date.now()), 5_000);
        return () => clearInterval(timer);
    }, [showingDistress]);

    const dismiss = useCallback((mmsi: number) => AisGuardAlertStore.dismiss(mmsi), []);

    // On the Go to it page the followed beacon's card stands aside: it would
    // cover the bearing, and the page carries the same facts and its Silence.
    const view = useUIStore((s) => s.currentView);
    const goTo = AisGuardAlertStore.getDistressGoTo();
    const shownDistress = view === 'mob' && goTo !== null ? distress.filter((b) => b.mmsi !== goTo) : distress;

    const status = notice ? noticeText(notice) : null;
    if (alerts.length === 0 && !status && shownDistress.length === 0) return null;
    const alarming =
        alerts.some((a) => a.collision && !a.collision.cleared) ||
        shownDistress.some((b) => AisGuardAlertStore.distressSounding(b));

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
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{status}</span>
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
            {alerts.map((alert) =>
                alert.collision ? (
                    <CollisionCard key={`c-${alert.mmsi}`} alert={alert as CollisionAlertCard} />
                ) : (
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
                ),
            )}
        </div>
    );
};
