import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    CHL_RAMP_HEX,
    CURRENT_WAVE_RAMP_HEX,
    encodeSstTemperatureByte,
    MLD_RAMP_HEX,
    SST_DISPLAY_MAX_C,
    SST_DISPLAY_MIN_C,
} from '../components/map/marineLayerRamps';
import { MARINE_MOTION_HONESTY } from '../components/map/ThalassaHelixControl';

describe('CMEMS marine visual contracts', () => {
    it('encodes the full signed SST display domain without erasing polar water', () => {
        expect(SST_DISPLAY_MIN_C).toBe(-3);
        expect(SST_DISPLAY_MAX_C).toBe(40);
        expect(encodeSstTemperatureByte(-10)).toBe(0);
        expect(encodeSstTemperatureByte(-3)).toBe(0);
        expect(encodeSstTemperatureByte(0)).toBe(18);
        expect(encodeSstTemperatureByte(40)).toBe(255);
        expect(encodeSstTemperatureByte(45)).toBe(255);

        const source = readFileSync('components/map/SstRasterLayer.ts', 'utf8');
        expect(source).not.toContain('if (vRaw < 0.005) discard');
        expect(source).toContain('encodeSstTemperatureByte(temp[i])');
    });

    it('keeps legend stops aligned to the actual marine shader palettes', () => {
        expect(CURRENT_WAVE_RAMP_HEX).toEqual(['#1a4d8c', '#33a6d9', '#8ccc8c', '#f2cc66', '#f2734d', '#d9404d']);
        expect(CHL_RAMP_HEX).toEqual(['#1a5966', '#268c59', '#59bf4d', '#bfd940', '#f2cc26', '#f28026']);
        expect(MLD_RAMP_HEX).toEqual(['#f5eb66', '#fa9f33', '#eb4d4d', '#c72e80', '#73198c', '#1a0d4d']);
    });

    it('labels wave vectors as significant-wave-height metres, not physical velocity', () => {
        const source = readFileSync('components/map/WaveParticleLayer.ts', 'utf8');
        expect(source).toContain('DISPLAY_ADVECTION_FACTOR');
        expect(source).toContain('WAVE_STRONG_M');
        expect(source).not.toContain('SPEED_STRONG_M_S');
        expect(source).not.toContain('a_particle_speed;  // m/s');
    });

    it('never presents display-tuned current or wave particle motion as measured speed', () => {
        expect(MARINE_MOTION_HONESTY).toEqual({
            currents: 'Colour = current speed (m/s) · particle motion = direction only (speed illustrative)',
            waves: 'Colour = significant wave height (m) · particle motion = direction only (speed illustrative)',
        });
    });

    it('tiers both global vector layers and bounds their persistent trail ownership', () => {
        for (const filename of ['components/map/CurrentParticleLayer.ts', 'components/map/WaveParticleLayer.ts']) {
            const source = readFileSync(filename, 'utf8');
            expect(source).toContain("import { particleScale } from '../../utils/deviceTier'");
            expect(source).toContain('Math.round(80000 * particleScale())');
            expect(source).toContain('const TRAIL_LENGTH = 20;');
        }
    });

    it('releases particle CPU arrays, grid references, timers and every owned GL resource on removal', () => {
        for (const filename of ['components/map/CurrentParticleLayer.ts', 'components/map/WaveParticleLayer.ts']) {
            const source = readFileSync(filename, 'utf8');
            const onRemove = source.slice(source.indexOf('onRemove('), source.indexOf('// ── Public API'));

            expect(onRemove).toContain("document.removeEventListener('visibilitychange'");
            expect(onRemove).toContain('clearTimeout(this._keepaliveTimer)');
            expect(onRemove).toContain('gl2.deleteVertexArray(this.particleVAO)');
            expect(onRemove.match(/gl\.deleteBuffer\(/g)).toHaveLength(4);
            expect(onRemove).toContain('gl.deleteTexture(this.speedTexture)');
            expect(onRemove.match(/gl\.deleteProgram\(/g)).toHaveLength(2);
            expect(onRemove).toContain('this.releaseCpuOwnership()');

            const cpuRelease = source.slice(
                source.indexOf('private releaseCpuOwnership()'),
                source.indexOf('// ── Mapbox lifecycle'),
            );
            const frameRelease = source.slice(
                source.indexOf('private clearFrameData()'),
                source.indexOf('private releaseCpuOwnership()'),
            );
            expect(cpuRelease).toContain('this.clearFrameData()');
            expect(cpuRelease).toContain('this.trailData = new Float32Array(0)');
            expect(cpuRelease).toContain('this.particleAges = new Int32Array(0)');
            for (const field of ['gridU', 'gridV', 'gridSpeed', 'landMask', 'spawnCDF', 'spawnIndexMap']) {
                expect(frameRelease).toContain(`this.${field} = null`);
            }
        }
    });
});
