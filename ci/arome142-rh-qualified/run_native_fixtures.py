"""Actual compiled generated fixtures, with kernel admission before imports."""
import argparse
import json
from pathlib import Path
import sys
import unittest

p = argparse.ArgumentParser()
p.add_argument('--source', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--kind', choices=('base', 'rh'), required=True)
a = p.parse_args()
from original_pilot_native import kernel_before_native
cgroup, kernel = kernel_before_native()
assert not {'eccodes', 'numpy', 'catalogue', 'native'}.intersection(sys.modules)
with a.output.open('x') as stream:
    stream.write(json.dumps({'fixtureOnly': True, 'nativeImported': False, 'providerRequests': 0, **kernel})+'\n')
sys.path.insert(0, str(a.source/'tools/arome142'))
pattern = 'test_native.py' if a.kind == 'base' else 'test_rh_display_native.py'
expected = 4 if a.kind == 'base' else 9
suite = unittest.defaultTestLoader.discover(str(a.source/'tools/arome142/native-tests'), pattern=pattern)
result = unittest.TextTestRunner(verbosity=2).run(suite)
assert result.testsRun == expected and not result.skipped and result.wasSuccessful(), 'all actual compiled cases required'
print(json.dumps({'actualCompiledCases': expected, 'kind': a.kind, 'fixtureOnly': True,
    'providerRequests': 0, 'ownMemoryPeakBytes': int((cgroup/'memory.peak').read_text())}))
