/**
 * AisLegend — Floating glass-pill legend + Guard Zone toggle.
 *
 * Renders a compact, horizontally scrollable strip along the bottom
 * of the map. Only visible when AIS layers are active.
 * Includes a shield icon toggle for the AIS Guard Zone.
 *
 * Build 126 (126-04a): with a Pi paired, the shield arms and stands down the
 * Pi's night watch too (services/piNightWatch.ts), and a line under it says
 * who is watching (utils/collisionWatchRow.ts): this phone, the Pi, both, or
 * that the Pi is still watching after a stand-down it could not hear; that
 * the Pi cannot see this phone's anchor watch; and, with this phone's shield
 * off, a two-tap 'Stand the Pi down' for every device. Ashore the Pi's word
 * comes from this account's own cloud row, read on its own while the key
 * shows and the boat LAN does not answer (CloudTelemetryService
 * followPiWatch: it feeds nothing else). No Pi paired: no line.
 *
 * Build 126 (126-04b): the line says whether the Pi can wake THIS phone,
 * claimed only once proved (utils/collisionWatchRow.ts), and aboard offers
 * "Send a test from the Pi": one push through the whole path, to try with
 * the phone locked.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { AisGuardZone, type GuardZoneState } from '../../services/AisGuardZone';
import { PiNightWatchStatus } from '../../services/piNightWatchStatus';
import { presentCollisionWatchRow, type CollisionWatchRow } from '../../utils/collisionWatchRow';
import { triggerHaptic } from '../../utils/system';
import { lazyRetry } from '../../utils/lazyRetry';
import { AIS_LEGEND_ITEMS } from './aisPresentationPalette';

/** The anchor's real sound check, in its collision wording (loaded only when arming). */
const SoundCheckModal = lazyRetry(
    () => import('../anchor-watch/SoundCheckModal').then((m) => ({ default: m.SoundCheckModal })),
    'SoundCheckModal',
);

const RADIUS_OPTIONS = [0.5, 1, 2, 5, 10];

const ROW_TONE: Record<CollisionWatchRow['tone'], { colour: string; border: string }> = {
    ok: { colour: 'var(--day-ui-success, #86efac)', border: 'rgba(34, 197, 94, 0.35)' },
    warn: { colour: 'var(--day-ui-warning, #fcd34d)', border: 'rgba(245, 158, 11, 0.5)' },
    quiet: { colour: 'var(--day-ui-muted, #94a3b8)', border: 'var(--day-ui-border, rgba(255, 255, 255, 0.08))' },
};

interface AisLegendProps {
    visible: boolean;
    /** Inline in a shared chart key, retaining the same guard controls. */
    embedded?: boolean;
}

export const AisLegend: React.FC<AisLegendProps> = ({ visible, embedded = false }) => {
    const [guardState, setGuardState] = useState<GuardZoneState>(AisGuardZone.getState());
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);
    const [soundCheck, setSoundCheck] = useState(false);

    useEffect(() => AisGuardZone.subscribe(setGuardState), []);

    // Who is watching (126-04a): the Pi's word, re-read as it arrives and as it ages.
    const [watchNow, setWatchNow] = useState(() => Date.now());
    useEffect(() => PiNightWatchStatus.subscribe(() => setWatchNow(Date.now())), []);
    const piView = PiNightWatchStatus.view(watchNow);
    const watchRow = presentCollisionWatchRow(
        {
            armed: guardState.enabled && guardState.collisionChecked === true,
            // Whether this phone puts the boat at anchor while the Pi keeps no anchor watch (piNightWatch reads it).
            anchorWatch: PiNightWatchStatus.phoneAnchorWatch(),
        },
        piView,
        watchNow,
    );
    const paired = piView.paired;
    const reachable = piView.reachable;
    // 'Stand the Pi down' for every device: a deliberate second tap within 5 s.
    const [confirmStandDown, setConfirmStandDown] = useState(false);
    useEffect(() => {
        if (!confirmStandDown) return;
        const timer = setTimeout(() => setConfirmStandDown(false), 5_000);
        return () => clearTimeout(timer);
    }, [confirmStandDown]);
    // "Send a test from the Pi" (126-04b): its answer stays on the button a few seconds.
    const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'internet-off' | 'failed'>('idle');
    useEffect(() => {
        if (testState === 'idle' || testState === 'sending') return;
        const timer = setTimeout(() => setTestState('idle'), 8_000);
        return () => clearTimeout(timer);
    }, [testState]);
    const testTone: CollisionWatchRow['tone'] =
        testState === 'sent' ? 'ok' : testState === 'idle' || testState === 'sending' ? 'quiet' : 'warn';
    const sendTest = useCallback(() => {
        triggerHaptic('light');
        setTestState('sending');
        void PiNightWatchStatus.sendTest()
            .catch(() => null)
            .then((result) =>
                setTestState(result?.queued ? 'sent' : result?.push === 'internet-off' ? 'internet-off' : 'failed'),
            );
    }, []);
    const standDownPi = useCallback(() => {
        triggerHaptic('medium');
        if (!confirmStandDown) {
            setConfirmStandDown(true);
            return;
        }
        setConfirmStandDown(false);
        PiNightWatchStatus.standDownForEveryone();
    }, [confirmStandDown]);
    useEffect(() => {
        if (!visible || !paired) return;
        const timer = setInterval(() => setWatchNow(Date.now()), 5_000);
        return () => clearInterval(timer);
    }, [visible, paired]);
    // Ashore: this account's own cloud row says whether the Pi is watching.
    // Read on its own while the key shows: it never starts the instrument
    // lane, so this phone's own position stays its own.
    useEffect(() => {
        if (!visible || !paired || reachable) return;
        let stop: (() => void) | null = null;
        let cancelled = false;
        void import('../../services/CloudTelemetryService')
            .then(({ CloudTelemetryService }) => {
                if (!cancelled) stop = CloudTelemetryService.followPiWatch();
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [visible, paired, reachable]);

    // The shield arms the collision watch too (build 125, 125-01), so arming
    // runs the real sound check first: the alarm it arms must be heard.
    // Disarming stays one tap.
    const toggleGuard = useCallback(() => {
        triggerHaptic('medium');
        if (guardState.enabled) AisGuardZone.setEnabled(false);
        else setSoundCheck(true);
    }, [guardState.enabled]);

    const selectRadius = useCallback((r: number) => {
        triggerHaptic('light');
        AisGuardZone.setRadius(r);
        setShowRadiusPicker(false);
    }, []);

    if (!visible) return null;

    return (
        <>
            <div
                role="group"
                aria-label="AIS vessel colours and guard controls"
                style={{
                    position: embedded ? 'static' : 'absolute',
                    bottom: embedded ? undefined : 'calc(28px + env(safe-area-inset-bottom, 0px))',
                    left: embedded ? undefined : '50%',
                    transform: embedded ? undefined : 'translateX(-50%)',
                    zIndex: embedded ? undefined : 400,
                    display: 'flex',
                    flexWrap: embedded ? 'wrap' : 'nowrap',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 14px',
                    background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.85))',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid var(--day-ui-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: 20,
                    boxShadow: 'var(--day-ui-shadow, 0 4px 24px rgba(0, 0, 0, 0.4))',
                    whiteSpace: embedded ? 'normal' : 'nowrap',
                    maxWidth: embedded ? '100%' : 'calc(100vw - 24px)',
                    overflowX: embedded ? undefined : 'auto',
                    overscrollBehaviorX: 'contain',
                    WebkitOverflowScrolling: 'touch',
                    scrollbarWidth: 'none',
                    animation: embedded ? undefined : 'aisLegendIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
                }}
            >
                {/* Guard Zone Shield Toggle */}
                <button
                    type="button"
                    aria-label={`${guardState.enabled ? 'Disable' : 'Enable'} AIS guard zone`}
                    aria-pressed={guardState.enabled}
                    className="hit-target-44"
                    /* The double-click handler is GONE. It shared this button with onClick,
                       so a double-tap toggled the guard ON then OFF on its way to opening
                       the radius picker — a picker that has its own button right beside this
                       one (audit 2026-09-02). The toggle stays immediate: a guard-zone
                       switch must not lag by a double-tap window. Long-press (contextmenu)
                       still opens the picker. */
                    onClick={toggleGuard}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setShowRadiusPicker((p) => !p);
                    }}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 8px',
                        borderRadius: 12,
                        border: `1px solid ${guardState.enabled ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255,255,255,0.06)'}`,
                        background: guardState.enabled ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'all 200ms ease',
                    }}
                    title={`Guard Zone ${guardState.enabled ? 'ON' : 'OFF'} — ${guardState.radiusNm} NM. Use the arrow to change radius.`}
                >
                    <span style={{ fontSize: 12 }}>🛡️</span>
                    <span
                        style={{
                            fontSize: 12,
                            fontWeight: 800,
                            color: guardState.enabled
                                ? 'var(--day-ui-danger, #fca5a5)'
                                : 'var(--day-ui-muted, #64748b)',
                            letterSpacing: 0.3,
                            fontFamily: '-apple-system, system-ui, sans-serif',
                        }}
                    >
                        {guardState.radiusNm} NM
                    </span>
                </button>
                <button
                    type="button"
                    aria-label="Choose AIS guard zone radius"
                    aria-expanded={showRadiusPicker}
                    className="hit-target-44"
                    onClick={() => setShowRadiusPicker((open) => !open)}
                    style={{
                        width: 28,
                        height: 28,
                        borderRadius: 12,
                        border: '1px solid var(--day-ui-border, rgba(255,255,255,0.08))',
                        background: showRadiusPicker ? 'rgba(56,189,248,0.15)' : 'transparent',
                        color: showRadiusPicker ? 'var(--day-ui-accent, #7dd3fc)' : 'var(--day-ui-muted, #64748b)',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                >
                    ▾
                </button>

                {/* Who is watching (126-04a): its own line, under the shield. */}
                {watchRow && (
                    <div
                        data-testid="collision-watch-row"
                        aria-live="polite"
                        style={{
                            flexBasis: embedded ? '100%' : undefined,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                            padding: '4px 8px',
                            borderRadius: 10,
                            border: `1px solid ${ROW_TONE[watchRow.tone].border}`,
                            whiteSpace: 'normal',
                            overflowWrap: 'anywhere',
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                        }}
                    >
                        <span style={{ fontSize: 12, fontWeight: 700, color: ROW_TONE[watchRow.tone].colour }}>
                            {watchRow.text}
                        </span>
                        {watchRow.note && (
                            <span style={{ fontSize: 11, color: 'var(--day-ui-muted, #94a3b8)' }}>{watchRow.note}</span>
                        )}
                        {watchRow.test && (
                            <button
                                type="button"
                                data-testid="collision-watch-send-test"
                                className="hit-target-44"
                                onClick={sendTest}
                                disabled={testState === 'sending'}
                                style={{
                                    alignSelf: 'flex-start',
                                    marginTop: 2,
                                    minHeight: 44,
                                    minWidth: 44,
                                    padding: '3px 10px',
                                    borderRadius: 10,
                                    border: `1px solid ${ROW_TONE[testTone].border}`,
                                    background: 'transparent',
                                    color: ROW_TONE[testTone].colour,
                                    fontSize: 12,
                                    fontWeight: 700,
                                    whiteSpace: 'normal',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                }}
                            >
                                {
                                    {
                                        idle: 'Send a test from the Pi',
                                        sending: 'Sending a test…',
                                        sent: 'Test sent: lock this phone and wait',
                                        'internet-off': "Not sent: the Pi's internet use is off",
                                        failed: "The Pi couldn't send it. Try again in a minute.",
                                    }[testState]
                                }
                            </button>
                        )}
                        {watchRow.action === 'stand-down-all' && (
                            <button
                                type="button"
                                data-testid="collision-watch-stand-down"
                                className="hit-target-44"
                                onClick={standDownPi}
                                aria-label={
                                    confirmStandDown
                                        ? 'Tap again to stand the Pi down for every device'
                                        : 'Stand the Pi down'
                                }
                                style={{
                                    alignSelf: 'flex-start',
                                    marginTop: 2,
                                    minHeight: 44,
                                    minWidth: 44,
                                    padding: '3px 10px',
                                    borderRadius: 10,
                                    border: `1px solid ${ROW_TONE[confirmStandDown ? 'warn' : 'quiet'].border}`,
                                    background: 'transparent',
                                    color: ROW_TONE[confirmStandDown ? 'warn' : 'quiet'].colour,
                                    fontSize: 12,
                                    fontWeight: 700,
                                    whiteSpace: 'normal',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                }}
                            >
                                {confirmStandDown ? 'Tap again: stand down for everyone' : 'Stand the Pi down'}
                            </button>
                        )}
                    </div>
                )}

                {/* Divider (the watch line already parts the controls from the colours in the key) */}
                {!(embedded && watchRow) && (
                    <div
                        style={{
                            width: 1,
                            height: 14,
                            background: 'var(--day-ui-surface-soft, rgba(255,255,255,0.08))',
                        }}
                    />
                )}

                {/* Type colours, plus the navigation-danger override. */}
                {AIS_LEGEND_ITEMS.map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div
                            aria-hidden="true"
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: color,
                                boxShadow: `0 0 5px ${color}80`,
                                flexShrink: 0,
                            }}
                        />
                        <span
                            style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: 'var(--day-ui-muted, #94a3b8)',
                                letterSpacing: 0.2,
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                            }}
                        >
                            {label}
                        </span>
                    </div>
                ))}
                <span style={{ fontSize: 10, color: 'var(--day-ui-muted, #94a3b8)' }}>
                    Boat: moving with known direction · Dot: stationary or direction unknown
                </span>
            </div>

            {soundCheck && (
                <React.Suspense fallback={null}>
                    <SoundCheckModal
                        purpose="collision"
                        onConfirm={() => {
                            setSoundCheck(false);
                            AisGuardZone.armAfterSoundCheck();
                        }}
                        onCancel={() => setSoundCheck(false)}
                    />
                </React.Suspense>
            )}

            {/* Radius picker popover */}
            {showRadiusPicker && (
                <div
                    style={{
                        position: embedded ? 'static' : 'absolute',
                        bottom: embedded ? undefined : 'calc(62px + env(safe-area-inset-bottom, 0px))',
                        left: embedded ? undefined : '50%',
                        transform: embedded ? undefined : 'translateX(-50%)',
                        zIndex: embedded ? undefined : 401,
                        display: 'flex',
                        flexWrap: embedded ? 'wrap' : 'nowrap',
                        gap: 6,
                        padding: '6px 10px',
                        background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.95))',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: '1px solid var(--day-ui-border, rgba(255, 255, 255, 0.1))',
                        borderRadius: 14,
                        boxShadow: 'var(--day-ui-shadow, 0 8px 32px rgba(0, 0, 0, 0.5))',
                        animation: embedded ? undefined : 'aisLegendIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    }}
                    role="group"
                    aria-label="AIS guard zone radius"
                >
                    {RADIUS_OPTIONS.map((r) => (
                        <button
                            type="button"
                            aria-label={`Set AIS guard zone radius to ${r} nautical miles`}
                            aria-pressed={r === guardState.radiusNm}
                            className="hit-target-44"
                            key={r}
                            onClick={() => selectRadius(r)}
                            style={{
                                padding: '4px 10px',
                                borderRadius: 10,
                                border: 'none',
                                background:
                                    r === guardState.radiusNm
                                        ? 'rgba(239, 68, 68, 0.3)'
                                        : 'var(--day-ui-surface-soft, rgba(255,255,255,0.05))',
                                color:
                                    r === guardState.radiusNm
                                        ? 'var(--day-ui-danger, #fca5a5)'
                                        : 'var(--day-ui-muted, #94a3b8)',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                                fontFamily: 'monospace',
                            }}
                        >
                            {r} NM
                        </button>
                    ))}
                </div>
            )}
        </>
    );
};
