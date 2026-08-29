#!/usr/bin/env python3
"""
Add the Pi's own u-blox GPS to Signal K as a SECOND position source, with
failover priority behind the boat's own instrument GPS.

Why: the track recorder, the anchor watch and the app all read position from
Signal K, which reads the YDWG-02 gateway. That makes the gateway a single
point of failure for knowing where the boat is. There is already a u-blox 7 on
the Pi holding a differential fix at 1 Hz with HDOP 0.85 — using it removes
that single point of failure and costs nothing.

Priority, not replacement: the gateway stays primary because it is the boat's
own instrument GPS, the one feeding the plotter and the pilot, and the readouts
should agree with what the instruments say. The u-blox is accepted only once
the gateway has been quiet for longer than the timeout.

Idempotent: running it twice changes nothing the second time.
"""
import json, shutil, sys, datetime

PATH = '/home/shanes/.signalk/settings.json'
PROVIDER_ID = 'ublox-gps'
DEVICE = '/dev/ttyACM0'

# The gateway publishes as "<providerId>.<talker>"; both are GP-talker GNSS.
GATEWAY_SOURCE = 'ydwg-tcp.YD'
UBLOX_SOURCE = f'{PROVIDER_ID}.GP'

# Long enough that ordinary 1 Hz jitter never triggers a handover, short enough
# that a dead gateway is covered within seconds rather than minutes.
FAILOVER_MS = 15000

GNSS_KEYS = [
    'navigation.position',
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue',
    'navigation.datetime',
]

def main(path=PATH, write=True):
    with open(path) as fh:
        cfg = json.load(fh)

    providers = cfg.setdefault('pipedProviders', [])
    if any(p.get('id') == PROVIDER_ID for p in providers):
        print('provider already present — nothing to do')
    else:
        providers.append({
            'id': PROVIDER_ID,
            'enabled': True,
            'pipeElements': [{
                'type': 'providers/simple',
                'options': {
                    'logging': False,
                    'type': 'NMEA0183',
                    'subOptions': {'type': 'serial', 'device': DEVICE, 'baudrate': 9600},
                },
            }],
        })
        print(f'added provider {PROVIDER_ID} on {DEVICE}')

    prio = cfg.setdefault('sourcePriorities', {})
    for key in GNSS_KEYS:
        prio[key] = [
            {'sourceRef': GATEWAY_SOURCE, 'timeout': FAILOVER_MS},
            {'sourceRef': UBLOX_SOURCE, 'timeout': FAILOVER_MS},
        ]
    print(f'set source priorities on {len(GNSS_KEYS)} keys: gateway first, u-blox after {FAILOVER_MS} ms of silence')

    if write:
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        shutil.copy2(path, f'{path}.bak-{stamp}')
        print(f'backed up to {path}.bak-{stamp}')
        with open(path, 'w') as fh:
            json.dump(cfg, fh, indent=2)
        print('written')
    return cfg

if __name__ == '__main__':
    # Flags are not paths. The first version took argv[1] as the settings file
    # outright, so `--dry-run` on its own — the obvious way to run this — was
    # opened as a filename and died. Tested with the flag alone, with a path,
    # and with both.
    positional = [a for a in sys.argv[1:] if not a.startswith('-')]
    main(positional[0] if positional else PATH, write='--dry-run' not in sys.argv)
