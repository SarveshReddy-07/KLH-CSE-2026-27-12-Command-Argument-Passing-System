const { test } = require("node:test");
const assert = require("node:assert/strict");
const { schedule } = require("../web/scheduler.js");

const sample = [
    { id: "P1", arrival: 0, burst: 5 },
    { id: "P2", arrival: 1, burst: 3 },
    { id: "P3", arrival: 2, burst: 1 },
];

test("FCFS gives the exact expected timeline and metrics", () => {
    const result = schedule(sample, "fcfs");
    assert.deepEqual(result.segments, [
        { id: "P1", start: 0, end: 5 }, { id: "P2", start: 5, end: 8 }, { id: "P3", start: 8, end: 9 },
    ]);
    assert.deepEqual(result.processes.map((p) => p.waiting), [0, 4, 6]);
    assert.equal(result.averageWaiting, 10 / 3);
    assert.equal(result.utilization, 100);
});

test("SJF is non-preemptive and chooses shortest ready work", () => {
    const result = schedule(sample, "sjf");
    assert.deepEqual(result.segments.map((s) => s.id), ["P1", "P3", "P2"]);
    assert.deepEqual(result.processes.map((p) => p.waiting), [0, 5, 3]);
    assert.equal(result.averageWaiting, 8 / 3);
});

test("Round Robin queues arrivals before requeueing the running job", () => {
    const result = schedule(sample, "rr", 2);
    assert.deepEqual(result.segments, [
        { id: "P1", start: 0, end: 2 }, { id: "P2", start: 2, end: 4 },
        { id: "P3", start: 4, end: 5 }, { id: "P1", start: 5, end: 7 },
        { id: "P2", start: 7, end: 8 }, { id: "P1", start: 8, end: 9 },
    ]);
    assert.deepEqual(result.processes.map((p) => p.completion), [9, 8, 5]);
    assert.deepEqual(result.processes.map((p) => p.response), [0, 1, 2]);
    assert.deepEqual(result.processes.map((p) => p.waiting), [4, 4, 2]);
});

test("initial and intermediate idle time are modeled, not skipped", () => {
    for (const algorithm of ["fcfs", "sjf", "rr"]) {
        const result = schedule([{ arrival: 2, burst: 1 }, { arrival: 6, burst: 2 }], algorithm);
        assert.deepEqual(result.segments.filter((s) => s.id === "IDLE"), [
            { id: "IDLE", start: 0, end: 2 }, { id: "IDLE", start: 3, end: 6 },
        ]);
        assert.equal(result.utilization, 37.5);
        assert.deepEqual(result.processes.map((p) => p.waiting), [0, 0]);
    }
});

test("arrival and burst ties retain input order", () => {
    const workload = [{ id: "B", arrival: 0, burst: 1 }, { id: "A", arrival: 0, burst: 1 }];
    for (const algorithm of ["fcfs", "sjf", "rr"]) {
        assert.deepEqual(schedule(workload, algorithm).segments.map((s) => s.id), ["B", "A"]);
    }
});

test("validation rejects invalid and unbounded workloads", () => {
    const invalid = [
        [], [null], [[]], [{ arrival: -1, burst: 2 }], [{ arrival: 0.5, burst: 2 }],
        [{ arrival: 0, burst: 0 }], [{ arrival: 0, burst: Infinity }],
        [{ id: "", arrival: 0, burst: 1 }], [{ id: "IDLE", arrival: 0, burst: 1 }],
        [{ id: "A", arrival: 0, burst: 1 }, { id: "A", arrival: 1, burst: 1 }],
        Array.from({ length: 13 }, () => ({ arrival: 0, burst: 1 })),
    ];
    invalid.forEach((workload) => assert.throws(() => schedule(workload)));
    assert.throws(() => schedule(sample, "invalid"));
    for (const quantum of [0, -1, 0.5, NaN, 101]) assert.throws(() => schedule(sample, "rr", quantum));
});

test("timelines conserve CPU work and metrics across a deterministic workload set", () => {
    for (let seed = 0; seed < 20; seed++) {
        const workload = Array.from({ length: 5 }, (_, i) => ({
            id: `P${i}`, arrival: (seed * 3 + i * 7) % 15, burst: 1 + (seed + i * 3) % 10,
        }));
        const snapshot = JSON.stringify(workload);
        for (const algorithm of ["fcfs", "sjf", "rr"]) {
            const result = schedule(workload, algorithm, 1 + seed % 4);
            assert.equal(result.segments[0].start, 0);
            result.segments.forEach((segment, i) => {
                assert.ok(segment.end > segment.start);
                if (i) assert.equal(segment.start, result.segments[i - 1].end);
            });
            for (const process of result.processes) {
                const slices = result.segments.filter((s) => s.id === process.id);
                assert.equal(slices.reduce((sum, s) => sum + s.end - s.start, 0), process.burst);
                assert.ok(slices.every((s) => s.start >= process.arrival));
                assert.equal(process.completion, slices.at(-1).end);
                assert.equal(process.turnaround, process.completion - process.arrival);
                assert.equal(process.waiting, process.turnaround - process.burst);
                assert.equal(process.response, slices[0].start - process.arrival);
                assert.ok(process.waiting >= 0);
            }
        }
        assert.equal(JSON.stringify(workload), snapshot);
    }
});
