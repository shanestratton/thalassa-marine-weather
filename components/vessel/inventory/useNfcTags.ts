import { useEffect, useState } from 'react';
import { nfcAvailable } from '../../../services/native/nfcTags';

/**
 * Whether this phone can read and write the box tags (126-11b): an iPhone with
 * NFC. Write tag and Scan box stay hidden until it says yes, so the web, an
 * iPad and the simulator never show them (on the web nothing asks the plugin).
 */
export function useNfcTags(): boolean {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        let live = true;
        void nfcAvailable().then((yes) => {
            if (live) setReady(yes);
        });
        return () => {
            live = false;
        };
    }, []);
    return ready;
}
