# Command Argument Passing System - ForkLab

**Team 12 | OSSP PBL 2026-27 | KLH Bachupally, CSE**

ForkLab is a parent-child process and inter-process communication visualizer.
Its C executor creates real children using `fork()`, loads programs with
`execvp()`, connects pipeline stages with `pipe()` and `dup2()`, and collects
termination statuses with `waitpid()`. A local Python server and web interface
display command output, observed PIDs and execution traces.

## Team

| Member | Roll number |
| --- | --- |
| G.ROHITH | 2520030220 |
| SARVESH | 2520030049 |
| GAUTHAM | 2520030316 |

**Guide:** HARIKA

## Run the project

Requires macOS or Linux, a C compiler, Python 3 and a browser.
No pip or npm dependencies are needed.

```bash
git clone https://github.com/SarveshReddy-07/KLH-CSE-2026-27-12-Command-Argument-Passing-System.git
cd KLH-CSE-2026-27-12-Command-Argument-Passing-System/src/forklab
make web
```

Open the URL printed in the terminal, normally `http://127.0.0.1:8000`.
If that port is occupied, the server selects the next available port.
Press Ctrl+C to stop.

For the C-only command executor:

```bash
make
./command_executor uname -a
```

## Demonstrate the main concept

In the web interface, select **Mini shell v2** and run:

```text
printf "apple\nbanana\napple\n" | sort | uniq -c
```

The C parent creates three sibling children and two pipes:

```text
                    C parent
                   /    |    \
              printf   sort   uniq -c
                 output -> input -> output
```

`printf` produces three lines, `sort` groups equal lines, and `uniq -c`
counts consecutive duplicates. The output is two apples and one banana.
Inspect the three child PIDs, two pipe creations and all child completion
statuses in the process explorer and trace.

## Supporting features

- Mini shell with pipelines, file redirection and session-directory navigation.
- Command-group cancellation and bounded v2 output/execution time.
- Read-only live process monitor.
- Guided OS experiments and system-call explanations.
- Searchable local history with rerun and JSON export.
- FCFS, non-preemptive SJF and Round Robin **simulations**, including Gantt
  charts and performance comparisons; these do not control the real OS scheduler.
- Classic v1 execution remains available for the original direct-argument behavior.

**Safety:** This is a local educational tool, not a sandbox. Commands run with
your user permissions and can modify real files. Do not expose the server to a
network or enter secrets into commands/history.

## Documentation and presentation

- [Complete usage, API, limits and demo guide](src/forklab/README.md)
- [Faculty presentation - PowerPoint with speaker notes](docs/ForkLab_Project_Presentation.pptx)
- [Faculty presentation - PDF](docs/ForkLab_Project_Presentation.pdf)
- [Original project statement](docs/Argument_Passing_Project_Statement.pdf)

The presentation focuses on parent-child processes and IPC, with supporting
features kept secondary.

## Tests

From `src/forklab`, run:

```bash
make test
```

Python tests use the standard library. Node.js 18+ is required only for
scheduler tests, not for running the application.

## Repository layout

```text
src/forklab/   C executor, Python server, web UI and automated tests
docs/         Original statement and faculty presentation
data/         Existing project data placeholder
reports/      Existing reports placeholder
```

Generated executables, caches, local demo files and editor settings are not
included in the source upload.
