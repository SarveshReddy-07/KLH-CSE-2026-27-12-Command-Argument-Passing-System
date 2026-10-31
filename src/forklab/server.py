#!/usr/bin/env python3

import errno
import json
import os
import platform
import shlex
import signal
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from shell_engine import (
    cancel_job, create_job, get_job, process_snapshot, shutdown_jobs,
    split_execution_output,
)

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
SOURCE = ROOT / "main.c"
EXECUTABLE = ROOT / "command_executor"
HOST = "127.0.0.1"
PORT = 8000


def compile_program():
    """Compile main.c when the executable is missing or out of date."""
    if EXECUTABLE.exists() and EXECUTABLE.stat().st_mtime >= SOURCE.stat().st_mtime:
        return

    result = subprocess.run(
        ["cc", "-Wall", "-Wextra", "-pedantic", "-std=c11", str(SOURCE), "-o", str(EXECUTABLE)],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or "The C program could not be compiled.")


def validate_command(command_text):
    """Convert command text into the argument list expected by execvp()."""
    try:
        parts = shlex.split(command_text)
    except ValueError as error:
        raise ValueError(f"Could not read command: {error}") from error

    if not parts:
        raise ValueError("Enter a command first.")

    return parts


def run_command(command_text):
    arguments = validate_command(command_text)
    started_at = time.perf_counter()

    try:
        result = subprocess.run(
            [str(EXECUTABLE), *arguments],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=ROOT,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("The command took too long and was stopped.") from error

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    command_output, process_log = split_execution_output(result.stdout, result.stderr)
    clean_output = "\n".join(
        part for part in (result.stdout.strip(), result.stderr.strip()) if part
    )

    return {
        "command": command_text,
        "output": clean_output,
        "commandOutput": command_output,
        "processLog": process_log,
        "status": result.returncode,
        "durationMs": elapsed_ms,
    }


class CommandHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"status": "ready"})
            return
        try:
            if path == "/api/v2/info":
                self.send_json({
                    "cwd": str(ROOT), "platform": platform.system(),
                    "cpuCount": os.cpu_count(), "timeoutSeconds": 12,
                    "outputLimitKiB": 256, "apiVersion": 2,
                })
                return
            if path == "/api/v2/processes":
                self.send_json(process_snapshot())
                return
            if path.startswith("/api/v2/jobs/"):
                self.send_json(get_job(path.rsplit("/", 1)[-1]))
                return
        except KeyError as error:
            self.send_json({"error": str(error.args[0])}, 404)
            return
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            self.log_error("API request failed: %s", error)
            self.send_json({"error": f"Could not read system data: {error}"}, 500)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        is_v2 = path.startswith("/api/v2/")
        if path != "/api/execute" and path != "/api/v2/jobs" and not (
            path.startswith("/api/v2/jobs/") and path.endswith("/cancel")
        ):
            self.send_json({"error": "Not found."}, 404)
            return

        try:
            if is_v2:
                origin = self.headers.get("Origin")
                allowed = {f"http://127.0.0.1:{self.server.server_port}",
                           f"http://localhost:{self.server.server_port}"}
                if origin is not None and origin not in allowed:
                    self.send_json({"error": "Only this local application can start or stop commands."}, 403)
                    return
                if self.headers.get_content_type() != "application/json":
                    self.send_json({"error": "Send an application/json request."}, 415)
                    return
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 0 or content_length > 4096:
                raise ValueError("Request size must be between 0 and 4096 bytes.")

            data = json.loads(self.rfile.read(content_length))
            if not isinstance(data, dict):
                raise ValueError("The request body must be a JSON object.")
            if path.endswith("/cancel"):
                self.send_json(cancel_job(path.split("/")[-2]))
                return
            command_text = data.get("command", "")
            if not isinstance(command_text, str):
                raise ValueError("Command must be text.")
            if is_v2:
                self.send_json(create_job(command_text.strip(), data.get("cwd", str(ROOT))), 201)
            else:
                self.send_json(run_command(command_text.strip()))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
        except KeyError as error:
            self.send_json({"error": str(error.args[0])}, 404)
        except (OSError, subprocess.SubprocessError) as error:
            self.log_error("Execution failed: %s", error)
            self.send_json({"error": f"Execution failed: {error}"}, 500)

    def log_message(self, format_text, *args):
        print(f"[Web] {self.address_string()} - {format_text % args}")


def main():
    compile_program()
    def terminate_server(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate_server)

    for port in range(PORT, PORT + 10):
        try:
            server = ThreadingHTTPServer((HOST, port), CommandHandler)
            break
        except OSError as error:
            if error.errno != errno.EADDRINUSE or port == PORT + 9:
                raise

    print(f"ForkLab is running at http://{HOST}:{port}")
    print("Press Ctrl+C to stop the server.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping ForkLab...")
    finally:
        shutdown_jobs()
        server.server_close()


if __name__ == "__main__":
    main()