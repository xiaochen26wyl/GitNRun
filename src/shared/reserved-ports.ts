/**
 * 留給使用者手動啟動的 port：5173 是 Vite 與多數前端工具的預設起點，5174 是 toBloom 本機 API 的固定號碼。
 * GitNRun 的動態 port 配置與它自己的 dev server 都不得占用，手動啟動的專案與手機端才找得到固定的位置。
 * 純常數，主程序與設定檔都能引用。
 */
export const MANUAL_START_PORTS: readonly number[] = [5173, 5174];
