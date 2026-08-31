// @vitest-environment node
/**
 * A passage must be publicly present from the moment it starts (2026-09-01:
 * Cast-Off departure showed its route but "No trip started yet", while a
 * Log-page start was fine). Two independent guarantees:
 *
 *   1. SERVER: the trip picker mints the active voyage from its own row —
 *      never dependent on the live trickle having delivered a point.
 *   2. CLIENT: the live trickle self-heals from the capture heartbeat, so
 *      whichever start path forgot to arm it, the first captured fix does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');
const trickle = readFileSync(resolve(process.cwd(), 'services/shiplog/LiveTrickle.ts'), 'utf8');
const entrySave = readFileSync(resolve(process.cwd(), 'services/shiplog/EntrySave.ts'), 'utf8');

describe('the picker does not depend on the live trickle', () => {
    it('falls back to the active voyage row, zombie-guarded', () => {
        expect(edge).toContain(".eq('status', 'active')");
        expect(edge).toContain('const ACTIVE_ROW_FRESH_MS = 7 * 24 * 3_600_000;');
        expect(edge).toContain(': activeRowVoyageId;');
        // Hidden voyages stay hidden even while active.
        expect(edge).toContain('!hiddenVoyageIds.has(id)');
    });

    it('seeds the departure moment when no point exists yet', () => {
        expect(edge).toContain('timestamp: activeRowStartedAtIso,');
    });
});

describe('the trickle self-heals from the capture heartbeat', () => {
    it('an unarmed or wrong-voyage session is re-armed by the first fix', () => {
        expect(trickle).toContain('if (activeVoyageId) startLiveTrickle(activeVoyageId, expectedScope, boatId);');
        expect(trickle).toContain('session.voyageId !== activeVoyageId');
    });

    it('the capture path names its voyage to the heartbeat', () => {
        expect(entrySave).toContain(
            'noteLiveTrickleHeartbeat(scope, entry.voyageId ?? null, entry.boatId ?? undefined);',
        );
    });
});
