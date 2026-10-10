import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from "react";
import { COMMAND_PRESETS } from "@shared/command-presets";
import { errorMessage } from "@shared/format";
import {
  DEFAULT_SHORTCUT,
  TERMINAL_APP_DEFAULT,
  TERMINAL_APP_ITERM,
  TERMINAL_APP_TERMINAL,
  hasWildcard,
  type LaunchResult,
  type LauncherSettings,
  type TerminalAvailability,
  type TerminalMapping
} from "@shared/launcher";
import type { Project } from "@shared/projects";

const BUILT_IN = [TERMINAL_APP_TERMINAL, TERMINAL_APP_ITERM];

const terminalLabel = (value: string): string =>
  value === TERMINAL_APP_DEFAULT ? "使用預設" : value === TERMINAL_APP_TERMINAL ? "Terminal" : value === TERMINAL_APP_ITERM ? "iTerm2" : value;

const ResultLine = ({ result }: { result: LaunchResult | null }) => {
  if (!result) return null;
  if (!result.ok) return <p className="warn">{result.message}</p>;
  return (
    <p className="ok">
      已在 {result.app} 開啟 <span className="mono">{result.folder}</span>
      {result.command ? (
        <>
          ，並執行 <span className="mono">{result.command}</span>
        </>
      ) : null}
    </p>
  );
};

const SettingsBlock = ({ projects, availability }: { projects: Project[]; availability: TerminalAvailability | null }) => {
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [customTerminal, setCustomTerminal] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apply = useCallback((next: LauncherSettings) => {
    setSettings(next);
    setShortcut(next.shortcut ?? "");
    setCustomTerminal(BUILT_IN.includes(next.defaultTerminal) ? "" : next.defaultTerminal);
  }, []);

  useEffect(() => {
    void window.gitNRun.getLauncherSettings().then(apply);
  }, [apply]);

  const save = async (patch: Parameters<typeof window.gitNRun.saveLauncherSettings>[0], success: string) => {
    setMessage("");
    setError("");
    try {
      apply(await window.gitNRun.saveLauncherSettings(patch));
      setMessage(success);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  if (!settings) return null;

  return (
    <div className="subpanel">
      <h3>預設與快捷鍵</h3>
      <div className="form-grid">
        <label className="field">
          預設終端機
          <select
            value={BUILT_IN.includes(settings.defaultTerminal) ? settings.defaultTerminal : "custom"}
            onChange={(event) => {
              if (event.target.value !== "custom") void save({ defaultTerminal: event.target.value }, "已儲存");
            }}
          >
            <option value={TERMINAL_APP_TERMINAL}>Terminal（內建）</option>
            <option value={TERMINAL_APP_ITERM} disabled={availability?.iterm === false}>
              iTerm2{availability?.iterm === false ? "（未安裝）" : ""}
            </option>
            <option value="custom">其他終端機…</option>
          </select>
        </label>
        <label className="field">
          其他終端機 App 名稱（只能開啟資料夾，無法自動執行指令）
          <div className="secret-controls">
            <input value={customTerminal} placeholder="例如 Warp、Ghostty" onChange={(event) => setCustomTerminal(event.target.value)} />
            <button type="button" disabled={customTerminal.trim() === ""} onClick={() => void save({ defaultTerminal: customTerminal.trim() }, "已儲存")}>
              套用
            </button>
          </div>
        </label>
        <label className="field">
          全域快捷鍵
          <div className="secret-controls">
            <input className="mono" value={shortcut} placeholder={DEFAULT_SHORTCUT} onChange={(event) => setShortcut(event.target.value)} spellCheck={false} />
            <button type="button" onClick={() => void save({ shortcut: shortcut.trim() === "" ? null : shortcut.trim() }, shortcut.trim() === "" ? "已停用快捷鍵" : "已儲存快捷鍵")}>
              儲存
            </button>
          </div>
        </label>
        <label className="field">
          快捷鍵啟動的專案（沒選就跳出選單）
          <select
            value={settings.selectedProjectId ?? ""}
            onChange={(event) => void save({ selectedProjectId: event.target.value === "" ? null : Number(event.target.value) }, "已儲存")}
          >
            <option value="">每次跳出選單</option>
            {projects
              .filter((project) => project.localPath)
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="muted">
        快捷鍵目前：
        {settings.shortcut === null ? "未啟用" : settings.shortcutRegistered ? `${settings.shortcut}（已啟用）` : `${settings.shortcut}（被其他程式佔用，未啟用）`}
        ．格式例如 CommandOrControl+Shift+T，至少要有一個修飾鍵。
      </p>
      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn">{error}</p> : null}
    </div>
  );
};

const MappingForm = ({ onSaved }: { onSaved: () => void }) => {
  const [pathPattern, setPathPattern] = useState("");
  const [command, setCommand] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [terminalApp, setTerminalApp] = useState(TERMINAL_APP_DEFAULT);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await window.gitNRun.saveTerminalMapping({ pathPattern, command, recursive, terminalApp });
      setPathPattern("");
      setCommand("");
      onSaved();
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  return (
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <h3>新增資料夾 → 指令</h3>
      <div className="form-grid">
        <label className="field wide">
          資料夾（絕對路徑；* ? 當萬用符號，如 /Users/me/Projects/*）
          <input className="mono" value={pathPattern} onChange={(event) => setPathPattern(event.target.value)} placeholder="/Users/me/Projects/api" required />
        </label>
        <label className="field wide">
          開啟後自動執行的指令（一行；留空只開啟終端機）
          <input className="mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="pnpm dev" />
        </label>
        <label className="field">
          套用常用指令模板
          <select value="" onChange={(event) => setCommand(COMMAND_PRESETS.find((preset) => preset.id === event.target.value)?.command ?? command)}>
            <option value="">選一個…</option>
            {COMMAND_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          終端機
          <select value={terminalApp} onChange={(event) => setTerminalApp(event.target.value)}>
            <option value={TERMINAL_APP_DEFAULT}>使用預設</option>
            <option value={TERMINAL_APP_TERMINAL}>Terminal</option>
            <option value={TERMINAL_APP_ITERM}>iTerm2</option>
          </select>
        </label>
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
        包含符合資料夾底下的所有子資料夾
      </label>
      {error ? <p className="warn pre-line">{error}</p> : null}
      <div>
        <button type="submit" disabled={pathPattern.trim() === ""}>
          儲存
        </button>
      </div>
    </form>
  );
};

export const TerminalView = () => {
  const [mappings, setMappings] = useState<TerminalMapping[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [availability, setAvailability] = useState<TerminalAvailability | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(() => {
    void window.gitNRun.listTerminalMappings().then(setMappings);
    void window.gitNRun.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    refresh();
    void window.gitNRun.getTerminalAvailability().then(setAvailability);
  }, [refresh]);

  const launch = async (action: () => Promise<LaunchResult>) => {
    setError("");
    try {
      setResult(await action());
    } catch (launchError) {
      setResult(null);
      setError(errorMessage(launchError));
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.gitNRun.pathForFile(file);
      if (path) void launch(() => window.gitNRun.launchFolder(path));
    }
  };

  return (
    <section>
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        把資料夾拖到這裡，就會在終端機開啟（有符合的映射會自動執行指令）
      </div>
      <ResultLine result={result} />
      {error ? <p className="warn">{error}</p> : null}

      <h3>專案</h3>
      <ul className="plain-list">
        {projects.filter((project) => project.localPath).length === 0 ? <li className="muted">還沒有專案設定本機路徑。</li> : null}
        {projects
          .filter((project) => project.localPath)
          .map((project) => (
            <li key={project.id} className="row-actions">
              <strong>{project.name}</strong>
              <span className="muted mono">{project.localPath}</span>
              <button type="button" onClick={() => void launch(() => window.gitNRun.launchProject(project.id))}>
                在終端機開啟
              </button>
            </li>
          ))}
      </ul>

      <h3>資料夾 → 指令 映射</h3>
      {mappings.length === 0 ? <p className="muted">還沒有映射。</p> : null}
      <ul className="project-list">
        {mappings.map((mapping) => (
          <li key={mapping.id} className="project-row">
            <div className="project-head">
              <strong className="mono">{mapping.pathPattern}</strong>
              {mapping.recursive ? <span className="badge">含子資料夾</span> : null}
              <span className="badge">{terminalLabel(mapping.terminalApp)}</span>
            </div>
            <div className="mono">{mapping.command || <span className="muted">（只開啟終端機）</span>}</div>
            <div className="row-actions">
              {hasWildcard(mapping.pathPattern) ? (
                <span className="muted">樣式：拖曳符合的資料夾、或從專案啟動</span>
              ) : (
                <button type="button" onClick={() => void launch(() => window.gitNRun.launchFolder(mapping.pathPattern))}>
                  啟動
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void window.gitNRun
                    .deleteTerminalMapping(mapping.id)
                    .then(refresh)
                    .catch((deleteError) => setError(errorMessage(deleteError)))
                }
              >
                刪除
              </button>
            </div>
          </li>
        ))}
      </ul>

      <MappingForm onSaved={refresh} />
      <SettingsBlock projects={projects} availability={availability} />
    </section>
  );
};
