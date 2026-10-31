"use strict";

const $ = (selector) => document.querySelector(selector);
const make = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
};
const HISTORY_KEY = "forklab.history.v2";
const mode = $("#execution-mode");
const input = $("#command-input");
const output = $("#terminal-output");
const runButton = $("#run-button");
const stopButton = $("#stop-button");
let currentView = "terminal";
let cwd = "";
let baseCwd = "";
let busy = false;
let activeJob = null;
let historyPosition = 0;
let monitorPaused = false;
let monitorLoading = false;
let monitorProcesses = [];
let lastSchedule = null;
let replayTimer = null;
let replayTime = 0;
let nextProcess = 1;

function notify(message) {
    $("#notification").textContent = message;
    $("#notification").hidden = false;
}

function connection(online) {
    $("#server-status").classList.toggle("offline", !online);
    $("#connection-label").textContent = online ? "Server connected" : "Server unreachable";
}

async function request(path, data) {
    const options = data === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    };
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
}

function loadHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        if (!Array.isArray(saved) || saved.length > 100 || saved.some((item) =>
            !item || typeof item.command !== "string" || item.command.length > 1024
            || typeof item.cwd !== "string" || !["mini", "classic"].includes(item.mode)
            || !(item.status === null || Number.isInteger(item.status))
            || !Number.isFinite(item.durationMs) || item.durationMs < 0
            || !Number.isFinite(Date.parse(item.createdAt)))) {
            throw new Error("The saved history has an invalid format.");
        }
        return saved;
    } catch (error) {
        notify(`History could not be loaded: ${error.message} New executions will start a fresh log.`);
        return [];
    }
}

let commandHistory = loadHistory();
historyPosition = commandHistory.length;

function saveHistory() {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(commandHistory));
    } catch (error) {
        notify(`History is available for this visit, but could not be saved: ${error.message}`);
    }
    renderHistory();
    renderStats();
}

function renderStats() {
    const executed = commandHistory.filter((item) => item.status !== null);
    $("#stat-runs").textContent = executed.length;
    $("#stat-success").textContent = executed.length
        ? `${Math.round(100 * executed.filter((item) => item.status === 0).length / executed.length)}%` : "—";
    $("#stat-duration").textContent = executed.length
        ? `${Math.round(executed.reduce((sum, item) => sum + item.durationMs, 0) / executed.length)} ms` : "—";
}

function displayCwd() {
    $("#cwd-label").textContent = (mode.value === "classic" ? baseCwd : cwd) || "Connecting...";
    $("#cwd-label").title = $("#cwd-label").textContent;
    $("#mode-note").textContent = mode.value === "classic"
        ? "Classic v1 preserves direct argv execution: operators are plain arguments, cwd is the project folder, and the timeout is 5 seconds."
        : "Mini shell supports |, <, >, >> and cd. Commands run with your permissions; redirection can overwrite files. 12s / 256 KiB limits.";
}

function showView(name) {
    currentView = name;
    document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== `view-${name}`; });
    document.querySelectorAll("[data-view]").forEach((button) => {
        const selected = button.dataset.view === name;
        button.classList.toggle("active", selected);
        if (selected) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    });
    $("#view-label").textContent = $(`[data-view="${name}"]`).textContent.replace(/[1-5]$/, "").replace(/^[>_|=+@\s]+/, "").trim();
    if (name === "monitor") refreshMonitor();
    if (name !== "scheduler") pauseReplay();
}

function createEntry(command) {
    const entry = make("article", "terminal-entry running");
    const header = make("div", "entry-header");
    const status = make("span", "entry-status", "running");
    header.append(make("p", "terminal-command", command), status);
    const pre = make("pre", "result-output", "Starting the C executor...");
    const notice = make("p", "entry-notice");
    const meta = make("div", "entry-meta");
    entry.append(header, pre, notice, meta);
    output.append(entry);
    while (output.querySelectorAll(".terminal-entry").length > 20) {
        output.querySelector(".terminal-entry").remove();
    }
    output.scrollTop = output.scrollHeight;
    return { entry, pre, status, notice, meta };
}

function updateEntry(ui, result, complete) {
    ui.pre.textContent = result.commandOutput || (complete
        ? (result.status === 0 ? "Completed without printed output." : "No command output was captured.")
        : "Running; waiting for output...");
    ui.status.textContent = complete ? (result.status === 0 ? "success" : `exit ${result.status}`) : (
        result.state === "running" ? "running" : "stopping");
    ui.entry.classList.toggle("running", !complete);
    ui.entry.classList.toggle("error", complete && result.status !== 0);
    ui.notice.textContent = result.notice || "";
    ui.meta.textContent = `${result.durationMs} ms · ${result.processLog.length} process events`;
    if (complete && result.processLog.length) {
        const details = make("details", "process-trace");
        details.append(make("summary", "", `Inspect system-call trace (${result.processLog.length})`));
        result.processLog.forEach((event) => {
            details.append(make("div", `trace-row ${event.role}`, event.message));
        });
        ui.entry.insertBefore(details, ui.meta);
    }
    output.scrollTop = output.scrollHeight;
}

function updateExplorer(result) {
    const log = (result.processLog || []).map((event) => event.message).join("\n");
    const parent = log.match(/\[Parent\] Parent PID\s*:\s*(\d+)/);
    const children = [...log.matchAll(/\[Parent\] Child PID\s*:\s*(\d+)/g)];
    $("#parent-pid").textContent = parent ? `PID ${parent[1]}` : (result.builtIn ? "Browser-session directory change" : "Waiting for parent PID");
    $("#child-nodes").replaceChildren();
    children.forEach((match, index) => {
        const node = make("div", "process-node");
        const copy = make("div");
        copy.append(make("strong", "", `Child ${index + 1}`), make("code", "", `PID ${match[1]} · stage ${index + 1}`));
        node.append(make("span", "node-symbol green", "C"), copy);
        $("#child-nodes").append(node);
    });
    if (!children.length) {
        const node = make("div", "process-node");
        node.append(make("code", "", result.builtIn ? "No fork: cd updates this session's cwd." : "No child PID observed yet."));
        $("#child-nodes").append(node);
    }
    $("#duration").textContent = `${result.durationMs} ms`;
    $("#execution-state").textContent = result.status === null ? (
        result.state === "running" ? "Running" : "Stopping"
    ) : result.status === 0 ? "Completed" : `Exit ${result.status}`;
    $("#process-note").textContent = result.notice || (children.length > 1
        ? `${children.length} real child processes. pipe() channels connect stages; waitpid() collects every child. Pipeline status is the last stage's exit status.`
        : "PIDs and traces come from the C executor, not a simulation.");
}

async function executeCommand(commandText, options = {}) {
    const command = commandText.trim();
    if (!command || busy || !baseCwd) return;
    if (command === "clear") {
        output.replaceChildren();
        input.value = "";
        return;
    }
    if (command === "help") {
        const ui = createEntry(command);
        updateEntry(ui, {
            commandOutput: 'MINI SHELL v2\n  pwd / ls -la / uname -a / whoami\n  cd ".."                  change this session directory\n  printf "a\\nb\\n" | wc -l   real C pipeline\n  printf "hello\\n" > demo.txt   overwrite a file\n  printf "more\\n" >> demo.txt   append to a file\n  cat < demo.txt               redirect input\n\nRun one pipeline at a time (up to 8 stages / 64 arguments each).\nNo &&, ;, background &, glob/variable expansion, or interactive stdin.\nQuoted operators stay literal. Programs run with your user permissions.\nStop cancels the entire process group. Limit: 12s / 256 KiB.\n\nCLASSIC v1\nDirect arguments only, project-directory cwd, 5-second timeout.\n\nBROWSER\nhelp / clear · Up/Down: command history · Ctrl/Cmd+K: clear output\nAlt+1..5: switch labs · History: search, rerun and export',
            status: 0, durationMs: 0, processLog: [],
        }, true);
        input.value = "";
        return;
    }
    const commandMode = options.mode || mode.value;
    const commandCwd = commandMode === "classic" ? baseCwd : (options.cwd || cwd);
    const ui = createEntry(command);
    let result = null;
    busy = true;
    activeJob = null;
    runButton.disabled = true;
    input.disabled = true;
    mode.disabled = true;
    input.value = "";
    $("#execution-state").textContent = "Starting";
    $("#parent-pid").textContent = "Waiting for parent PID";
    $("#child-nodes").replaceChildren(make("p", "panel-footnote", "Waiting for child processes..."));
    $("#duration").textContent = "—";
    $("#process-note").textContent = "Starting a real command; process details appear when observed.";
    try {
        if (commandMode === "classic") {
            result = await request("/api/execute", { command });
            result = { ...result, state: "completed", cwd: baseCwd, processLog: result.processLog || [] };
        } else {
            result = await request("/api/v2/jobs", { command, cwd: commandCwd });
            activeJob = result.id;
            stopButton.disabled = result.status !== null;
            const started = Date.now();
            while (result.status === null) {
                updateEntry(ui, result, false);
                updateExplorer(result);
                await new Promise((resolve) => setTimeout(resolve, 180));
                result = await request(`/api/v2/jobs/${activeJob}`);
                if (Date.now() - started > 20000) throw new Error("Execution status could not be confirmed within 20 seconds. The server applies its own 12-second limit.");
            }
            cwd = result.cwd;
        }
        updateEntry(ui, result, true);
        updateExplorer(result);
        displayCwd();
        connection(true);
    } catch (error) {
        ui.entry.classList.remove("running");
        ui.entry.classList.add("error");
        const uncertain = activeJob !== null || error instanceof TypeError || error instanceof SyntaxError;
        ui.status.textContent = uncertain ? "status unknown" : "request error";
        ui.pre.textContent = error.message;
        ui.notice.textContent = uncertain ? "Could not confirm completion. Server-side limits still apply." : "The request was not completed; no successful execution is being reported.";
        $("#execution-state").textContent = uncertain ? "Unknown" : "Not started";
        $("#process-note").textContent = uncertain ? "The server's execution status could not be confirmed." : `Request rejected: ${error.message}`;
        if (!activeJob) $("#duration").textContent = "Not confirmed";
        if (error instanceof TypeError) connection(false);
        result = { status: null, durationMs: 0, state: uncertain ? "unknown" : "rejected" };
    } finally {
        commandHistory.push({
            command, cwd: commandCwd, mode: commandMode, status: result.status,
            durationMs: result.durationMs, state: result.state, createdAt: new Date().toISOString(),
        });
        commandHistory = commandHistory.slice(-100);
        historyPosition = commandHistory.length;
        saveHistory();
        busy = false;
        activeJob = null;
        runButton.disabled = false;
        input.disabled = false;
        mode.disabled = false;
        stopButton.disabled = true;
        input.focus();
    }
}

function renderHistory() {
    const filter = $("#history-search").value.toLowerCase();
    $("#history-count").textContent = commandHistory.length;
    const body = $("#history-table");
    body.replaceChildren();
    [...commandHistory].reverse().filter((item) => `${item.command} ${item.cwd}`.toLowerCase().includes(filter)).forEach((item) => {
        const row = make("tr");
        const command = make("td", "history-command");
        command.append(make("code", "", item.command), make("small", "", `${item.cwd} · ${item.mode === "mini" ? "v2" : "v1"}`));
        const status = make("td");
        status.append(make("span", `history-result${item.status === 0 ? "" : " failed"}`, item.status === null
            ? (item.state === "unknown" ? "Unknown" : "Not started") : (item.status === 0 ? "Success" : `${item.state || "exit"} · ${item.status}`)));
        const action = make("td");
        const rerun = make("button", "text-link", "Rerun ↗");
        rerun.type = "button";
        rerun.addEventListener("click", () => {
            if (busy) { notify("Wait for the current command or stop it before rerunning history."); return; }
            mode.value = item.mode;
            displayCwd();
            showView("terminal");
            executeCommand(item.command, { cwd: item.cwd, mode: item.mode });
        });
        action.append(rerun);
        row.append(command, status, make("td", "", `${item.durationMs} ms`), make("td", "", new Date(item.createdAt).toLocaleString()), action);
        body.append(row);
    });
    if (!body.children.length) {
        const row = make("tr");
        const cell = make("td", "empty-state", filter ? "No executions match your search." : "Your next experiment starts the story. Run a command to begin.");
        cell.colSpan = 5;
        row.append(cell);
        body.append(row);
    }
}

async function refreshMonitor() {
    if (monitorLoading) return;
    monitorLoading = true;
    $("#monitor-refresh").disabled = true;
    try {
        const snapshot = await request("/api/v2/processes");
        monitorProcesses = snapshot.processes;
        $("#monitor-total").textContent = snapshot.total;
        $("#monitor-running").textContent = snapshot.running;
        $("#monitor-updated").textContent = `Sampled ${new Date(snapshot.sampledAt * 1000).toLocaleTimeString()}`;
        $("#monitor-note").textContent = `Showing top ${snapshot.processes.length} of ${snapshot.total} processes, ordered by CPU use. CPU can exceed 100% on multicore machines. Names only; no command arguments or kill controls.`;
        renderProcesses();
        connection(true);
    } catch (error) {
        monitorProcesses = [];
        renderProcesses();
        $("#monitor-total").textContent = "—";
        $("#monitor-running").textContent = "—";
        $("#monitor-updated").textContent = "Snapshot unavailable";
        $("#monitor-note").textContent = `Could not read the process list: ${error.message}`;
        if (error instanceof TypeError) connection(false);
    } finally {
        monitorLoading = false;
        $("#monitor-refresh").disabled = false;
    }
}

function renderProcesses() {
    const filter = $("#process-search").value.toLowerCase();
    const body = $("#process-table");
    body.replaceChildren();
    monitorProcesses.filter((process) => `${process.command} ${process.pid} ${process.ppid}`.toLowerCase().includes(filter)).forEach((process) => {
        const row = make("tr");
        const name = make("td");
        name.append(make("code", "", process.command));
        row.append(name, make("td", "", process.pid), make("td", "", process.ppid));
        for (const [value, memory] of [[process.cpu, false], [process.memory, true]]) {
            const cell = make("td");
            const wrapper = make("div", "resource-cell", value.toFixed(1));
            const bar = make("span", `resource-bar${memory ? " memory" : ""}`);
            bar.style.setProperty("--width", `${Math.min(60, value * (memory ? 6 : 0.6))}px`);
            wrapper.append(bar);
            cell.append(wrapper);
            row.append(cell);
        }
        const state = make("td");
        state.append(make("span", "state-badge", process.state));
        row.append(state);
        body.append(row);
    });
    if (!body.children.length) {
        const row = make("tr");
        const cell = make("td", "empty-state", monitorProcesses.length ? "No processes match your search." : "No snapshot available.");
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
    }
}

const experiments = [
    { title: "Meet your machine", tag: "FOUNDATIONS", command: "uname -s", description: "Run a real executable and identify the operating system hosting your lab.", expected: "Expect Darwin on macOS, or Linux. Inspect the parent and child PIDs." },
    { title: "Find the family tree", tag: "PROCESSES", command: "ps -p 1 -o pid,ppid,stat,comm", description: "Look at the system's first process and its parent relationship.", expected: "Read PID, parent PID, state and program name from a real process snapshot." },
    { title: "Build a data pipeline", tag: "IPC / PIPES", command: 'printf "apple\\nbanana\\napple\\n" | sort | uniq -c', description: "Three commands, three children. The C program connects their stdin and stdout with pipe() and dup2().", expected: "Expect two apples and one banana; inspect all three child PIDs." },
    { title: "Make the output stick", tag: "FILE DESCRIPTORS", command: 'printf "Hello from ForkLab\\n" >> forklab_demo.txt', description: "Append output to forklab_demo.txt in the current directory. This experiment writes a local file.", expected: "No printed output is normal. Then run cat forklab_demo.txt to read the appended text." },
    { title: "Fail, on purpose", tag: "EXIT STATUS", command: "forklab_command_not_found", description: "See what happens when execvp() cannot find a program. Failure is part of the lesson.", expected: "Expect exit 127 and a command-failed trace, not a successful execution." },
    { title: "Take back control", tag: "SIGNALS", command: "sleep 10", description: "Start a long-running command. Press Stop to cancel the complete process group, not only its parent.", expected: "After Stop, expect a cancellation notice and a signal-derived exit status." },
];
experiments.forEach((experiment, index) => {
    const card = make("article", "experiment-card");
    const number = make("div", "experiment-number", `0${index + 1}`);
    number.append(make("span", "", experiment.tag));
    const button = make("button", "text-link", "Run experiment ↗");
    button.type = "button";
    button.addEventListener("click", () => {
        if (busy) { notify("Stop or finish the current command before starting an experiment."); return; }
        mode.value = "mini";
        displayCwd();
        showView("terminal");
        executeCommand(experiment.command);
    });
    card.append(number, make("h3", "", experiment.title), make("p", "", experiment.description),
        make("p", "experiment-expect", experiment.expected), make("code", "", experiment.command), button);
    $("#experiment-grid").append(card);
});

const concepts = {
    fork: ["CREATES", "One process becomes two.", "The child gets a new PID and a separate address space. fork() returns zero in the child and the child's PID in the parent.", "pid_t pid = fork();\nif (pid == 0) {\n    // Child path\n} else if (pid > 0) {\n    // Parent path\n}"],
    exec: ["REPLACES", "Same PID. New program.", "execvp() replaces the child's program image. A successful exec does not return. If loading fails, our child reports the error and exits with status 127.", 'execvp(args[0], args);\n\n// Only reached on failure\nperror("[Child] Command failed");\n_exit(127);'],
    wait: ["COLLECTS", "Finish the job properly.", "The C parent waits for every child. Collecting its termination status releases the child's process-table entry and prevents an unreaped zombie.", "int status;\nwaitpid(child_pid, &status, 0);\nif (WIFEXITED(status)) {\n    return WEXITSTATUS(status);\n}"],
    pipe: ["CONNECTS", "Your output. Their input.", "pipe() creates read and write file descriptors. dup2() connects adjacent children. Every unused pipe end must be closed, otherwise a reader can wait forever for EOF.", "int channel[2];\npipe(channel);\n\n// In the writer child\ndup2(channel[1], STDOUT_FILENO);\n// In the reader child\ndup2(channel[0], STDIN_FILENO);"],
};
function selectConcept(name) {
    const [label, title, explanation, code] = concepts[name];
    $("#concept-label").textContent = `${label} / ILLUSTRATIVE C EXCERPT`;
    $("#concept-title").textContent = title;
    $("#concept-text").textContent = explanation;
    $("#concept-code").textContent = code;
    document.querySelectorAll("[data-concept]").forEach((button) => {
        const selected = button.dataset.concept === name;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
}

function invalidateSchedule() {
    pauseReplay();
    lastSchedule = null;
    $("#scheduler-results").hidden = true;
    $("#scheduler-error").hidden = true;
}

function addProcess(values) {
    if ($("#workload-rows").children.length >= 12) {
        notify("The scheduling lab supports a maximum of 12 processes.");
        return;
    }
    const number = nextProcess++;
    const row = make("tr");
    for (const [field, value] of Object.entries(values || { id: `P${number}`, arrival: 0, burst: 3 })) {
        const cell = make("td");
        const control = make("input");
        control.dataset.field = field;
        control.type = field === "id" ? "text" : "number";
        control.value = value;
        control.required = true;
        control.setAttribute("aria-label", `Process row ${number} ${field}`);
        if (field === "id") control.maxLength = 16;
        else { control.min = field === "arrival" ? "0" : "1"; control.max = "100"; control.step = "1"; }
        cell.append(control);
        row.append(cell);
    }
    const cell = make("td");
    const remove = make("button", "remove-process", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove process row ${number}`);
    remove.addEventListener("click", () => {
        if ($("#workload-rows").children.length === 1) {
            notify("Keep at least one process in the workload.");
            return;
        }
        row.remove();
        invalidateSchedule();
    });
    cell.append(remove);
    row.append(cell);
    $("#workload-rows").append(row);
}

function sampleWorkload() {
    invalidateSchedule();
    $("#workload-rows").replaceChildren();
    nextProcess = 1;
    [{ id: "P1", arrival: 0, burst: 5 }, { id: "P2", arrival: 1, burst: 3 }, { id: "P3", arrival: 2, burst: 1 }]
        .forEach(addProcess);
}

const colors = ["#8060c9", "#2d967d", "#bc8051", "#477fbe", "#af5f8e", "#6f8e3f", "#815bb0", "#3b8c99", "#b46564", "#657fc0", "#9e873e", "#6e9a80"];
function pauseReplay() {
    if (replayTimer !== null) clearInterval(replayTimer);
    replayTimer = null;
    $("#schedule-replay").textContent = lastSchedule && replayTime < lastSchedule.totalTime ? "Resume" : "Replay";
}

function updateReplay() {
    if (!lastSchedule) return;
    $("#playback-time").textContent = `t = ${replayTime} / ${lastSchedule.totalTime}`;
    [...$("#gantt-chart").children].forEach((node, index) => {
        const segment = lastSchedule.segments[index];
        node.classList.toggle("future", segment.start > replayTime);
        node.classList.toggle("current", segment.start <= replayTime && segment.end > replayTime);
    });
}

function renderSchedule(result, workload, quantum) {
    lastSchedule = result;
    $("#scheduler-results").hidden = false;
    $("#scheduler-error").hidden = true;
    $("#schedule-wait").textContent = result.averageWaiting.toFixed(2);
    $("#schedule-turnaround").textContent = result.averageTurnaround.toFixed(2);
    $("#schedule-response").textContent = result.averageResponse.toFixed(2);
    $("#schedule-utilization").textContent = `${result.utilization.toFixed(1)}%`;
    $("#schedule-summary").textContent = `${result.processes.length} processes · ${result.totalTime} total time units · ${result.segments.length} execution/idle intervals · ${result.algorithm === "rr" ? `Round Robin, quantum ${quantum}` : result.algorithm === "sjf" ? "Non-preemptive SJF" : "Non-preemptive FCFS"}. Hover a slice for exact boundaries.`;
    const chart = $("#gantt-chart");
    chart.replaceChildren();
    result.segments.forEach((segment) => {
        const node = make("div", `gantt-segment${segment.id === "IDLE" ? " idle" : ""}`, segment.id);
        node.style.width = `${100 * (segment.end - segment.start) / result.totalTime}%`;
        node.style.flexShrink = "0";
        if (segment.id !== "IDLE") {
            node.style.backgroundColor = colors[result.processes.findIndex((p) => p.id === segment.id) % colors.length];
        }
        node.append(make("small", "", `${segment.start}–${segment.end}`));
        node.title = `${segment.id}: ${segment.start} to ${segment.end}`;
        node.setAttribute("aria-label", node.title);
        chart.append(node);
    });
    const axis = $("#gantt-axis");
    axis.replaceChildren();
    for (let i = 0; i <= 5; i++) axis.append(make("span", "", (result.totalTime * i / 5).toFixed(1)));
    const metrics = $("#schedule-metrics");
    metrics.replaceChildren();
    result.processes.forEach((process) => {
        const row = make("tr");
        ["id", "arrival", "burst", "completion", "turnaround", "waiting", "response"].forEach((key) => row.append(make("td", "", process[key])));
        metrics.append(row);
    });
    const comparisons = $("#schedule-comparison");
    comparisons.replaceChildren();
    for (const [algorithm, label] of [["fcfs", "FCFS"], ["sjf", "SJF (non-preemptive)"], ["rr", `Round Robin (q = ${quantum})`]]) {
        const comparison = window.ForkLabScheduler.schedule(workload, algorithm, quantum);
        const row = make("tr", result.algorithm === algorithm ? "comparison-selected" : "");
        row.append(make("td", "", label), make("td", "", comparison.averageWaiting.toFixed(2)),
            make("td", "", comparison.averageTurnaround.toFixed(2)), make("td", "", comparison.averageResponse.toFixed(2)));
        comparisons.append(row);
    }
    replayTime = result.totalTime;
    updateReplay();
    $("#schedule-replay").textContent = "Replay";
}

$("#command-form").addEventListener("submit", (event) => { event.preventDefault(); executeCommand(input.value); });
$("#clear-button").addEventListener("click", () => { output.replaceChildren(); input.focus(); });
mode.addEventListener("change", displayCwd);
stopButton.addEventListener("click", async () => {
    if (!activeJob) return;
    stopButton.disabled = true;
    try {
        await request(`/api/v2/jobs/${activeJob}/cancel`, {});
    } catch (error) {
        notify(`Could not stop the command: ${error.message}`);
        if (busy && activeJob) stopButton.disabled = false;
    }
});
$("#copy-cwd").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(mode.value === "classic" ? baseCwd : cwd);
        $("#copy-cwd").textContent = "Copied";
        setTimeout(() => { $("#copy-cwd").textContent = "Copy path"; }, 1500);
    } catch (error) {
        notify(`Could not copy the path: ${error.message}. Select the path in the history table instead.`);
    }
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", () => {
    if (busy) { notify("A command is already running. Stop it or wait for completion."); return; }
    executeCommand(button.dataset.command);
}));
document.querySelectorAll("[data-concept]").forEach((button) => button.addEventListener("click", () => selectConcept(button.dataset.concept)));
input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
        event.preventDefault();
        historyPosition = Math.max(0, historyPosition - 1);
        input.value = commandHistory[historyPosition]?.command || "";
    } else if (event.key === "ArrowDown") {
        event.preventDefault();
        historyPosition = Math.min(commandHistory.length, historyPosition + 1);
        input.value = commandHistory[historyPosition]?.command || "";
    }
});
document.addEventListener("keydown", (event) => {
    if (event.altKey && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        showView(["terminal", "monitor", "scheduler", "experiments", "history"][Number(event.key) - 1]);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && currentView === "terminal") {
        event.preventDefault();
        output.replaceChildren();
        input.focus();
    }
});
$("#process-search").addEventListener("input", renderProcesses);
$("#monitor-refresh").addEventListener("click", refreshMonitor);
$("#monitor-pause").addEventListener("click", () => {
    monitorPaused = !monitorPaused;
    $("#monitor-pause").textContent = monitorPaused ? "Resume updates" : "Pause updates";
    if (!monitorPaused) refreshMonitor();
});
setInterval(() => {
    if (currentView === "monitor" && !monitorPaused && !document.hidden) refreshMonitor();
}, 3000);
$("#history-search").addEventListener("input", renderHistory);
$("#clear-history").addEventListener("click", () => {
    if (!window.confirm("Clear the saved execution history in this browser? This cannot be undone.")) return;
    commandHistory = [];
    historyPosition = 0;
    saveHistory();
});
$("#export-history").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(commandHistory, null, 2)], { type: "application/json" });
    const link = make("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `forklab-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#scheduler-algorithm").addEventListener("change", () => {
    const algorithm = $("#scheduler-algorithm").value;
    $("#algorithm-description").textContent = {
        fcfs: "FCFS runs in arrival order, without preemption.",
        sjf: "Non-preemptive SJF chooses the shortest ready job at each dispatch.",
        rr: "Round Robin shares the CPU in fixed time slices; arrivals queue before the current job is requeued.",
    }[algorithm];
    invalidateSchedule();
});
$("#scheduler-form").addEventListener("input", invalidateSchedule);
$("#add-process").addEventListener("click", () => { addProcess(); invalidateSchedule(); });
$("#scheduler-sample").addEventListener("click", sampleWorkload);
$("#scheduler-form").addEventListener("submit", (event) => {
    event.preventDefault();
    pauseReplay();
    try {
        const workload = [...$("#workload-rows").children].map((row) => ({
            id: row.querySelector('[data-field="id"]').value,
            arrival: Number(row.querySelector('[data-field="arrival"]').value),
            burst: Number(row.querySelector('[data-field="burst"]').value),
        }));
        const quantum = Number($("#scheduler-quantum").value);
        const result = window.ForkLabScheduler.schedule(workload, $("#scheduler-algorithm").value, quantum);
        renderSchedule(result, workload, quantum);
    } catch (error) {
        $("#scheduler-error").textContent = error.message;
        $("#scheduler-error").hidden = false;
        $("#scheduler-results").hidden = true;
    }
});
$("#schedule-replay").addEventListener("click", () => {
    if (!lastSchedule) return;
    if (replayTimer !== null) { pauseReplay(); return; }
    if (replayTime >= lastSchedule.totalTime) replayTime = 0;
    $("#schedule-replay").textContent = "Pause";
    updateReplay();
    replayTimer = setInterval(() => {
        replayTime = Math.min(lastSchedule.totalTime, replayTime + Math.max(1, Math.ceil(lastSchedule.totalTime / 80)));
        updateReplay();
        if (replayTime >= lastSchedule.totalTime) pauseReplay();
    }, 160);
});

sampleWorkload();
selectConcept("fork");
renderHistory();
renderStats();
runButton.disabled = true;
request("/api/v2/info").then((info) => {
    cwd = baseCwd = info.cwd;
    $("#platform-label").textContent = `${info.platform} / Local environment`;
    $("#stat-cores").textContent = info.cpuCount ?? "—";
    $("#stat-platform").textContent = `${info.platform} · POSIX compatible`;
    displayCwd();
    connection(true);
    runButton.disabled = false;
}).catch((error) => {
    connection(false);
    $("#cwd-label").textContent = "Server unavailable";
    $("#platform-label").textContent = "Connection required";
    notify(`Could not initialize ForkLab: ${error.message}. Start the server with make web, then reload this page.`);
});
