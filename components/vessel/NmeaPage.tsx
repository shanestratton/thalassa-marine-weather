/**
 * NmeaPage — Standalone NMEA Gateway connection page for the Vessel Hub.
 *
 * Shows connection status, configuration controls, and AIS Hub settings.
 * The "Instrument Panel" CTA navigates to the full multimeter dashboard.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('NmeaPage');
import { NmeaStatusDot, useNmeaConnectionStatus } from '../nmea/useNmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { triggerHaptic } from '../../utils/system';
import { AisStore } from '../../services/AisStore';
import {
    getShareStats,
    isLowDataLink,
    isShareConfigured,
    isShareEnabled,
    setLowDataLink,
    setShareEnabled,
    subscribeShareStats,
} from '../../services/AisShareService';
import { Toggle } from '../settings/SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import { NMEA_DEVICE_PROFILES } from '../../services/NmeaDeviceProfiles';
import { GpsReceiverStatusService, type GpsReceiverStatus } from '../../services/GpsReceiverStatusService';

import { PageHeader } from '../ui/PageHeader';
import { useKeyboardScroll } from '../../hooks/useKeyboardScroll';
import { assessHostRoute, getInterfaces } from '../../services/network/networkContext';
import { FormField } from '../ui/FormField';
import { Button } from '../ui/Button';

interface NmeaPageProps {
    onBack: () => void;
    onNavigateToGlass?: () => void;
}

/**
 * Clear the app's OLD factory defaults so the YDWG-02 ones take effect.
 *
 * Two things were wrong with the version of this that ran in the render body.
 *
 * It ran on EVERY render — a side effect during render, so React's StrictMode
 * double-invoke ran it twice on mount and every subsequent re-render ran it
 * again. "One-time migration" was in the comment and nowhere in the code.
 *
 * And it deleted any saved port of 10110, unconditionally. 10110 is not a
 * stale default — it is the standard NMEA 0183 over TCP port, one this app's
 * own scanner offers as a candidate and labels as such. So a skipper who
 * deliberately configured a gateway on 10110 had that setting quietly removed
 * and replaced with the 1456 default, while the HOST was left alone: a
 * half-migration that manufactures a host/port pairing the user never chose.
 * On Shane's setup that pairing was the house Pi on the YDWG's own port,
 * which is the one combination that makes the app blame a Yacht Devices
 * gateway for a Raspberry Pi in the spare room (found 2026-08-28).
 *
 * Now: once, ever, recorded by a flag; and only the old default PAIR, because
 * a value is only a stale default if the value beside it is too.
 */
const LEGACY_DEFAULT_HOST = '192.168.1.1';
const LEGACY_DEFAULT_PORT = '10110';
const LEGACY_DEFAULTS_CLEARED_KEY = 'nmea_legacy_defaults_cleared';
let legacyDefaultsCheckedThisSession = false;

function clearLegacyGatewayDefaultsOnce(): void {
    if (legacyDefaultsCheckedThisSession) return;
    legacyDefaultsCheckedThisSession = true;
    try {
        if (localStorage.getItem(LEGACY_DEFAULTS_CLEARED_KEY)) return;
        localStorage.setItem(LEGACY_DEFAULTS_CLEARED_KEY, '1');
        const host = localStorage.getItem('nmea_host');
        const port = localStorage.getItem('nmea_port');
        // Only the pair. A host on 10110 that is not the old default host is
        // a real configuration, and deleting half of it is worse than
        // leaving all of it.
        if (host === LEGACY_DEFAULT_HOST && (port === LEGACY_DEFAULT_PORT || port === null)) {
            localStorage.removeItem('nmea_host');
            localStorage.removeItem('nmea_port');
        }
    } catch {
        /* storage unavailable — the defaults below still apply */
    }
}

/**
 * How this phone is placed relative to the gateway, right now.
 *
 * Deliberately modest about what it can know. iOS lets us see our own
 * interfaces and whether a tunnel is up; it does NOT let us enumerate which
 * subnets that tunnel carries. So when a VPN is running and we are not on the
 * gateway's LAN, the honest answer is "this works if your VPN carries that
 * network", not "you are connected".
 *
 * Renders nothing at all when we have no interface data — on web, and on any
 * failure. A false claim about the network is exactly what sent Shane looking
 * at the boat for a problem that was on his phone.
 */
const GatewayRouteNote: React.FC<{ host: string }> = ({ host }) => {
    const [state, setState] = useState<{ known: boolean; vpn: boolean; onLan: boolean; warning: string | null } | null>(
        null,
    );
    useEffect(() => {
        let alive = true;
        const check = async () => {
            const interfaces = await getInterfaces();
            const route = await assessHostRoute(host, 'the NMEA gateway');
            if (!alive) return;
            setState({
                known: interfaces.length > 0,
                vpn: route.vpnActive,
                onLan: route.onSameLan,
                warning: route.warning,
            });
        };
        void check();
        // Joining boat Wi-Fi or toggling the VPN is exactly what this reports
        // on, so it has to notice them doing it.
        const timer = setInterval(() => void check(), 20_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [host]);

    if (!state || !state.known) return null;

    // SILENT WHEN THERE IS NOTHING TO DO.
    //
    // This used to narrate all four states, including the two where everything
    // was working: "connecting directly", and "a VPN is up, so this works if
    // that VPN carries the boat's network". The second is the one Shane asked
    // to lose — it appears precisely when the setup is fine, and it is written
    // for someone who knows what a tunnel carries. "VPN's are for advanced
    // users only, so they will not [need] this. also it is buggering up my
    // screen" (2026-09-04). The hairpin nag went with it for the same reason.
    //
    // What is KEPT is the one state the skipper must act on: no route to the
    // gateway at all. Dropping that too would make a real failure silent,
    // which is the fault this whole page exists to prevent.
    if (state.onLan || state.vpn) return null;

    // Only one tone survives, because only one state still speaks.
    return (
        <div className="mb-3 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm leading-snug text-amber-200">
            You are not on {host}&apos;s network. Join the boat&apos;s Wi-Fi to reach the gateway.
        </div>
    );
};

export const NmeaPage: React.FC<NmeaPageProps> = ({ onBack, onNavigateToGlass }) => {
    // Idempotent and flag-guarded, so the render-phase call is safe under
    // StrictMode's double-invoke — it does its work once per install.
    clearLegacyGatewayDefaultsOnce();
    /* Container-scoped focus handling, the same pattern AnchorWatchPage uses.
       The app-wide guard owns keyboard geometry; this makes sure THIS
       scroller is the surface that moves when the host or port field takes
       focus. */
    const keyboardScrollRef = useKeyboardScroll<HTMLDivElement>();
    const [host, setHost] = useState(localStorage.getItem('nmea_host') || '192.168.1.151');
    const [port, setPort] = useState(localStorage.getItem('nmea_port') || '1456');
    const [device, setDevice] = useState(localStorage.getItem('nmea_device') || 'ydwg02');

    // Direct subscription to NmeaListenerService for connection status —
    // avoids the race condition where NmeaStore.start() misses the initial
    // 'connecting' status because NmeaListenerService.start() fires first.
    const [connStatus, setConnStatus] = useState(NmeaListenerService.getStatus());
    // The store, not the socket: 'remote' means the Instrument Panel is being
    // fed from the Pi's cloud snapshot because no socket is up. This page owns
    // the socket, so it says so rather than reading as a fault.
    const storeLink = useNmeaConnectionStatus();
    const readingViaCloud = storeLink.status === 'remote';
    const [reconnectAttempts, setReconnectAttempts] = useState(0);
    const [lastError, setLastError] = useState<string | null>(null);
    const [aisCount, setAisCount] = useState(0);

    useEffect(() => {
        const unsub = NmeaListenerService.onStatusChange((s) => {
            setConnStatus(s);
            setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
            setLastError(NmeaListenerService.getLastError());
        });
        // Sync on mount
        setConnStatus(NmeaListenerService.getStatus());
        setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
        setLastError(NmeaListenerService.getLastError());

        // Poll reconnect state every second (attempt count isn't event-driven
        // — it updates between status changes during the reconnect backoff)
        const poll = setInterval(() => {
            setReconnectAttempts(NmeaListenerService.getReconnectAttempts());
            setLastError(NmeaListenerService.getLastError());
            setConnStatus(NmeaListenerService.getStatus());
        }, 1000);

        // Subscribe to AIS target count updates
        const unsubAis = AisStore.subscribe((targets) => {
            setAisCount(targets.size);
        });

        return () => {
            unsub();
            clearInterval(poll);
            unsubAis();
        };
    }, []);

    const handleDeviceChange = useCallback((deviceId: string) => {
        setDevice(deviceId);
        localStorage.setItem('nmea_device', deviceId);
        const preset = NMEA_DEVICE_PROFILES.find((d) => d.id === deviceId);
        if (preset) {
            setPort(preset.port);
            localStorage.setItem('nmea_port', preset.port);
        }
    }, []);

    const isConnected = connStatus === 'connected';
    // 'error' used to be folded in here, so a FAILED connection rendered as
    // "Connecting..." forever — the screen never once said the word error
    // (Shane 2026-08-13: "it will not connect at all", with nothing on screen
    // saying so). Keep them apart: a failure has to look like a failure.
    const isConnecting = connStatus === 'connecting';
    const hasFailed = connStatus === 'error';

    // ── Position source ────────────────────────────────────────────────
    // Shane, 2026-08-02, with a Bad Elf GPS Pro+ paired: "there is no mention
    // of it anywhere in the app." He was right, and not because the detection
    // was missing — the whole chain exists — but because its ONLY consumer was
    // the system-status FAB, which returns null when nothing else is active
    // (SystemStatusButton.tsx:733). Bad Elf paired, no track running, no anchor
    // watch: activeCount 0, no FAB, and not one pixel in Thalassa naming a GPS
    // receiver. This page is where a skipper looks to ask "where is my data
    // coming from", so the answer lives here permanently.
    const [receiver, setReceiver] = useState<GpsReceiverStatus>(() => GpsReceiverStatusService.getStatus());
    useEffect(() => {
        let disposed = false;
        const refresh = () => {
            void GpsReceiverStatusService.refresh().then((r) => {
                if (!disposed) setReceiver(r);
            });
        };
        refresh();
        // refresh() reads a cache and enumerates accessories; it never starts
        // location services, so polling here costs no battery.
        const id = setInterval(refresh, 5000);
        return () => {
            disposed = true;
            clearInterval(id);
        };
    }, []);

    /*
     * The gateway scan is gone (Shane 2026-08-28: "lets get rid of the network
     * scan card, that is 5 parts useless").
     *
     * It was written after he sailed to Tangalooma without instruments because
     * the gateway's IP had been forgotten — a real problem, but the scan was a
     * poor answer to it. It offered any open port on a known gateway number as
     * a 'likely' candidate, which is how a silent AvNav listener on the house
     * Pi became his saved gateway; its probes could strand sockets in the
     * YDWG's three slots; and the address it hunts for is printed on the
     * device and set once in a boat's life.
     *
     * The default host is the YDWG-02's factory address, and the connection
     * error now names what actually went wrong. That is the better answer.
     */

    const handleConnect = useCallback(() => {
        triggerHaptic('medium');
        // Validate BEFORE touching the service. An empty or non-numeric port
        // reached configure() as NaN and the service fell back to its factory
        // default while the card and localStorage showed what was typed — a
        // connection to somewhere other than what the screen said (audit
        // 2026-09-02).
        const portNum = Number.parseInt(port, 10);
        if (!host.trim()) {
            setLastError('Enter the gateway host or IP address.');
            return;
        }
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            setLastError('Enter a port between 1 and 65535.');
            return;
        }
        try {
            // Always stop first so re-tapping Connect restarts cleanly
            NmeaListenerService.stop();
            NmeaStore.stop();
            // Save config
            localStorage.setItem('nmea_host', host);
            localStorage.setItem('nmea_port', port);
            // Configure fresh
            NmeaListenerService.configure(host, parseInt(port, 10));
            // Start store FIRST so it catches the initial 'connecting' status
            NmeaStore.start();
            NmeaListenerService.start();
        } catch (e) {
            log.error('NMEA connect failed:', e);
        }
    }, [host, port]);

    const handleDisconnect = useCallback(() => {
        triggerHaptic('medium');
        // IMPORTANT: Stop listener FIRST so the 'disconnected' status fires
        // while the store is still subscribed and can relay it to the UI.
        NmeaListenerService.stop();
        NmeaStore.stop();
    }, []);

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="NMEA Gateway"
                    subtitle="Instruments & AIS"
                    onBack={onBack}
                    breadcrumbs={["Ship's Office", 'NMEA Gateway']}
                    action={<NmeaStatusDot />}
                />

                {/* Content — fills viewport */}
                <div
                    ref={keyboardScrollRef}
                    className="flex-1 px-4 min-h-0 overflow-y-auto"
                    // nav + inset + 8px gap + the pinned CTA (~52px) + 8px,
                    // so the last card scrolls clear of the button instead of
                    // stopping underneath it.
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 68px)' }}
                >
                    {/* ═══ POSITION SOURCE ═══
                        Always rendered — including when the answer is just
                        "iPhone GPS". A skipper with a receiver plugged in
                        needs to see whether the app is using it, and silence
                        is the one answer that helps nobody. */}
                    <div className="shrink-0 mb-3 rounded-2xl border border-white/10 bg-white/3 p-4">
                        <div className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-400">
                            Position source
                        </div>
                        <div className="flex items-center gap-3">
                            <span
                                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                    receiver.kind === 'ios-accessory'
                                        ? 'bg-emerald-400'
                                        : receiver.kind === 'vessel-nmea'
                                          ? 'bg-sky-400'
                                          : receiver.kind === 'precision-location'
                                            ? 'bg-violet-400'
                                            : 'bg-slate-500'
                                }`}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[14px] font-bold text-white">
                                    {receiver.deviceName ?? receiver.label}
                                </div>
                                <div className="text-[11px] leading-snug text-gray-400">{receiver.detail}</div>
                            </div>
                        </div>
                        {receiver.kind === 'phone' && (
                            <p className="mt-2 text-[10px] leading-snug text-gray-500">
                                An MFi receiver (Bad Elf and similar) feeds iOS system-wide — it appears here once it
                                supplies a fix, with no setup needed.
                            </p>
                        )}
                    </div>

                    {/* ═══ CONNECTION CARD ═══ */}
                    <div
                        className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${
                            isConnected ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/3 border-white/6'
                        }`}
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div
                                className={`w-3 h-3 rounded-full ${
                                    isConnected
                                        ? 'bg-emerald-400'
                                        : isConnecting
                                          ? 'bg-amber-400 animate-pulse'
                                          : 'bg-gray-500'
                                }`}
                            />
                            <h3 className="text-sm font-black text-white">
                                {isConnected
                                    ? 'Connected'
                                    : isConnecting
                                      ? 'Connecting…'
                                      : hasFailed
                                        ? 'Connection failed'
                                        : 'Disconnected'}
                            </h3>
                            {readingViaCloud && !isConnected && !isConnecting && (
                                <span className="ml-auto rounded-full border border-sky-400/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-sky-300">
                                    Away · via the Pi
                                </span>
                            )}
                            {/* Show host:port when connected or connecting */}
                            {(isConnected || isConnecting || hasFailed) && (
                                <span className="text-xs text-white/70 font-mono ml-auto">
                                    {host}:{port}
                                </span>
                            )}
                            {/* AIS target count badge */}
                            {isConnected && aisCount > 0 && (
                                <span className="ml-2 px-2 py-0.5 rounded-lg bg-sky-500/15 border border-sky-500/20 text-[11px] font-black text-sky-400 uppercase tracking-wider">
                                    ⛴ {aisCount} AIS
                                </span>
                            )}
                        </div>

                        {/*
                         * "Enable remote access" USED to sit here, and it did
                         * not belong (Shane 2026-08-28: "i can still reach the
                         * ydwg-02 without it being connected??? so i am unsure
                         * of its purpose").
                         *
                         * He was right to be unsure. That control runs
                         * `tailscale up` ON THE PI — POST /api/remote-access/
                         * enable against pi-cache — and makes the PI reachable
                         * off the boat. It has nothing to do with the gateway.
                         * He reaches the YDWG-02 from home because his RUTX50
                         * advertises the boat's 192.168.1.0/24 to his tailnet
                         * and the route is approved, which is a router setting
                         * and is true whether the Pi is switched on, off, or
                         * sitting on his bench at home.
                         *
                         * Worse, it was mounted here AND in the Boat Pi tab,
                         * so one Pi setting had two switches on two screens. I
                         * moved it here this morning on the strength of "this
                         * is a better spot for it" and did not check what it
                         * actually did. It lives in the Boat Pi tab only.
                         *
                         * What belongs on THIS card is the question this card
                         * raises: can this phone reach THIS gateway from where
                         * it is standing right now.
                         */}
                        <GatewayRouteNote host={host} />

                        {/* Why it failed — shown on the FIRST failure, not
                            withheld until a retry, and never truncated.
                            Previously gated on reconnectAttempts > 0 and
                            wrapped in `truncate`, which clipped the tail of
                            "(SwiftSocket.SocketError error 3.)" — where the
                            only informative token, the final digit, lives.
                            Also survives the 5-minute park now, so the reason
                            is still on screen when it is finally read. */}
                        {(lastError || reconnectAttempts > 0) && !isConnected && (
                            <div className="mb-3 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/15">
                                {reconnectAttempts > 0 && (
                                    <p className="text-xs text-amber-300 font-medium">
                                        Reconnecting… attempt {reconnectAttempts}
                                    </p>
                                )}
                                {lastError && (
                                    <p className="mt-0.5 wrap-break-word text-sm leading-snug text-amber-200">
                                        {lastError}
                                    </p>
                                )}
                            </div>
                        )}

                        {!isConnected && !isConnecting && (
                            <div className="space-y-3 mb-3">
                                {/* Device preset selector */}
                                <div>
                                    <label className="block text-[11px] font-bold uppercase tracking-widest text-white/40 mb-1.5">
                                        Gateway Device
                                    </label>
                                    <select
                                        value={device}
                                        onChange={(e) => handleDeviceChange(e.target.value)}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-white font-medium outline-hidden appearance-none cursor-pointer transition-colors focus:border-sky-500/40"
                                        style={{
                                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                                            backgroundRepeat: 'no-repeat',
                                            backgroundPosition: 'right 12px center',
                                        }}
                                    >
                                        {NMEA_DEVICE_PROFILES.map((d) => (
                                            <option key={d.id} value={d.id} className="bg-slate-900 text-white">
                                                {d.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                {/* Host + Port. The scroll-margin keeps these
                                    clear of the sticky header when the keyboard
                                    shoves them up — they are the two fields on
                                    this page anyone actually types into. */}
                                <div className="thalassa-keyboard-safe-field flex gap-2">
                                    <div className="flex-1">
                                        <FormField
                                            label="Host IP"
                                            value={host}
                                            onChange={setHost}
                                            placeholder="192.168.1.151"
                                            mono
                                        />
                                    </div>
                                    <div className="w-24">
                                        <FormField
                                            label="Port"
                                            value={port}
                                            onChange={setPort}
                                            placeholder={
                                                NMEA_DEVICE_PROFILES.find((d) => d.id === device)?.port || '1456'
                                            }
                                            mono
                                            inputMode="numeric"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex gap-2">
                            {!isConnected && !isConnecting && (
                                <button
                                    onClick={handleConnect}
                                    aria-label="Connect NMEA"
                                    className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-sky-600 text-white shadow-lg shadow-sky-500/20 hover:bg-sky-500"
                                >
                                    Connect
                                </button>
                            )}
                            {isConnecting && (
                                <button
                                    onClick={handleConnect}
                                    aria-label="Retry NMEA connection"
                                    className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-sky-600 text-white shadow-lg shadow-sky-500/20 hover:bg-sky-500"
                                >
                                    <div className="flex items-center justify-center gap-2">
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        Retry
                                    </div>
                                </button>
                            )}
                            {isConnected && (
                                <button
                                    onClick={handleDisconnect}
                                    aria-label="Disconnect NMEA"
                                    className="flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30"
                                >
                                    Disconnect
                                </button>
                            )}
                            {isConnecting && (
                                <Button
                                    variant="secondary"
                                    onClick={handleDisconnect}
                                    aria-label="Cancel connection"
                                    className="uppercase tracking-widest text-gray-400 hover:text-white"
                                >
                                    Cancel
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* ═══ FLEET SHARING (opt-in crowd-feed) ═══
                        Replaces the old "AISHub contribution unavailable"
                        banner: the uplink exists now, via the cloud relay
                        (authorized by AISHub in writing, 2026-03-18 — one
                        port for all feeds). Consent is PER-DEVICE and off by
                        default; the copy states the exposure plainly: the
                        boat's OWN transponder reports are part of what is
                        shared, and AISHub is public. */}
                    <FleetSharingCard connected={isConnected} />
                </div>

                {/* ═══ INSTRUMENT PANEL CTA ═══
                    PINNED, not scrolled to. It used to be the last child of the
                    scroller, so the way into the Instrument Panel was only
                    visible once you had scrolled past every gateway setting —
                    the one thing on this page a skipper wants mid-passage was
                    the hardest to reach.

                    Shane 2026-09-04: "put the Instrument CTA Button at the
                    bottom of the screen, exactly 8px above the top of the menu
                    section". The nav is `h-16` + the safe-area inset
                    (App.tsx), so the top of the menu is 4rem + inset from the
                    bottom, and this sits 8px above that — the gap is derived
                    from the nav rather than eyeballed, so it stays 8px if the
                    nav ever changes height.

                    z-800 keeps it under the nav (z-900) and over the page. */}
                {onNavigateToGlass && (
                    <div
                        className="fixed left-0 right-0 z-800 px-4"
                        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                onNavigateToGlass();
                            }}
                            aria-label="Open Instrument Panel"
                            className="w-full py-3.5 rounded-2xl text-sm font-black uppercase tracking-[0.2em] transition-all active:scale-[0.97] bg-linear-to-r from-sky-600 via-cyan-500 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-cyan-500 border border-sky-400/20 flex items-center justify-center gap-2"
                        >
                            <span className="text-lg">🧭</span>
                            <span>Instrument Panel</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * The crowd-feed consent card and its disclaimer sheet.
 *
 * Two rules shape this UI, both learned the hard way elsewhere in the app:
 *
 *  1. TURNING IT ON IS A DECISION; TURNING IT OFF IS NOT. Enabling opens the
 *     full disclaimer and requires an explicit accept — because for a boat with
 *     a transponder, opting in publishes its own position publicly and that
 *     cannot be undone once AISHub copies it onward. Disabling is one tap with
 *     no friction, no confirmation and no "are you sure": consent withdrawal
 *     must never carry a cost.
 *  2. A DEAD CONTROL MUST LOOK DEAD. Inert-with-reason whenever the relay is
 *     unconfigured or the skipper is signed out, never a green light over
 *     nothing.
 *
 * Note what is NOT here any more: "waiting for the gateway". A disconnected
 * gateway no longer stops the watch — the check-in reports the fault and
 * standing is held — so telling the skipper sharing has stopped would be
 * false, and would push them to switch it off.
 */
const ConsentSheet: React.FC<{ onAccept: () => void; onDismiss: () => void }> = ({ onAccept, onDismiss }) => (
    <div
        className="fixed inset-0 z-200 flex items-center justify-center bg-black/70 p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
        role="dialog"
        aria-modal="true"
        aria-label="Share what you hear"
        onClick={onDismiss}
    >
        {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
        <div
            className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 p-5 pb-8"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
            <h2 className="text-lg font-bold text-gray-100">Share what you hear</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-gray-300">
                Turn this on and every AIS sentence your gateway hears gets sent to Thalassa&rsquo;s fleet map and on to
                AISHub, a public AIS network that copies it out to other tracking sites. It&rsquo;s off by default and
                it&rsquo;s entirely your call.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-amber-300">Your own boat becomes publicly trackable.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                If your setup transmits &mdash; any Class A or Class B transponder &mdash; your boat&rsquo;s own
                position reports go out with everything else. Your MMSI, your boat&rsquo;s name if it&rsquo;s programmed
                in, your position, course and speed, live, on public tracking websites, to anyone who cares to look.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                We can&rsquo;t take that back. Once it reaches AISHub it&rsquo;s copied onward within seconds and we
                have no way to reach the sites that copied it. Turning sharing off later stops new reports. It does not
                remove what&rsquo;s already out there.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Don&rsquo;t turn this on if there&rsquo;s any reason you&rsquo;d rather your boat wasn&rsquo;t findable
                &mdash; you sail alone, you&rsquo;re avoiding someone, or you&rsquo;re heading somewhere that being
                tracked is a risk.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                If your gear only receives and never transmits, nothing about your boat goes out. Only the ships you
                hear.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">Being heard by nobody still counts.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Anchored somewhere with no ships for 200 miles? That silence is worth as much as a busy harbour &mdash;
                it proves someone was listening out there. What we count is time on watch, never ships delivered. An
                empty ocean earns exactly what Sydney Harbour earns.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What we keep about you.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                One row: how many minutes you&rsquo;ve been on watch, when we last heard from you, and how many
                sentences you&rsquo;ve sent. Not where you were, not where you went, no history. It&rsquo;s deleted when
                your account is.
            </p>

            <h3 className="mt-5 text-[15px] font-bold text-gray-100">What this never affects.</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-300">
                Nothing here changes what you see from your own AIS receiver, the collision guard, the anchor radar, or
                any ship near you. That&rsquo;s safety data. It&rsquo;s never rationed, for anyone, and never will be.
            </p>

            <p className="mt-4 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Data cost.</span> About 5 MB a month when there&rsquo;s
                nothing to hear, more in busy water. Switch on Low-data link for a satellite connection and it&rsquo;s
                under 1 MB &mdash; you earn exactly the same either way.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                <span className="font-semibold text-gray-300">Turning it off.</span> One tap, any time. Sharing stops
                immediately.
            </p>

            <div className="mt-5 flex flex-col gap-2">
                <button
                    type="button"
                    onClick={onAccept}
                    className="rounded-xl bg-emerald-500 px-4 py-3 text-[15px] font-semibold text-slate-950 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Share what I hear
                </button>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="rounded-xl px-4 py-3 text-[15px] font-semibold text-emerald-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                    Not now
                </button>
            </div>
        </div>
    </div>
);

const FleetSharingCard: React.FC<{ connected: boolean }> = ({ connected }) => {
    const [enabled, setEnabled] = useState(() => isShareEnabled());
    const [lowData, setLowData] = useState(() => isLowDataLink());
    const [sheetOpen, setSheetOpen] = useState(false);
    const [, force] = useState(0);
    useEffect(() => subscribeShareStats(() => force((n) => n + 1)), []);
    // Sharing uploads through an authenticated endpoint — signed out, every
    // batch is dropped by getAuthenticatedFunctionHeaders. The card must not
    // claim "Sharing live" in that state (review, 2026-08-21).
    const signedIn = useAuthStore((state) => state.user !== null);

    const configured = isShareConfigured();
    const stats = getShareStats();
    const active = enabled && configured && signedIn;
    const hours = stats.card ? Math.floor(stats.card.watchMinutes / 60) : 0;

    return (
        <div className="shrink-0 mb-3 rounded-2xl border border-white/8 bg-slate-900/60 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-100">Share what you hear</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                        Contribute the AIS traffic this gateway hears to the Thalassa fleet map and to AISHub&rsquo;s
                        public network. Off by default &mdash; sharing is an explicit choice.
                    </p>
                </div>
                <Toggle
                    checked={enabled}
                    onChange={(value) => {
                        // ON asks first. OFF is immediate — withdrawal must
                        // never be made harder than consent.
                        if (value) {
                            setSheetOpen(true);
                            return;
                        }
                        setShareEnabled(false);
                        setEnabled(false);
                    }}
                    label="Share what you hear"
                />
            </div>

            {enabled && !configured && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    This build has no share relay configured &mdash; nothing is being sent.
                </p>
            )}
            {enabled && configured && !signedIn && (
                <p className="mt-2 text-[11px] font-semibold text-amber-300">
                    Sign in to share &mdash; the fleet feed needs a Thalassa account.
                </p>
            )}

            {active && (
                <>
                    <p className="mt-2 text-[11px] font-semibold text-emerald-300">
                        {stats.card
                            ? `On watch · ${hours.toLocaleString()} h total · ${stats.card.watchMinutes7d.toLocaleString()} min this week`
                            : 'On watch · first check-in on its way'}
                    </p>
                    {!connected && (
                        // Deliberately NOT an error. Standing is held through a
                        // gateway fault, and telling someone their contribution
                        // has stopped is how you get them to switch it off.
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Gateway down{stats.linkError ? ` — ${stats.linkError}` : ''}. Standing held. Nothing to fix
                            if the boat&rsquo;s ashore.
                        </p>
                    )}
                    {connected && stats.sharedTotal === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                            Nothing heard yet. If you&rsquo;re offshore that&rsquo;s exactly what we&rsquo;d expect, and
                            it still counts.
                        </p>
                    )}
                    {stats.rejected && stats.rejected.checksum > 0 && stats.rejected.notAis === 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
                            Most sentences are failing their checksum &mdash; usually a baud-rate or NMEA-0183 wiring
                            fault.
                        </p>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/6 pt-3">
                        <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-gray-200">Low-data link</p>
                            <p className="text-[11px] leading-relaxed text-gray-400">
                                Check in every 30 minutes instead of 5, for satellite. Earns exactly the same.
                            </p>
                        </div>
                        <Toggle
                            checked={lowData}
                            onChange={(value) => {
                                setLowDataLink(value);
                                setLowData(value);
                            }}
                            label="Low-data link"
                        />
                    </div>
                </>
            )}

            {sheetOpen && (
                <ConsentSheet
                    onAccept={() => {
                        setShareEnabled(true);
                        setEnabled(true);
                        setSheetOpen(false);
                        triggerHaptic();
                    }}
                    onDismiss={() => setSheetOpen(false)}
                />
            )}
        </div>
    );
};
