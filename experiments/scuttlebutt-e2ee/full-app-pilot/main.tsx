import React from 'react';
import { createRoot } from 'react-dom/client';
import { FullAppResearchRoot } from './FullAppResearchRoot';
import type { PrivateMessageResearchRuntime } from '../app-pilot/runtime';
import '../../../index.css';
import '../app-pilot/style.css';
export function mountFullAppResearch(createRuntime: () => PrivateMessageResearchRuntime) {
    const element = document.getElementById('root');
    if (!element) throw new Error('Full App Research interface unavailable');
    createRoot(element).render(<FullAppResearchRoot createRuntime={createRuntime} />);
}
