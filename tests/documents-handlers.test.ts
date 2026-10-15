import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DOCUMENT_ROOT_KEY, createDocumentHandlers } from "@main/documents/handlers";
import { discoverReadmes, findRepoFolders } from "@main/documents/runtime";
import { setSetting } from "@main/db/settings-repo";
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

  it("defaults to Cursor when a shortcut has no opener", () => {
    const db = createTestDb();
    const handlers = createDocumentHandlers({
      db,
      inspect: async () => "file",
      open: async () => ({ ok: true }),
      now: () => 1,
      onConfigChanged: () => undefined
    });

    assert.equal(handlers.save({ path: "/Users/me/spec.md" }).opener, "cursor");
    assert.equal(handlers.save({ path: "/Users/me/old.md", opener: "default" }).opener, "default");
  });

  it("opens auto-discovered readmes with Cursor", () => {
    const db = createTestDb();
    const root = mkdtempSync(join(tmpdir(), "gitnrun-docs-"));
    try {
      mkdirSync(join(root, "app", ".git"), { recursive: true });
      writeFileSync(join(root, "app", "README.md"), "# app\n");
      setSetting(db, DOCUMENT_ROOT_KEY, root);

      const readmes = discoverReadmes(db);

      assert.deepEqual(
        readmes.map(({ source, opener }) => ({ source, opener })),
        [{ source: "project-readme", opener: "cursor" }]
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  describe("project root", () => {
    const makeHandlers = (db = createTestDb(), kind: "dir" | "file" | "missing" = "dir") => {
      let changed = 0;
      const handlers = createDocumentHandlers({
        db,
        inspect: async () => kind,
        open: async () => ({ ok: true }),
        now: () => 1,
        onConfigChanged: () => void (changed += 1)
      });
      return { handlers, changes: () => changed };
    };

    it("defaults to ~/Documents/GitHub until the user sets or clears it", async () => {
      const { handlers, changes } = makeHandlers();
      assert.equal(handlers.getRoot(), join(homedir(), "Documents", "GitHub"));

      assert.equal(await handlers.setRoot("/Users/me/code/"), "/Users/me/code");
      assert.equal(handlers.getRoot(), "/Users/me/code");

      assert.equal(await handlers.setRoot(""), "");
      assert.equal(handlers.getRoot(), "");
      assert.equal(changes(), 2);
    });

    it("rejects relative paths and folders that do not exist", async () => {
      await assert.rejects(makeHandlers().handlers.setRoot("code"), UserFacingError);
      await assert.rejects(makeHandlers(createTestDb(), "missing").handlers.setRoot("/Users/me/none"), UserFacingError);
      await assert.rejects(makeHandlers(createTestDb(), "file").handlers.setRoot("/Users/me/file.md"), UserFacingError);
    });

    it("discovers only the root README.md of every git repo under the root, and honours turning it off", () => {
      const root = mkdtempSync(join(tmpdir(), "gitnrun-docs-"));
      try {
        mkdirSync(join(root, "alpha", ".git"), { recursive: true });
        writeFileSync(join(root, "alpha", "README.md"), "# alpha");
        writeFileSync(join(root, "alpha", "README.ja.md"), "# alpha ja");
        mkdirSync(join(root, "alpha", "docs"), { recursive: true });
        writeFileSync(join(root, "alpha", "docs", "README.md"), "# nested");
        mkdirSync(join(root, "beta"), { recursive: true });
        writeFileSync(join(root, "beta", ".git"), "gitdir: ../elsewhere");
        writeFileSync(join(root, "beta", "README.md"), "# beta");
        mkdirSync(join(root, "notes"), { recursive: true });
        writeFileSync(join(root, "notes", "README.md"), "# not a repo");
        mkdirSync(join(root, ".hidden", ".git"), { recursive: true });
        writeFileSync(join(root, ".hidden", "README.md"), "# hidden");

        assert.deepEqual(findRepoFolders(root), [join(root, "alpha"), join(root, "beta")]);

        const db = createTestDb();
        setSetting(db, DOCUMENT_ROOT_KEY, root);
        const found = discoverReadmes(db);
        assert.deepEqual(
          found.map((item) => [item.id, item.label, item.path, item.source]),
          [
            [-1, "alpha · README.md", join(root, "alpha", "README.md"), "project-readme"],
            [-2, "beta · README.md", join(root, "beta", "README.md"), "project-readme"]
          ]
        );

        setSetting(db, DOCUMENT_ROOT_KEY, "");
        assert.deepEqual(discoverReadmes(db), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("returns nothing when the root folder is missing", () => {
      assert.deepEqual(findRepoFolders("/definitely/not/here"), []);
    });
  });
});
