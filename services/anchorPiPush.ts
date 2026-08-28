/**
 * anchorPiPush — mirror the anchor watch onto the boat's cabin dashboard.
 *
 * Shane runs a Pi on the tailnet with a dashboard in the saloon. This pushes
 * anchor state to it so the crew can see at a glance how the hook is doing
 * without waking whoever owns the phone.
 *
 * ── Why a SINGLE SLOT and not a queue ──────────────────────────────────────
 * The obvious build is a FIFO outbox that replays every failed push. It is the
 * wrong shape here. The Pi renders CURRENT state, not history, and the API is
 * idempotent — so replaying a stale 'holding' after a newer 'cleared' would
 * resurrect an anchor the skipper already weighed. That is the one failure the
 * crew would actually act on, and a queue creates it by construction.
 *
 * So the outbox holds exactly one thing: the latest state that has not been
 * acknowledged. A newer state overwrites an older unsent one, which is both
 * correct and self-limiting — no retry storm, no reordering, no unbounded
 * growth while a boat sits out of tailnet range for a week.
 *
 * It IS persisted, because the case the spec calls out — "a single anchor-set
 * that silently fails is the one that matters" — is exactly the case where iOS
 * suspends the app thirty seconds after the hook goes down. An in-memory queue
 * would lose it in precisely the scenario it exists for.
 *
 * ── Why plain CapacitorHttp, when every other Pi call must use piTls ────────
 * services/piTls.ts exists because PiCacheService reaches the Pi on its LAN
 * address, where it serves a SELF-SIGNED certificate that neither fetch nor
 * CapacitorHttp will complete — those calls need the pinning plugin.
 *
 * This endpoint is different and the difference is the whole reason plain HTTP
 * is correct: it is a Tailscale MagicDNS host (*.ts.net), and Tailscale issues
 * it a publicly-valid certificate. There is nothing to pin. Routing it through
 * piTls would demand a pairing record it will never have, and would make the
 * push unavailable on the web build, where the pinning plugin does not exist.
 *
 * If you are here because a guard test flagged this file as "a Pi URL not using
 * piRequest" — that is the distinction to check before changing it.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../utils/createLogger';
import { withDeadline } from '../utils/deadline';
import type { AnchorWatchSnapshot } from './AnchorWatchService';

const log = createLogger('AnchorPiPush');

/** Endpoint and token are entered by the skipper and never ship in the repo. */
const ENDPOINT_KEY = 'anchor_pi_endpoint';
const TOKEN_KEY = 'anchor_pi_token';
const OUTBOX_KEY = 'anchor_pi_outbox';

/**
 * AbortSignal.timeout() is a silent no-op on device — the CapacitorHttp fetch
 * patch never reads options.signal, and the native default is 600 000 ms. A
 * stalled marine-LTE socket would otherwise park a push for ten minutes. See
 * utils/deadline.ts.
 */
const REQUEST_DEADLINE_MS = 12_000;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export type AnchorPiState = 'holding' | 'dragging' | 'cleared';

/** The wire format, exactly as the Pi's API specifies it. */
export interface AnchorPiPayload {
    state: AnchorPiState;
    /** The ANCHOR, not the boat. WGS84 decimal degrees, 7dp. */
    lat: number;
    lon: number;
    /** The alarm radius actually in force, so the dashboard draws the circle. */
    radius_m: number;
    rode_m?: number;
    depth_m?: number;
    source: string;
    /**
     * Beyond the base spec, and the reason it was worth asking for: the app
     * distinguishes states the three-value enum cannot. False means the anchor
     * is still down but the watch is NOT actively guarding it — paused, or
     * blind with no GPS. Without this the dashboard must either show a
     * confident green while the app cannot see, or blank a circle that is
     * still very much deployed. Both are lies the crew would sleep through.
     */
    watching: boolean;
    /** Human-readable qualifier for `watching: false`. */
    detail?: string;
    /** Only as a fallback for when the Pi has no fix of its own — never on a timer. */
    distance_m?: number;
}

interface Outbox {
    seq: number;
    payload: AnchorPiPayload;
    attempts: number;
    firstQueuedAt: number;
}

/** 7 decimal places, as specified — ~11 mm, far finer than any GPS fix. */
const dp7 = (n: number): number => Math.round(n * 1e7) / 1e7;

/**
 * Map the app's five states onto the API's three.
 *
 * Returns null when there is nothing meaningful to say — 'setting' means the
 * skipper is still dropping and no anchor position exists yet, and pushing
 * then would draw a circle round a boat that has not anchored.
 */
export function mapAnchorState(
    snapshot: AnchorWatchSnapshot,
): { state: AnchorPiState; watching: boolean; detail?: string } | null {
    switch (snapshot.state) {
        case 'idle':
            // Covers the ⏏ Weigh Anchor button and every other route to idle.
            // 'cleared' is what blanks the Pi panel.
            return { state: 'cleared', watching: false };
        case 'setting':
            return null;
        case 'watching':
            return { state: 'holding', watching: true };
        case 'alarm':
            // 'alarm' has TWO causes and only one of them is dragging. A watch
            // that went blind because the phone lost its fix has not moved the
            // boat an inch, and reporting it as a drag is a false 3am alarm on
            // a screen beside someone's bunk. Report the truth: still holding
            // as far as anyone knows, and no longer being watched.
            return snapshot.alarmCause === 'gps-lost'
                ? { state: 'holding', watching: false, detail: 'No GPS fix — watch is blind' }
                : { state: 'dragging', watching: true };
        case 'paused':
            // The anchor is down; the circle should stay on screen. 'cleared'
            // would blank it and imply the boat is under way.
            return { state: 'holding', watching: false, detail: 'Anchor watch paused' };
        default:
            return null;
    }
}

/** Build the wire payload, or null when this snapshot should not be pushed. */
export function buildAnchorPayload(snapshot: AnchorWatchSnapshot, source: string): AnchorPiPayload | null {
    const mapped = mapAnchorState(snapshot);
    if (!mapped) return null;

    // 'cleared' blanks the panel and carries no geometry, so it is the one
    // state that stays meaningful after the anchor position is gone.
    const anchor = snapshot.anchorPosition;
    if (mapped.state !== 'cleared' && !anchor) return null;

    const payload: AnchorPiPayload = {
        state: mapped.state,
        lat: dp7(anchor?.latitude ?? 0),
        lon: dp7(anchor?.longitude ?? 0),
        radius_m: Math.round(snapshot.swingRadius * 10) / 10,
        source,
        watching: mapped.watching,
    };
    if (mapped.detail) payload.detail = mapped.detail;

    // Both are metres throughout the anchor path — no unit conversion. Note
    // depth is the skipper's slider value, not a live sounder reading.
    if (Number.isFinite(snapshot.config?.rodeLength) && snapshot.config.rodeLength > 0) {
        payload.rode_m = snapshot.config.rodeLength;
    }
    if (Number.isFinite(snapshot.config?.waterDepth) && snapshot.config.waterDepth > 0) {
        payload.depth_m = snapshot.config.waterDepth;
    }
    if (mapped.state !== 'cleared' && Number.isFinite(snapshot.distanceFromAnchor)) {
        payload.distance_m = Math.round(snapshot.distanceFromAnchor * 10) / 10;
    }
    return payload;
}

/** Field-by-field equality, so an unchanged snapshot never costs a request. */
export function payloadsEqual(a: AnchorPiPayload | null, b: AnchorPiPayload | null): boolean {
    if (!a || !b) return a === b;
    return (
        a.state === b.state &&
        a.lat === b.lat &&
        a.lon === b.lon &&
        a.radius_m === b.radius_m &&
        a.rode_m === b.rode_m &&
        a.depth_m === b.depth_m &&
        a.watching === b.watching &&
        a.detail === b.detail
        // distance_m is deliberately excluded: it drifts every fix while the
        // boat swings, and letting it drive equality would turn an
        // event-driven push into the per-fix timer the API asked us not to be.
    );
}

export interface AnchorPiConfig {
    endpoint: string;
    token: string;
}

export async function readAnchorPiConfig(): Promise<AnchorPiConfig | null> {
    const [endpoint, token] = await Promise.all([
        Preferences.get({ key: ENDPOINT_KEY }),
        Preferences.get({ key: TOKEN_KEY }),
    ]);
    const url = endpoint.value?.trim();
    const key = token.value?.trim();
    if (!url || !key) return null;
    if (!url.startsWith('https://')) {
        log.warn('Anchor dashboard endpoint is not https — refusing to send a boat position over plaintext');
        return null;
    }
    return { endpoint: url, token: key };
}

export async function writeAnchorPiConfig(endpoint: string, token: string): Promise<void> {
    await Promise.all([
        Preferences.set({ key: ENDPOINT_KEY, value: endpoint.trim() }),
        Preferences.set({ key: TOKEN_KEY, value: token.trim() }),
    ]);
}

/**
 * Forget the dashboard pairing, including anything still queued for it.
 *
 * The outbox goes too, and that is not tidiness: it holds ANCHOR POSITIONS —
 * where the boat is lying — addressed to a device this handset is no longer
 * paired with. Leaving them queued means the next successful flush sends one
 * skipper's anchorage to another skipper's dashboard.
 */
export async function clearAnchorPiConfig(): Promise<void> {
    await Promise.all([
        Preferences.remove({ key: ENDPOINT_KEY }),
        Preferences.remove({ key: TOKEN_KEY }),
        Preferences.remove({ key: OUTBOX_KEY }),
    ]);
}

export type PushOutcome = 'sent' | 'unauthorised' | 'rejected' | 'unreachable' | 'not-configured';

/** One POST. No retry logic here — the caller owns that. */
export async function postAnchorState(payload: AnchorPiPayload, config: AnchorPiConfig): Promise<PushOutcome> {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
    };
    try {
        const status = await withDeadline(
            (async () => {
                if (Capacitor.isNativePlatform()) {
                    // Native HTTP bypasses CORS entirely, which is why the
                    // Pi's broken OPTIONS handler never affects the iOS app.
                    const res = await CapacitorHttp.post({ url: config.endpoint, headers, data: payload });
                    return res.status;
                }
                // Web build: a real browser request, so the Pi's CORS policy
                // applies and a failed preflight surfaces as a network error.
                const res = await fetch(config.endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload),
                });
                return res.status;
            })(),
            REQUEST_DEADLINE_MS,
            'anchor-pi-push',
        );

        if (status === 200) return 'sent';
        if (status === 401) return 'unauthorised';
        if (status === 400) return 'rejected';
        log.warn(`Anchor dashboard returned ${status}`);
        return 'unreachable';
    } catch (e) {
        // Off the tailnet, Pi rebooting, DNS not resolving — all retryable.
        log.info('Anchor dashboard unreachable:', (e as Error)?.message || e);
        return 'unreachable';
    }
}

async function readOutbox(): Promise<Outbox | null> {
    try {
        const raw = await Preferences.get({ key: OUTBOX_KEY });
        if (!raw.value) return null;
        const parsed = JSON.parse(raw.value) as Outbox;
        return parsed?.payload?.state ? parsed : null;
    } catch {
        return null;
    }
}

async function writeOutbox(outbox: Outbox | null): Promise<void> {
    if (!outbox) {
        await Preferences.remove({ key: OUTBOX_KEY });
        return;
    }
    await Preferences.set({ key: OUTBOX_KEY, value: JSON.stringify(outbox) });
}

class AnchorPiPushService {
    private lastAcked: AnchorPiPayload | null = null;
    private seq = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private draining = false;
    private unsubscribe: (() => void) | null = null;
    private started = false;
    /** subscribe() replays the current snapshot immediately; that is not news. */
    private primed = false;

    private source(): string {
        return Capacitor.isNativePlatform() ? `thalassa-${Capacitor.getPlatform()}` : 'thalassa-web';
    }

    /** Offer a snapshot. Cheap and safe to call on every notify. */
    async offer(snapshot: AnchorWatchSnapshot): Promise<void> {
        const payload = buildAnchorPayload(snapshot, this.source());
        if (!payload) return;
        if (payloadsEqual(payload, this.lastAcked)) return;

        const existing = await readOutbox();
        if (existing && payloadsEqual(existing.payload, payload)) return;

        // Overwrite, never append. See the header note on why this is a single
        // slot: a newer state always supersedes an older unsent one.
        this.seq += 1;
        await writeOutbox({
            seq: this.seq,
            payload,
            attempts: 0,
            firstQueuedAt: existing?.firstQueuedAt ?? Date.now(),
        });
        void this.drain();
    }

    /** Try to deliver whatever is pending. Idempotent and re-entrant-safe. */
    async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            const outbox = await readOutbox();
            if (!outbox) return;

            const config = await readAnchorPiConfig();
            if (!config) return; // Not set up — hold the state, do not drop it.

            const outcome = await postAnchorState(outbox.payload, config);

            // A newer state may have been queued while this was in flight.
            // Only clear the slot if it still holds the thing we just sent.
            const current = await readOutbox();
            const stillOurs = current?.seq === outbox.seq;

            if (outcome === 'sent') {
                this.lastAcked = outbox.payload;
                if (stillOurs) await writeOutbox(null);
                log.info(`Anchor dashboard updated: ${outbox.payload.state}`);
                return;
            }

            if (outcome === 'rejected' || outcome === 'unauthorised') {
                // 400 means this body will never be accepted; 401 means the
                // token is wrong and hammering it helps nobody. Both need a
                // human, so drop the slot rather than retry forever — but say
                // so loudly, because a silently discarded anchor-set is the
                // exact failure this service exists to prevent.
                log.error(
                    `Anchor dashboard ${outcome === 'unauthorised' ? 'rejected the token' : 'rejected the payload'} — ` +
                        `dropping ${outbox.payload.state}. Check the endpoint and token in Settings.`,
                );
                if (stillOurs) await writeOutbox(null);
                return;
            }

            if (stillOurs) {
                await writeOutbox({ ...outbox, attempts: outbox.attempts + 1 });
                this.scheduleRetry(outbox.attempts + 1);
            }
        } finally {
            this.draining = false;
        }
    }

    private scheduleRetry(attempts: number): void {
        if (this.retryTimer) return;
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), RETRY_MAX_MS);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.drain();
        }, delay);
    }

    /** Wire to the anchor watch. Idempotent. */
    start(subscribeFn: (listener: (s: AnchorWatchSnapshot) => void) => () => void): void {
        if (this.started) return;
        this.started = true;
        this.unsubscribe = subscribeFn((snapshot) => {
            if (!this.primed) {
                // The replayed snapshot on subscribe is the state as it already
                // is, not a transition. Seed from it so a restart does not
                // re-send what the Pi is already showing, but do not treat it
                // as an event.
                this.primed = true;
                const initial = buildAnchorPayload(snapshot, this.source());
                if (initial && initial.state === 'cleared') {
                    // Nothing to mirror from an idle watch on boot.
                    this.lastAcked = initial;
                    return;
                }
            }
            void this.offer(snapshot);
        });

        // The Pi is on the tailnet, so internet reachability is the WRONG
        // signal — the boat's Wi-Fi may have no uplink at all while the Pi is
        // two metres away. Retry on the events that plausibly changed the
        // route instead, and let the ladder cover everything else.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) void this.drain();
            });
        }
    }

    stop(): void {
        if (this.unsubscribe) this.unsubscribe();
        this.unsubscribe = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.started = false;
        this.primed = false;
    }

    /** Test seam. */
    __resetForTests(): void {
        this.stop();
        this.lastAcked = null;
        this.seq = 0;
        this.draining = false;
    }
}

export const AnchorPiPush = new AnchorPiPushService();
