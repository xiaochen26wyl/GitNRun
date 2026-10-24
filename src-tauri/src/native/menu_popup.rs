//! 游標處的快速選單（啟動器的 ⌘⇧T 選單）。
//!
//! 原型實測：Tauri／muda 內建的 popup 在 app 不在前景時不會顯示。改用 Chromium 的做法：
//! 在游標處放一個 1×1、不啟動 app 的 NSPanel，再用合成的右鍵事件對它彈出 NSMenu。
//! 選到項目時以編號回報核心（核心用編號找回處理函式）。

use serde::Deserialize;
use tauri::AppHandle;

use super::failure;
use crate::protocol::Reply;
use crate::supervisor::SidecarHandle;

#[derive(Deserialize, Clone)]
pub struct Item {
    pub id: isize,
    pub label: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct PopupParams {
    pub items: Vec<Item>,
}

/// 選單項目最多這麼多筆，標題最長這麼多字，避免被塞爆畫面。
pub const MAX_ITEMS: usize = 50;
pub const MAX_LABEL_CHARS: usize = 200;

pub fn sanitize(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .take(MAX_ITEMS)
        .map(|item| Item { label: item.label.chars().take(MAX_LABEL_CHARS).collect(), ..item })
        .collect()
}

#[cfg(target_os = "macos")]
pub fn popup(app: &AppHandle, sidecar: SidecarHandle, params: PopupParams) -> Reply {
    let items = sanitize(params.items);
    // 彈出會停在選單的追蹤迴圈直到關閉；這裡只排進主執行緒就回覆，核心不必等選單關掉。
    app.run_on_main_thread(move || mac::show(items, sidecar)).map_err(failure)?;
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub fn popup(_app: &AppHandle, _sidecar: SidecarHandle, _params: PopupParams) -> Reply {
    Ok(None)
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::{define_class, msg_send, rc::Retained, runtime::NSObject, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBackingStoreType, NSEvent, NSEventType, NSMenu, NSMenuItem, NSPanel, NSWindowStyleMask};
    use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
    use serde_json::json;

    use super::Item;
    use crate::supervisor::SidecarHandle;

    /// kCGPopUpMenuWindowLevel：選單要蓋在其他視窗上面。
    const POPUP_LEVEL: isize = 101;

    struct Ivars {
        sidecar: SidecarHandle,
    }

    define_class!(
        // 接收選單項目被選取的動作；NSMenuItem 只弱參照它，所以彈出期間要由呼叫端持有。
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "GitNRunMenuTarget"]
        #[ivars = Ivars]
        struct MenuTarget;

        unsafe impl NSObjectProtocol for MenuTarget {}

        impl MenuTarget {
            #[unsafe(method(itemSelected:))]
            fn item_selected(&self, sender: &NSMenuItem) {
                let id = sender.tag();
                self.ivars().sidecar.send_event("menu-select", Some(json!({ "id": id })));
            }
        }
    );

    impl MenuTarget {
        fn new(mtm: MainThreadMarker, sidecar: SidecarHandle) -> Retained<Self> {
            let this = mtm.alloc::<MenuTarget>().set_ivars(Ivars { sidecar });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn show(items: Vec<Item>, sidecar: SidecarHandle) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if items.is_empty() {
            return;
        }

        let target = MenuTarget::new(mtm, sidecar);
        let menu = NSMenu::new(mtm);
        // 項目的啟用狀態由核心決定，不要讓 AppKit 依 target 的回應自動改掉。
        menu.setAutoenablesItems(false);
        for item in &items {
            let menu_item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    mtm.alloc(),
                    &NSString::from_str(&item.label),
                    Some(sel!(itemSelected:)),
                    &NSString::from_str(""),
                )
            };
            unsafe { menu_item.setTarget(Some(&target)) };
            menu_item.setTag(item.id);
            menu_item.setEnabled(item.enabled);
            menu.addItem(&menu_item);
        }

        let cursor = NSEvent::mouseLocation();
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            NSRect::new(cursor, NSSize::new(1.0, 1.0)),
            NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            NSBackingStoreType::Buffered,
            false,
        );
        panel.setLevel(POPUP_LEVEL);
        panel.setOpaque(false);
        panel.setAlphaValue(0.0);
        panel.setHasShadow(false);
        // 不啟動 app，只把這個小面板排到最前面。
        panel.orderFrontRegardless();

        let Some(view) = panel.contentView() else {
            panel.orderOut(None);
            return;
        };
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::RightMouseDown,
            NSPoint::new(0.0, 0.0),
            objc2_app_kit::NSEventModifierFlags::empty(),
            0.0,
            panel.windowNumber(),
            None,
            0,
            1,
            1.0,
        );
        if let Some(event) = event {
            // 同步彈出：選單關閉（選取或取消）後才返回；動作在返回前已經送出。
            NSMenu::popUpContextMenu_withEvent_forView(&menu, &event, &view);
        }
        panel.orderOut(None);
        drop(target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_the_number_and_length_of_menu_items() {
        let items: Vec<Item> = (0..80).map(|id| Item { id, label: "x".repeat(500), enabled: true }).collect();
        let cleaned = sanitize(items);
        assert_eq!(cleaned.len(), MAX_ITEMS);
        assert!(cleaned.iter().all(|item| item.label.chars().count() == MAX_LABEL_CHARS));
        assert_eq!(cleaned[3].id, 3);
    }
}
