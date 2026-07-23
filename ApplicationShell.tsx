import React from 'react';
import App from './App';
import { ThalassaProvider } from './context/ThalassaContext';
import { CrewCountProvider } from './contexts/CrewCountContext';

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
