import React from 'react';
import { createRoot } from 'react-dom/client';
import { FullAppResearchRoot } from './FullAppResearchRoot';
import type { PrivateMessageResearchRuntime } from '../app-pilot/runtime';
import { setFullAppWindowRemount } from './windowEvidence';
import '../../../index.css';
import '../app-pilot/style.css';
export function mountFullAppResearch(createRuntime: () => PrivateMessageResearchRuntime) {
    const element = document.getElementById('root');
    if (!element) throw new Error('Full App Research interface unavailable');
    const root = createRoot(element);
    let generation = 0;
    const render = () => root.render(<FullAppResearchRoot key={generation} createRuntime={createRuntime} />);
    // This private closure is reachable only through the explicit, run/nonce
    // bound one-shot fixture control. The factory/native host remain the same;
    // keying the whole root creates fresh effect-owned resources underneath it.
    setFullAppWindowRemount(() => {
        generation += 1;
        render();
        return true;
    });
    render();
}
