import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
/** Explicit export only. Private data cannot cross a late account change before the platform handoff. */
export async function handoffAnnotationFile(
    text: string,
    format: 'GeoJSON' | 'GPX',
    scope = getAuthIdentityScope(),
    options: { isCurrent?: () => boolean } = {},
) {
    const check = () => {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || options.isCurrent?.() === false)
            throw Error('Export cancelled because the account changed.');
    };
    check();
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw Error('Export exceeds 1 MiB.');
    const mime = format === 'GeoJSON' ? 'application/geo+json' : 'application/gpx+xml',
        name = `chart-annotations-${crypto.randomUUID()}.${format === 'GeoJSON' ? 'geojson' : 'gpx'}`;
    if (Capacitor.isNativePlatform()) {
        let written = false;
        try {
            const saved = await Filesystem.writeFile({
                path: name,
                directory: Directory.Cache,
                encoding: Encoding.UTF8,
                data: text,
            });
            written = true;
            check();
            await Share.share({
                title: 'Private chart annotations',
                dialogTitle: 'Export chart annotations',
                url: saved.uri,
            });
        } finally {
            if (written)
                setTimeout(() => {
                    void Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {});
                }, 30000);
        }
        return;
    }
    const file = new File([text], name, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
        check();
        try {
            await navigator.share({ title: 'Private chart annotations', files: [file] });
            return;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return;
            check();
        }
    }
    check();
    const url = URL.createObjectURL(file),
        link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
