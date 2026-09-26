import React from 'react';
import { LockIcon } from '../Icons';
import { Button } from './Button';
import { UnavailableNotice } from './UnavailableNotice';

/**
 * Honest replacement for every Pi setup/control surface, on builds that cannot
 * verify the Pi. No Pi discovery, setup, chart or control call is made from
 * this screen.
 *
 * Since 2026-08-06 this is no longer a beta-wide hold — the Pi is available to
 * any build carrying the native certificate-pinning transport. What this screen
 * now says is narrower and more useful: THIS build cannot check that the box
 * answering `calypso.local` is your Pi, so it will not talk to it. The web
 * build is the ordinary case (browsers do not expose the peer certificate to
 * script, so nothing there can verify the pin).
 *
 * Skipper words, not build words: "unavailable in this build" and "Pi
 * integration" read as developer-speak (UX scorecard run 6), so the heading
 * says what to use instead.
 */
export const PiPublicBetaUnavailable: React.FC<{ onOpenEncLibrary?: () => void }> = ({ onOpenEncLibrary }) => (
    <UnavailableNotice
        tone="amber"
        icon={<LockIcon className="h-5 w-5" />}
        title="Boat network needs the Thalassa iPhone app"
        note={<>Open Thalassa on your iPhone, on the boat&rsquo;s Wi-Fi, to pair with the Pi.</>}
        actions={
            onOpenEncLibrary && (
                <Button variant="secondary" onClick={onOpenEncLibrary} className="text-white">
                    Open chart library
                </Button>
            )
        }
    >
        <p>
            Only the iPhone app can check that it is talking to your own boat&rsquo;s Pi. Weather, charts and the diary
            still work here.
        </p>
    </UnavailableNotice>
);
