import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('restore', Path(__file__).parents[1] / 'scripts/verify-sql-restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreChecks(unittest.TestCase):
    def test_counts_empty_and_escaped_data(self):
        lines = ['COPY public.scan_entries (id, name) FROM stdin;\n', '1\ta\\nb\n', '\\.\n', 'COPY public.feeds (id) FROM stdin;\n', '\\.\n', '-- PostgreSQL database dump complete\n']
        self.assertEqual(restore.copy_counts(lines), {'scan_entries': 1, 'feeds': 0})

    def test_truncated_dump_fails(self):
        with self.assertRaises(ValueError):
            restore.copy_counts(['COPY public.feeds (id) FROM stdin;\n', '1\n'])

    def test_repeated_table_fails(self):
        with self.assertRaises(ValueError):
            restore.copy_counts(['COPY public.feeds (id) FROM stdin;', r'\.', 'COPY public.feeds (id) FROM stdin;'])

    def test_missing_rows_or_tables_fail(self):
        expected = {'scan_entries': 3, 'feeds': 1, 'summaries': 2}
        restore.verify(expected, dict(expected))
        for actual in ({**expected, 'scan_entries': 2}, {**expected, 'extra': 0}, {'scan_entries': 3, 'feeds': 1}):
            with self.assertRaises(ValueError):
                restore.verify(expected, actual)

    def test_website_profile_rejects_wrong_database_and_preserves_empty_state_tables(self):
        website = {'desk_proposals': 3, 'desk_verdicts': 2, 'ingest_state': 0, 'desk_applied_changes': 0}
        restore.verify(website, dict(website), 'grantswatch')
        with self.assertRaises(ValueError):
            restore.verify(website, dict(website), 'wire-room')
        wire = {'scan_entries': 3, 'feeds': 1, 'summaries': 2}
        with self.assertRaises(ValueError):
            restore.verify(wire, dict(wire), 'grantswatch')
        with self.assertRaises(ValueError):
            restore.verify(website, {**website, 'desk_proposals': 2}, 'grantswatch')
        incomplete = {'desk_proposals': 3, 'desk_verdicts': 2}
        with self.assertRaises(ValueError):
            restore.verify(incomplete, dict(incomplete), 'grantswatch')

    def test_empty_required_table_fails(self):
        with self.assertRaises(ValueError):
            restore.verify({'scan_entries': 0}, {'scan_entries': 0})


if __name__ == '__main__':
    unittest.main()
