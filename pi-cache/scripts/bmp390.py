#!/usr/bin/env python3
"""
BMP390 barometer on the boat Pi (calypso) — one-shot read.

Wired 2026-09-02 to I2C bus 1 at 0x77:
    purple VCC -> pin 1 (3V3)      blue   SDA -> pin 3
    orange GND -> pin 6            yellow SCL -> pin 5
    green  INT -> not connected (polled, no interrupt)

Verified on install: CHIP_ID 0x60 (BMP390), ERR_REG clean, and 1022.13 hPa
against ECMWF's 1022.6 hPa for the same minute — 0.5 hPa apart, which is the
sensor's rated absolute accuracy. Temperature reads ~1 degC below ambient
because it sits in an enclosure and self-heats; treat it as an enclosure
temperature, not an air temperature.

    python3 bmp390.py           human readable
    python3 bmp390.py --json    {"pressure_hpa": ..., "temp_c": ..., "ts": ...}

Forced mode on purpose: it takes one measurement then returns to sleep, so
nothing is spinning between reads. Pressure is oversampled x8 (the datasheet's
"standard" preset for weather); temperature x1, since it only trims the
pressure maths.
"""
import argparse
import json
import struct
import time
from datetime import datetime, timezone

from smbus2 import SMBus

ADDR = 0x77
BUS = 1


def read(bus: SMBus) -> tuple[float, float]:
    """Return (pressure_hPa, temperature_degC), Bosch-compensated."""
    # Factory trimming from NVM 0x31..0x45 (datasheet 3.11.1). Read every
    # call: it is 21 bytes, and a cached copy would survive a sensor swap.
    raw = bus.read_i2c_block_data(ADDR, 0x31, 21)
    t1, t2, t3, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11 = struct.unpack('<HHbhhbbHHbbhbb', bytes(raw))
    T1 = t1 / 2**-8.0
    T2 = t2 / 2**30.0
    T3 = t3 / 2**48.0
    P1 = (p1 - 2**14) / 2**20.0
    P2 = (p2 - 2**14) / 2**29.0
    P3 = p3 / 2**32.0
    P4 = p4 / 2**37.0
    P5 = p5 / 2**-3.0
    P6 = p6 / 2**6.0
    P7 = p7 / 2**8.0
    P8 = p8 / 2**15.0
    P9 = p9 / 2**48.0
    P10 = p10 / 2**48.0
    P11 = p11 / 2**65.0

    bus.write_byte_data(ADDR, 0x1C, 0b011)       # OSR: pressure x8
    bus.write_byte_data(ADDR, 0x1B, 0b00010011)  # press+temp enabled, forced mode
    time.sleep(0.2)                              # x8 conversion is ~50 ms; 200 ms is ample

    d = bus.read_i2c_block_data(ADDR, 0x04, 6)
    praw = d[0] | d[1] << 8 | d[2] << 16
    traw = d[3] | d[4] << 8 | d[5] << 16

    a = traw - T1
    b_ = a * T2
    temp = b_ + (a * a) * T3

    o1 = P5 + P6 * temp + P7 * temp**2 + P8 * temp**3
    o2 = praw * (P1 + P2 * temp + P3 * temp**2 + P4 * temp**3)
    o3 = praw**2 * (P9 + P10 * temp) + praw**3 * P11
    return (o1 + o2 + o3) / 100.0, temp


def main() -> None:
    ap = argparse.ArgumentParser(description='Read the BMP390 barometer.')
    ap.add_argument('--json', action='store_true', help='machine-readable output')
    args = ap.parse_args()
    with SMBus(BUS) as bus:
        chip = bus.read_byte_data(ADDR, 0x00)
        if chip != 0x60:
            raise SystemExit(f'Not a BMP390 at 0x{ADDR:02x}: CHIP_ID 0x{chip:02x}')
        hpa, degc = read(bus)
    if args.json:
        print(json.dumps({
            'pressure_hpa': round(hpa, 2),
            'temp_c': round(degc, 2),
            'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        }))
    else:
        print(f'{hpa:.2f} hPa   {degc:.2f} degC')


if __name__ == '__main__':
    main()
