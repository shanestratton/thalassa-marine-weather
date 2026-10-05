/**
 * Seabed routes: the app's switch and readout for the Pi's sounding log.
 *
 *   GET  /api/seabed/status  what is on, what is running, what is held
 *   POST /api/seabed/config  the owner's settings, pushed over the boat LAN
 *
 * App-only, behind the pinned-TLS transport like the track routes: this is
 * where the boat has been, and how deep it was there. There is no route that
 * reads soundings back; they leave the Pi only for the owner's own account.
 *
 * `enabled` is the owner's switch and `logger` says which device logs ('pi',
 * the default, or 'phone'). Only the switch going OFF purges the queue: a
 * logger moved to a phone leaves what this Pi already holds to upload.
 *
 * The config is PERSISTED BEFORE IT IS ACTED ON, so a Pi that dies mid-request
 * comes back in the state the skipper asked for. A config naming a different
 * account than the one this Pi is paired to is refused: crew on the LAN, or a
 * second account on the same phone, cannot point the boat's log anywhere.
 * Switching ON needs the current consent version, as the cloud path does.
 *
 * `zones` and `sounder_note` are optional: a phone that does not know them (it
 * has never seen the owner's cloud row) leaves the Pi's own alone, so a fresh
 * device can never blank the home berth.
 */
import { Request, Response, Router } from 'express';
import { parseSeabedZones, SEABED_CONSENT_VERSION, SEABED_CORE_VERSION } from '../seabed/seabedCore.js';
import type { PiSeabedConfig, SeabedStore } from '../seabed/seabedStore.js';

export interface SeabedRouteDeps {
    store: SeabedStore;
    /** The account this Pi is paired to (DiaryRelayOutbox), null while unpaired; binds the log to it first. */
    ownerId: () => string | null;
    /** Act on a config that has already been saved; `withdrawn` = the owner switched it off. */
    apply: (config: PiSeabedConfig, withdrawn: boolean) => void;
    describe: () => Record<string, unknown>;
    uploaderStatus: () => { lastOutcome: string | null; lastUploadAt: number | null };
}

const CONSENT_RE = /^\d{4}-\d{2}-\d{2}$/;

function body(req: Request): Record<string, unknown> {
    const b: unknown = req.body;
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
    if (typeof b === 'string') {
        try {
            const parsed: unknown = JSON.parse(b);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
        } catch {
            return {};
        }
    }
    return {};
}

export function createSeabedRoutes(deps: SeabedRouteDeps): Router {
    const router = Router();

    router.get('/status', (_req: Request, res: Response) => {
        try {
            deps.ownerId();
            const config = deps.store.getConfig();
            const stats = deps.store.stats();
            const uploader = deps.uploaderStatus();
            res.json({
                coreVersion: SEABED_CORE_VERSION,
                enabled: config.enabled,
                consentVersion: config.consentVersion,
                zones: config.zones.length,
                ...deps.describe(),
                pending: stats.pending,
                parked: stats.parked,
                uploaded: stats.uploaded,
                rejected: stats.rejected,
                openRows: stats.openRows,
                lastUploadAt: stats.lastUploadAt,
                uploader: uploader.lastOutcome,
                storage: stats.storage,
            });
        } catch (err) {
            res.status(503).json({ error: err instanceof Error ? err.message : 'seabed store unavailable' });
        }
    });

    router.post('/config', (req: Request, res: Response) => {
        const b = body(req);
        if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
        const zones = b.zones === undefined ? undefined : parseSeabedZones(b.zones);
        if (zones === null) return res.status(400).json({ error: 'zones are malformed' });
        const consent = b.consent_version ?? null;
        if (consent !== null && (typeof consent !== 'string' || !CONSENT_RE.test(consent))) {
            return res.status(400).json({ error: 'consent_version must be a date' });
        }
        const note = b.sounder_note === undefined ? undefined : b.sounder_note;
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 120)) {
            return res.status(400).json({ error: 'sounder_note must be at most 120 characters' });
        }
        const draft = b.vessel_draft_m ?? null;
        if (draft !== null && (typeof draft !== 'number' || !Number.isFinite(draft) || draft < 0 || draft > 30)) {
            return res.status(400).json({ error: 'vessel_draft_m must be metres' });
        }
        const owner = deps.ownerId();
        if (!owner) return res.status(409).json({ error: 'This Pi is not paired to an account' });
        if (b.owner_id !== owner) return res.status(403).json({ error: 'This Pi belongs to another account' });
        if (b.enabled && consent !== SEABED_CONSENT_VERSION) {
            return res.status(409).json({ error: 'Switching on needs the current consent', code: 'consent-outdated' });
        }
        const current = deps.store.getConfig();
        const updatedAt = typeof b.updated_at === 'number' && Number.isFinite(b.updated_at) ? b.updated_at : Date.now();
        // Switched on with a PHONE as the logger is not switched off: this Pi
        // stops logging but keeps (and uploads) what it already holds.
        const piLogs = b.logger !== 'phone';
        const config: PiSeabedConfig = {
            enabled: b.enabled && piLogs,
            consentVersion: consent,
            zones: zones ?? current.zones,
            sounderNote: note === undefined ? current.sounderNote : (note as string | null),
            vesselDraftM: draft,
            draftConfirmed: typeof b.draft_confirmed === 'boolean' ? b.draft_confirmed : null,
            updatedAt,
            source: 'lan',
            ownerId: owner,
        };
        try {
            deps.store.setConfig(config);
            if (!b.enabled) deps.store.purgeAll();
        } catch (err) {
            return res.status(503).json({ error: err instanceof Error ? err.message : 'could not save' });
        }
        deps.apply(config, !b.enabled);
        return res.json({ ok: true, enabled: config.enabled, zones: config.zones.length });
    });

    return router;
}
