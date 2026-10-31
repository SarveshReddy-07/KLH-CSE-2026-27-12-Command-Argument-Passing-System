import json
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server
import shell_engine as engine


def wait_job(job, timeout=5):
    deadline = time.monotonic() + timeout
    while job["status"] is None:
        if time.monotonic() >= deadline:
            raise AssertionError(f"Job did not finish: {job['id']}")
        time.sleep(0.01)
        job = engine.get_job(job["id"])
    return job


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.compile_program()

    def tearDown(self):
        engine.shutdown_jobs()
        deadline = time.monotonic() + 3
        while any(job["finished"] is None for job in engine.JOBS.values()):
            if time.monotonic() >= deadline:
                self.fail("A job did not clean up.")
            time.sleep(0.01)
        with engine.LOCK:
            engine.JOBS.clear()

    def run_command(self, command, cwd=engine.ROOT):
        return wait_job(engine.create_job(command, str(cwd)))

    def test_pipeline_creates_every_child_and_counts_output(self):
        result = self.run_command('printf "apple\\nbanana\\napple\\n" | sort | uniq -c')
        self.assertEqual(result["status"], 0)
        self.assertIn("2 apple", result["commandOutput"])
        self.assertIn("1 banana", result["commandOutput"])
        self.assertEqual(result["stageCount"], 3)
        children = [event for event in result["processLog"] if "Child PID" in event["message"]]
        self.assertEqual(len(children), 3)
        self.assertEqual(sum("completed with status" in e["message"] for e in result["processLog"]), 3)

    def test_literal_operators_quotes_and_empty_arguments(self):
        for value in ["|", ">", ">>", "&&", "", "a b", "a'b", 'a"b', "é"]:
            with self.subTest(value=value):
                result = self.run_command(f"printf '%s' {shlex.quote(value)}")
                self.assertEqual(result["commandOutput"], value)
                self.assertEqual(result["stageCount"], 1)

    def test_backslash_escaped_operator_and_adjacent_quoted_word(self):
        self.assertEqual(self.run_command(r"printf '%s' \|")["commandOutput"], "|")
        self.assertEqual(self.run_command('printf "%s" ab" cd"')["commandOutput"], "ab cd")

    def test_redirect_truncate_append_and_input_with_spaces(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.run_command('printf "one\\n" > "demo file.txt"', directory)["status"], 0)
            self.assertEqual(self.run_command('printf "two\\n" >> "demo file.txt"', directory)["status"], 0)
            result = self.run_command('cat < "demo file.txt" | wc -l', directory)
            self.assertEqual(result["commandOutput"], "2")
            self.run_command('printf "new\\n" > "demo file.txt"', directory)
            self.assertEqual((Path(directory) / "demo file.txt").read_text(), "new\n")

    def test_redirection_error_is_not_success(self):
        result = self.run_command("cat < forklab_file_that_does_not_exist_39cf")
        self.assertNotEqual(result["status"], 0)
        self.assertIn("Input redirection failed", result["commandOutput"])

    def test_unknown_executable_and_last_stage_exit_status(self):
        result = self.run_command("forklab_nonexistent_executable_39cf")
        self.assertEqual(result["status"], 127)
        self.assertIn("Command failed", result["commandOutput"])
        self.assertEqual(self.run_command("false | cat")["status"], 0)
        self.assertEqual(self.run_command("printf hi | false")["status"], 1)

    def test_cd_is_per_request_and_does_not_change_server_directory(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            job = self.run_command(f"cd {shlex.quote(directory)}")
            self.assertTrue(job["builtIn"])
            self.assertEqual(Path(job["cwd"]), Path(directory).resolve())
            self.assertEqual(job["processLog"], [])
            result = self.run_command("pwd", directory)
            self.assertEqual(Path(result["commandOutput"]), Path(directory).resolve())
            self.assertEqual(Path.cwd(), original)
        self.assertEqual(self.run_command("pwd")["commandOutput"], str(engine.ROOT))

    def test_invalid_syntax_and_bounds(self):
        invalid = ["", " ", "| cat", "printf hi |", "cat || cat", "cat && cat", "ls &",
                   "ls ; pwd", "cat <", 'cat > ""', 'printf "oops', "a\0b",
                   "cd / | cat", "cd > out.txt", "cat < a < b", "echo " + "x " * 64,
                   " | ".join(["cat"] * 9), "x" * 1025]
        for command in invalid:
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    engine.create_job(command, str(engine.ROOT))

    def test_directory_errors_are_explicit(self):
        for directory in [None, 42, str(engine.ROOT / "main.c"), "/forklab_missing_directory_39cf"]:
            with self.subTest(directory=directory):
                with self.assertRaises(ValueError):
                    engine.create_job("pwd", directory)

    def test_cancel_stops_running_job_and_is_idempotent(self):
        job = engine.create_job("sleep 10 | cat", str(engine.ROOT))
        cancelled = engine.cancel_job(job["id"])
        self.assertEqual(cancelled["state"], "cancelled")
        result = wait_job(job)
        self.assertEqual(result["state"], "cancelled")
        self.assertGreaterEqual(result["status"], 128)
        self.assertIn("Stopped by you", result["notice"])
        self.assertEqual(engine.cancel_job(job["id"])["state"], "cancelled")

    def test_partial_output_is_observable_and_cancel_stops_descendants(self):
        program = (
            'import subprocess,sys,time; '
            'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"]); '
            'print(child.pid,flush=True); time.sleep(10)'
        )
        job = engine.create_job(f"{shlex.quote(sys.executable)} -c {shlex.quote(program)}", str(engine.ROOT))
        deadline = time.monotonic() + 3
        while not job["commandOutput"]:
            self.assertLess(time.monotonic(), deadline, "Expected incremental output before completion")
            time.sleep(0.01)
            job = engine.get_job(job["id"])
        self.assertIsNone(job["status"])
        descendant = int(job["commandOutput"])
        engine.cancel_job(job["id"])
        self.assertEqual(wait_job(job)["state"], "cancelled")
        status = subprocess.run(["ps", "-p", str(descendant), "-o", "stat="],
                                capture_output=True, text=True, timeout=2).stdout.strip()
        self.assertTrue(not status or status.startswith("Z"), f"Descendant still running: {status}")

    def test_timeout_and_output_limits(self):
        with patch.object(engine, "TIMEOUT_SECONDS", 0.15):
            result = wait_job(engine.create_job("sleep 10 | cat", str(engine.ROOT)))
            self.assertEqual(result["state"], "timed_out")
            self.assertGreaterEqual(result["status"], 128)
        program = shlex.quote('import sys; sys.stdout.write("x" * 300000)')
        result = self.run_command(f"{shlex.quote(sys.executable)} -c {program}")
        self.assertEqual(result["state"], "output_limit")
        self.assertLessEqual(len(result["output"].encode()), engine.OUTPUT_LIMIT + 1)
        self.assertIn("256 KiB", result["notice"])

    def test_concurrency_and_recent_job_cache_are_bounded(self):
        with patch.object(engine, "MAX_RUNNING", 1):
            first = engine.create_job("sleep 10", str(engine.ROOT))
            with self.assertRaisesRegex(ValueError, "already running"):
                engine.create_job("pwd", str(engine.ROOT))
            engine.cancel_job(first["id"])
            wait_job(first)
        with patch.object(engine, "MAX_JOBS", 2):
            for _ in range(3):
                self.run_command("pwd")
            self.assertEqual(len(engine.JOBS), 2)

    def test_monitor_returns_real_bounded_snapshot(self):
        snapshot = engine.process_snapshot()
        self.assertGreater(snapshot["total"], 0)
        self.assertLessEqual(len(snapshot["processes"]), 100)
        self.assertEqual([p["cpu"] for p in snapshot["processes"]],
                         sorted((p["cpu"] for p in snapshot["processes"]), reverse=True))
        for process in snapshot["processes"]:
            self.assertIsInstance(process["pid"], int)
            self.assertIsInstance(process["memory"], float)
            self.assertTrue(process["command"])


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.compile_program()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.CommandHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        engine.shutdown_jobs()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)

    def api(self, path, data=None, headers=None):
        request = Request(self.base + path, data=None if data is None else json.dumps(data).encode(),
                          headers=headers or {"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_health_and_classic_api_contract(self):
        self.assertEqual(self.api("/api/health"), (200, {"status": "ready"}))
        code, result = self.api("/api/execute", {"command": 'printf "%s" "|"'})
        self.assertEqual(code, 200)
        self.assertEqual(result["commandOutput"], "|")
        self.assertEqual(result["status"], 0)
        self.assertTrue({"command", "output", "commandOutput", "processLog", "status", "durationMs"} <= result.keys())

    def test_v2_job_round_trip(self):
        code, job = self.api("/api/v2/jobs", {"command": 'printf "a\\nb\\n" | wc -l'})
        self.assertEqual(code, 201)
        result = wait_job(job)
        code, fetched = self.api("/api/v2/jobs/" + result["id"])
        self.assertEqual(code, 200)
        self.assertEqual(fetched["commandOutput"], "2")
        self.assertEqual(fetched["status"], 0)

    def test_bad_json_shape_and_command_validation(self):
        for data in [[], None, {"command": 1}, {"command": ""}, {"command": "ls && pwd"}]:
            if data is None:
                continue
            with self.subTest(data=data):
                self.assertEqual(self.api("/api/v2/jobs", data)[0], 400)
        self.assertEqual(self.api("/api/v2/jobs/missing")[0], 404)
        self.assertEqual(self.api("/api/v2/jobs/missing/cancel", {})[0], 404)

    def test_v2_rejects_cross_origin_and_non_json_posts(self):
        code, _ = self.api("/api/v2/jobs", {"command": "pwd"},
                           {"Content-Type": "application/json", "Origin": "https://example.invalid"})
        self.assertEqual(code, 403)
        code, _ = self.api("/api/v2/jobs", {"command": "pwd"}, {"Content-Type": "text/plain"})
        self.assertEqual(code, 415)

    def test_v2_metadata_and_monitor(self):
        code, info = self.api("/api/v2/info")
        self.assertEqual(code, 200)
        self.assertEqual(info["apiVersion"], 2)
        self.assertEqual(info["cwd"], str(engine.ROOT))
        self.assertEqual(self.api("/api/v2/processes")[0], 200)


if __name__ == "__main__":
    unittest.main()
