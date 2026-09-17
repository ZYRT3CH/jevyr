import hashlib
import unittest

from jevyr.experiment import plan_experiment


class UvExperimentTests(unittest.TestCase):
    def test_plan_binds_exact_source_and_only_emits_offline_no_shell_argv(self):
        source = b"print(1 + 1)\n"
        plan = plan_experiment("experiment.py", source, arguments=["--value", "hello world"])
        self.assertEqual(plan["materials"][0]["digest"], "sha256:" + hashlib.sha256(source).hexdigest())
        self.assertEqual(plan["args"]["command"], "uv")
        self.assertEqual(plan["args"]["args"][-3:], ["experiment.py", "--value", "hello world"])
        self.assertIn("--offline", plan["args"]["args"])
        self.assertIn("--no-python-downloads", plan["args"]["args"])
        self.assertEqual(plan["evidenceAuthority"], "none-until-forge-execution")

    def test_dependency_metadata_requires_an_exact_lock(self):
        source = b'# /// script\n# dependencies = ["numpy"]\n# ///\n'
        with self.assertRaisesRegex(ValueError, "sealed uv script lock"):
            plan_experiment("experiment.py", source)
        plan = plan_experiment("experiment.py", source, lock_bytes=b"version = 1\n")
        self.assertIn("--locked", plan["args"]["args"])
        self.assertEqual(plan["materials"][1]["path"], "experiment.py.lock")

    def test_rejects_paths_that_can_escape_or_change_platform_interpretation(self):
        for value in ["../outside.py", "/tmp/outside.py", "C:/outside.py", "a\\b.py", "a//b.py", "a/./b.py"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan_experiment(value, b"pass")

    def test_rejects_unbounded_or_non_utf8_inputs(self):
        with self.assertRaises(ValueError):
            plan_experiment("experiment.py", b"pass", timeout_ms=True)
        with self.assertRaises(UnicodeDecodeError):
            plan_experiment("experiment.py", b"\xff")


if __name__ == "__main__":
    unittest.main()
