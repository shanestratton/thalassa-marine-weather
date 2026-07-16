/**
 * sharePdf — hand a generated PDF Blob to the platform's share/save UI.
 *
 * Native (Capacitor): write the PDF to the Cache dir and open the iOS share
 * sheet (Files / Mail / AirDrop / WhatsApp), then clean the temp file up.
 * Web: use the Web Share API with a file when available, else fall back to a
 * plain download. Mirrors the proven SharePassageButton flow.
 */

import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { createLogger } from './createLogger';

const log = createLogger('sharePdf');

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Share (native) or download (web) a PDF blob. Returns 'shared' | 'downloaded'
 * | 'cancelled'. Throws only on an unexpected failure so the caller can toast.
 */
export async function sharePdfBlob(blob: Blob, fileName: string, title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
    if (Capacitor.isNativePlatform()) {
        const base64 = await blobToBase64(blob);
        const saved = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
        try {
            await Share.share({ title, url: saved.uri, dialogTitle: title });
        } catch (err) {
            // The user dismissing the share sheet rejects — that's not an error.
            log.info(`share dismissed/failed: ${err instanceof Error ? err.message : String(err)}`);
            return 'cancelled';
        } finally {
            setTimeout(() => {
                void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {});
            }, 30_000);
        }
        return 'shared';
    }

    // Web: prefer a native share with the file, else download.
    const file = new File([blob], fileName, { type: 'application/pdf' });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
        try {
            await nav.share({ files: [file], title });
            return 'shared';
        } catch {
            /* user cancelled or unsupported → fall through to download */
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    return 'downloaded';
}
