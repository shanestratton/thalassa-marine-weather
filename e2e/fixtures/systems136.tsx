/** Real Systems UI and wire parser; entirely generated private sensor fixtures, no network. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { SystemsEntry } from '../../components/vessel/SystemsEntry';
import { NmeaStore } from '../../services/NmeaStore';
import { snapshotFromWire } from '../../services/telemetryWire';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
if (!import.meta.env.DEV) throw Error('Development fixture only');
setAuthIdentityScope('generated-systems-owner');
const T = Date.now();
const pack = (kind: string, id: string, ...values: unknown[]) => JSON.stringify([1, kind, id, 'venus.1', T, ...values]);
const extra = new URLSearchParams(location.search).has('empty')
    ? {}
    : {
          sys_0_v1: pack('b', 'bank1', 13.4, 0, -5, 1000, 78, 2000),
          sys_1_v1: pack('f', 'tank1', 52, 10000),
          sys_2_v1: pack('s', 'solar1', 125, 0, 18.4, 0, 2.1, 0),
          sys_3_v1: pack('a', 'bus1/single', 350, 0, 230, 0, 1.5, 0),
          sys_4_v1: pack('c', 'charger1', 14.2, 0, 8, 0, 32, 0),
          sys_5_v1: pack('p', 'autopilot', 0, 0),
          sys_6_v1: pack('b', 'bank2', 12.8, 0, 0, 0, null, null),
          instrument_times_v1: JSON.stringify([null, null, null, null, null, T, null, null]),
          engine_metrics_v1: JSON.stringify([1, 'main', T, 36000, 0, 80, 0, 300, 0]),
      };
NmeaStore.ingestRemote(
    snapshotFromWire({ source: 'pi', reported_at: new Date(T).toISOString(), rpm: 1000, extra }, 'lan')!.snapshot,
);
createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-slate-950 text-white">
        <SystemsEntry />
    </main>,
);
