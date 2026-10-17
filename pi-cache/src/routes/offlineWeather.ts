import { Router } from 'express';
import type { OfflineWeatherStore } from '../offlineWeather.js';

/** Mounted behind the existing app/device gate. All handlers are cache-only. */
export function createOfflineWeatherRoutes(store: OfflineWeatherStore): Router {
    const router = Router();
    router.use((_request, response, next) => {
        response.set('Cache-Control', 'no-store');
        next();
    });
    router.get('/capabilities', (_request, response) => {
        response.json(store.capabilities());
    });
    router.get('/satellite', (_request, response) => {
        const data = store.satellite();
        if (!data?.frames.length) {
            response.status(404).json({ error: 'No satellite frames received aboard' });
            return;
        }
        response.json(data);
    });
    router.get('/analysis/:id', (request, response) => {
        const data = store.analysis(String(request.params.id));
        if (!data) {
            response.status(404).json({ error: 'No official analysis received aboard' });
            return;
        }
        response.json(data);
    });
    router.get('/bulletins', (_request, response) => {
        response.json(store.bulletins());
    });
    return router;
}
