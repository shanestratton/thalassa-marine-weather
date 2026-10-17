"""Real POSIX filesystem guards, run once as root in the disposable CI job."""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

from runtime_manifest import inventory


class ActualPosixReadonlyInventory(unittest.TestCase):
    def setUp(self):
        self.assertEqual(sys.platform, 'linux', 'actual POSIX Linux fixture required; no skip')
        self.assertEqual(os.getuid(), 0, 'disposable root ownership fixture required; no skip')
        self.temporary = tempfile.TemporaryDirectory(prefix='arome142-scalar-link-fixture-')
        self.root = Path(self.temporary.name) / 'stage'
        (self.root / 'runtime/lib').mkdir(parents=True)
        (self.root / 'runtime/lib/fixture.txt').write_text('fictional readonly runtime fixture\n')
        (self.root / 'runtime/lib64').symlink_to('lib', target_is_directory=True)
        self.freeze()

    def freeze(self):
        for path in [self.root, *self.root.rglob('*')]:
            if not path.is_symlink():
                path.chmod(0o555 if path.is_dir() else 0o444)

    def tearDown(self):
        self.temporary.cleanup()

    def replace_link(self, name):
        link = self.root / 'runtime/lib64'
        link.unlink()
        link.symlink_to(name, target_is_directory=True)

    def refuses(self):
        with self.assertRaises((AssertionError, RuntimeError, OSError)):
            inventory(self.root)

    def test_exact_real_rootowned_readonly_venv_link_with0777_lstat_passes(self):
        link = self.root / 'runtime/lib64'
        self.assertTrue(stat.S_ISLNK(link.lstat().st_mode))
        self.assertEqual(link.lstat().st_mode & 0o777, 0o777)
        proof = json.loads(inventory(self.root))
        row = next(row for row in proof['files'] if row['path'] == 'runtime/lib64')
        self.assertEqual(row, {'path': 'runtime/lib64', 'link': 'lib', 'resolvedTarget': 'runtime/lib', 'uid': 0})

    def test_equivalent_but_unreviewed_link_spelling_refuses(self):
        self.replace_link('./lib')
        self.refuses()

    def test_absolute_target_even_inside_stage_refuses(self):
        self.replace_link(str(self.root / 'runtime/lib'))
        self.refuses()

    def test_parent_escape_target_refuses(self):
        self.replace_link('../../outside')
        self.refuses()

    def test_other_symlink_name_refuses(self):
        (self.root / 'runtime/other').symlink_to('lib')
        self.refuses()

    def test_nonroot_link_owner_refuses(self):
        os.lchown(self.root / 'runtime/lib64', 65534, 65534)
        self.refuses()

    def test_nonroot_target_owner_refuses(self):
        os.chown(self.root / 'runtime/lib', 65534, 65534)
        self.refuses()

    def test_writable_target_directory_refuses(self):
        (self.root / 'runtime/lib').chmod(0o755)
        self.refuses()

    def test_writable_regular_file_refuses(self):
        (self.root / 'runtime/lib/fixture.txt').chmod(0o644)
        self.refuses()

    def test_cycle_target_refuses(self):
        (self.root / 'runtime/lib/fixture.txt').unlink()
        (self.root / 'runtime/lib').rmdir()
        (self.root / 'runtime/lib').symlink_to('lib64', target_is_directory=True)
        self.refuses()


if __name__ == '__main__':
    unittest.main(verbosity=2)
