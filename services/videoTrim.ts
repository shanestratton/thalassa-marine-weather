/**
 * videoTrim — cut a chosen window out of a phone video WITHOUT re-encoding.
 *
 * A WebView cannot transcode 4K without cooking the phone, so this never
 * touches pixels: mp4box demuxes the file, the samples inside the window are
 * kept, mp4-muxer writes them into a fresh mp4. Seconds of work, zero quality
 * loss, and the output is always video/mp4 regardless of whether the source
 * was an iPhone .mov — which the diary-video bucket accepts either way.
 *
 * The one honest compromise of a lossless cut: the start must land on a video
 * keyframe, so the window's start snaps BACK to the nearest sync sample
 * (iPhone HEVC keyframes arrive roughly every second). The returned
 * `actualStartSec` says where the cut really began; the caller shows it
 * rather than pretending the requested point was hit.
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import type { ISOFile, Movie, Sample, Track } from 'mp4box';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { createLogger } from '../utils/createLogger';

const log = createLogger('videoTrim');

export interface TrimResult {
    blob: Blob;
    /** Where the cut actually starts, after the keyframe snap. */
    actualStartSec: number;
    durationSec: number;
}

/** Serialise a sample-description child box (avcC/hvcC) without its header. */
function descriptionFromTrack(file: ISOFile, trackId: number): { codec: 'avc' | 'hevc'; data: Uint8Array } {
    // mp4box's typings do not describe the raw box tree, so this walk is
    // necessarily untyped — it follows the layout every isobmff file shares.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const trak = (file as any).getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC ?? entry.hvcC;
        if (!box) continue;
        const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        box.write(stream);
        // Skip the 8-byte box header (size + fourcc): decoders want the payload.
        return { codec: entry.avcC ? 'avc' : 'hevc', data: new Uint8Array(stream.buffer, 8) };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    throw new Error('No AVC/HEVC configuration in the video track — cannot cut this file');
}

/** Track rotation from the isobmff matrix, mapped to what mp4-muxer accepts. */
function rotationFromMatrix(track: Track): 0 | 90 | 180 | 270 {
    const m = track.matrix;
    if (!m) return 0;
    // Fixed-point 16.16: read the two terms that define the rotation quadrant.
    const a = m[0] / 65536;
    const b = m[1] / 65536;
    if (a === 0 && b === 1) return 90;
    if (a === -1 && b === 0) return 180;
    if (a === 0 && b === -1) return 270;
    return 0;
}

/**
 * Parse the file and pull every sample from the wanted tracks in ONE pass.
 *
 * The extraction options MUST be set inside onReady, before the appended
 * buffer is processed: mp4box hands samples out while it consumes the buffer,
 * and options set afterwards watch a stream that has already gone by — the
 * classic silent-hang. (Found the hard way: the first cut of this code awaited
 * a promise that could never resolve.)
 */
function parseAndExtract(buffer: ArrayBuffer): Promise<{ file: ISOFile; info: Movie; samples: Map<number, Sample[]> }> {
    return new Promise((resolve, reject) => {
        const file = createFile();
        const samples = new Map<number, Sample[]>();
        const wanted = new Map<number, number>();
        let info: Movie | null = null;

        file.onError = (e: string) => reject(new Error(`Could not read the video: ${e}`));
        file.onReady = (movie: Movie) => {
            info = movie;
            const tracks = [movie.videoTracks[0], movie.audioTracks[0]].filter(Boolean) as Track[];
            if (tracks.length === 0) {
                reject(new Error('No video track in that file'));
                return;
            }
            for (const track of tracks) {
                wanted.set(track.id, track.nb_samples);
                samples.set(track.id, []);
                file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
            }
            file.start();
        };
        file.onSamples = (id: number, _user: unknown, batch: Sample[]) => {
            const bucket = samples.get(id);
            if (!bucket) return;
            bucket.push(...batch);
            const done = [...wanted.entries()].every(
                ([trackId, count]) => (samples.get(trackId)?.length ?? 0) >= count,
            );
            if (done && info) resolve({ file, info, samples });
        };
        file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
        file.flush();
    });
}

/**
 * Cut `[startSec, startSec + windowSec]` out of the file, losslessly.
 *
 * Everything is held in memory once — the phone already held the file to pick
 * it, so the transient cost is one extra copy of the samples, and the result
 * replaces a clip several times the size.
 */
export async function trimVideoLossless(source: Blob, startSec: number, windowSec = 60): Promise<TrimResult> {
    const { file, info, samples } = await parseAndExtract(await source.arrayBuffer());

    const videoTrack = info.videoTracks[0];
    if (!videoTrack) throw new Error('No video track in that file');
    const audioTrack = info.audioTracks[0] ?? null;

    const { codec, data: description } = descriptionFromTrack(file, videoTrack.id);

    const videoSamples = samples.get(videoTrack.id) ?? [];
    const audioSamples: Sample[] = audioTrack ? (samples.get(audioTrack.id) ?? []) : [];

    // Snap the start BACK to a keyframe. Cutting mid-GOP without re-encoding
    // yields grey soup until the next keyframe, which is worse than starting
    // slightly early.
    const vScale = videoTrack.timescale;
    const requestedStart = Math.max(0, startSec) * vScale;
    // Work in DECODE order throughout. B-frames make presentation order
    // non-monotonic, and the muxer (rightly) refuses a DTS that goes backwards;
    // the cts−dts gap rides along as each chunk's composition offset instead.
    const decodeOrdered = [...videoSamples].sort((a, b) => a.dts - b.dts);
    let snapStart = 0;
    for (const s of decodeOrdered) {
        if (!s.is_sync) continue;
        if (s.cts <= requestedStart) snapStart = s.cts;
        else break;
    }
    const actualStartSec = snapStart / vScale;
    const endTs = snapStart + windowSec * vScale;

    // Extraction always populates `data`; the typings mark it optional for the
    // metadata-only path this code never uses.
    const hasData = (s: Sample): s is Sample & { data: Uint8Array } => s.data instanceof Uint8Array;
    const keptVideo = decodeOrdered.filter(hasData).filter((s) => s.cts >= snapStart && s.cts < endTs);
    if (keptVideo.length === 0) throw new Error('The chosen window holds no video');

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
            codec,
            width: videoTrack.track_width,
            height: videoTrack.track_height,
            rotation: rotationFromMatrix(videoTrack),
        },
        ...(audioTrack
            ? {
                  audio: {
                      codec: 'aac' as const,
                      sampleRate: audioTrack.audio?.sample_rate ?? 44100,
                      numberOfChannels: audioTrack.audio?.channel_count ?? 2,
                  },
              }
            : {}),
        fastStart: 'in-memory',
    });

    const toMicros = (ts: number, scale: number) => Math.round(((ts - 0) * 1e6) / scale);
    // The muxer takes PRESENTATION timestamps and derives decode time as
    // timestamp − compositionTimeOffset, so anchor everything on the first
    // sample's dts: decode times then start at exactly zero and stay monotonic.
    const dtsBase = keptVideo[0].dts;
    let first = true;
    for (const s of keptVideo) {
        muxer.addVideoChunkRaw(
            s.data,
            s.is_sync ? 'key' : 'delta',
            toMicros(s.cts - dtsBase, vScale),
            toMicros(s.duration, vScale),
            first ? { decoderConfig: { codec: videoTrack.codec, description } } : undefined,
            toMicros(s.cts - s.dts, vScale),
        );
        first = false;
    }

    if (audioTrack) {
        const aScale = audioTrack.timescale;
        const aStart = (snapStart / vScale) * aScale;
        const aEnd = aStart + windowSec * aScale;
        const keptAudio = audioSamples.filter(hasData).filter((s) => s.cts >= aStart && s.cts < aEnd);
        // Anchor audio on its own first kept sample: the muxer demands the
        // track start at exactly zero, and audio frames land up to ~21ms after
        // the video keyframe. The sub-frame A/V offset that costs is inaudible.
        const aBase = keptAudio[0]?.cts ?? 0;
        for (const s of keptAudio) {
            muxer.addAudioChunkRaw(s.data, 'key', toMicros(s.cts - aBase, aScale), toMicros(s.duration, aScale));
        }
    }

    muxer.finalize();
    const buffer = (muxer.target as ArrayBufferTarget).buffer;
    log.info(
        `[Trim] ${(source.size / 1048576).toFixed(1)}MB → ${(buffer.byteLength / 1048576).toFixed(1)}MB, ` +
            `start ${actualStartSec.toFixed(1)}s (asked ${startSec.toFixed(1)}s)`,
    );
    return { blob: new Blob([buffer], { type: 'video/mp4' }), actualStartSec, durationSec: windowSec };
}

/**
 * Duration by reading the container header directly.
 *
 * The <video> element probe stalls on iOS for long camera files — their moov
 * index sits at the END of the file, and WKWebView's media loader gives up
 * silently on big blobs, which left the trimmer looking like it "did not
 * load". mp4box reads the buffer directly and finds the index wherever it is.
 */
export async function probeVideoDurationSeconds(source: Blob): Promise<number | null> {
    try {
        const buffer = await source.arrayBuffer();
        return await new Promise<number | null>((resolve) => {
            const file = createFile();
            const timer = setTimeout(() => resolve(null), 10_000);
            file.onError = () => {
                clearTimeout(timer);
                resolve(null);
            };
            file.onReady = (info: Movie) => {
                clearTimeout(timer);
                resolve(info.timescale > 0 ? info.duration / info.timescale : null);
            };
            file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
            file.flush();
        });
    } catch {
        return null;
    }
}
