"""Actual offline Bash EXIT-status tests; no systemctl, native or network call."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

RUN = Path(__file__).with_name('run.sh').read_text()
assert RUN.count('# BEGIN cleanup-status') == RUN.count('# END cleanup-status') == 1
WRAPPER = RUN.split('# BEGIN cleanup-status\n', 1)[1].split('# END cleanup-status', 1)[0]
assert 'trap - EXIT' in WRAPPER and 'trap cleanup_exit EXIT' in WRAPPER
BASH = (r'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))
assert BASH
ENV = {k:v for k,v in os.environ.items() if k.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP')}
ENV['LC_ALL'] = 'C'


class CleanupStatusTests(unittest.TestCase):
    def run_case(self, original, cleanup_status, expected):
        # Exact production wrapper, with only the cleanup function substituted.
        # stdin/fixed heredoc carries the fixture: no real service command exists.
        script = ('set -euo pipefail\n'
                  'cleanup() { printf "cleanup-called\\n"; return '+str(cleanup_status)+'; }\n'
                  + WRAPPER + '\nexit '+str(original)+'\n')
        self.assertNotIn('systemctl', script)
        reply = subprocess.run([BASH, '--noprofile', '--norc', '-s'], input=script, text=True,
                               capture_output=True, timeout=5, env=ENV)
        self.assertEqual(reply.returncode, expected, reply.stderr)
        self.assertEqual(reply.stdout, 'cleanup-called\n', 'cleanup must run exactly once without recursive EXIT')
        self.assertEqual(reply.stderr, '')

    def test_success_and_successful_cleanup(self): self.run_case(0, 0, 0)
    def test_success_and_failed_cleanup_is_failure(self): self.run_case(0, 1, 1)
    def test_old_failure_survives_successful_cleanup(self): self.run_case(7, 0, 7)
    def test_old_failure_survives_failed_cleanup(self): self.run_case(7, 1, 7)
    def test_failed_real_command_status_and_once_without_recursion(self):
        script = ('set -euo pipefail\ncleanup() { printf "cleanup-called\\n"; return 1; }\n'
                  + WRAPPER + '\n(exit 23)\nprintf "unreachable\\n"\n')
        reply = subprocess.run([BASH, '--noprofile', '--norc', '-s'], input=script, text=True,
                               capture_output=True, timeout=5, env=ENV)
        self.assertEqual((reply.returncode, reply.stdout, reply.stderr), (23, 'cleanup-called\n', ''))


if __name__ == '__main__': unittest.main()
