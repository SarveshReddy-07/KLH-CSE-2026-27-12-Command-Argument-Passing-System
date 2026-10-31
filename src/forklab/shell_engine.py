import os
import selectors
import shlex
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXECUTABLE = ROOT / "command_executor"
TIMEOUT_SECONDS = 12
OUTPUT_LIMIT = 256 * 1024
MAX_JOBS = 64
MAX_RUNNING = 4
JOBS = {}
LOCK = threading.RLock()


def shell_tokens(command):
    """Keep quoted operators as arguments rather than shell syntax."""
    tokens = []
    word = []
    quote = None
    index = 0

    def finish_word():
        if word:
            values = shlex.split("".join(word))
            tokens.extend((value, False) for value in values)
            word.clear()

    while index < len(command):
        char = command[index]
        if char == "\\" and quote != "'":
            word.append(char)
            index += 1
            if index < len(command):
                word.append(command[index])
        elif char in ("'", '"'):
            word.append(char)
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
        elif quote is None and char.isspace():
            finish_word()
        elif quote is None and char in "|<>&;":
            finish_word()
            operator = char
            if index + 1 < len(command) and command[index + 1] == char:
                operator += char
                index += 1
            if operator not in ("|", "<", ">", ">>"):
                raise ValueError(f"{operator} is not supported. Run one pipeline at a time.")
            tokens.append((operator, True))
        else:
            word.append(char)
        index += 1
    finish_word()
    return tokens


def parse_pipeline(command):
    if not isinstance(command, str) or not command.strip():
        raise ValueError("Enter a command first.")
    if len(command) > 1024 or "\0" in command:
        raise ValueError("Commands must be at most 1024 characters and contain no NUL bytes.")
    tokens = shell_tokens(command)
    stages = [{"args": [], "input": "", "output": "", "append": False}]
    index = 0
    while index < len(tokens):
        value, operator = tokens[index]
        stage = stages[-1]
        if not operator:
            stage["args"].append(value)
        elif value == "|":
            if not stage["args"]:
                raise ValueError("Each pipeline stage needs an executable.")
            stages.append({"args": [], "input": "", "output": "", "append": False})
        else:
            index += 1
            if index == len(tokens) or tokens[index][1] or not tokens[index][0]:
                raise ValueError(f"Provide a filename after {value}.")
            key = "input" if value == "<" else "output"
            if stage[key]:
                raise ValueError("Only one input and one output redirection per stage are supported.")
            stage[key] = tokens[index][0]
            if key == "output":
                stage["append"] = value == ">>"
        index += 1
    if len(stages) > 8:
        raise ValueError("Use at most 8 pipeline stages.")
    for stage in stages:
        if not stage["args"] or not stage["args"][0]:
            raise ValueError("Each pipeline stage needs an executable.")
        if len(stage["args"]) > 64:
            raise ValueError("Use at most 64 arguments per stage.")
    return stages


def resolve_directory(value, current=ROOT):
    if not isinstance(value, str) or not isinstance(current, (str, Path)):
        raise ValueError("The working directory must be text.")
    try:
        base = Path(current).expanduser().resolve(strict=True)
        target = Path(value).expanduser()
        directory = (target if target.is_absolute() else base / target).resolve(strict=True)
        if not directory.is_dir():
            raise ValueError("The requested path is not a directory.")
        if not os.access(directory, os.R_OK | os.X_OK):
            raise ValueError("You do not have permission to access that directory.")
        return directory
    except (OSError, RuntimeError) as error:
        raise ValueError(f"Cannot open directory: {error}") from error


def split_execution_output(standard_output, standard_error):
    command_lines = standard_output.strip().splitlines()
    process_log = []
    for line in standard_error.strip().splitlines():
        message = line.strip()
        if not message or message == "-" * 40:
            continue
        if message.startswith("[Parent]"):
            role = "parent"
        elif message.startswith("[Child]"):
            role = "child"
        else:
            command_lines.append(message)
            continue
        process_log.append({"role": role, "message": message})
        if "failed" in message.lower():
            command_lines.append(message)
    return "\n".join(command_lines).strip(), process_log


def public_job(job):
    with LOCK:
        stdout = bytes(job["stdout"]).decode("utf-8", errors="replace")
        stderr = bytes(job["stderr"]).decode("utf-8", errors="replace")
        command_output, process_log = split_execution_output(stdout, stderr)
        elapsed = (job["finished"] or time.monotonic()) - job["started"]
        return {
            "id": job["id"],
            "command": job["command"],
            "cwd": str(job["cwd"]),
            "state": job["state"],
            "status": job["status"],
            "durationMs": round(elapsed * 1000),
            "commandOutput": command_output,
            "output": "\n".join(part for part in (stdout.strip(), stderr.strip()) if part),
            "processLog": process_log,
            "stageCount": job["stageCount"],
            "notice": job["notice"],
            "builtIn": job["process"] is None,
        }


def stop_job(job, state, notice):
    with LOCK:
        if job["state"] != "running":
            return
        job["state"] = state
        job["notice"] = notice
        try:
            os.killpg(job["process"].pid, signal.SIGKILL)
        except ProcessLookupError:
            # The process can finish between checking its state and signaling it.
            pass


def collect_job(job):
    process = job["process"]
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                if time.monotonic() - job["started"] >= TIMEOUT_SECONDS:
                    stop_job(job, "timed_out", f"Stopped the process group after {TIMEOUT_SECONDS} seconds.")
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    with LOCK:
                        size = len(job["stdout"]) + len(job["stderr"])
                        remaining = max(0, OUTPUT_LIMIT - size)
                        job[key.data].extend(chunk[:remaining])
                        if len(chunk) > remaining:
                            stop_job(job, "output_limit", "Stopped: captured output exceeded 256 KiB.")
        status = process.wait()
        with LOCK:
            job["status"] = status if status >= 0 else 128 - status
            if job["state"] == "running":
                job["state"] = "completed"
    except (OSError, ValueError) as error:
        print(f"[Jobs] Capture failed for {job['id']}: {error}", flush=True)
        stop_job(job, "failed", f"Could not capture process output: {error}")
        process.wait()
        with LOCK:
            job["status"] = 1
    finally:
        process.stdout.close()
        process.stderr.close()
        with LOCK:
            job["finished"] = time.monotonic()


def create_job(command, cwd):
    stages = parse_pipeline(command)
    directory = resolve_directory(cwd)
    builtin = stages[0]["args"][0] == "cd"
    if any(stage["args"][0] == "cd" for stage in stages):
        if len(stages) != 1 or len(stages[0]["args"]) > 2 or stages[0]["input"] or stages[0]["output"]:
            raise ValueError("Use cd alone, with an optional directory and no redirection.")
        directory = resolve_directory(stages[0]["args"][1] if len(stages[0]["args"]) == 2 else str(Path.home()), directory)

    with LOCK:
        if sum(job["finished"] is None for job in JOBS.values()) >= MAX_RUNNING:
            raise ValueError("Four commands are already running. Stop one or wait for completion.")
        while len(JOBS) >= MAX_JOBS:
            completed = next((key for key, job in JOBS.items() if job["finished"] is not None), None)
            if completed is None:
                raise ValueError("The execution history is full. Wait for a running command.")
            del JOBS[completed]
        now = time.monotonic()
        job = {
            "id": uuid.uuid4().hex,
            "command": command,
            "cwd": directory,
            "state": "completed" if builtin else "running",
            "status": 0 if builtin else None,
            "started": now,
            "finished": now if builtin else None,
            "stdout": bytearray((str(directory) + "\n").encode() if builtin else b""),
            "stderr": bytearray(),
            "stageCount": 0 if builtin else len(stages),
            "process": None,
            "notice": "Directory changed in this browser session; no child process was created." if builtin else "",
        }
        if not builtin:
            arguments = [str(EXECUTABLE), "--pipeline-v2", str(len(stages))]
            for stage in stages:
                arguments.extend([
                    str(len(stage["args"])), stage["input"], stage["output"],
                    "1" if stage["append"] else "0", *stage["args"],
                ])
            job["process"] = subprocess.Popen(
                arguments, cwd=directory, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            )
        JOBS[job["id"]] = job
        if not builtin:
            threading.Thread(target=collect_job, args=(job,), daemon=True).start()
        return public_job(job)


def get_job(job_id):
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise KeyError("Execution not found or expired from the recent-job cache.")
        return public_job(job)


def cancel_job(job_id):
    with LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise KeyError("Execution not found or expired from the recent-job cache.")
        stop_job(job, "cancelled", "Stopped by you; the entire command process group was signaled.")
        return public_job(job)


def shutdown_jobs():
    with LOCK:
        for job in JOBS.values():
            if job["state"] == "running":
                stop_job(job, "cancelled", "The local server is shutting down.")


def process_snapshot():
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,%cpu=,%mem=,stat=,comm="],
        capture_output=True, text=True, timeout=3, check=True,
    )
    processes = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 5)
        if len(parts) != 6:
            raise ValueError("The system process list returned an unexpected format.")
        pid, parent, cpu, memory, state, command = parts
        processes.append({
            "pid": int(pid), "ppid": int(parent), "cpu": float(cpu),
            "memory": float(memory), "state": state,
            "command": Path(command).name,
        })
    processes.sort(key=lambda process: (-process["cpu"], process["pid"]))
    return {
        "processes": processes[:100], "total": len(processes),
        "sampledAt": time.time(),
        "running": sum(process["state"].startswith("R") for process in processes),
    }
