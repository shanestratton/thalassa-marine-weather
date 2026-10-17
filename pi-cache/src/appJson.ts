import express, { type RequestHandler } from 'express';
/** Watch mutations authenticate first, then enforce their own smaller raw-byte cap. */
export function createAppJsonParser(unsafeAdmin: boolean): RequestHandler {
    const parse = express.json({ limit: unsafeAdmin ? '100mb' : '64kb' });
    return (req, res, next) => {
        const path = req.path.toLowerCase();
        if (
            path === '/api/wake-rules' ||
            path.startsWith('/api/wake-rules/') ||
            path === '/api/fleet-sharing' ||
            path.startsWith('/api/fleet-sharing/') ||
            path === '/api/own-boat-skill' ||
            path.startsWith('/api/own-boat-skill/') ||
            path === '/api/radar' ||
            path.startsWith('/api/radar/')
        )
            return next();
        return parse(req, res, next);
    };
}
