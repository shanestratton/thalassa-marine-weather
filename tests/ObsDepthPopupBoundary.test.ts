import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');
const encVectorSource = readFileSync(resolve(process.cwd(), 'components/map/EncVectorLayer.ts'), 'utf8');

describe('OBS depth-inspection boundary', () => {
    it('enables tap-to-check-keel-depth only on the clean Plan surface', () => {
        expect(mapHubSource).toContain('setEncDepthPopupEnabled(map, cleanPlanningMap);');
    });

    it('suppresses both charted and uncharted water-depth verdicts without muting mark popups', () => {
        expect(encVectorSource).toContain('if (depthPopupAllowed) showUnchartedDepthPopup(map, e.lngLat);');
        expect(encVectorSource).toContain('if (layerId === ENC_VEC_LAYERS.DEPARE && !depthPopupAllowed) return;');
    });
});
