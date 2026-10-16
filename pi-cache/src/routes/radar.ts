/** Mount only in the paired pinned-TLS app-only route group. No public HTTP mount. */
import { Router } from 'express';
import { RADAR_RESPONSE_BYTES, type RadarRawReader } from '../radar/rawReader.js';
export function createRadarRoutes(reader: Pick<RadarRawReader, 'snapshot'>): Router {
    const router = Router();
    router.get('/targets', (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: 'Radar targets takes no query' });
        const text = JSON.stringify(reader.snapshot());
        if (Buffer.byteLength(text, 'utf8') > RADAR_RESPONSE_BYTES)
            return res.status(503).json({ error: 'Radar cache exceeds its response bound' });
        res.setHeader('Cache-Control', 'no-store');
        return res.type('application/json').send(text);
    });
    return router;
}
