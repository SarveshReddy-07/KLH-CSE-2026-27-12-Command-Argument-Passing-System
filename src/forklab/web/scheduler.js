(function (root) {
    "use strict";

    function schedule(input, algorithm = "fcfs", quantum = 2) {
        if (!Array.isArray(input) || input.length < 1 || input.length > 12) {
            throw new Error("Provide between 1 and 12 processes.");
        }
        if (!["fcfs", "sjf", "rr"].includes(algorithm)) {
            throw new Error("Choose FCFS, SJF or Round Robin.");
        }
        if (!Number.isInteger(quantum) || quantum < 1 || quantum > 100) {
            throw new Error("The time quantum must be an integer from 1 to 100.");
        }
        const ids = new Set();
        const processes = input.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error("Each process must provide an arrival time and burst length.");
            }
            const id = item.id === undefined ? `P${index + 1}` : String(item.id).trim();
            if (!id || id.length > 16 || id === "IDLE" || ids.has(id)) {
                throw new Error("Use unique process names of 1–16 characters, other than IDLE.");
            }
            if (!Number.isInteger(item.arrival) || item.arrival < 0 || item.arrival > 100) {
                throw new Error(`${id}: arrival must be an integer from 0 to 100.`);
            }
            if (!Number.isInteger(item.burst) || item.burst < 1 || item.burst > 100) {
                throw new Error(`${id}: burst must be an integer from 1 to 100.`);
            }
            ids.add(id);
            return { id, arrival: item.arrival, burst: item.burst, remaining: item.burst, index, first: null };
        });
        const ordered = [...processes].sort((a, b) => a.arrival - b.arrival || a.index - b.index);
        const segments = [];
        let time = 0;
        let completed = 0;
        let next = 0;
        const queue = [];
        const arrivals = () => {
            while (next < ordered.length && ordered[next].arrival <= time) {
                queue.push(ordered[next++]);
            }
        };
        while (completed < processes.length) {
            let process;
            if (algorithm === "rr") {
                arrivals();
                process = queue.shift();
            } else {
                const ready = processes.filter((p) => p.remaining > 0 && p.arrival <= time);
                ready.sort((a, b) => (algorithm === "sjf" ? a.burst - b.burst : 0)
                    || a.arrival - b.arrival || a.index - b.index);
                process = ready[0];
            }
            if (!process) {
                const upcoming = Math.min(...processes.filter((p) => p.remaining > 0).map((p) => p.arrival));
                segments.push({ id: "IDLE", start: time, end: upcoming });
                time = upcoming;
                continue;
            }
            if (process.first === null) process.first = time;
            const duration = algorithm === "rr" ? Math.min(quantum, process.remaining) : process.remaining;
            segments.push({ id: process.id, start: time, end: time + duration });
            time += duration;
            process.remaining -= duration;
            if (algorithm === "rr") arrivals();
            if (process.remaining === 0) {
                process.completion = time;
                completed += 1;
            } else if (algorithm === "rr") {
                queue.push(process);
            }
        }
        const metrics = processes.map((p) => ({
            id: p.id, arrival: p.arrival, burst: p.burst, completion: p.completion,
            turnaround: p.completion - p.arrival,
            waiting: p.completion - p.arrival - p.burst,
            response: p.first - p.arrival,
        }));
        const average = (key) => metrics.reduce((sum, p) => sum + p[key], 0) / metrics.length;
        return {
            algorithm, quantum, segments, processes: metrics, totalTime: time,
            averageWaiting: average("waiting"), averageTurnaround: average("turnaround"),
            averageResponse: average("response"),
            utilization: 100 * processes.reduce((sum, p) => sum + p.burst, 0) / time,
        };
    }

    if (typeof module !== "undefined" && module.exports) module.exports = { schedule };
    else root.ForkLabScheduler = { schedule };
})(typeof globalThis !== "undefined" ? globalThis : this);
