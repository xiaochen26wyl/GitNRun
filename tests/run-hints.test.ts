import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serviceHintOf } from "@shared/run-hints";

describe("serviceHintOf", () => {
  it("專案 + 服務名稱精準命中，不分大小寫", () => {
    assert.equal(serviceHintOf("/Users/x/GitHub/stockPaw", "edge"), "邊緣節點，負責轉發與快取");
    assert.equal(serviceHintOf("/Users/x/GitHub/stockPaw/", "API"), "提供資料與業務邏輯");
  });

  it("對不到精準項目時退回名稱前綴", () => {
    assert.equal(serviceHintOf("/a/fictionPurr", "web-sparkpurr"), "網頁前端");
    assert.equal(serviceHintOf("/a/fictionPurr", "mobile-poppurr"), "手機 App");
    assert.equal(serviceHintOf("/a/fictionPurr", "desktop-mahopurr"), "桌面 App");
    assert.equal(serviceHintOf("/a/xiaochenStudio", "web"), "網頁前端");
  });

  it("前綴必須整段吻合，查不到就不顯示", () => {
    assert.equal(serviceHintOf("/a/other", "webhook"), undefined);
    assert.equal(serviceHintOf("/a/other", "worker"), undefined);
  });
});
