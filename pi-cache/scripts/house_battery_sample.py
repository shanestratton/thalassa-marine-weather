"""Timestamp the selected HOUSE SmartShunt, never a cached CSV row or another bank.

The yacht's existing MQTT logger calls record on its mapped shunt_soc message,
clear on broker connect/disconnect, and save during its usual logging cycle.
No extra MQTT connection, BLE connection or battery commands are created here.
"""
import json
import math
import os
import threading
import time


class HouseBatterySample:
    def __init__(self):
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._sample = None

    def clear(self):
        with self._lock:
            self._sample = None

    def record(self, value, retained=False):
        # A retained message has no sensor timestamp; receipt cannot freshen it.
        valid = (not retained and type(value) in (int, float)
                 and math.isfinite(value) and 0 <= value <= 100)
        sample = (value, int(time.time() * 1000), time.monotonic()) if valid else None
        with self._lock:
            self._sample = sample

    def snapshot(self):
        now, mono = time.time(), time.monotonic()
        with self._lock:
            sample = self._sample
        fresh = sample is not None and 0 <= mono - sample[2] <= 90
        return {"source": "victron-smartshunt-house",
                "soc_pct": sample[0] if fresh else None,
                "at": sample[1] if fresh else None,
                "generated_at_ms": int(now * 1000)}

    def save(self, filename):
        with self._write_lock:
            tmp = filename + ".tmp"
            with open(tmp, "w", encoding="utf-8") as output:
                json.dump(self.snapshot(), output, allow_nan=False)
            os.replace(tmp, filename)
