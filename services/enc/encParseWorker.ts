import {
    parseNoaaPart,
    noaaFeatureBounds,
    noaaPartIntersects,
    noaaLeadDependency,
    type NoaaPackage,
    type NoaaPartObject,
} from './noaaPackageContract';
/**
 * encParseWorker — one job: JSON.parse multi-MB cell text off the main
 * thread (closing audit: the cold-path parse blocks were indivisible —
 * a 7 MB harbour cell froze ~100-200 ms per cell during boot merges).
 * The worker pays the parse; the main thread pays only the structured
 * clone IN, which is substantially cheaper than parsing the same text.
 */
const ctx = self as unknown as {
    onmessage:
        | ((
              ev: MessageEvent<{
                  seq: number;
                  cellId: string;
                  text: string;
                  noaaPackage?: NoaaPackage;
                  descriptor?: NoaaPartObject;
                  bounds?: [number, number, number, number];
                  select?: boolean;
                  completeLateralMarks?: boolean;
              }>,
          ) => void)
        | null;
    postMessage(msg: { seq: number; cellId: string; blob: unknown | null }): void;
};

ctx.onmessage = (ev) => {
    const { seq, cellId, text } = ev.data;
    try {
        let blob = JSON.parse(text);
        if (ev.data.noaaPackage && ev.data.descriptor) {
            const manifest = ev.data.noaaPackage;
            const part = parseNoaaPart(blob, manifest, ev.data.descriptor);
            blob = { ...manifest.metadata, layers: {}, selectedBytes: 0 };
            if (ev.data.select)
                for (const r of part.records) {
                    const features = r.features.filter(
                        (f) =>
                            (ev.data.completeLateralMarks && noaaLeadDependency(r.layer)) ||
                            !ev.data.bounds ||
                            noaaPartIntersects(noaaFeatureBounds(f), ev.data.bounds),
                    );
                    blob.selectedBytes += new TextEncoder().encode(JSON.stringify(features)).length;
                    blob.layers[r.layer] = { ...manifest.layers.find((l) => l.name === r.layer)!.collection, features };
                }
        }
        ctx.postMessage({ seq, cellId, blob });
    } catch {
        ctx.postMessage({ seq, cellId, blob: null });
    }
};
