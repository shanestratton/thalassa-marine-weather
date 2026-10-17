import React from 'react';
import { createRoot } from 'react-dom/client';
import { NmeaPage } from '../../components/vessel/NmeaPage';
import '../../index.css';

// The real connection UI and listener, using TEST-NET input. UDP is unavailable
// in a browser; pressing Connect exercises that refusal and never opens a socket.
localStorage.removeItem('thalassa_pi_pairing_v1');
localStorage.setItem('nmea_host', '192.0.2.151');
localStorage.setItem('nmea_port', '10110');
localStorage.setItem('nmea_device', 'direct');
localStorage.removeItem('nmea_transport');
localStorage.setItem('nmea_legacy_defaults_cleared', '1');
createRoot(document.getElementById('root')!).render(
    <main className="relative h-dvh w-full bg-slate-950 text-white">
        <NmeaPage onBack={() => undefined} onNavigateToGlass={() => undefined} />
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-900 h-16 bg-slate-900" />
    </main>,
);
