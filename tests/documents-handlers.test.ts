import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentHandlers } from "@main/documents/handlers";
import { UserFacingError } from "@main/errors";
import type { DocumentOpener } from "@shared/documents";
import { createTestDb } from "./helpers/db";

describe("document handlers", () => {
  it("saves, lists and removes local document shortcuts", () => {
    const db = createTestDb();
    let changed = 0;
    const handlers = createDocumentHandlers({
      db,
      inspect: async () => "file",
      open: async () => ({ ok: true }),
      now: () => 1234,
      onConfigChanged: () => void (changed += 1)
    });

    const saved = handlers.save({ label: "Spec", path: "/Users/me/spec.md", opener: "vscode" });
    assert.deepEqual(saved, { id: 1, label: "Spec", path: "/Users/me/spec.md", opener: "vscode", createdAt: 1234, updatedAt: 1234 });
    assert.deepEqual(handlers.list(), [saved]);
    assert.equal(changed, 1);

    handlers.remove(saved.id);
    assert.deepEqual(handlers.list(), []);
    assert.equal(changed, 2);
  });

  it("opens a saved shortcut with its selected opener", async () => {
    const db = createTestDb();
    const opened: Array<{ path: string; opener: DocumentOpener; kind: "dir" | "file" }> = [];
    const handlers = createDocumentHandlers({
      db,
      inspect: async () => "file",
      open: async (path, opener, kind) => {
        opened.push({ path, opener, kind });
        return { ok: true };
      },
      now: () => 1,
      onConfigChanged: () => undefined
    });

    const saved = handlers.save({ path: "/Users/me/readme.txt", opener: "textedit" });
    await handlers.open(saved.id);

    assert.deepEqual(opened, [{ path: "/Users/me/readme.txt", opener: "textedit", kind: "file" }]);
  });

  it("lists and opens auto-discovered project readmes without saving them", async () => {
    const db = createTestDb();
    const opened: Array<{ path: string; opener: DocumentOpener; kind: "dir" | "file" }> = [];
    const handlers = createDocumentHandlers({
      db,
      discoverReadmes: () => [
        { id: -1, label: "App · README.md", path: "/Users/me/app/README.md", opener: "default", source: "project-readme", createdAt: 0, updatedAt: 0 }
      ],
      inspect: async () => "file",
      open: async (path, opener, kind) => {
        opened.push({ path, opener, kind });
        return { ok: true };
      },
      now: () => 1,
      onConfigChanged: () => undefined
    });

    assert.deepEqual(handlers.list(), [
      { id: -1, label: "App · README.md", path: "/Users/me/app/README.md", opener: "default", source: "project-readme", createdAt: 0, updatedAt: 0 }
    ]);
    await handlers.open(-1);
    assert.deepEqual(opened, [{ path: "/Users/me/app/README.md", opener: "default", kind: "file" }]);
  });

  it("lets a saved shortcut override an auto-discovered readme at the same path", () => {
    const db = createTestDb();
    const handlers = createDocumentHandlers({
      db,
      discoverReadmes: () => [
        { id: -1, label: "App · README.md", path: "/Users/me/app/README.md", opener: "default", source: "project-readme", createdAt: 0, updatedAt: 0 }
      ],
      inspect: async () => "file",
      open: async () => ({ ok: true }),
      now: () => 1,
      onConfigChanged: () => undefined
    });

    const saved = handlers.save({ label: "Pinned README", path: "/Users/me/app/README.md", opener: "cursor" });

    assert.deepEqual(handlers.list(), [saved]);
  });

  it("rejects missing files and invalid paths", async () => {
    const db = createTestDb();
    const handlers = createDocumentHandlers({
      db,
      inspect: async () => "missing",
      open: async () => ({ ok: true }),
      now: () => 1,
      onConfigChanged: () => undefined
    });

    assert.throws(() => handlers.save({ path: "relative/file.md" }), UserFacingError);
    const saved = handlers.save({ path: "/Users/me/missing.md" });
    await assert.rejects(handlers.open(saved.id), UserFacingError);
  });
});
