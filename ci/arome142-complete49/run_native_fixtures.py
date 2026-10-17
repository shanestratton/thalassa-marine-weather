"""Actual compiled fixture preflight, never original-provider qualification."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import unittest

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
from original_pilot_native import kernel_before_native
cgroup, kernel = kernel_before_native()
with args.output.open('x') as stream:
    stream.write(json.dumps({'fixtureOnly': True, 'providerRequests': 0, 'nativeImported': False, **kernel}, indent=2) + '\n')
sys.path.insert(0, str(args.source / 'tools/arome142'))
suite = unittest.defaultTestLoader.discover(str(args.source / 'tools/arome142/native-tests'), pattern='test_native.py')
result = unittest.TextTestRunner(verbosity=2).run(suite)
assert result.testsRun == 4 and not result.skipped and result.wasSuccessful(), 'all four actual compiled cases required'
print(json.dumps({'actualCompiledCases': 4, 'fixtureOnly': True, 'providerRequests': 0,
                  'ownMemoryPeakBytes': int((cgroup / 'memory.peak').read_text())}))
