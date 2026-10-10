import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SAMPLE_VALUES,
  TOKEN_LABELS,
  TOKEN_NAMES,
  VERSION_SOURCES,
  renderBranchName,
  validateTemplate,
  type BranchRuleView,
  type VersionSource
} from "@shared/branch-template";
import { errorMessage } from "@shared/format";
import type { Project } from "@shared/projects";

const SCOPE_LABEL: Record<BranchRuleView["scope"], string> = {
  project: "此專案自己的規則",
  global: "全域預設",
  default: "內建預設"
};

const SOURCE_LABEL: Record<VersionSource, string> = {
  "package.json": "package.json 的 version",
  VERSION: "VERSION 檔案第一行",
  "git-tag": "最近的 git tag"
};

/**
 * 分支命名規則：全域預設，每個專案可覆寫。範本同時決定「開工」產生的分支名稱，
 * 以及監視到的推送是否合規。預覽直接用共用的範本引擎，所見即所得。
 */
export const BranchRulesPanel = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scopeId, setScopeId] = useState(0);
  const [view, setView] = useState<BranchRuleView | null>(null);
  const [template, setTemplate] = useState("");
  const [versionSource, setVersionSource] = useState<VersionSource>("package.json");
  const [exemptText, setExemptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apply = useCallback((next: BranchRuleView) => {
    setView(next);
    setTemplate(next.template);
    setVersionSource(next.versionSource);
    setExemptText(next.exempt.join("\n"));
  }, []);

  useEffect(() => {
    void window.gitNRun.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    setMessage("");
    setError("");
    void window.gitNRun.getBranchRule(scopeId).then(apply).catch((loadError) => setError(errorMessage(loadError)));
  }, [scopeId, apply]);

  const validation = useMemo(() => validateTemplate(template), [template]);
  const preview = useMemo(() => {
    if (!validation.ok) return null;
    try {
      return renderBranchName(template, SAMPLE_VALUES);
    } catch {
      return null;
    }
  }, [template, validation]);

  const run = async (action: () => Promise<BranchRuleView>, success: string) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      apply(await action());
      setMessage(success);
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const exempt = exemptText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <section className="panel">
      <h2>分支命名規則</h2>
      <p className="muted">
        範本決定「開工」建立的分支名稱，也用來檢查監視到的推送是否合規。預設沿用 v版本_年份_月日（例：v010_2026_1009）。
      </p>

      <label className="field">
        套用範圍
        <select value={scopeId} onChange={(event) => setScopeId(Number(event.target.value))}>
          <option value={0}>全域預設</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              專案：{project.name}
            </option>
          ))}
        </select>
      </label>
      {view ? (
        <p className="muted">
          目前生效：{SCOPE_LABEL[view.scope]}
          {scopeId !== 0 && !view.hasOwn ? "（儲存後會成為這個專案自己的覆寫）" : ""}
        </p>
      ) : null}

      <label className="field">
        範本
        <input className="mono" value={template} onChange={(event) => setTemplate(event.target.value)} spellCheck={false} />
      </label>
      <div className="token-row">
        {TOKEN_NAMES.map((name) => (
          <button key={name} type="button" title={TOKEN_LABELS[name]} onClick={() => setTemplate((current) => `${current}{${name}}`)}>
            {`{${name}}`}
          </button>
        ))}
      </div>

      {validation.ok ? (
        <p>
          預覽：<span className="mono">{preview}</span>
        </p>
      ) : (
        <ul className="plain-list">
          {validation.errors.map((problem) => (
            <li key={problem} className="warn">
              {problem}
            </li>
          ))}
        </ul>
      )}

      <label className="field">
        版本來源（{`{version}`} 用）
        <select value={versionSource} onChange={(event) => setVersionSource(event.target.value as VersionSource)}>
          {VERSION_SOURCES.map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABEL[source]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        豁免的分支（每行一個，支援 * ?；這些分支不檢查命名）
        <textarea rows={4} value={exemptText} onChange={(event) => setExemptText(event.target.value)} spellCheck={false} />
      </label>

      <div className="row-actions">
        <button
          type="button"
          disabled={busy || !validation.ok}
          onClick={() => void run(() => window.gitNRun.saveBranchRule(scopeId, { template: template.trim(), versionSource, exempt }), "已儲存")}
        >
          儲存
        </button>
        <button
          type="button"
          disabled={busy || !view?.hasOwn}
          onClick={() => void run(() => window.gitNRun.resetBranchRule(scopeId), scopeId === 0 ? "已回到內建預設" : "已移除覆寫")}
        >
          {scopeId === 0 ? "回到內建預設" : "移除這個專案的覆寫"}
        </button>
      </div>
      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn">{error}</p> : null}
    </section>
  );
};
