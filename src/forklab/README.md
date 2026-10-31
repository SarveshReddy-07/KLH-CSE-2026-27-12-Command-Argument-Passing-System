# ForkLab 2.0 — The Operating System Playground

A local OS learning lab built around a real C process executor. The redesigned,
offline-ready dashboard combines a mini shell, a system process monitor, guided
experiments, execution history, and CPU scheduling simulations.

## Run

Requires macOS or Linux, a C compiler and Python 3. No pip or npm packages needed.

```bash
make web
```

Open the printed URL, normally <http://127.0.0.1:8000>. If busy, the server tries
ports 8001–8009. Press Ctrl+C to stop the server and its active v2 command groups.
The UI uses local assets and system fonts; internet access is not required.

## Five labs

### 1. Command lab: real C execution

- **Mini shell v2:** real pipelines (`|`), input (`<`), overwrite (`>`), append
  (`>>`) and per-browser working-directory navigation (`cd`).
- Output is captured incrementally. A process explorer shows observed parent
  and child PIDs; expandable traces show pipe creation and child exit statuses.
- **Stop** kills the complete command process group. Jobs have a 12-second
  timeout and a combined 256 KiB captured-output limit.
- Arrow keys recall history; Ctrl/Cmd+K clears terminal output; `help` documents
  commands. Each browser runs one command at a time; the server allows four
  concurrent v2 jobs and retains at most 64 recent jobs in memory.
- The **Classic executor v1** selector preserves direct-argument behavior:
  no operator interpretation, project-folder cwd, and the original 5-second
  timeout. Stop is only available for v2 jobs.

```text
pwd
printf "hello\nworld\n" | wc -l
printf "apple\nbanana\napple\n" | sort | uniq -c
cd ..
```

File-writing examples (use a directory where you want these files):

```text
printf "hello\n" > demo.txt
printf "more\n" >> demo.txt
cat < demo.txt
```

The parser preserves quoted or escaped operators as literal arguments.
Pipelines support up to eight stages and 64 executable/argument tokens per
stage. Pipeline status is the **last stage's exit status**, like a shell without
`pipefail`; every child's status remains visible in the trace.

This is deliberately not a full shell: no `&&`, `||`, `;`, background jobs,
aliases, globbing, environment/command expansion or terminal-interactive stdin.
`cd` must be used alone without redirection. External commands receive closed
stdin unless an input file or preceding pipeline provides it. Redirection is
performed in the C child with `open()` and `dup2()`.

### 2. Process monitor: real system data

Read-only snapshots from POSIX `ps`, refreshed every three seconds while the
monitor is visible. Search by process name, PID or parent PID; pause or refresh
manually. Shows up to 100 processes ordered by CPU use, plus system-wide process
and runnable-process counts. Only program names are shown, not command arguments.
CPU percentages are the operating system's `ps` measurements and can exceed 100%
on multicore machines. The monitor cannot terminate arbitrary system processes.

### 3. CPU scheduler: educational simulation

Compare **FCFS**, **non-preemptive SJF**, and **Round Robin** on the same workload.
Configure 1–12 processes, integer arrival times (0–100), burst lengths (1–100)
and Round Robin quantum (1–100). Results include:

- Gantt chart with explicit idle intervals and replay/pause controls.
- Completion, turnaround, waiting and response time for every process.
- Average waiting, turnaround and response times, plus CPU utilization.
- A comparison table for all three algorithms.

The model has one CPU, CPU-only bursts and zero context-switch overhead. Ties
retain arrival/input order. In Round Robin, newly arrived processes are queued
before the running process is requeued. Simulations do **not** control the
machine's real scheduler.

### 4. Guided experiments

Six runnable exercises: identify the OS, inspect PID/PPID, connect a three-stage
pipeline, append output to a file, inspect an intentional exec failure, and
cancel a sleeping command. Each includes expected observations. The file
exercise explicitly appends to `forklab_demo.txt` in the current directory.
An interactive C concept explorer explains fork, exec, wait and pipes.

### 5. Execution history

Up to 100 command metadata entries in this browser's localStorage, with search,
same-directory/mode rerun, JSON export and confirmed clearing. Command output is
not persisted. Statistics are derived from recorded outcomes, not demo values.
Storage failures are displayed rather than silently ignored.

## Presentation walkthrough

1. Run `pwd` and expand the real C trace.
2. Try the three-stage pipeline; point out the three child PIDs and two pipes.
3. Use the append experiment, then `cat forklab_demo.txt` to demonstrate file I/O.
4. Run `sleep 10`, then press **Stop** to demonstrate process-group signals.
5. Open **Process monitor**, search a PID, pause and refresh.
6. Open **CPU scheduler**. Simulate the sample with FCFS, SJF and Round Robin.
   The sample's average waiting times are 3.33, 2.67 and 3.33 respectively
   (Round Robin quantum 2). Replay the Gantt chart and compare response times.
7. Search and export the history. Use Alt+1 through Alt+5 to switch labs.

## Safety and boundaries

The server binds only to `127.0.0.1`. It is **not a sandbox**: commands run with
your account's permissions and can read, change or remove files your account
can access. `>` overwrites files. Do not expose this service to a network, run it
as root, or type credentials into commands/history. V2 mutations require JSON
and reject explicitly cross-origin browser requests. There is no multi-user
authentication. The documented job limits apply to v2, not the legacy v1 API.
Process groups cannot contain a program that deliberately starts a new session;
run trusted, non-daemon commands for the lab.

## API compatibility and rollback

Existing APIs remain available:

- `GET /api/health` → `{"status":"ready"}`.
- `POST /api/execute` with `{"command":"uname -a"}` → original v1 response fields.

New, separately versioned APIs:

- `GET /api/v2/info`: default cwd, platform, cores and execution limits.
- `GET /api/v2/processes`: read-only system snapshot.
- `POST /api/v2/jobs` with `{"command":"printf hi | wc -c","cwd":"/path"}`:
  create a job, returning HTTP 201 and its snapshot.
- `GET /api/v2/jobs/<id>`: poll output/state until `status` is non-null.
- `POST /api/v2/jobs/<id>/cancel` with `{}`: cancel the group.

States include `running`, `completed`, `cancelled`, `timed_out`, `output_limit`
and `failed`. Terminal state names can appear before output is completely
drained; use non-null `status` as the completion signal. `notice` explains
cancellation and limits. Job IDs expire when the in-memory cache evicts them or
the server restarts. Polling is shared within the trusted local application.

For a behavioral rollback, select **Classic executor v1**; old clients can
continue using `/api/execute`. The new mini-shell protocol is only used by v2
jobs. No database or destructive data migration was introduced. History uses a
new `forklab.history.v2` key and can be exported before clearing. The pure C CLI
is still supported:

```bash
make run
# or
make
./command_executor uname -a
```

## Tests

Python tests use only the standard library. Scheduler tests use Node.js 18+,
which is needed for testing only, not for running ForkLab.

```bash
make test
```

Coverage includes real multi-stage pipelines, quoted operators, redirection,
per-session cwd, invalid input, process-group cancellation, output/time limits,
bounded job history/concurrency, live process snapshots, v1/v2 HTTP contracts,
and exact scheduling results plus conservation/timing invariants.

## Files

- `main.c`: original CLI and version-gated POSIX pipeline executor.
- `shell_engine.py`: parser, bounded job capture, cancellation and process data.
- `server.py`: HTTP routes, compilation and backward-compatible v1 API.
- `web/index.html`, `web/styles.css`: responsive, offline-ready dashboard.
- `web/app.js`: execution, monitor, experiments, history and scheduler UI.
- `web/scheduler.js`: pure, independently testable scheduling algorithms.
- `tests/`: Python API/engine tests and Node.js scheduler tests.
