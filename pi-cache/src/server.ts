/**
 * Thalassa Pi Cache — Express server entry point.
 *
 * Runs on a Raspberry Pi behind the native pinned-TLS client. Public-beta
 * defaults are loopback-only with every private/admin surface disabled; see
 * publicBetaBoundary.ts and pi-cache/README.md.
 *
 * Default port: 3001
 */

import 'dotenv/config';
import os from 'node:os';

// Force IPv4 for all fetch() calls — most boat networks lack IPv6 connectivity
// and Node.js 22's undici-based fetch() tries AAAA records first, causing timeouts
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { Cache } from './cache.js';
import { Barometer } from './barometer.js';
import { createWeatherRoutes } from './routes/weather.js';
import { createTileRoutes } from './routes/tiles.js';
import { createGribRoutes } from './routes/grib.js';
import { createTideRoutes } from './routes/tides.js';
import { createMiscRoutes } from './routes/misc.js';
import { createChartRoutes } from './routes/charts.js';
import { createEncRoutes } from './routes/enc.js';
import { createOsmRoutes } from './routes/osm.js';
import { createDiaryRelayRoutes } from './routes/diary.js';
import { createTrackRoutes } from './routes/track.js';
import { TrackStore } from './trackStore.js';
import { TrackRecorderRunner } from './trackRunner.js';
import { TELEMETRY_RELAY_PATH, TelemetryPublisher } from './telemetryPublisher.js';
import { cachedJsonFetch, cachedTileFetch } from './proxy.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { startEncWatcher, stopEncWatcher } from './encWatcher.js';
import {
    canonicalAnchorRelayEndpoint,
    DiaryRelayOutbox,
    type DiaryRelayConfigInput,
    DiaryRelayValidationError,
} from './diaryRelayOutbox.js';
import { AnchorWatchRunner, currentFix, fixIsCurrent } from './anchorBroadcaster.js';
import { DiaryVideoRelay } from './diaryVideoRelay.js';
import { loadOrCreateIdentity, readIdentityPrivateKeyPem } from './identity.js';
import { ensureIdentityTls } from './tlsIdentity.js';
import { createPairRoutes } from './routes/pair.js';
import { createRemoteAccessRoutes } from './routes/remoteAccess.js';
import { assertSupabaseOriginAssertion, resolveTrustedSupabaseOrigin } from './outboundHttp.js';
import {
    INVALID_PI_CONFIGURATION_CODE,
    operatorEnvironmentLines,
    piEnvironmentLine,
    validatePiConfigurationFields,
    writeEnvironmentFileAtomic,
} from './configurationBoundary.js';
import {
    adminApiDisabledPayload,
    allowedCorsOrigins,
    publicStatusPayload,
    resolveBindHost,
    unsafeAdminApiEnabled,
    appApiEnabled,
    appApiDisabledPayload,
} from './publicBetaBoundary.js';

// ── Config (mutable only after explicit unsafe-development opt-in) ──

const PORT = parseInt(process.env.PORT || '3001', 10);
const CACHE_DIR = process.env.CACHE_DIR || './cache';
const BIND_HOST = resolveBindHost();
const UNSAFE_ADMIN_API_ENABLED = unsafeAdminApiEnabled();
const APP_API_ENABLED = appApiEnabled();
const CORS_ORIGINS = allowedCorsOrigins();

// Pairing identity — survives redeploys (rsync excludes identity/). See
// identity.ts for what this defends against. PI_BOAT_NAME overrides the
// hostname shown on the app's pairing card.
const IDENTITY_DIR = process.env.IDENTITY_DIR || './identity';
const identity = loadOrCreateIdentity(IDENTITY_DIR);
console.log(`[identity] ${identity.boatName} (${identity.deviceId}) fingerprint ${identity.fingerprint}`);

// ── Boat-LAN TLS ───────────────────────────────────────────────────
// Certificate issued from the SAME key the app pinned at pairing, so the
// encrypted channel and the pairing identity are one trust decision rather
// than two. See tlsIdentity.ts for why self-signed is correct offshore and
// PiTlsPlugin.swift for the pin that consumes it. There is no plaintext
// fallback: an unencrypted boat LAN is what kept this out of the beta.
const tls = ensureIdentityTls(IDENTITY_DIR, readIdentityPrivateKeyPem(IDENTITY_DIR));
console.log(`[tls] boat-LAN certificate valid to ${tls.notAfter} — cert fp ${tls.certFingerprint}`);
const SUPABASE_ORIGIN = resolveTrustedSupabaseOrigin(process.env.SUPABASE_URL);
let SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const proxyConfig = {
    supabaseUrl: SUPABASE_ORIGIN,
    supabaseAnonKey: SUPABASE_ANON_KEY,
};

// One-time upgrade hygiene: older builds persisted the commercial provider
// key on the Pi. It is no longer consumed, so remove only that legacy line
// while preserving every other skipper setting.
const LEGACY_PROVIDER_ENV = 'OPEN_METEO_API_KEY';
const legacyProviderLine = new RegExp(`^\\s*${LEGACY_PROVIDER_ENV}\\s*=`);
try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const current = fs.readFileSync(envPath, 'utf8');
        const lines = current.split(/\r?\n/);
        if (lines.some((line) => legacyProviderLine.test(line))) {
            const sanitized = lines.filter((line) => !legacyProviderLine.test(line)).join('\n');
            fs.writeFileSync(envPath, sanitized.replace(/\n*$/, '\n'));
        }
    }
} catch (err) {
    console.warn('Could not retire legacy provider credential:', (err as Error).message);
}
delete process.env[LEGACY_PROVIDER_ENV];

// ── Bootstrap ──

const cache = new Cache(CACHE_DIR);
// The boat's own barometer. Starts even with no sensor fitted — it just
// reports unavailable, so a Pi without one behaves exactly as before.
const barometer = new Barometer(CACHE_DIR);
void barometer.start();
const diaryRelayOutbox = new DiaryRelayOutbox(CACHE_DIR, { trustedSupabaseOrigin: SUPABASE_ORIGIN });
// The big-upload babysitter. Borrows the outbox's pairing credential; holds
// clips on disk until WAN lets it redeem a signed upload URL per object.
const diaryVideoRelay = new DiaryVideoRelay(CACHE_DIR, () => diaryRelayOutbox.lendVideoCredentials());
diaryVideoRelay.start();

/* The always-on track. Signal K on this same Pi is the source — reading the
   gateway's TCP feed directly would burn one of the YDWG-02's three client
   slots permanently, which is a cost this has no business paying. */
const SIGNALK_ORIGIN = process.env.SIGNALK_ORIGIN || 'http://127.0.0.1:3000';
const trackStore = new TrackStore(CACHE_DIR);
const trackRecorder = new TrackRecorderRunner({
    fetchImpl: fetch,
    signalkOrigin: SIGNALK_ORIGIN,
    store: trackStore,
});
/* Resume on boot if the skipper left it on. The promise is that the boat keeps
   her own record; a Pi that forgot after every power cycle would fail exactly
   the case it exists for — the phone flat, the app crashed, nobody watching. */
if (trackStore.isEnabled()) trackRecorder.start();

/* The boat's live snapshot to the cloud — position and the whole bus, every
   few seconds, so the Pi is the primary device and crew see the Instrument
   Panel anywhere (Shane 2026-09-06). Uses the diary pairing's credential and
   the skipper's internet policy; THALASSA_TELEMETRY_PUBLISH=0 switches it off. */
const telemetryPublisher = new TelemetryPublisher({
    fetchImpl: fetch,
    signalkOrigin: SIGNALK_ORIGIN,
    endpoint: `${SUPABASE_ORIGIN}${TELEMETRY_RELAY_PATH}`,
    anonKey: () => SUPABASE_ANON_KEY,
    credentials: () => diaryRelayOutbox.lendTelemetryCredentials(),
    internetAllowed: () => diaryRelayOutbox.getConfiguration().allowInternet,
    deviceLabel: os.hostname(),
});
if (process.env.THALASSA_TELEMETRY_PUBLISH !== '0') telemetryPublisher.start();

/* The shore watch, when the skipper hands it to this Pi.
 *
 * Deliberately NOT resumed on boot, unlike the track above. A Pi that has just
 * rebooted cannot vouch for what happened while it was down, and an anchor
 * alarm that silently resumes with a stale idea of where the hook is would be
 * worse than one that is honestly off — so the app re-assigns on its next
 * renew sweep and the watch starts from something current. */
const anchorWatch = new AnchorWatchRunner({ fetchImpl: fetch, signalkOrigin: SIGNALK_ORIGIN });
/** The app's own alphabet is unambiguous; the relay accepts any alphanumeric. */
const ANCHOR_SESSION_CODE_RE = /^[A-Za-z0-9]{12}$/;
const app = express();

app.use(
    cors({
        origin(origin, callback) {
            // No Origin is a same-origin/native/CLI request. Browser origins
            // must be explicitly allowlisted; a wildcard is never accepted.
            callback(null, !origin || CORS_ORIGINS.has(origin));
        },
    }),
);
// Bump body parser limit for public-data chart uploads. A regional
// GeoJSON pack for AU coastal coverage runs 10-50MB after gdal_contour
// simplification — the 100kb default would reject them on POST. ENC
// imports go through a different code path (raw octet-stream / base64)
// so they aren't affected by this limit.
app.use(express.json({ limit: UNSAFE_ADMIN_API_ENABLED ? '100mb' : '64kb' }));

/**
 * ── Which gate, and why ───────────────────────────────────────────────────────
 *
 * These are FEATURE FLAGS, not authentication. Neither identifies a caller; the
 * real access control is THALASSA_PI_LAN_BIND (loopback by default) and the
 * pinned TLS the app pairs with. What the two flags decide is DEFAULT SURFACE:
 *
 *   requireAppApi     THALASSA_PI_APP_API !== '0'  → defaults ON
 *   requireUnsafeAdmin THALASSA_UNSAFE_ADMIN_API === '1' → defaults OFF
 *
 * Until 2026-08-30 the endpoints the APP ITSELF calls — /api/configure,
 * /api/passthrough, /api/passthrough-tile, /api/admin/status, /cache/purge and
 * /api/remote-access — all sat behind the unsafe flag. The app cannot work
 * without them, so the flag was always on, so it protected nothing while
 * keeping the genuinely dangerous surface permanently reachable alongside it.
 * A gate that must always be open is not a gate.
 *
 * They now sit behind the app gate, and the unsafe flag keeps only what the app
 * never calls: /api/misc/proxy (raw arbitrary-upstream proxy), /api/charts
 * (download and delete arbitrary chart sets), serving the built web app, and
 * the 100 MB body limit. Those can now default off on a stock Pi, which is the
 * whole point of the split.
 */
const requireUnsafeAdmin: express.RequestHandler = (_req, res, next) => {
    if (UNSAFE_ADMIN_API_ENABLED) return next();
    return res.status(503).json(adminApiDisabledPayload());
};

const requireAppApi: express.RequestHandler = (_req, res, next) => {
    if (APP_API_ENABLED) return next();
    return res.status(503).json(appApiDisabledPayload());
};

// ── Health & Status ──

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'thalassa-pi-cache', uptime: process.uptime() });
});

app.get('/status', (_req, res) => {
    res.json(
        publicStatusPayload({
            uptime: process.uptime(),
            cache: cache.getStats(),
            bindHost: BIND_HOST,
            unsafeAdminEnabled: UNSAFE_ADMIN_API_ENABLED,
        }),
    );
});

/** Private development status. Never fold this detail back into /status. */
app.get('/api/admin/status', requireAppApi, (_req, res) => {
    const diaryRelay = diaryRelayOutbox.getStats();
    res.json({
        status: 'ok',
        cache: cache.getStats(),
        config: {
            port: PORT,
            cacheDir: CACHE_DIR,
            supabaseConfigured: !!SUPABASE_ANON_KEY,
            prefetchConfigured: !!(process.env.PREFETCH_LAT && process.env.PREFETCH_LON),
            prefetchLat: process.env.PREFETCH_LAT || null,
            prefetchLon: process.env.PREFETCH_LON || null,
            // Kept in `config` for older/mobile Pi clients. relayId is a
            // public Pi identity, not the secret bearer token.
            diaryRelayId: diaryRelay.relay.relayId,
            diaryRelayConfigured: diaryRelay.relay.configured,
            // This is a non-secret account identifier. It lets a crew
            // device decline to hand a private diary to a Pi paired by a
            // different skipper, without exposing the relay token or URL.
            diaryRelayOwnerId: diaryRelay.relay.ownerId,
            diaryRelayAllowInternet: diaryRelay.relay.allowInternet,
        },
        diaryRelay,
        // describe() never includes the credential, so this is safe here.
        anchorWatch: anchorWatch.describe(),
    });
});

// ── Configure (called by the Thalassa app on the phone) ──
// The skipper never touches a terminal. The app pushes config here.

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configurationBody(value: unknown): Record<string, unknown> {
    if (isObject(value)) return value;
    // Capacitor's native HTTP bridge has historically sent JSON strings on a
    // few iOS versions even with application/json. Accept that exact shape so
    // the Pi relay can still be paired, but never treat arbitrary text as a
    // configuration object.
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            return isObject(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

/**
 * The diary relay's internet gate is intentionally accepted only here, never
 * through the entry endpoint. This makes the Pi owner explicitly opt in once
 * and preserves that policy across restart without placing credentials in .env.
 */
function applyDiaryRelayConfiguration(body: Record<string, unknown>): void {
    const nested = body.diaryRelay;
    const hasFlatPolicy = Object.prototype.hasOwnProperty.call(body, 'diaryRelayAllowInternet');
    const flatNames = {
        url: 'diaryRelayUrl',
        relayId: 'diaryRelayId',
        token: 'diaryRelayToken',
        ownerId: 'diaryRelayOwnerId',
    } as const;
    const hasFlatRelay = Object.values(flatNames).some((name) => Object.prototype.hasOwnProperty.call(body, name));
    if (nested === undefined && !hasFlatPolicy && !hasFlatRelay) return;
    if (nested !== undefined && !isObject(nested)) {
        throw new DiaryRelayValidationError('diaryRelay must be an object');
    }

    const values: Record<string, unknown> = nested ?? {};
    const input: DiaryRelayConfigInput = {};
    const textKeys: Array<keyof Pick<DiaryRelayConfigInput, 'url' | 'relayId' | 'token' | 'ownerId'>> = [
        'url',
        'relayId',
        'token',
        'ownerId',
    ];
    for (const key of textKeys) {
        const nestedPresent = Object.prototype.hasOwnProperty.call(values, key);
        const flatKey = flatNames[key];
        const flatPresent = Object.prototype.hasOwnProperty.call(body, flatKey);
        const nestedValue = values[key];
        const flatValue = body[flatKey];
        if (nestedPresent && flatPresent && nestedValue !== flatValue) {
            throw new DiaryRelayValidationError(`Diary relay ${key} was provided twice with different values`);
        }
        const value = nestedPresent ? nestedValue : flatValue;
        if (value !== undefined) {
            if (typeof value !== 'string') throw new DiaryRelayValidationError(`diaryRelay.${key} must be a string`);
            input[key] = value;
        }
    }

    const nestedPolicy = values.allowInternet;
    if (nestedPolicy !== undefined && typeof nestedPolicy !== 'boolean') {
        throw new DiaryRelayValidationError('diaryRelay.allowInternet must be a boolean');
    }
    const flatPolicy = body.diaryRelayAllowInternet;
    if (flatPolicy !== undefined && typeof flatPolicy !== 'boolean') {
        throw new DiaryRelayValidationError('diaryRelayAllowInternet must be a boolean');
    }
    if (nestedPolicy !== undefined && flatPolicy !== undefined && nestedPolicy !== flatPolicy) {
        throw new DiaryRelayValidationError('Diary relay policy was provided twice with different values');
    }
    if (typeof (flatPolicy ?? nestedPolicy) === 'boolean') {
        input.allowInternet = (flatPolicy ?? nestedPolicy) as boolean;
    }

    diaryRelayOutbox.configure(input);
}

app.post('/api/configure', requireAppApi, (req, res) => {
    const requestBody = configurationBody(req.body);
    let validated: ReturnType<typeof validatePiConfigurationFields>;
    try {
        validated = validatePiConfigurationFields(requestBody);
        // The phone may confirm which backend it was built for, but HTTP input
        // can never replace the process-startup Supabase authority.
        assertSupabaseOriginAssertion(validated.supabaseUrl, SUPABASE_ORIGIN);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid diary relay configuration';
        return res.status(400).json({ status: 'error', code: INVALID_PI_CONFIGURATION_CODE, error: message });
    }

    // Build the complete future file before mutating process state. Every value
    // crosses piEnvironmentLine, including values inherited from process startup,
    // so no newline/control character can become a second dotenv assignment.
    const nextAnonKey = validated.supabaseAnonKey || SUPABASE_ANON_KEY;
    const nextUserId = validated.userId ?? process.env.PREFETCH_USER_ID;
    const nextLat = validated.prefetchLat ?? process.env.PREFETCH_LAT;
    const nextLon = validated.prefetchLon ?? process.env.PREFETCH_LON;
    const nextRadius =
        validated.prefetchLat !== undefined ? (validated.prefetchRadius ?? 5) : process.env.PREFETCH_RADIUS || 5;
    const nextInterval = process.env.PREFETCH_INTERVAL || 15;

    let envContents: string;
    try {
        if ((nextLat === undefined) !== (nextLon === undefined)) {
            throw new Error('Existing prefetch coordinates are incomplete');
        }
        const envLines: string[] = [
            '# Thalassa Pi Cache — configured by the Thalassa app',
            piEnvironmentLine('PORT', PORT, 16),
            piEnvironmentLine('CACHE_DIR', CACHE_DIR, 4_096),
            piEnvironmentLine('SUPABASE_URL', SUPABASE_ORIGIN, 2_048),
        ];
        if (nextAnonKey) envLines.push(piEnvironmentLine('SUPABASE_ANON_KEY', nextAnonKey));
        if (nextUserId) envLines.push(piEnvironmentLine('PREFETCH_USER_ID', nextUserId, 64));
        if (nextLat !== undefined && nextLon !== undefined) {
            envLines.push(piEnvironmentLine('PREFETCH_LAT', nextLat, 32));
            envLines.push(piEnvironmentLine('PREFETCH_LON', nextLon, 32));
            envLines.push(piEnvironmentLine('PREFETCH_RADIUS', nextRadius, 32));
            envLines.push(piEnvironmentLine('PREFETCH_INTERVAL', nextInterval, 32));
        }
        // Operator-owned settings (LAN bind, admin/app API opt-ins, CORS
        // origins, ENC_* chart-import flags) are process-startup authority,
        // exactly like SUPABASE_URL — a push must carry them forward, never
        // drop them. See operatorEnvironmentLines() for the two outages that
        // dropping them has already caused.
        envLines.push(...operatorEnvironmentLines(path.join(process.cwd(), '.env')));
        envContents = `${envLines.join('\n')}\n`;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Configuration cannot be persisted safely';
        return res.status(400).json({ status: 'error', code: INVALID_PI_CONFIGURATION_CODE, error: message });
    }

    try {
        const envPath = path.join(process.cwd(), '.env');
        // Validate and persist Pi-private relay configuration before changing
        // the rest of the server settings, so an invalid relay cannot leave a
        // half-applied configuration request behind.
        applyDiaryRelayConfiguration(requestBody);
        writeEnvironmentFileAtomic(envPath, envContents);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not persist Pi configuration';
        return res.status(500).json({ status: 'error', code: 'PI_CONFIGURATION_WRITE_FAILED', error: message });
    }

    // Update mutable in-memory values only after the durable replacement has
    // succeeded. Supabase authority is intentionally absent: immutable at boot.
    SUPABASE_ANON_KEY = nextAnonKey;
    proxyConfig.supabaseAnonKey = SUPABASE_ANON_KEY;
    if (nextUserId) process.env.PREFETCH_USER_ID = nextUserId;
    if (nextLat !== undefined && nextLon !== undefined) {
        process.env.PREFETCH_LAT = String(nextLat);
        process.env.PREFETCH_LON = String(nextLon);
        process.env.PREFETCH_RADIUS = String(nextRadius);
        process.env.PREFETCH_INTERVAL = String(nextInterval);
    }

    // Restart pre-fetch scheduler with updated config
    stopScheduler();
    startScheduler(cache, proxyConfig);

    console.log(
        `📱 Configuration updated by Thalassa app${validated.prefetchLat !== undefined ? ` (location: ${validated.prefetchLat}, ${validated.prefetchLon})` : ''}`,
    );
    res.json({ status: 'ok', message: 'Configuration updated', diaryRelay: diaryRelayOutbox.getConfiguration() });
});

// Purge expired cache entries
app.post('/cache/purge', requireAppApi, (_req, res) => {
    const result = cache.purgeExpired();
    res.json({ purged: result });
});

// ── Generic Passthrough Proxy ──
// The app sends any URL here and the Pi caches the response.
// This is the magic one — zero config, works for every API.

/**
 * A query parameter Express may hand back as a string, an ARRAY, or a nested
 * object depending on the syntax used (`?url=a&url=b`, `?url[x]=y`). Casting it
 * `as string` is a lie that lets a check and a later use disagree about what
 * the value even is.
 *
 * Anything that is not a single string is refused rather than coerced, so the
 * validation and the fetch always consume the identical value.
 */
function singleQueryString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

app.get('/api/passthrough', requireAppApi, async (req, res) => {
    try {
        const url = singleQueryString(req.query.url);
        const ttl = parseInt(singleQueryString(req.query.ttl) || '900000', 10);
        const source = singleQueryString(req.query.source) || 'passthrough';

        if (!url) return res.status(400).json({ error: 'url parameter required' });

        const key = `passthrough:${url}`;
        const result = await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: ttl, source });

        res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
        res.json(result.data);
    } catch (err) {
        res.status(502).json({ error: 'Passthrough failed', message: (err as Error).message });
    }
});

app.get('/api/passthrough-tile', requireAppApi, async (req, res) => {
    try {
        const url = singleQueryString(req.query.url);
        const ttl = parseInt(singleQueryString(req.query.ttl) || '1800000', 10);
        const contentType = singleQueryString(req.query.ct) || 'image/png';

        if (!url) return res.status(400).json({ error: 'url parameter required' });

        const key = `passthrough-tile:${url}`;
        const result = await cachedTileFetch(cache, { cacheKey: key, url, contentType, ttlMs: ttl });

        res.set('Content-Type', result.contentType);
        res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
        res.send(result.data);
    } catch (err) {
        res.status(502).json({ error: 'Tile passthrough failed', message: (err as Error).message });
    }
});

// ── API Routes (for direct Pi endpoints — used by pre-fetch) ──

/**
 * GET /api/barometer — the boat's pressure record.
 *
 * Behind requireAppApi like the rest of the app surface: it is boat data, not
 * public data. Always 200 with `available` telling the truth, so the client
 * can fall back to the phone without having to interpret an error code.
 */
app.get('/api/barometer', requireAppApi, (_req, res) => {
    res.json(barometer.state());
});

/**
 * Take the shore watch (or give it back).
 *
 * The app authorises this Pi's relay for the session code FIRST, then posts
 * here; the broadcaster's own doc explains why that order is the only one that
 * works. This endpoint therefore stores no permission of its own — it holds an
 * assignment, and the relay decides every ten seconds whether that assignment
 * may still be published.
 *
 * The credential is the Pi's existing scoped pairing credential, lent for this
 * one purpose, and the endpoint comes from the process-startup trust anchor —
 * never from this request body.
 */
/**
 * Can this Pi actually keep the watch?
 *
 * Asked BEFORE the app offers to hand it over, because a Pi that takes the
 * watch and then broadcasts "no-fix" forever is worse than one that never
 * offered: the skipper would go ashore believing the boat was being watched.
 * Three things have to be true — paired to an account, configured to reach
 * Supabase, and able to see the vessel on the bus right now.
 *
 * Always 200. `capable: false` with a reason is a real answer the app can put
 * in front of the skipper, not an error it has to interpret.
 */
app.get('/api/anchor/capability', requireAppApi, async (_req, res) => {
    const paired = diaryRelayOutbox.lendAnchorCredentials() !== null;
    let hasFix = false;
    try {
        const fix = await currentFix({ fetchImpl: fetch, signalkOrigin: SIGNALK_ORIGIN });
        hasFix = fix !== null && fixIsCurrent(fix);
    } catch {
        hasFix = false;
    }
    const reason = !paired
        ? 'This Pi is not paired to an account'
        : !SUPABASE_ANON_KEY
          ? 'This Pi has no Supabase key configured'
          : !hasFix
            ? 'Signal K on this Pi cannot see the vessel right now'
            : null;
    res.json({ capable: paired && !!SUPABASE_ANON_KEY && hasFix, paired, hasFix, reason });
});

/**
 * The boat's own position, and WHICH receiver it came from.
 *
 * The app already reads the instrument bus directly through the gateway, so
 * this is the middle rung of the chain Shane asked for: Garmin, then the USB
 * stick on this Pi, then the phone. A phone below decks in a pocket is the
 * last resort, not the default, and this is what makes the middle rung
 * reachable at all.
 *
 * Always 200. `available: false` is a real answer — ashore, with nothing
 * feeding the bus, there is no fix and that is not an error.
 */
app.get('/api/gps', requireAppApi, async (_req, res) => {
    try {
        const fix = await currentFix({ fetchImpl: fetch, signalkOrigin: SIGNALK_ORIGIN });
        if (!fix || !fixIsCurrent(fix)) {
            return res.json({ available: false, reason: fix ? 'the last fix is stale' : 'no fix on the bus' });
        }
        return res.json({
            available: true,
            latitude: fix.latitude,
            longitude: fix.longitude,
            timestamp: fix.timestamp,
            source: fix.source ?? null,
        });
    } catch {
        return res.json({ available: false, reason: 'Signal K did not answer' });
    }
});

app.post('/api/anchor/watch', requireAppApi, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionCode = typeof body.sessionCode === 'string' ? body.sessionCode.trim() : '';
    const anchorLat = Number(body.anchorLat);
    const anchorLon = Number(body.anchorLon);
    const swingRadius = Number(body.swingRadius);
    if (!ANCHOR_SESSION_CODE_RE.test(sessionCode)) {
        return res.status(400).json({ status: 'error', error: 'sessionCode must be 12 alphanumeric characters' });
    }
    if (!Number.isFinite(anchorLat) || anchorLat < -90 || anchorLat > 90) {
        return res.status(400).json({ status: 'error', error: 'anchorLat must be a latitude' });
    }
    if (!Number.isFinite(anchorLon) || anchorLon < -180 || anchorLon > 180) {
        return res.status(400).json({ status: 'error', error: 'anchorLon must be a longitude' });
    }
    // An alarm radius of zero would drag on the first GPS jitter, and one the
    // size of a bay would never drag at all. Both are a broken watch.
    if (!Number.isFinite(swingRadius) || swingRadius < 5 || swingRadius > 5_000) {
        return res.status(400).json({ status: 'error', error: 'swingRadius must be between 5 and 5000 metres' });
    }
    const lent = diaryRelayOutbox.lendAnchorCredentials();
    if (!lent) {
        return res
            .status(409)
            .json({ status: 'error', error: 'This Pi is not paired to an account, so it cannot relay a watch' });
    }
    if (!SUPABASE_ANON_KEY) {
        return res.status(409).json({ status: 'error', error: 'This Pi has no Supabase anon key configured' });
    }
    // Optional: an older app build assigns without them, and the shore view
    // shows "--" rather than failing.
    const rodeLength = Number(body.rodeLength);
    const waterDepth = Number(body.waterDepth);
    anchorWatch.start(
        {
            sessionCode,
            anchorLat,
            anchorLon,
            swingRadius,
            rodeLength: Number.isFinite(rodeLength) && rodeLength > 0 ? rodeLength : undefined,
            waterDepth: Number.isFinite(waterDepth) && waterDepth > 0 ? waterDepth : undefined,
        },
        {
            url: canonicalAnchorRelayEndpoint(SUPABASE_ORIGIN),
            relayId: lent.relayId,
            token: lent.token,
            anonKey: SUPABASE_ANON_KEY,
        },
    );
    // Logged because the app cannot see this from ashore, and every diagnosis
    // of "the shore view says vessel offline" has come down to whether the Pi
    // was ever told, and whether something later told it to stop. Both were
    // silent, so both were guessed at.
    console.log(`⚓ Anchor watch STARTED for session ${sessionCode} (r=${swingRadius}m)`);
    return res.json({ status: 'ok', watch: anchorWatch.describe() });
});

app.delete('/api/anchor/watch', requireAppApi, (_req, res) => {
    const was = anchorWatch.describe();
    anchorWatch.stop();
    console.log(`⚓ Anchor watch STOPPED (was ${was.running ? `running ${was.sessionCode}` : 'not running'})`);
    return res.json({ status: 'ok', watch: anchorWatch.describe() });
});
app.use('/api/weather', createWeatherRoutes(cache, proxyConfig));
app.use('/api/tiles', createTileRoutes(cache, proxyConfig));
app.use('/api/grib', createGribRoutes(cache, proxyConfig));
app.use('/api/tides', createTideRoutes(cache, proxyConfig));
// The fixed named routes above have bounded upstreams. The generic function
// proxy below does not, so block it before the harmless misc allowlist.
app.use('/api/misc/proxy', requireUnsafeAdmin);
app.use('/api/misc', createMiscRoutes(cache, proxyConfig));
// Remote access via the punter's own Tailscale account — device management,
// so it sits behind the same gate as /api/configure. The transport is the
// pinned pairing channel either way.
app.use('/api/remote-access', requireAppApi, createRemoteAccessRoutes());
// ── App routes vs admin routes ──
// These used to share ONE flag, which meant pairing a phone required also
// exposing /api/misc/proxy, the raster-chart download/delete API and a 100 MB
// body limit. Pairing and chart sync are the product, not administration, and
// they carry their own defences (pinned TLS, TOFU pairing, per-payload
// signature). Network exposure is gated separately and restrictively by
// THALASSA_PI_LAN_BIND, so mounting these on a loopback-only server reaches
// nobody. See publicBetaBoundary.appApiEnabled for why this one defaults ON.
if (APP_API_ENABLED) {
    app.use('/api/enc', createEncRoutes(identity));
    app.use('/api/osm', createOsmRoutes());
    app.use('/api/pair', createPairRoutes(identity));
    app.use('/api/diary', createDiaryRelayRoutes(diaryRelayOutbox, diaryVideoRelay));
    app.use('/api/track', createTrackRoutes(trackStore, trackRecorder));
} else {
    for (const prefix of ['/api/enc', '/api/osm', '/api/pair', '/api/diary', '/api/track']) {
        app.use(prefix, requireAppApi);
    }
}
// Raster chart download/delete stays admin-only: it fetches arbitrary chart
// sets and removes files, and the app never calls it.
if (UNSAFE_ADMIN_API_ENABLED) {
    app.use('/api/charts', createChartRoutes());
} else {
    app.use('/api/charts', requireUnsafeAdmin);
}

// ── Boat-LAN app hosting (Shane 2026-07-09: "if the Pi serves charts
// to the device, how come it can't serve the computer?") ──
// It can — the blocker was never the network, it's browser mixed-content
// policy: a page from https://thalassawx.app may not fetch plain-HTTP
// LAN origins, so the DEPLOYED builder can't reach calypso.local. A page
// served FROM the Pi has no such problem: same-origin HTTP, ENC cells
// (licensed extracts included) flow to any browser on the boat network —
// LAN reachability IS the gate, exactly like the phone. Deploy drops the
// built web bundle into app-dist/ next to the server (see redeploy.sh);
// missing dir = feature off, the Pi stays a pure cache.
const APP_DIST = process.env.THALASSA_APP_DIST || path.join(process.cwd(), 'app-dist');
if (UNSAFE_ADMIN_API_ENABLED && fs.existsSync(path.join(APP_DIST, 'index.html'))) {
    app.use(express.static(APP_DIST));
    // SPA fallback: any dotless non-API path boots the app (mirrors the
    // Vercel catch-all so /plan works here too).
    app.get(/^\/(?!api\/)[^.]*$/, (_req, res) => {
        res.sendFile(path.join(APP_DIST, 'index.html'));
    });
    console.log(`🖥  Serving Thalassa web app from ${APP_DIST}`);
}

// ── Start ──

const server = https.createServer({ key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.2' }, app);
server.listen(PORT, BIND_HOST, () => {
    console.log(`\n🌊 Thalassa Pi Cache running on https://${BIND_HOST}:${PORT}`);
    console.log(`   Cache dir: ${CACHE_DIR}`);
    console.log(
        `   LAN bind:   ${BIND_HOST === '127.0.0.1' ? 'disabled (loopback only)' : 'ENABLED by explicit opt-in'}`,
    );
    console.log(`   Admin API:  ${UNSAFE_ADMIN_API_ENABLED ? 'UNSAFE DEVELOPMENT OPT-IN ENABLED' : 'disabled'}`);
    // Say this out loud. When these routes were folded into the admin flag,
    // the ONLY symptom of them being off was the app reporting "Pi not
    // connected" — which reads as a network fault, not a config one.
    console.log(
        `   App API:    ${APP_API_ENABLED ? 'pairing, ENC charts, OSM, diary' : 'DISABLED — the app cannot pair or sync charts'}`,
    );
    console.log(`   CORS:       ${CORS_ORIGINS.size > 0 ? [...CORS_ORIGINS].join(', ') : 'same-origin only'}\n`);

    /* ── Background workers are NOT an admin API ──────────────────────────
       Both of these used to require THALASSA_UNSAFE_ADMIN_API, which meant the
       only way to have weather prefetch or automatic chart decryption was to
       also expose an unbounded outbound proxy (/api/misc/proxy,
       /api/passthrough), a config writer, a cache purge, remote access, and
       arbitrary chart download/delete — on a machine holding the boat's charts,
       its track history and its ChartWorld credentials.

       That is a coupling, not a policy. Neither worker serves a request or
       reads one; they poll and they write to disk. Each already had its own
       honest gate — the scheduler needs a Supabase key to fetch anything, and
       the watcher has an explicit ENC_WATCHER_ENABLED — so they now stand on
       those alone, and the admin flag can go back to meaning what it says.
       (Shane 2026-08-30, after a redeploy warned the unsafe API was live.) ── */
    if (SUPABASE_ANON_KEY) {
        startScheduler(cache, proxyConfig);
    }

    // Close the chart-distribution loop: watch the user's o-charts download dir
    // for new .oesu files and auto-decrypt them into pi-cache's chart store.
    // Also starts the ChartWorld licence poller. The iOS app's auto-sync picks
    // new cells up on next launch.
    if (process.env.ENC_WATCHER_ENABLED === 'true') {
        startEncWatcher();
    }
});

// ── Plaintext port: a signpost, never a data path ──────────────────
// Everything that used to answer here now answers over TLS on the same port,
// so an app or laptop from before the switch would otherwise hang on a TLS
// handshake it never gets — the least diagnosable failure mode on a boat.
// This listener exists ONLY to turn that hang into a sentence. It reads no
// request body, serves no cache, and never redirects (a 30x would put the
// requested path back on the wire in clear, which is the thing we just fixed).
const plaintextSignpost = http.createServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end(
        `This Pi speaks HTTPS now — try https://${identity.boatName}:${PORT}/\n` +
            'The certificate is self-signed and pinned to the Pi pairing key;\n' +
            'the Thalassa app verifies it automatically, browsers will ask once.\n',
    );
});
plaintextSignpost.on('error', (err) => {
    // Port already busy is not fatal — TLS is up, which is what matters.
    console.warn(`[tls] plaintext signpost not listening: ${err instanceof Error ? err.message : String(err)}`);
});
plaintextSignpost.listen(PORT + 1, BIND_HOST, () => {
    console.log(`   Plaintext:  port ${PORT + 1} answers "use HTTPS" and nothing else\n`);
});

// ── Graceful Shutdown ──

function shutdown() {
    console.log('\n🛑 Shutting down...');
    stopScheduler();
    void stopEncWatcher();
    plaintextSignpost.close();
    server.close(() => {
        diaryRelayOutbox.close();
        cache.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
