import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * 說明提示：滑過或聚焦 ⓘ 會顯示泡泡，點擊會釘住；按 Esc 或點擊外部時關閉釘住的泡泡。
 * 泡泡的顯示靠 CSS（:hover、:focus-visible 與 .pinned），這裡只管釘住狀態。
 */
export const HelpTip = ({ label, children }: { label: string; children: ReactNode }) => {
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleId = useId();

  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pinned]);

  return (
    <span ref={rootRef} className={pinned ? "help-tip pinned" : "help-tip"}>
      <button
        type="button"
        className="help-tip-trigger"
        aria-label={label}
        aria-expanded={pinned}
        aria-describedby={bubbleId}
        onClick={() => setPinned((value) => !value)}
      >
        ⓘ
      </button>
      <div id={bubbleId} role="tooltip" className="help-tip-bubble">
        {children}
      </div>
    </span>
  );
};
