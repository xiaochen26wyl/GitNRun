import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LIVE_LINES_PER_RUN, applyOutputEvents, type CommandOutputEvent } from "@shared/command-output";
import { createOutputHub } from "@main/exec/output-hub";
import { createValueRedactor, redactSecrets } from "@main/log-redaction";

const SECRET_VALUE = "very-secret-value-12345";

const setup = () => {
  const batches: CommandOutputEvent[][] = [];
  const timers: Array<() => void> = [];
  let ids = 0;
  const hub = createOutputHub({
    emit: (events) => batches.push(events),
    now: () => 1000,
    newId: () => `run-${(ids += 1)}`,
    schedule: (fn) => void timers.push(fn)
  });
  const flush = () => timers.splice(0).forEach((fn) => fn());
  const lines = () => batches.flat().flatMap((event) => (event.kind === "line" ? [`${event.stream}:${event.text}`] : []));
  const redact = (text: string) => redactSecrets(createValueRedactor([SECRET_VALUE])(text));
  return { hub, flush, lines, batches, timers, redact };
};

describe("output hub", () => {
  it("emits start, whole lines and end — batched, not one message per chunk", () => {
    const t = setup();
    const run = t.hub.begin("deploy", t.redact);
    run.write("stdout", "hel");
    run.write("stdout", "lo\nwor");
    run.write("stdout", "ld\n");
    run.end("success");

    assert.equal(t.timers.length, 1, "a single flush is scheduled for the whole burst");
    t.flush();

    assert.equal(t.batches.length, 1);
    assert.deepEqual(t.batches[0]?.map((event) => event.kind), ["start", "line", "line", "end"]);
    assert.deepEqual(t.lines(), ["stdout:hello", "stdout:world"]);
  });

  it("flushes an unterminated last line when the run ends", () => {
    const t = setup();
    const run = t.hub.begin("x", t.redact);
    run.write("stdout", "no newline at end");
    run.write("stderr", "also none");
    run.end("failed");
    t.flush();
    assert.deepEqual(t.lines(), ["stdout:no newline at end", "stderr:also none"]);
    assert.equal((t.batches[0]?.at(-1) as { status: string }).status, "failed");
  });

  it("redacts per whole line, so a secret split across two chunks cannot slip through", () => {
    const t = setup();
    const run = t.hub.begin("x", t.redact);
    run.write("stdout", `token=${SECRET_VALUE.slice(0, 10)}`);
    run.write("stdout", `${SECRET_VALUE.slice(10)} and ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
    run.end("success");
    t.flush();

    const text = t.lines().join("\n");
    assert.ok(!text.includes(SECRET_VALUE));
    assert.ok(!text.includes("a1B2c3D4"));
    assert.ok(text.includes("[redacted]"));
  });

  it("normalises Windows line endings and keeps stdout and stderr separate", () => {
    const t = setup();
    const run = t.hub.begin("x", t.redact);
    run.write("stdout", "a\r\nb\r\n");
    run.write("stderr", "e");
    run.write("stdout", "c\n");
    run.end("success");
    t.flush();
    assert.deepEqual(t.lines(), ["stdout:a", "stdout:b", "stdout:c", "stderr:e"]);
  });

  it("sends a very long line without a newline instead of buffering forever", () => {
    const t = setup();
    const run = t.hub.begin("x", t.redact);
    run.write("stdout", "y".repeat(9_000));
    t.flush();
    assert.equal(t.lines().length, 1);
  });

  it("stops pushing lines after the limit and says output was omitted, once", () => {
    const t = setup();
    const run = t.hub.begin("x", t.redact);
    for (let i = 0; i < MAX_LIVE_LINES_PER_RUN + 500; i += 1) {
      run.write("stdout", `line ${i}\n`);
    }
    run.end("success");
    t.flush();

    const lines = t.lines();
    assert.equal(lines.filter((line) => line.startsWith("stdout:")).length, MAX_LIVE_LINES_PER_RUN);
    assert.equal(lines.filter((line) => line.startsWith("system:")).length, 1);
  });

  it("ignores writes after the run ended, and keeps runs separate", () => {
    const t = setup();
    const first = t.hub.begin("a", t.redact);
    const second = t.hub.begin("b", t.redact);
    first.write("stdout", "from a\n");
    first.end("success");
    first.write("stdout", "late\n");
    second.write("stdout", "from b\n");
    second.note("retrying");
    second.end("timeout");
    t.flush();

    assert.notEqual(first.runId, second.runId);
    assert.ok(!t.lines().includes("stdout:late"));
    const byRun = new Map<string, string[]>();
    for (const event of t.batches.flat()) {
      if (event.kind === "line") byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event.text]);
    }
    assert.deepEqual(byRun.get(first.runId), ["from a"]);
    assert.deepEqual(byRun.get(second.runId), ["from b", "retrying"]);
  });
});

describe("applyOutputEvents (what the screen shows)", () => {
  const start = (runId: string, label = runId): CommandOutputEvent => ({ kind: "start", runId, label, at: 0 });
  const line = (runId: string, text: string, stream: "stdout" | "stderr" | "system" = "stdout"): CommandOutputEvent => ({ kind: "line", runId, stream, text, at: 0 });
  const end = (runId: string, status: "success" | "failed" | "timeout"): CommandOutputEvent => ({ kind: "end", runId, status, at: 0 });

  it("builds a run from start, lines and end", () => {
    const runs = applyOutputEvents([], [start("a", "make"), line("a", "one"), line("a", "two", "stderr"), end("a", "failed")]);
    assert.deepEqual(runs, [
      { runId: "a", label: "make", status: "failed", lines: [{ stream: "stdout", text: "one" }, { stream: "stderr", text: "two" }] }
    ]);
  });

  it("keeps only the latest few runs and the latest lines of each", () => {
    let runs = applyOutputEvents([], Array.from({ length: 8 }, (_, i) => start(`r${i}`)));
    assert.deepEqual(runs.map((run) => run.runId), ["r3", "r4", "r5", "r6", "r7"]);

    runs = applyOutputEvents(runs, Array.from({ length: 700 }, (_, i) => line("r7", `l${i}`)));
    const last = runs.at(-1);
    assert.equal(last?.lines.length, 500);
    assert.equal(last?.lines.at(-1)?.text, "l699");
  });

  it("ignores events for runs that are not shown, and does not mutate its input", () => {
    const before = applyOutputEvents([], [start("a")]);
    const frozen = JSON.stringify(before);
    const after = applyOutputEvents(before, [line("ghost", "x"), end("ghost", "success"), line("a", "y")]);
    assert.equal(JSON.stringify(before), frozen);
    assert.equal(after[0]?.lines.length, 1);
  });
});
