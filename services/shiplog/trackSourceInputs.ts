/**
 * trackSourceInputs — gathers the facts trackSourcePlan.ts decides from, at
 * the moment a voyage starts: is there a boat GPS to wait for, how does she
 * reach this phone and from where (gwstate's BoatLinkService — WHERE by
 * position, never by which address answered), where is she right now (her
 * bus, then her Pi direct, then her cloud row), does her Pi record her track,
 * and is a Bad Elf / MFi accessory what Core Location is reading.
 *
 * Nothing here asks for a permission, starts the phone's GPS, or throws. A
 * fact that cannot be read reads as "not known", and the plan is built from
 * what could be read: a Pi that does not answer in time simply does not count
 * as recording, and a silent boat simply asks the skipper.
 */
import { Capacitor } from '@capacitor/core';
import { BoatLinkService } from '../boatLink/BoatLinkService';
import type { DataState, Lane, LinkKind, Where } from '../boatLink/boatLinkModel';
import { NmeaListenerService } from '../NmeaListenerService';
import { getPairing } from '../PiPairingService';
import { createLogger } from '../../utils/createLogger';
import { planTrackSource, type TrackSourceInput, type TrackSourcePlan } from './trackSourcePlan';

const log = createLogger('ShipLog.SourcePlan');

/** The Pi direct gets this long at Start; her cloud row is the next rung. */
const PI_FIX_TIMEOUT_MS = 2_500;
/** The Pi's recorder status gets this long before it counts as "not known". */
const RECORDER_TIMEOUT_MS = 3_000;
/** The accessory flag is read from the cached location, not a fresh fix. */
const ACCESSORY_TIMEOUT_MS = 1_500;
/** An accessory flag older than this describes an earlier session. */
const ACCESSORY_FIX_MAX_AGE_MS = 5 * 60_000;

const UNKNOWN_LINK: TrackSourceInput['link'] = { where: 'unknown', lane: 'none', kind: 'none', data: 'none' };

function safely<T>(name: string, read: () => T, fallback: T): T {
    try {
        return read();
    } catch (error) {
        log.warn(`${name} unavailable:`, error instanceof Error ? error.message : String(error));
        return fallback;
    }
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Her freshest position: the bus, the Pi direct, then her cloud row (dated by the receiver when it says). */
async function freshBoatPosition(now: number): Promise<TrackSourceInput['boatPosition']> {
    try {
        const { busFix, piFix, cloudFix } = await import('../boatPositionChain');
        const bus = busFix();
        if (bus) return { lane: 'bus', ageMs: Math.max(0, now - bus.timestamp) };
        const pi = await within(piFix(PI_FIX_TIMEOUT_MS), PI_FIX_TIMEOUT_MS + 500, null);
        if (pi) return { lane: 'pi', ageMs: Math.max(0, now - pi.timestamp) };
        const cloud = await cloudFix(now);
        if (cloud) return { lane: 'cloud', ageMs: Math.max(0, now - (cloud.positionAt ?? cloud.timestamp)) };
    } catch (error) {
        log.warn('boat position unavailable at Start:', error instanceof Error ? error.message : String(error));
    }
    return null;
}

async function piRecorderEnabled(): Promise<boolean> {
    try {
        const { getPiTrackStatus } = await import('../piTrackRecorder');
        const status = await within(getPiTrackStatus(), RECORDER_TIMEOUT_MS, null);
        return status?.enabled === true;
    } catch {
        return false;
    }
}

async function phoneAccessoryActive(now: number): Promise<boolean> {
    if (!safely('platform', () => Capacitor.isNativePlatform(), false)) return false;
    try {
        const { BackgroundLocationService } = await import('../BackgroundLocationService');
        const info = await within(BackgroundLocationService.getGpsReceiverInfo(), ACCESSORY_TIMEOUT_MS, null);
        const source = info?.source;
        if (!source?.externalAccessory) return false;
        return source.timestampMs === null || now - source.timestampMs <= ACCESSORY_FIX_MAX_AGE_MS;
    } catch {
        return false;
    }
}

function linkFacts(now: number): TrackSourceInput['link'] {
    const snapshot = safely('boat link', () => BoatLinkService.evaluate(now), null);
    if (!snapshot) return UNKNOWN_LINK;
    return {
        where: snapshot.where as Where,
        lane: snapshot.lane as Lane,
        kind: snapshot.kind as LinkKind,
        data: snapshot.data.state as DataState,
    };
}

/** The plan for a voyage starting now. Never throws; never asks the phone for anything. */
export async function resolveTrackSourcePlan(now = Date.now()): Promise<TrackSourcePlan> {
    const piPaired = safely('pairing', () => getPairing() !== null, false);
    const gatewaySaved = safely('saved gateway', () => NmeaListenerService.getSavedConfig() !== null, false);
    const boatConfigured = piPaired || gatewaySaved;
    const link = boatConfigured ? linkFacts(now) : UNKNOWN_LINK;
    const [boatPosition, piRecorderOn, phoneAccessory] = await Promise.all([
        boatConfigured ? freshBoatPosition(now) : Promise.resolve(null),
        piPaired ? piRecorderEnabled() : Promise.resolve(false),
        phoneAccessoryActive(now),
    ]);
    const plan = planTrackSource({ boatConfigured, piRecorderOn, link, boatPosition, phoneAccessory });
    log.warn(
        `source plan: ${plan.source} (lane ${plan.lane}, ${plan.where}, keep-alive ${plan.keepAlive}, stand-in ${plan.standIn})`,
    );
    return plan;
}
