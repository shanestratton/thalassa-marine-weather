import React from 'react';
import { Capacitor } from '@capacitor/core';
import App from './App';
import { ThalassaProvider } from './context/ThalassaContext';
import { CrewCountProvider } from './contexts/CrewCountContext';

// Box tags (126-11b): a Ship's Stores box link from iOS (a tag held to the
// iPhone) opens that box. Native only, and loaded from here rather than from
// index.tsx so it shares the shell's page store instead of splitting it out.
if (Capacitor.isNativePlatform()) {
    void import('./services/boxLinks').then((links) => links.installBoxLinks()).catch(() => undefined);
}

/**
 * Heavy application providers live behind the legal gate so a first-time
 * visitor can read the navigation disclaimer without downloading weather,
 * account, drag-and-drop, and time-zone code that cannot yet be used.
 */
const ApplicationShell: React.FC = () => (
    <ThalassaProvider>
        <CrewCountProvider>
            <App />
        </CrewCountProvider>
    </ThalassaProvider>
);

export default ApplicationShell;
