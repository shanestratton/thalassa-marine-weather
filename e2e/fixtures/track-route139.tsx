import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { LogPageHeader } from '../../pages/log/LogPageHeader';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { requestTrackRouteLibraryOpen, consumeTrackRouteLibraryOpen } from '../../services/deepLink';
import { getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { awaitSettingsLoaded } from '../../stores/settingsStore';
if (!import.meta.env.DEV) throw Error('Development fixture only');
await awaitSettingsLoaded();
setAuthIdentityScope('synthetic-track-owner');
function Fixture() {
    const [open, setOpen] = React.useState(false),
        [requested, setRequested] = React.useState(false);
    const trigger = React.useRef<HTMLButtonElement>(null),
        close = React.useRef<HTMLButtonElement>(null);
    const dismiss = React.useCallback(() => setOpen(false), []);
    const menu = useFocusTrap<HTMLDivElement>(open, { initialFocusRef: close, onEscape: dismiss });
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 text-white">
            <LogPageHeader
                isTracking={false}
                gpsStatus="none"
                hasRecordedFix={false}
                gpsHeadline=""
                overflowTriggerRef={trigger}
                overflowMenuRef={menu}
                overflowCloseRef={close}
                overflowMenuId="track-route-actions"
                showMenu={open}
                setShowMenu={setOpen}
                closeOverflowMenu={dismiss}
                dispatch={() => {}}
                loggedVoyages={[]}
                loggedEntries={[]}
                hasLifetimeVoyages
                onMakeTrackRoute={() => {
                    requestTrackRouteLibraryOpen(getAuthIdentityScope());
                    setRequested(consumeTrackRouteLibraryOpen());
                }}
            />
            <p role="status" className="p-4 text-sm">
                {requested
                    ? 'Past voyage picker requested. Navigation remains stopped.'
                    : 'Synthetic Log actions; no boat, account or provider requests.'}
            </p>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
