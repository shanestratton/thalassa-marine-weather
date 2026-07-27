/**
 * Diary relay routes for Boat-LAN clients.
 *
 * POST always saves an entry to the Pi's durable outbox before responding.
 * A successful immediate relay simply upgrades that already-acknowledged
 * record to `synced`; an unavailable WAN remains a normal `queued` result.
 */

import { Request, Response, Router } from 'express';
import {
    DiaryRelayOperationCancelledError,
    DiaryRelayOperationConflictError,
    DiaryRelayOutbox,
    DiaryRelayValidationError,
    type DiaryRelayEnvelope,
} from '../diaryRelayOutbox.js';

function requestEnvelope(value: unknown): DiaryRelayEnvelope {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as DiaryRelayEnvelope;
    // Some Capacitor iOS releases pass `data: JSON.stringify(value)` through
    // the native bridge as a JSON string despite the content-type. Match the
    // Pi configuration endpoint's narrow compatibility handling so a diary
    // can still reach the durable outbox from those devices.
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as DiaryRelayEnvelope;
        } catch {
            // The outbox supplies the normal validated 400 response below.
        }
    }
    return {} as DiaryRelayEnvelope;
}

function cancellationOperationId(value: unknown): string {
    const body = requestEnvelope(value) as unknown as Record<string, unknown>;
    return typeof body.client_operation_id === 'string' ? body.client_operation_id : '';
}

export function createDiaryRelayRoutes(outbox: DiaryRelayOutbox): Router {
    const router = Router();

    /**
     * POST /api/diary/entries
     *
     * Accepts an idempotent phone envelope. The `client_operation_id` inside
     * `entry` is the durable idempotency key; sending it again is safe.
     */
    router.post('/entries', async (req: Request, res: Response) => {
        try {
            const queued = outbox.enqueue(requestEnvelope(req.body));
            // This is deliberately after enqueue(): no network result can be
            // returned before the phone's entry has survived a Pi restart.
            const current = await outbox.attempt(queued.operationId);
            const result = current ?? queued;
            // GET status remains metadata-only for the Boat LAN. This one
            // immediate response goes only to the submitting device and gives
            // it the canonical Supabase row needed to retire its local draft.
            const canonicalEntry =
                result.kind === 'entry' && result.status === 'synced'
                    ? outbox.getCanonicalEntry(result.operationId)
                    : null;
            return res.json({
                accepted: true,
                status: result.status,
                client_operation_id: result.operationId,
                client_revision: result.clientRevision,
                ...(result.kind === 'cancellation' ? { cancelled: true } : {}),
                ...(canonicalEntry ? { entry: canonicalEntry } : {}),
            });
        } catch (error) {
            if (error instanceof DiaryRelayValidationError) {
                return res.status(400).json({ accepted: false, error: error.message });
            }
            if (error instanceof DiaryRelayOperationConflictError) {
                return res.status(409).json({ accepted: false, error: error.message });
            }
            if (error instanceof DiaryRelayOperationCancelledError) {
                // A stale device retry must not resurrect a tombstoned diary.
                return res.status(409).json({ accepted: false, cancelled: true, error: error.message });
            }
            // Do not log the request body: it can contain private diary text
            // and the scoped relay credential.
            console.warn('Could not queue diary relay entry:', error instanceof Error ? error.message : String(error));
            return res.status(500).json({ accepted: false, error: 'Could not queue diary entry' });
        }
    });

    /**
     * POST /api/diary/cancel
     *
     * Writes a cancellation tombstone before acknowledgement, removes an
     * unsent local entry atomically, and retries the scoped Edge cancellation
     * until it receives `{ ok: true }`. A cancellation has priority over
     * normal diary delivery after every Pi restart.
     */
    router.post('/cancel', async (req: Request, res: Response) => {
        try {
            const operationId = cancellationOperationId(req.body);
            const queued = outbox.cancel(operationId);
            const current = await outbox.attemptCancellation(operationId);
            const result = current ?? queued;
            return res.json({
                accepted: true,
                status: result.status,
                client_operation_id: result.operationId,
            });
        } catch (error) {
            if (error instanceof DiaryRelayValidationError) {
                return res.status(400).json({ accepted: false, error: error.message });
            }
            // Do not log the body: a diary operation id is safe, but keep the
            // route's failure behaviour uniformly privacy-first.
            console.warn('Could not queue diary cancellation:', error instanceof Error ? error.message : String(error));
            return res.status(500).json({ accepted: false, error: 'Could not queue diary cancellation' });
        }
    });

    /**
     * GET /api/diary/status/:operationId — metadata only. Boat-LAN status may
     * be visible to other connected devices, so it never includes diary text,
     * media, the server row, relay URL, or scoped bearer credential.
     */
    router.get('/status/:operationId', (req: Request, res: Response) => {
        const operationId = Array.isArray(req.params.operationId) ? req.params.operationId[0] : req.params.operationId;
        const record = outbox.getStatus(operationId ?? '');
        if (!record) return res.status(404).json({ error: 'Diary operation not found' });
        return res.json(record);
    });

    return router;
}
