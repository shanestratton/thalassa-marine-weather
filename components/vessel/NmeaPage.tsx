/**
 * NmeaPage — Standalone NMEA Gateway connection page for the Vessel Hub.
 *
 * Shows connection status, configuration controls, and AIS Hub settings.
 * The "Instrument Panel" CTA navigates to the full multimeter dashboard.
 */
import React, { useState, useCallback, useEffect, useId } from 'react';
import { InstrumentSourcePolicy } from '../../services/InstrumentSourcePolicy';
import { getPairing } from '../../services/PiPairingService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('NmeaPage');
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { triggerHaptic } from '../../utils/system';
import { AisStore } from '../../services/AisStore';
import { NMEA_DEVICE_PROFILES } from '../../services/NmeaDeviceProfiles';
import { GpsReceiverStatusService, type GpsReceiverStatus } from '../../services/GpsReceiverStatusService';

import { PageHeader } from '../ui/PageHeader';
import { useKeyboardScroll } from '../../hooks/useKeyboardScroll';
import { useBoatLink } from '../../hooks/useBoatLink';
import type { Tone } from '../../services/boatLink/boatLinkModel';
import { BoatLinkPill } from './BoatLinkPill';
import { Button } from '../ui/Button';
import { BoatIcon, GaugeIcon } from '../Icons';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';

/** A field label on this page: sentence case at label size, so it reads under
 *  the card's capital eyebrow (GATEWAY) rather than as its peer (UX scorecard
 *  run 10, nmea-labels). */
const FIELD_LABEL = 'block text-label font-bold text-gray-400';

/**
 * Host IP and Port. FormField's input and keyboard handling, with this page's
 * sentence-case label and an optional quiet hint. FormField owns the app's
 * capital field-label token, which is what set 'HOST IP (DEFAULT)' level with
 * the section eyebrow above it. The hint follows the label on its own
 * line, not on a line under the input: there it pushed Connect into the tab
 * bar's fade at 375x667.
 */
const GatewayField: React.FC<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    hint?: string;
    inputMode?: 'text' | 'numeric';
}> = ({ label, value, onChange, placeholder, hint, inputMode }) => {
    const fieldId = useId();
    const hintId = hint ? `${fieldId}-hint` : undefined;
    return (
        <div>
            <div className="flex items-baseline gap-2">
                <label htmlFor={fieldId} className={`${FIELD_LABEL} shrink-0`}>
                    {label}
                </label>
                {hint && (
                    <span id={hintId} className="min-w-0 text-xs font-medium leading-snug text-gray-400">
                        {hint}
                    </span>
                )}
            </div>
            <input
                id={fieldId}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                inputMode={inputMode}
                aria-describedby={hintId}
                onFocus={scrollInputAboveKeyboard}
                className="w-full min-w-0 min-h-11 mt-0.5 bg-white/5 border border-white/10 focus:border-sky-500/30 rounded-xl px-3 py-2 text-white text-sm font-mono outline-hidden transition-colors placeholder:text-gray-400"
            />
        </div>
    );
};

/** The pinned Instrument Panel button's height. The scroller clears it plus
 *  12 px, and fades its content out just above it (UX scorecard run 6: at
 *  375×667 the bar sat over CONNECT with only a hidden scrollbar hinting). */
const CTA_HEIGHT_PX = 52;

/** Room the scroller keeps for the pinned CTA: the 8px gap plus the button.
 *  Zero on short screens (max-height 700px), where the CTA flows after the
 *  connection card instead of being pinned — pinned, it still hid Connect and
 *  the foot of the Host IP and Port fields at 375×667 (UX scorecard run 7). */
const CTA_RESERVE_CLASS = '[--nmea-cta-reserve:60px] [@media(max-height:700px)]:[--nmea-cta-reserve:0px]'; // 60 = 8 + CTA_HEIGHT_PX

interface NmeaPageProps {
    onBack: () => void;
    onNavigateToGlass?: () => void;
}

/**
 * The way into the Instrument Panel. The house secondary while the page still
 * offers Connect, so Connect is the one primary on the page; the primary once
 * there is a feed to look at (UX scorecard run 7). Opaque in both styles:
 * pinned, it sits over scrolled cards, so the translucent secondary gets a
 * solid backing of its own shape.
 */
const InstrumentPanelButton: React.FC<{ quiet: boolean; onOpen: () => void }> = ({ quiet, onOpen }) => {
    const open = () => {
        triggerHaptic('medium');
        onOpen();
    };
    // Named by its visible words (the glyph is aria-hidden), so Voice
    // Control's "Tap Instrument Panel" finds it; "Open Instrument Panel" did
    // not start with them.
    const label = (
        <>
            <GaugeIcon className="h-5 w-5 shrink-0" />
            <span>Instrument Panel</span>
        </>
    );
    return quiet ? (
        <div className="rounded-xl bg-slate-900 shadow-lg shadow-black/30">
            <Button
                variant="secondary"
                onClick={open}
                className="w-full text-white"
                style={{ minHeight: CTA_HEIGHT_PX }}
            >
                {label}
            </Button>
        </div>
    ) : (
        <Button variant="primary" onClick={open} className="w-full" style={{ minHeight: CTA_HEIGHT_PX }}>
            {label}
        </Button>
    );
};

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
/** The host the field starts on before anything is saved. A default, not a
 *  detection: the field says so while it still holds it (UX scorecard run 9). */
const DEFAULT_GATEWAY_HOST = '192.168.1.151';

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

/** The gateway card's wash, by the boat link's tone: one state, one look. */
const CARD_TONE: Record<Tone, string> = {
    green: 'bg-emerald-500/10 border-emerald-500/20',
    sky: 'bg-sky-500/10 border-sky-500/20',
    amber: 'bg-white/3 border-white/6',
    red: 'bg-white/3 border-white/6',
    grey: 'bg-white/3 border-white/6',
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
    const [host, setHost] = useState(localStorage.getItem('nmea_host') || DEFAULT_GATEWAY_HOST);
    const [port, setPort] = useState(localStorage.getItem('nmea_port') || '1456');
    const [device, setDevice] = useState(localStorage.getItem('nmea_device') || 'ydwg02');

    // Direct subscription to NmeaListenerService for connection status —
    // avoids the race condition where NmeaStore.start() misses the initial
    // 'connecting' status because NmeaListenerService.start() fires first.
    const [connStatus, setConnStatus] = useState(NmeaListenerService.getStatus());
    // Where this phone is, how the boat reaches it, and how fresh — one
    // answer for every screen (services/boatLink). Shane 2026-10-07, at home
    // with the boat 900 km away over Tailscale: this page said "Aboard",
    // "Away" and "Connected" in turn while nobody moved, because it read the
    // place off whichever transport had answered last.
    const link = useBoatLink();
    // Shane 2026-09-07: "no more signal k or ydwg-02 on the actual phone unless
    // there is no pi available." With a Pi paired the policy keeps this socket
    // shut and the phone reads her through the Pi; Connect here is the
    // skipper's override for a Pi that is down.
    const piPaired = getPairing() !== null;
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
    const [showDirect, setShowDirect] = useState(false);
    // With a Pi paired and no socket of the skipper's own, the card is about
    // the Pi: the direct-connection controls roll up behind one link (Shane
    // 2026-09-08: "if we have a pi at the vessel, then nothing should try to
    // connect"). The layout follows WHO is in charge, not the socket's status
    // from one second to the next: it used to swap to host:port with Retry
    // and Cancel whenever the policy's fallback socket was mid-attempt, and
    // back again when it failed — "gateway settings, sometime take over"
    // (Shane 2026-10-07). A fallback socket is one line on the Pi card now.
    const skipperSocket = link.socketOwner === 'skipper';
    const piMode = piPaired && !skipperSocket;
    const rolledUp = piMode && !showDirect;
    // The socket's own controls belong to a socket this page answers for: the
    // skipper's, or a gateway-only boat's. Never the policy's fallback.
    const socketControls = !piMode || skipperSocket;
    const showConnected = isConnected && socketControls;
    const showConnecting = isConnecting && socketControls;
    const showFailed = hasFailed && socketControls;
    // The page's next step is Connect exactly when these controls show.
    const connectShowing = !showConnected && !showConnecting && !rolledUp;

    // With nothing ever saved, there is no gateway to be disconnected from:
    // the same neutral 'No gateway' the Instrument Panel pill shows, so one
    // state has one word on both pages (UX scorecard run 7).
    const gatewaySaved = NmeaListenerService.getSavedConfig() !== null;
    const hostIsDefault = !gatewaySaved && host === DEFAULT_GATEWAY_HOST;

    // The connection state, said ONCE — in the header's status pill — and in
    // the same words the Instrument Panel, the Vessel page and the System
    // status box use: WHERE · DATA ('Away · Live', 'Aboard · 40 s old',
    // 'Connection failed'), from link.pill. The card used to repeat it as an
    // h2 beside a second dot, under a pill that said it a third time (UX
    // scorecard run 6).
    const deviceSelectId = useId();

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
            InstrumentSourcePolicy.noteManualConnect();
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
        InstrumentSourcePolicy.noteManualDisconnect();
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
                    // Opens from the Vessel hub, so the trail names the Vessel.
                    breadcrumbs={['Vessel', 'NMEA Gateway']}
                    // A status, not a control: in the action slot the chip
                    // squeezed NMEA GATEWAY onto two lines (four at 375 pt).
                    // PageHeader puts status on its own row under the title.
                    // Said as WHERE and DATA chips (BoatLinkPill), so the
                    // pair wraps at 320 pt rather than clipping; one reading
                    // for a screen reader: link.pill.text.
                    status={<BoatLinkPill pill={link.pill} pulse={link.data.state === 'connecting'} />}
                />

                {/* Content — fills viewport */}
                <div
                    ref={keyboardScrollRef}
                    className={`flex-1 px-4 min-h-0 overflow-y-auto ${onNavigateToGlass ? `thalassa-scroll-fade ${CTA_RESERVE_CLASS}` : ''}`}
                    // nav + inset + the CTA reserve (8px gap + the pinned
                    // CTA; zero where it flows in the cards) + 12px, so the
                    // last card scrolls clear of the button instead of
                    // stopping underneath it. The fade ends at the CTA's top
                    // edge, so a card running under it reads as continuing.
                    style={
                        {
                            paddingBottom:
                                'calc(4rem + env(safe-area-inset-bottom) + var(--nmea-cta-reserve, 0px) + 12px)',
                            '--thalassa-scroll-fade-inset':
                                'calc(4rem + env(safe-area-inset-bottom) + var(--nmea-cta-reserve, 0px))',
                        } as React.CSSProperties
                    }
                >
                    {/* ═══ POSITION SOURCE ═══
                        Always rendered — including when the answer is just
                        "iPhone GPS". A skipper with a receiver plugged in
                        needs to see whether the app is using it, and silence
                        is the one answer that helps nobody. */}
                    {/* Tighter on short screens (max-height 700px): at 375x667
                        the Connect button sat in the tab bar's fade and the
                        Instrument Panel entry was wholly below the fold (UX
                        scorecard run 8). Same for the connection card below. */}
                    <div className="shrink-0 mb-3 rounded-2xl border border-white/10 bg-white/3 p-4 [@media(max-height:700px)]:mb-2 [@media(max-height:700px)]:p-3">
                        {/* h2: the page title is the h1, and each card here is a
                            section of it (UX referee A-heading-outline). */}
                        <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-gray-400">
                            Position source
                        </h2>
                        {/* The source's colour dot at 8 pt, set on the title's line
                            like the header pill's dot, beside the source's name:
                            a 10 pt dot centred on two lines read as an unselected
                            radio button (UX scorecard run 10, nmea-labels). */}
                        <div className="flex items-start gap-2.5">
                            <span
                                aria-hidden="true"
                                className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${
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
                                <div className="text-xs leading-snug text-gray-400">{receiver.detail}</div>
                            </div>
                        </div>
                        {receiver.kind === 'phone' && (
                            <p className="mt-2 text-xs leading-snug text-gray-400 [@media(max-height:700px)]:mt-1.5">
                                A plug-in or Bluetooth GPS made for iPhone (Bad Elf and similar) shows here once it
                                supplies a fix. No setup needed.
                            </p>
                        )}
                    </div>

                    {/* ═══ CONNECTION CARD ═══ */}
                    <div
                        data-testid="gateway-card"
                        className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all [@media(max-height:700px)]:mb-2 [@media(max-height:700px)]:p-3 ${
                            CARD_TONE[link.pill.tone]
                        }`}
                    >
                        {/* The card's eyebrow, as POSITION SOURCE has one (UX
                            scorecard run 9). It names the section, not the
                            state: the header pill says that (run 6). What
                            stays is what only this card knows — where the
                            socket points, what it hears, and that the panel is
                            reading her through the Pi. */}
                        <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-gray-400">Gateway</h2>
                        {/* How the boat reaches this phone, in one sentence —
                            the boat's Wi-Fi, a VPN to her network, the Pi's
                            internet updates — and, when the place is unknown,
                            why. The pill above says where and how fresh. */}
                        {link.line && (
                            <p
                                data-testid="gateway-link-line"
                                className="mb-2 text-sm leading-snug text-gray-200 [@media(max-height:700px)]:mb-1.5"
                            >
                                {link.line}
                            </p>
                        )}
                        {link.whereNote && (
                            <p data-testid="gateway-where-note" className="mb-2 text-xs leading-snug text-gray-400">
                                {link.whereNote}
                            </p>
                        )}
                        {(showConnected || showConnecting || showFailed) && !rolledUp && (
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                {/* Show host:port when connected or connecting */}
                                <span className="text-xs text-white/70 font-mono">
                                    {host}:{port}
                                </span>
                                {/* AIS target count badge */}
                                {showConnected && aisCount > 0 && (
                                    <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-sky-500/15 border border-sky-500/20 text-xs font-bold text-sky-400">
                                        <BoatIcon className="h-3.5 w-3.5" />
                                        {aisCount} AIS
                                    </span>
                                )}
                            </div>
                        )}

                        {/* The next step, for the plain disconnected card. One line
                            at 375 pt: "check the IP below" still wrapped "Connect."
                            onto a second (UX scorecard runs 8 and 9); the field
                            below is the Host IP. */}
                        {connectShowing && !showFailed && !link.line && (
                            <p className="mb-3 text-xs leading-snug text-gray-300 [@media(max-height:700px)]:mb-2">
                                Join the boat&apos;s Wi-Fi, check the IP, then Connect.
                            </p>
                        )}

                        {/*
                         * "Enable remote access" USED to sit here, and it did
                         * not belong (Shane 2026-08-28). That control runs
                         * `tailscale up` ON THE PI and lives in the Boat Pi
                         * tab only. A route note that guessed "you are not on
                         * this network" from a /24 match lived here too until
                         * 2026-10-07: 192.168.1.0/24 is the world's commonest
                         * home network, so it went quiet at home and spoke on
                         * the boat. The line above answers the same question
                         * from where the phone actually is.
                         */}

                        {piMode && (
                            <div className="mb-3 px-3 py-2 rounded-xl bg-sky-500/10 border border-sky-500/15 text-xs leading-snug text-sky-200">
                                <p>
                                    Your Pi is paired, so nothing on this page connects on its own &mdash; the gateway
                                    settings are only for when the Pi is down.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setShowDirect((v) => !v)}
                                    aria-expanded={showDirect}
                                    data-testid="nmea-gateway-direct-toggle"
                                    className="mt-0.5 inline-flex min-h-[44px] items-center text-xs font-bold text-sky-300 underline-offset-2 hover:underline"
                                >
                                    {showDirect
                                        ? 'Hide the gateway settings'
                                        : 'Gateway settings — only if the Pi is down'}
                                </button>
                            </div>
                        )}

                        {/* Why it failed — shown on the FIRST failure, not
                            withheld until a retry, and never truncated.
                            Previously gated on reconnectAttempts > 0 and
                            wrapped in `truncate`, which clipped the tail of
                            "(SwiftSocket.SocketError error 3.)" — where the
                            only informative token, the final digit, lives.
                            Also survives the 5-minute park now, so the reason
                            is still on screen when it is finally read. */}
                        {(lastError || reconnectAttempts > 0) && !isConnected && !rolledUp && socketControls && (
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

                        {!showConnected && !showConnecting && !rolledUp && (
                            <div className="space-y-3 mb-3 [@media(max-height:700px)]:space-y-2 [@media(max-height:700px)]:mb-2">
                                {/* Device preset selector */}
                                <div>
                                    <label htmlFor={deviceSelectId} className={`${FIELD_LABEL} mb-1`}>
                                        Gateway device
                                    </label>
                                    {/* .thalassa-select draws the chevron in both palettes; an
                                        inline data-URI was swapped for an unsized, oversized
                                        glyph by the daylight rule (UX scorecard run 6). */}
                                    <select
                                        id={deviceSelectId}
                                        value={device}
                                        onChange={(e) => handleDeviceChange(e.target.value)}
                                        className="thalassa-select w-full min-h-[44px] pl-3 pr-9 py-2.5 rounded-xl bg-white/6 border border-white/10 text-sm text-white font-medium outline-hidden appearance-none cursor-pointer transition-colors focus:border-sky-500/40"
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
                                    <div className="flex-1 min-w-0">
                                        {/* Pre-filled on a fresh install, which read as
                                            detected (UX scorecard run 9): a quiet hint
                                            says it is the default until it is changed or
                                            saved. It was '(DEFAULT)' in the label's
                                            capitals (run 10). */}
                                        <GatewayField
                                            label="Host IP"
                                            value={host}
                                            onChange={setHost}
                                            placeholder={DEFAULT_GATEWAY_HOST}
                                            // Not "YDWG-02 factory default": .151 is an
                                            // address on a boat LAN, not a factory
                                            // setting, so the hint claims only what
                                            // is true of it.
                                            hint={hostIsDefault ? 'Default, not detected' : undefined}
                                        />
                                    </div>
                                    <div className="w-24">
                                        <GatewayField
                                            label="Port"
                                            value={port}
                                            onChange={setPort}
                                            placeholder={
                                                NMEA_DEVICE_PROFILES.find((d) => d.id === device)?.port || '1456'
                                            }
                                            inputMode="numeric"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex gap-2">
                            {connectShowing && (
                                <Button
                                    variant="primary"
                                    onClick={handleConnect}
                                    aria-label="Connect NMEA"
                                    className="flex-1"
                                >
                                    Connect
                                </Button>
                            )}
                            {showConnecting && (
                                <Button
                                    variant="primary"
                                    onClick={handleConnect}
                                    aria-label="Retry NMEA connection"
                                    className="flex-1"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
                                    />
                                    Retry
                                </Button>
                            )}
                            {showConnected && (
                                <Button
                                    variant="danger"
                                    onClick={handleDisconnect}
                                    aria-label="Disconnect NMEA"
                                    className="flex-1"
                                >
                                    Disconnect
                                </Button>
                            )}
                            {showConnecting && (
                                <Button
                                    variant="secondary"
                                    onClick={handleDisconnect}
                                    aria-label="Cancel connection"
                                    className="text-gray-300 hover:text-white"
                                >
                                    Cancel
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Short screens only: the CTA flows here, after Connect,
                        instead of pinned over the Host IP, Port and Connect
                        (UX scorecard run 7). The pinned copy below hides. */}
                    {onNavigateToGlass && (
                        <div className="mb-3 hidden [@media(max-height:700px)]:block">
                            <InstrumentPanelButton quiet={connectShowing} onOpen={onNavigateToGlass} />
                        </div>
                    )}
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
                        className="fixed left-0 right-0 z-800 px-4 [@media(max-height:700px)]:hidden"
                        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    >
                        <InstrumentPanelButton quiet={connectShowing} onOpen={onNavigateToGlass} />
                    </div>
                )}
            </div>
        </div>
    );
};
