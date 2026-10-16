/** Real confirmation UI; browser suite supplies a generated read-only test service at its module boundary. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import FollowedCourseDialog from '../../components/map/FollowedCourseDialog';
if (!import.meta.env.DEV) throw Error('Development fixture only');
function Fixture() {
    const [open, setOpen] = useState(false);
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <button
                type="button"
                className="min-h-11 rounded-xl border p-3"
                onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setOpen(true);
                }}
            >
                Send followed route
            </button>
            {open && <FollowedCourseDialog onClose={() => setOpen(false)} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
