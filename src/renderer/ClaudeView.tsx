import { useRef, useState } from "react";

type CommandItem = { text: string; note: string };
type CommandGroup = { title: string; items: CommandItem[] };

const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: "終端機指令",
    items: [
      { text: "claude --model sonnet", note: "以 Sonnet 模型啟動 Claude Code" }
    ]
  },
  {
    title: "Claude 內指令",
    items: [
      { text: "/model sonnet", note: "切換為 Sonnet" },
      { text: "/model haiku", note: "切換為 Haiku" },
      { text: "/clear", note: "清除目前對話內容" }
    ]
  },
  {
    title: "文字觸發語",
    items: [
      { text: "推送", note: "commit 並 push 目前分支" },
      { text: "開工", note: "同步 main 並開新分支" },
      { text: "完工", note: "同推送，收工後可清理本機分支" }
    ]
  }
];

type CopyState = "done" | "failed";

export const ClaudeView = () => {
  const [state, setState] = useState<{ text: string; result: CopyState } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = async (text: string) => {
    let result: CopyState = "done";
    try {
      await window.gitNRun.copyText(text);
    } catch {
      result = "failed";
    }
    setState({ text, result });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 1500);
  };

  const label = (text: string) => {
    if (state?.text !== text) return "複製";
    return state.result === "done" ? "已複製" : "複製失敗";
  };

  return (
    <div className="claude-page">
      {COMMAND_GROUPS.map((group) => (
        <section key={group.title} className="claude-group">
          <h2>{group.title}</h2>
          {group.items.map((item) => (
            <div key={item.text} className="claude-row">
              <code>{item.text}</code>
              <span className="muted">{item.note}</span>
              <button type="button" onClick={() => void copy(item.text)}>
                {label(item.text)}
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
