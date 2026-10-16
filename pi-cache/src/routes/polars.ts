import { Router } from 'express';
import type { PiPolarLearner } from '../polarLearner.js';
import { validPolarTable, type PolarTable } from '../polarLearningRule.js';

/** Mount only on the paired, app-only TLS router, behind the vessel command lock. */
export function createPolarRoutes(learner: PiPolarLearner): Router {
    const router = Router();
    router.get('/snapshot', (_req, res) => res.json(learner.snapshot()));
    router.post('/config', (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        if (
            !body ||
            typeof body.enabled !== 'boolean' ||
            (body.baseline !== undefined && !validPolarTable(body.baseline))
        )
            return res
                .status(400)
                .json({ error: 'A boolean enabled and an optional valid baseline polar are required' });
        try {
            learner.configure({
                enabled: body.enabled,
                ...(body.baseline ? { baseline: body.baseline as PolarTable } : {}),
            });
        } catch {
            return res.status(503).json({ error: 'Polar preference could not be saved' });
        }
        return res.json(learner.snapshot());
    });
    return router;
}
