/**
 * InstrumentSourcePolicy — who the phone reads the boat from, and when the
 * gateway socket is allowed to open at all.
 *
 * Shane 2026-09-07: "no more signal k or ydwg-02 on the actual phone unless
 * there is no pi available." The YDWG-02 has three TCP client slots; the Pi
 * holds two of them for the boat's own record, and a phone that opened a third
 * on every launch left nothing for the next phone aboard — and read the same
 * bus the Pi was already reading.
 *
 *   A Pi is paired → NmeaStore plus the LAN lane (PiTelemetryService); the
 *       cloud lane when a screen asks for it; the socket stays SHUT. Only when
 *       the Pi has not answered for PI_SILENT_MS and a gateway was saved does
 *       the socket open as a fallback, and it closes again once the Pi has
 *       been back for PI_BACK_MS. Never more than one switch per FLAP_GUARD_MS.
 *   No Pi → exactly what booted before this file existed: the store first,
 *       then autoStart the saved gateway. Deliberately not behind the Pi
 *       integration flag — that flag is about probing the boat LAN for a Pi,
 *       and a gateway the skipper configured by hand is its own thing.
 *
 * A socket the skipper opens by hand on the NMEA page is theirs: the policy
 * never closes it and stops arbitrating until they disconnect.
 */
import { NmeaListenerService } from './NmeaListenerService';
import { NmeaStore } from './NmeaStore';
import { PiTelemetryService } from './PiTelemetryService';
import { getPairing } from './PiPairingService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('InstrumentSource');

/** The Pi has not answered for this long → the gateway may be read direct. */
export const PI_SILENT_MS = 60_000;
/** The Pi has been answering again for this long → give the gateway its slot back. */
export const PI_BACK_MS = 30_000;
/** At most one open-or-close per this interval, so a flapping Pi cannot churn the gateway's slots. */
export const FLAP_GUARD_MS = 120_000;
export const POLICY_TICK_MS = 5_000;

export type InstrumentBoot = 'pi-first' | 'direct' | 'idle';
export type InstrumentSourceMode = 'pi' | 'pi-silent-direct' | 'direct' | 'manual' | 'none';

class InstrumentSourcePolicyClass {
    private booted: InstrumentBoot | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private startedAt = 0;
    /** True while the socket is open because WE opened it as the Pi-silent fallback. */
    private socketOwned = false;
    /** The skipper pressed Connect: hands off. */
    private manual = false;
    private lastSwitchAt = 0;
    private piBackSince: number | null = null;

    /** Called once from useAppBootstrap. Idempotent. */
    boot(now = Date.now()): InstrumentBoot {
        if (this.booted) return this.booted;
        this.startedAt = now;

        if (getPairing()) {
            // Pi first. The store starts here so the LAN lane has somewhere to
            // put the boat; the socket does not.
            NmeaStore.start();
            PiTelemetryService.start();
            this.timer = setInterval(() => this.tick(), POLICY_TICK_MS);
            this.booted = 'pi-first';
            return this.booted;
        }

        const saved = NmeaListenerService.getSavedConfig();
        if (!saved) {
            this.booted = 'idle';
            return this.booted;
        }
        // Store first, socket second — the store must be subscribed in time
        // to catch the initial 'connecting' status (Shane 2026-08-09: a
        // healthy gateway streamed into nothing because only the socket came
        // back at boot).
        NmeaStore.start();
        NmeaListenerService.autoStart();
        this.booted = 'direct';
        return this.booted;
    }

    /** The skipper pressed Connect on the NMEA page: that socket is theirs. */
    noteManualConnect(now = Date.now()): void {
        this.manual = true;
        this.socketOwned = false;
        this.lastSwitchAt = now;
    }

    noteManualDisconnect(now = Date.now()): void {
        this.manual = false;
        this.lastSwitchAt = now;
        this.piBackSince = null;
    }

    mode(): InstrumentSourceMode {
        if (this.manual) return 'manual';
        if (this.booted === 'direct') return 'direct';
        if (this.booted !== 'pi-first') return 'none';
        return this.socketOwned ? 'pi-silent-direct' : 'pi';
    }

    /** One arbitration step. Exposed for tests; the interval calls it every POLICY_TICK_MS. */
    tick(now = Date.now()): void {
        if (this.booted !== 'pi-first' || this.manual) return;
        const lastSeen = PiTelemetryService.lastSeenAt();
        const silentForMs = now - (lastSeen ?? this.startedAt);
        const piHere = lastSeen !== null && now - lastSeen <= POLICY_TICK_MS * 2;
        if (piHere) {
            if (this.piBackSince === null) this.piBackSince = now;
        } else {
            this.piBackSince = null;
        }

        if (!this.socketOwned) {
            if (silentForMs < PI_SILENT_MS) return;
            if (now - this.lastSwitchAt < FLAP_GUARD_MS) return;
            if (!NmeaListenerService.getSavedConfig()) return;
            log.warn(`the Pi has not answered for ${Math.round(silentForMs / 1000)} s — reading the gateway direct`);
            NmeaListenerService.autoStart();
            this.socketOwned = true;
            this.lastSwitchAt = now;
            return;
        }

        if (this.piBackSince === null || now - this.piBackSince < PI_BACK_MS) return;
        if (now - this.lastSwitchAt < FLAP_GUARD_MS) return;
        log.info('the Pi is back — giving the gateway its slot back');
        NmeaListenerService.stop();
        this.socketOwned = false;
        this.lastSwitchAt = now;
    }

    /** Tests only. */
    resetForTests(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.booted = null;
        this.startedAt = 0;
        this.socketOwned = false;
        this.manual = false;
        this.lastSwitchAt = 0;
        this.piBackSince = null;
    }
}

export const InstrumentSourcePolicy = new InstrumentSourcePolicyClass();
