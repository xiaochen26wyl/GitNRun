import { useEffect, useMemo, useState } from "react";
import { COMMON_TYPES, parseTemplate, templateTokens } from "@shared/branch-template";
import { errorMessage } from "@shared/format";
import type { Project } from "@shared/projects";
import { useProjectHead } from "./hooks";
import type { StartWorkInput, StartWorkPlan, StartWorkResult } from "@shared/start-work";

/**
 * 「開工」：依分支命名規則建立並推送新分支。
 * 一定先預覽（唯讀）再確認；執行時主程序會再核對名稱，與預覽不同就拒絕。
 */
export const StartWorkPanel = ({ project, onClose }: { project: Project; onClose: () => void }) => {
  const headProps = useProjectHead();
  const [needsType, setNeedsType] = useState(false);
  const [needsSlug, setNeedsSlug] = useState(false);
  const [type, setType] = useState("feat");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<StartWorkPlan | null>(null);
  const [blockedMessage, setBlockedMessage] = useState("");
  const [result, setResult] = useState<StartWorkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.gitNRun.getBranchRule(project.id).then((rule) => {
      const parsed = parseTemplate(rule.template);
      const tokens = parsed.ok ? templateTokens(parsed.parts) : [];
      setNeedsType(tokens.includes("type"));
      setNeedsSlug(tokens.includes("slug"));
    });
  }, [project.id]);

  const input = useMemo((): StartWorkInput => {
    const value: StartWorkInput = {};
    if (needsType) value.type = type;
    if (needsSlug) value.slug = slug;
    return value;
  }, [needsType, needsSlug, type, slug]);

  // 輸入一變，先前的預覽與結果就不再有效。
  useEffect(() => {
    setPlan(null);
    setBlockedMessage("");
    setResult(null);
  }, [input]);

  const preview = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await window.gitNRun.previewStartWork(project.id, input);
      setPlan(response.ok ? response.plan : null);
      setBlockedMessage(response.ok ? "" : response.message);
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      setResult(await window.gitNRun.runStartWork(project.id, input, plan.branch));
      setPlan(null);
    } catch (runError) {
      setError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="subpanel">
      <div {...headProps(project.localPath)}>
        <strong>開工：{project.name}</strong>
        <button type="button" onClick={onClose}>
          關閉
        </button>
      </div>

      {needsType || needsSlug ? (
        <div className="filters">
          {needsType ? (
            <select aria-label="分支類型" value={type} onChange={(event) => setType(event.target.value)}>
              {COMMON_TYPES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          {needsSlug ? (
            <input aria-label="簡短描述" placeholder="簡短描述，例如 login page" value={slug} onChange={(event) => setSlug(event.target.value)} />
          ) : null}
        </div>
      ) : null}

      <button type="button" disabled={busy} onClick={() => void preview()}>
        預覽
      </button>

      {blockedMessage ? <p className="warn">{blockedMessage}</p> : null}
      {error ? <p className="warn">{error}</p> : null}

      {plan ? (
        <div>
          <p>
            將建立分支 <strong className="mono">{plan.branch}</strong>（從 <span className="mono">{plan.baseBranch}</span> 出發）
          </p>
          <ol className="steps">
            {plan.steps.map((step) => (
              <li key={step} className="mono">
                {step}
              </li>
            ))}
          </ol>
          <button type="button" disabled={busy} onClick={() => void run()}>
            確認建立並推送
          </button>
        </div>
      ) : null}

      {result ? (
        <div>
          <p className={result.ok ? "ok" : "warn"}>{result.ok ? `完成：已建立並推送 ${result.branch}` : result.message}</p>
          <ol className="steps">
            {result.steps.map((step) => (
              <li key={step.label}>
                <span className="mono">{step.label}</span> {step.ok ? "✓" : "✗"}
                {step.output ? <pre className="output">{step.output}</pre> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
};
