"""Status publication survives Windows readers without truncation or silent loss."""
import ctypes
import errno
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "launcher"))
import data


def windows_error(number):
    error = PermissionError(errno.EACCES, "Synthetic Windows access conflict")
    error.winerror = number
    return error


class NativeAtomicStatusTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="qstudy-native-status-fixture-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "managed" / "status.json"
        self.path.parent.mkdir()
        self.original = b'{"state":"running","instance":"original-whole-instance"}'
        self.path.write_bytes(self.original)
        self.updated = {"state": "stopped", "message": "Задачи завершены", "children": [1, 2]}

    def assert_original_and_no_temporary(self):
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.path.parent.glob(".native-*.tmp")), [])

    @unittest.skipUnless(os.name == "nt", "Windows status sharing retry policy")
    def test_transient_windows_access_sharing_and_lock_errors_retry_without_changing_old_json(self):
        replace = os.replace
        for number in (5, 32, 33):
            with self.subTest(winerror=number):
                self.path.write_bytes(self.original)
                calls = 0

                def temporarily_blocked(source, destination):
                    nonlocal calls
                    calls += 1
                    self.assertEqual(self.path.read_bytes(), self.original)
                    if calls <= 2:
                        raise windows_error(number)
                    return replace(source, destination)

                with patch.object(data.os, "replace", side_effect=temporarily_blocked), patch.object(data.time, "sleep") as sleep:
                    data.atomic_json(self.path, self.updated)
                self.assertEqual(calls, 3)
                self.assertEqual(sleep.call_count, 2)
                self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), self.updated)
                self.assertEqual(list(self.path.parent.glob(".native-*.tmp")), [])

    @unittest.skipUnless(os.name == "nt", "Native Windows FILE_SHARE_DELETE behavior")
    def test_actual_windows_reader_releases_and_the_same_publication_then_succeeds(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                      ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        # Read/write sharing deliberately excludes FILE_SHARE_DELETE, matching
        # a PowerShell Get-Content reader that can overlap the status publisher.
        handle = kernel.CreateFileW(str(self.path), 0x80000000, 3, None, 3, 128, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        first_conflict = threading.Event()
        failures, sharing_errors = [], []
        replace = os.replace

        def observed_replace(source, destination):
            try:
                return replace(source, destination)
            except OSError as error:
                sharing_errors.append(getattr(error, "winerror", None))
                first_conflict.set()
                raise

        def publish():
            try:
                data.atomic_json(self.path, self.updated)
            except BaseException as error:
                failures.append(error)

        with patch.object(data.os, "replace", side_effect=observed_replace):
            writer = threading.Thread(target=publish)
            writer.start()
            try:
                self.assertTrue(first_conflict.wait(timeout=2), "Native reader must reproduce a real sharing conflict")
                self.assertEqual(self.path.read_bytes(), self.original)
                threading.Event().wait(0.04)
            finally:
                kernel.CloseHandle(handle)
                writer.join(timeout=3)
        self.assertFalse(writer.is_alive(), "Publication must finish promptly after the reader releases")
        self.assertEqual(failures, [])
        self.assertTrue(sharing_errors)
        self.assertTrue(all(number in (5, 32, 33) for number in sharing_errors))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), self.updated)
        self.assertEqual(list(self.path.parent.glob(".native-*.tmp")), [])

    @unittest.skipUnless(os.name == "nt", "Windows bounded sharing retry policy")
    def test_permanent_windows_access_denial_is_bounded_raised_and_preserves_whole_old_file(self):
        denial = windows_error(5)
        with patch.object(data.os, "replace", side_effect=denial) as replace, patch.object(data.time, "sleep") as sleep:
            with self.assertRaises(PermissionError) as failure:
                data.atomic_json(self.path, self.updated)
        self.assertIs(failure.exception, denial)
        self.assertEqual(replace.call_count, 12)
        self.assertEqual(sleep.call_count, 11)
        self.assertLess(sum(call.args[0] for call in sleep.call_args_list), 1)
        self.assert_original_and_no_temporary()

    def test_non_sharing_errors_fail_immediately_without_silent_success_or_retry(self):
        for error in (PermissionError(errno.EACCES, "Permanent generic denial"),
                      OSError(errno.ENOSPC, "Synthetic full device"),
                      FileNotFoundError(errno.ENOENT, "Synthetic missing destination")):
            with self.subTest(error=type(error).__name__):
                with patch.object(data.os, "replace", side_effect=error) as replace, patch.object(data.time, "sleep") as sleep:
                    with self.assertRaises(OSError) as failure:
                        data.atomic_json(self.path, self.updated)
                self.assertIs(failure.exception, error)
                replace.assert_called_once()
                sleep.assert_not_called()
                self.assert_original_and_no_temporary()

    def test_serialization_failure_never_replaces_a_valid_status_file(self):
        with self.assertRaises(TypeError):
            data.atomic_json(self.path, {"unsupported": object()})
        self.assert_original_and_no_temporary()


if __name__ == "__main__":
    unittest.main()
