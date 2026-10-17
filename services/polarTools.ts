import type { PolarData } from '../types/navigation';
import { DEFAULT_CRUISING_POLAR } from './defaultPolar';
import { polarSpeed, validPolarTable } from '../utils/polarLearningRule';

export const routingPolarScale = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0.7, Math.min(1.3, value)) : 1;

export function scalePolar(polar: PolarData, factor: number): PolarData {
    const scale = routingPolarScale(factor);
    return {
        windSpeeds: [...polar.windSpeeds],
        angles: [...polar.angles],
        matrix: polar.matrix.map((row) => row.map((v) => Math.min(40, v * scale))),
    };
}

/** Existing cells stay exact; new cells interpolate between the neighbouring figures. */
export function resizePolar(polar: PolarData, windSpeeds: number[], angles: number[]): PolarData {
    const axis = (a: number[], maximum: number, oldLength: number) =>
        a.length >= Math.min(2, Math.max(1, oldLength)) &&
        a.length <= 30 &&
        a.every((v, i) => Number.isFinite(v) && v > 0 && v <= maximum && (!i || v > a[i - 1]));
    if (!axis(windSpeeds, 150, polar.windSpeeds.length) || !axis(angles, 180, polar.angles.length))
        throw new Error('Use 2–30 different, increasing wind speeds and angles.');
    if (!polar.windSpeeds.length || !polar.angles.length) throw new Error('The original grid is empty.');
    return {
        windSpeeds: [...windSpeeds],
        angles: [...angles],
        matrix: angles.map((a) =>
            windSpeeds.map((w) => {
                const ai = polar.angles.indexOf(a),
                    wi = polar.windSpeeds.indexOf(w);
                if (ai >= 0 && wi >= 0) return polar.matrix[ai][wi];
                if (
                    a < polar.angles[0] ||
                    a > polar.angles.at(-1)! ||
                    w < polar.windSpeeds[0] ||
                    w > polar.windSpeeds.at(-1)!
                )
                    return 0;
                return Math.round(polarSpeed(polar, w, a) * 100) / 100;
            }),
        ),
    };
}

export interface PolarTargets {
    windKts: number;
    beatAngle: number;
    beatKts: number;
    reachKts: number;
    runKts: number;
}
/** A starting estimate from three targets. Never a measured or licensed yacht polar. */
export function polarFromTargets(target: PolarTargets): PolarData {
    if (
        ![target.windKts, target.beatAngle, target.beatKts, target.reachKts, target.runKts].every(Number.isFinite) ||
        target.windKts < 3 ||
        target.windKts > 30 ||
        target.beatAngle < 30 ||
        target.beatAngle > 80 ||
        [target.beatKts, target.reachKts, target.runKts].some((v) => v <= 0 || v > 30)
    )
        throw new Error('Use wind 3–30 kn, a beat angle 30–80°, and target speeds above 0 and at most 30 kn.');
    const windSpeeds = [...new Set([6, 8, 10, 12, 15, 20, 25, target.windKts])].sort((a, b) => a - b);
    const angles = [
        ...new Set([target.beatAngle, 45, 60, 90, 120, 150, 180].filter((a) => a >= target.beatAngle)),
    ].sort((a, b) => a - b);
    const speed = (a: number) =>
        a <= 90
            ? target.beatKts + ((target.reachKts - target.beatKts) * (a - target.beatAngle)) / (90 - target.beatAngle)
            : target.reachKts + ((target.runKts - target.reachKts) * (a - 90)) / 90;
    return {
        windSpeeds,
        angles,
        matrix: angles.map((a) =>
            windSpeeds.map(
                (w) =>
                    Math.round(
                        Math.min(
                            40,
                            (speed(a) * polarSpeed(DEFAULT_CRUISING_POLAR, w, a)) /
                                polarSpeed(DEFAULT_CRUISING_POLAR, target.windKts, a),
                        ) * 100,
                    ) / 100,
            ),
        ),
    };
}

export function polarFile(polar: PolarData, format: 'pol' | 'csv'): string {
    if (!validPolarTable(polar)) throw new Error('Enter a complete, finite polar grid before exporting.');
    const n = (value: number) => String(Math.round(value * 100) / 100);
    return format === 'pol'
        ? '!Expedition polar\n' +
              polar.windSpeeds
                  .map((w, wi) =>
                      [n(w), ...polar.angles.flatMap((a, ai) => [n(a), n(polar.matrix[ai][wi])])].join('\t'),
                  )
                  .join('\n') +
              '\n'
        : [
              'TWA\\TWS,' + polar.windSpeeds.map(n).join(','),
              ...polar.angles.map((a, ai) => [n(a), ...polar.matrix[ai].map(n)].join(',')),
          ].join('\n') + '\n';
}

export async function sharePolar(polar: PolarData, format: 'pol' | 'csv', name: string): Promise<void> {
    const data = polarFile(polar, format);
    const filename = `${name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'thalassa-polar'}.${format}`;
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
        const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
            import('@capacitor/filesystem'),
            import('@capacitor/share'),
        ]);
        const written = await Filesystem.writeFile({
            path: filename,
            data,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
        });
        try {
            await Share.share({ title: filename, files: [written.uri], dialogTitle: 'Export polar' });
        } catch (error) {
            if (!/cancel|dismiss/i.test(error instanceof Error ? error.message : '')) throw error;
        }
        return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: format === 'csv' ? 'text/csv' : 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
