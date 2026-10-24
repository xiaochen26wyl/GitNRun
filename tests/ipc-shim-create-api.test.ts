import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUSH } from "@shared/ipc";
import { IPC } from "@shared/ipc";
import { IPC_COMMAND, PUSH_EVENT, createGitNRunApi, toError, trimTrailingUndefined, unwrapEnvelope, type ShimTransport } from "../src/renderer/ipc/create-api";

interface Fake {
  transport: ShimTransport;
  invokes: Array<{ command: string; args: Record<string, unknown> }>;
  listens: string[];
  stopped: number;
  emit(payload: unknown): void;
}

const fake = (reply: (args: Record<string, unknown>) => unknown = () => ({})): Fake => {
  let handler: ((payload: unknown) => void) | null = null;
  const state: Fake = {
    invokes: [],
    listens: [],
    stopped: 0,
    emit: (payload) => handler?.(payload),
    transport: {
      invoke: async (command, args) => {
        state.invokes.push({ command, args });
        const result = reply(args);
        if (result instanceof Error) throw result;
        if (result && typeof result === "object" && "__reject" in result) throw (result as { __reject: unknown }).__reject;
        return result;
      },
      listen: async (event, next) => {
        state.listens.push(event);
        handler = next;
        return () => void (state.stopped += 1);
      }
    }
  };
  return state;
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("tauri shim api", () => {
  it("calls the single command with the channel and positional arguments", async () => {
    const host = fake(() => ({ value: { id: 1 } }));
    const { api } = createGitNRunApi(host.transport);
    assert.deepEqual(await api.updateProject(7, { name: "x" } as never), { id: 1 });
    assert.deepEqual(host.invokes[0], { command: IPC_COMMAND, args: { channel: IPC.projectsUpdate, args: [7, { name: "x" }] } });
  });

  it("drops trailing undefined arguments so the validator sees the right count", async () => {
    const host = fake();
    const { api } = createGitNRunApi(host.transport);
    await api.listRuleExecutions(undefined);
    await api.predictConflicts(3, undefined);
    await api.getGitLiteOverview(undefined);
    assert.deepEqual(
      host.invokes.map((call) => call.args.args),
      [[], [3], []]
    );
    assert.deepEqual(trimTrailingUndefined([1, undefined, 2, undefined, undefined]), [1, undefined, 2]);
  });

  it("unwraps the envelope: null stays null, a missing value is undefined", async () => {
    assert.equal(unwrapEnvelope({ value: null }), null);
    assert.equal(unwrapEnvelope({}), undefined);
    assert.equal(unwrapEnvelope(null), undefined);
    const { api } = createGitNRunApi(fake(() => ({})).transport);
    assert.equal(await api.deleteSecret("x"), undefined);
  });

  it("rejects with an Error instance that keeps the name", async () => {
    const { api } = createGitNRunApi(fake(() => ({ __reject: { name: "InvalidIpcInputError", message: "bad input" } })).transport);
    await assert.rejects(api.deleteSecret("x"), (error: unknown) => error instanceof Error && error.name === "InvalidIpcInputError" && error.message === "bad input");

    assert.equal(toError("plain").message, "plain");
    assert.equal(toError(42).message, "unknown error");
    const original = new TypeError("t");
    assert.equal(toError(original), original);
  });

  it("registers one global listener, dispatches by channel, and unsubscribes synchronously", async () => {
    const host = fake();
    const { api } = createGitNRunApi(host.transport);
    await tick();
    assert.deepEqual(host.listens, [PUSH_EVENT]);

    const monitor: unknown[] = [];
    const output: unknown[] = [];
    const stop = api.onMonitorChanged((change) => monitor.push(change));
    api.onCommandOutput((events) => output.push(events));

    host.emit({ channel: PUSH.monitorChanged, payload: { n: 1 } });
    host.emit({ channel: PUSH.commandOutput, payload: [1] });
    stop();
    host.emit({ channel: PUSH.monitorChanged, payload: { n: 2 } });
    host.emit("garbage");

    assert.deepEqual(monitor, [{ n: 1 }]);
    assert.deepEqual(output, [[1]]);
    assert.equal(host.listens.length, 1);
  });

  it("survives StrictMode's mount, unmount, mount without losing events", async () => {
    const host = fake();
    const { api } = createGitNRunApi(host.transport);
    await tick();

    const seen: unknown[] = [];
    const first = api.onMonitorChanged((change) => seen.push(["first", change]));
    first();
    api.onMonitorChanged((change) => seen.push(["second", change]));
    host.emit({ channel: PUSH.monitorChanged, payload: 1 });

    assert.deepEqual(seen, [["second", 1]]);
    assert.equal(host.listens.length, 1);
  });

  it("keeps dispatching when one handler throws, and releases the listener on dispose", async () => {
    const host = fake();
    const shim = createGitNRunApi(host.transport);
    await tick();
    const seen: number[] = [];
    shim.api.onMonitorChanged(() => {
      throw new Error("boom");
    });
    shim.api.onMonitorChanged(() => seen.push(1));
    const original = console.error;
    console.error = () => undefined;
    try {
      host.emit({ channel: PUSH.monitorChanged, payload: 0 });
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, [1]);

    shim.dispose();
    assert.equal(host.stopped, 1);
  });

  it("returns an empty path for dropped files", () => {
    const { api } = createGitNRunApi(fake().transport);
    assert.equal(api.pathForFile({} as File), "");
  });
});
