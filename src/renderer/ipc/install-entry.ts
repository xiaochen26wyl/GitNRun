import { installTauriShim } from "./install";

// 必須在其他模組之前執行（main.tsx 第一行引入）：App 一載入就會呼叫 window.gitNRun。
installTauriShim();
