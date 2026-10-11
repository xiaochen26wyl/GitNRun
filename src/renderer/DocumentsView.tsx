import { useCallback, useEffect, useState, type DragEvent } from "react";
import { DOCUMENT_OPENER_LABELS, DOCUMENT_OPENERS, type DocumentOpener, type DocumentShortcut } from "@shared/documents";
import { errorMessage } from "@shared/format";

export const DocumentsView = () => {
  const [shortcuts, setShortcuts] = useState<DocumentShortcut[]>([]);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [opener, setOpener] = useState<DocumentOpener>("default");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(() => {
    void window.gitNRun
      .listDocumentShortcuts()
      .then(setShortcuts)
      .catch((refreshError) => setError(errorMessage(refreshError)));
  }, []);

  useEffect(refresh, [refresh]);

  const save = async (filePath: string, fileLabel = label) => {
    setMessage("");
    setError("");
    try {
      await window.gitNRun.saveDocumentShortcut({
        label: fileLabel.trim() === "" ? undefined : fileLabel.trim(),
        path: filePath.trim(),
        opener
      });
      setLabel("");
      setPath("");
      setMessage("已保存文件捷徑");
      refresh();
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  const open = async (shortcut: DocumentShortcut) => {
    setMessage("");
    setError("");
    try {
      await window.gitNRun.openDocumentShortcut(shortcut.id);
      setMessage(`已開啟 ${shortcut.label}`);
    } catch (openError) {
      setError(errorMessage(openError));
    }
  };

  const remove = async (shortcut: DocumentShortcut) => {
    setMessage("");
    setError("");
    try {
      await window.gitNRun.removeDocumentShortcut(shortcut.id);
      refresh();
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  };

  const copyPath = async (shortcut: DocumentShortcut) => {
    setMessage("");
    setError("");
    try {
      await navigator.clipboard.writeText(shortcut.path);
      setMessage("已複製路徑");
    } catch (copyError) {
      setError(errorMessage(copyError));
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      const dropped = window.gitNRun.pathForFile(file);
      if (dropped) {
        void save(dropped, file.name);
      }
    }
  };

  return (
    <section>
      <div className="run-hero">
        <h1>文件空間</h1>
        <p className="muted">已加入專案的 README 會自動出現在這裡；手動捷徑只存在這台電腦與本機備份。</p>
      </div>

      <form
        className="document-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(path);
        }}
      >
        <label>
          名稱
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="選填，預設用檔名" />
        </label>
        <label>
          路徑
          <input className="mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/me/Documents/spec.md" required />
        </label>
        <label>
          開啟方式
          <select value={opener} onChange={(event) => setOpener(event.target.value as DocumentOpener)}>
            {DOCUMENT_OPENERS.map((item) => (
              <option key={item} value={item}>
                {DOCUMENT_OPENER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={path.trim() === ""}>
          保存
        </button>
      </form>

      <div
        className={`dropzone document-dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        把常看的檔案或資料夾拖到這裡保存
      </div>

      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn">{error}</p> : null}
      {shortcuts.length === 0 ? <p className="muted">還沒有文件捷徑。</p> : null}
      <ul className="project-list">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.id} className="project-row document-row">
            <div className="project-head">
              <strong>{shortcut.label}</strong>
              <div className="row-actions compact-actions">
                {shortcut.source === "project-readme" ? <span className="badge">自動 README</span> : null}
                <span className="badge">{DOCUMENT_OPENER_LABELS[shortcut.opener]}</span>
              </div>
            </div>
            <span className="muted mono breakable">{shortcut.path}</span>
            <div className="row-actions">
              <button type="button" onClick={() => void open(shortcut)}>
                開啟
              </button>
              <button type="button" onClick={() => void copyPath(shortcut)}>
                複製路徑
              </button>
              {shortcut.source === "project-readme" ? null : (
                <button type="button" onClick={() => void remove(shortcut)}>
                  移除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
