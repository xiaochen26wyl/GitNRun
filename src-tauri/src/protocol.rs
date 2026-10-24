//! 與核心（Node sidecar）之間的訊息格式：unix socket 上的逐行 JSON。
//! 與 src/main/sidecar/protocol.ts 使用相同的欄位與方法名稱；Rust 不解讀通道或參數，只轉發。

use serde::Serialize;
use serde_json::{json, Map, Value};

pub const PROTOCOL_VERSION: u64 = 1;
/// 單一訊息（一行）的大小上限，與核心一致。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

pub const METHOD_HELLO: &str = "hello";
pub const METHOD_IPC_INVOKE: &str = "ipc.invoke";
pub const EVENT_READY: &str = "ready";
pub const EVENT_PUSH: &str = "push";
pub const EVENT_CANCEL: &str = "native.cancel";
pub const NATIVE_PREFIX: &str = "native.";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WireError {
    pub name: String,
    pub message: String,
}

impl WireError {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        WireError { name: name.to_string(), message: message.into() }
    }

    pub fn unavailable(message: &str) -> Self {
        WireError::new("SidecarUnavailable", message)
    }
}

pub type Reply = Result<Option<Value>, WireError>;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Req { id: u64, method: String, params: Option<Value> },
    Res { id: u64, result: Reply },
    Evt { method: String, params: Option<Value> },
}

fn valid_method(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// 嚴格檢查形狀；任何不符合的一律回傳 None（呼叫端會斷線）。
pub fn parse_frame(line: &str) -> Option<Frame> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let kind = object.get("k")?.as_str()?;
    let params = object.get("p").cloned();

    match kind {
        "req" => {
            let id = object.get("id")?.as_u64()?;
            let method = object.get("m")?.as_str()?;
            valid_method(method).then(|| Frame::Req { id, method: method.to_string(), params })
        }
        "evt" => {
            let method = object.get("m")?.as_str()?;
            valid_method(method).then(|| Frame::Evt { method: method.to_string(), params })
        }
        "res" => {
            let id = object.get("id")?.as_u64()?;
            match object.get("ok")?.as_bool()? {
                true => Some(Frame::Res { id, result: Ok(object.get("v").cloned()) }),
                false => {
                    let error = object.get("e")?.as_object()?;
                    Some(Frame::Res {
                        id,
                        result: Err(WireError {
                            name: error.get("name")?.as_str()?.to_string(),
                            message: error.get("message")?.as_str()?.to_string(),
                        }),
                    })
                }
            }
        }
        _ => None,
    }
}

/// 編成一行（含換行）；超過上限時回傳 None，不送出超長訊息。
pub fn encode_frame(frame: &Frame) -> Option<String> {
    let mut object = Map::new();
    match frame {
        Frame::Req { id, method, params } => {
            object.insert("k".into(), json!("req"));
            object.insert("id".into(), json!(id));
            object.insert("m".into(), json!(method));
            if let Some(p) = params {
                object.insert("p".into(), p.clone());
            }
        }
        Frame::Evt { method, params } => {
            object.insert("k".into(), json!("evt"));
            object.insert("m".into(), json!(method));
            if let Some(p) = params {
                object.insert("p".into(), p.clone());
            }
        }
        Frame::Res { id, result } => {
            object.insert("k".into(), json!("res"));
            object.insert("id".into(), json!(id));
            match result {
                Ok(v) => {
                    object.insert("ok".into(), json!(true));
                    if let Some(v) = v {
                        object.insert("v".into(), v.clone());
                    }
                }
                Err(e) => {
                    object.insert("ok".into(), json!(false));
                    object.insert("e".into(), json!({ "name": e.name, "message": e.message }));
                }
            }
        }
    }
    let mut line = serde_json::to_string(&Value::Object(object)).ok()?;
    line.push('\n');
    (line.len() <= MAX_FRAME_BYTES).then_some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_three_frame_kinds() {
        let frames = [
            Frame::Req { id: 7, method: "ipc.invoke".into(), params: Some(json!({ "channel": "app:info", "args": [] })) },
            Frame::Evt { method: "ready".into(), params: None },
            Frame::Res { id: 3, result: Ok(Some(json!({ "value": null }))) },
            Frame::Res { id: 4, result: Ok(None) },
            Frame::Res { id: 5, result: Err(WireError::new("Boom", "bad")) },
        ];
        for frame in frames {
            let line = encode_frame(&frame).expect("encodes");
            assert!(line.ends_with('\n'));
            assert_eq!(parse_frame(line.trim_end()), Some(frame));
        }
    }

    #[test]
    fn keeps_a_missing_value_distinct_from_null() {
        let missing = parse_frame(r#"{"k":"res","id":1,"ok":true}"#);
        let null = parse_frame(r#"{"k":"res","id":1,"ok":true,"v":null}"#);
        assert_eq!(missing, Some(Frame::Res { id: 1, result: Ok(None) }));
        assert_eq!(null, Some(Frame::Res { id: 1, result: Ok(Some(Value::Null)) }));
    }

    #[test]
    fn rejects_anything_malformed() {
        for line in [
            "not json",
            "[]",
            r#"{"k":"nope"}"#,
            r#"{"k":"req","id":-1,"m":"x"}"#,
            r#"{"k":"req","id":1,"m":"has space"}"#,
            r#"{"k":"req","id":1}"#,
            r#"{"k":"res","id":1,"ok":false}"#,
            r#"{"k":"res","id":1,"ok":false,"e":{"name":"x"}}"#,
            r#"{"k":"evt","m":""}"#,
        ] {
            assert_eq!(parse_frame(line), None, "{line}");
        }
    }

    #[test]
    fn refuses_to_encode_an_oversized_frame() {
        let frame = Frame::Evt { method: "push".into(), params: Some(json!("x".repeat(MAX_FRAME_BYTES))) };
        assert_eq!(encode_frame(&frame), None);
    }
}
