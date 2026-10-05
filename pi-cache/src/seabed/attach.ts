/**
 * Seabed mapping on the Pi, wired in with ONE call from server.ts.
 *
 * Everything the feature needs is built here (store, Signal K reader, runner,
 * uploader, routes), so the server gains one import and one call and the
 * staged Pi install is that two-line delta plus these files. Nothing in here
 * may take the server down: any failure to start leaves the routes answering
 * 503 and the anchor watch, instruments and everything else untouched.
 *
 * Off by default. It starts only when the owner switches it on, by a LAN push
 * from the app or the config the uploader pulls from the cloud.
 *
 * WHOSE LOG. The log belongs to the account the Pi is paired to. Every 30 s,
 * and before every route and upload, bindSeabedOwner() compares the account
 * the settings were made for with the pairing: unpaired, or paired to someone
 * new, and the runner stops and the store is emptied. A new owner starts from
 * nothing, with nothing of the old owner's trips; nobody can be logged for
 * by a Pi nobody is paired to.
 */
import zlib from 'node:zlib';
import type express from 'express';
import { createSeabedRoutes } from '../routes/seabed.js';
import { parseSeabedZones, SEABED_CONSENT_VERSION } from './seabedCore.js';
import { SignalkSelfReader } from './seabedReader.js';
import { SeabedRunner } from './seabedRunner.js';
import { DEFAULT_SEABED_CONFIG, SeabedStore, type PiSeabedConfig } from './seabedStore.js';
import { SEABED_RELAY_PATH, SeabedUploader } from './seabedUploader.js';

export interface AttachSeabedOptions {
    app: express.Express;
    cacheDir: string;
    signalkOrigin: string;
    /** The process-startup Supabase origin: the only place batches can go. */
    supabaseOrigin: string;
    anonKey: () => string;
    outbox: {
        lendTelemetryCredentials(): { relayId: string; token: string } | null;
        getConfiguration(): { allowInternet: boolean; ownerId: string | null };
    };
    appApiEnabled: boolean;
    requireAppApi: express.RequestHandler;
    fetchImpl?: typeof fetch;
}

function gzip(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => zlib.gzip(text, (err, out) => (err ? reject(err) : resolve(out))));
}

/**
 * Make the Pi's log the paired account's. True when it had to start again:
 * the runner is discarded (nothing of the trip is closed or kept) and the
 * store emptied, with the settings back to OFF for the account paired now.
 */
export function bindSeabedOwner(store: SeabedStore, runner: SeabedRunner, pairedOwnerId: string | null): boolean {
    const config = store.getConfig();
    if (config.ownerId === pairedOwnerId) return false;
    runner.discard();
    store.purgeAll();
    store.setConfig({ ...DEFAULT_SEABED_CONFIG, ownerId: pairedOwnerId, updatedAt: Date.now() });
    console.log(
        `[seabed] ${pairedOwnerId ? 'paired to a different account' : 'unpaired'}: logging off, and this Pi's soundings removed`,
    );
    return true;
}

/**
 * The cloud's answer becomes the Pi's config unless a newer LAN push is still
 * waiting for the phone to sync. `withdrawn` only when the owner's switch is
 * OFF: a logger moved to a phone is not a withdrawal.
 */
export function configFromCloud(
    answer: Record<string, unknown>,
    current: PiSeabedConfig,
    pairedOwnerId: string | null,
): { config: PiSeabedConfig; withdrawn: boolean } | null {
    const p = answer.platform;
    if (!p || typeof p !== 'object') {
        // No platform row. Kept on only when the paired owner set it over the
        // LAN and their phone has not created the row yet; otherwise (the row
        // was deleted, the account with it) the Pi stops and lets go.
        if (!current.enabled) return null;
        if (current.source === 'lan' && current.ownerId !== null && current.ownerId === pairedOwnerId) return null;
        return {
            config: { ...current, enabled: false, source: 'cloud', updatedAt: Date.now(), ownerId: pairedOwnerId },
            withdrawn: true,
        };
    }
    const platform = p as Record<string, unknown>;
    const updatedAt = typeof platform.updated_at === 'string' ? Date.parse(platform.updated_at) : NaN;
    if (current.source === 'lan' && Number.isFinite(updatedAt) && current.updatedAt > updatedAt) return null;
    const consent = typeof platform.consent_version === 'string' ? platform.consent_version : null;
    const vessel =
        platform.vessel && typeof platform.vessel === 'object' ? (platform.vessel as Record<string, unknown>) : {};
    const draft = typeof vessel.draft_m === 'number' && Number.isFinite(vessel.draft_m) ? vessel.draft_m : null;
    const config: PiSeabedConfig = {
        enabled: platform.enabled === true && consent === SEABED_CONSENT_VERSION && platform.capture === 'pi',
        consentVersion: consent,
        zones: parseSeabedZones(platform.zones) ?? current.zones,
        sounderNote:
            typeof platform.sounder_note === 'string' ? platform.sounder_note.slice(0, 120) : current.sounderNote,
        vesselDraftM: draft !== null && draft >= 0 && draft <= 30 ? draft : current.vesselDraftM,
        draftConfirmed: typeof vessel.draft_confirmed === 'boolean' ? vessel.draft_confirmed : current.draftConfirmed,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        source: 'cloud',
        ownerId: pairedOwnerId,
    };
    return { config, withdrawn: platform.enabled !== true };
}

export function attachSeabed(options: AttachSeabedOptions): { close(): void } {
    const { app, requireAppApi } = options;
    try {
        const fetchImpl = options.fetchImpl ?? fetch;
        const store = new SeabedStore(options.cacheDir);
        const reader = new SignalkSelfReader(fetchImpl, options.signalkOrigin);
        const runner = new SeabedRunner({
            read: () => reader.read('vessels/self'),
            readSources: () => reader.read('sources'),
            store,
            gzip,
        });
        const paired = () => options.outbox.getConfiguration().ownerId;
        /** The paired account, after making sure the log is theirs. */
        const bindOwner = (): string | null => {
            const owner = paired();
            bindSeabedOwner(store, runner, owner);
            return owner;
        };
        const apply = (config: PiSeabedConfig, withdrawn: boolean): void => {
            if (config.enabled) {
                runner.applyConfig(config);
                return;
            }
            // Not logging here any more: end the trip. Only a switch turned OFF
            // also drops what it closed, with every other batch it holds.
            void runner.stop().then(() => (withdrawn ? store.purgeAll() : 0));
        };
        const uploader = new SeabedUploader({
            fetchImpl: fetchImpl as unknown as ConstructorParameters<typeof SeabedUploader>[0]['fetchImpl'],
            endpoint: `${options.supabaseOrigin}${SEABED_RELAY_PATH}`,
            anonKey: options.anonKey,
            credentials: () => options.outbox.lendTelemetryCredentials(),
            internetAllowed: () => options.outbox.getConfiguration().allowInternet,
            store,
            ownerId: bindOwner,
            onConfig: (answer) => {
                const owner = bindOwner();
                const current = store.getConfig();
                const next = configFromCloud(answer, current, owner);
                if (!next) return;
                store.setConfig(next.config);
                if (next.withdrawn) store.purgeAll();
                if (current.enabled !== next.config.enabled) apply(next.config, next.withdrawn);
                else runner.applyConfig(next.config);
            },
            onWithdrawn: () => {
                store.setConfig({ ...store.getConfig(), enabled: false, source: 'cloud', updatedAt: Date.now() });
                apply(store.getConfig(), true);
            },
        });

        if (options.appApiEnabled) {
            app.use(
                '/api/seabed',
                createSeabedRoutes({
                    store,
                    ownerId: bindOwner,
                    apply: (config, withdrawn) => {
                        apply(config, withdrawn);
                        uploader.nudge();
                    },
                    describe: () => ({ ...runner.describe() }),
                    uploaderStatus: () => uploader.status(),
                }),
            );
        } else {
            app.use('/api/seabed', requireAppApi);
        }

        bindOwner();
        if (store.getConfig().enabled) runner.start();
        uploader.start();
        // Unpaired or re-paired between uploads: the log lets go within 30 s.
        const ownerWatch = setInterval(() => {
            try {
                bindOwner();
            } catch (err) {
                console.warn(`[seabed] owner check failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }, 30_000);
        ownerWatch.unref?.();
        console.log(
            `[seabed] ready: ${store.getConfig().enabled ? 'logging when under way' : 'off until the owner switches it on'}`,
        );

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(ownerWatch);
            runner.halt();
            uploader.stop();
            store.close();
        };
        process.once('SIGTERM', close);
        process.once('SIGINT', close);
        return { close };
    } catch (err) {
        console.warn(`[seabed] not started: ${err instanceof Error ? err.message : String(err)}`);
        app.use('/api/seabed', (_req, res) => {
            res.status(503).json({ error: 'Seabed mapping is unavailable on this Pi' });
        });
        return { close: () => undefined };
    }
}
