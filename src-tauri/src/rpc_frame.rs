//! Protocol v2 frame reassembly for the omp RPC transport.
//!
//! Frames are newline-delimited JSON. An oversized logical frame arrives as a
//! sequence of `rpc_chunk` frames carrying base64 segments; this decoder
//! validates the sequence and hands back the reassembled object.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
pub const CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_CHUNKS: usize = MAX_REASSEMBLED_BYTES / CHUNK_PAYLOAD_BYTES;

#[derive(Debug)]
struct PendingChunks {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    next_index: usize,
    received_bytes: usize,
    chunks: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    pending: Option<PendingChunks>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one parsed JSONL line. Returns a complete logical frame when one is
    /// ready, `None` while chunk segments are still arriving.
    pub fn push(&mut self, value: Value) -> Result<Option<Value>, String> {
        let Some(object) = value.as_object() else {
            return Err("rpc frame must be a JSON object".into());
        };

        if object.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            if self.pending.is_some() {
                self.pending = None;
                return Err("rpc chunk sequence interrupted".into());
            }
            return Ok(Some(value));
        }

        let chunk_id = object
            .get("chunkId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("invalid rpc chunk metadata: chunkId")?
            .to_string();
        let index = as_usize(object.get("index")).ok_or("invalid rpc chunk metadata: index")?;
        let count = as_usize(object.get("count")).ok_or("invalid rpc chunk metadata: count")?;
        let byte_length =
            as_usize(object.get("byteLength")).ok_or("invalid rpc chunk metadata: byteLength")?;

        if !(2..=MAX_CHUNKS).contains(&count) || index >= count {
            return Err("invalid rpc chunk metadata: index/count".into());
        }
        if !(MAX_FRAME_BYTES..=MAX_REASSEMBLED_BYTES).contains(&byte_length) {
            return Err("invalid rpc chunk metadata: byteLength out of range".into());
        }

        let data = object
            .get("data")
            .and_then(Value::as_str)
            .ok_or("invalid rpc chunk data")?;
        let bytes = BASE64
            .decode(data)
            .map_err(|_| "invalid rpc chunk data: not base64".to_string())?;
        if BASE64.encode(&bytes) != data {
            return Err("invalid rpc chunk data: non-canonical base64".into());
        }
        if bytes.len() > CHUNK_PAYLOAD_BYTES {
            return Err("rpc chunk payload exceeds the transport limit".into());
        }

        match &mut self.pending {
            None => {
                if index != 0 {
                    return Err("rpc chunk sequence must start at index 0".into());
                }
                self.pending = Some(PendingChunks {
                    chunk_id,
                    count,
                    byte_length,
                    next_index: 0,
                    received_bytes: 0,
                    chunks: Vec::with_capacity(byte_length),
                });
            }
            Some(pending) => {
                if pending.chunk_id != chunk_id
                    || pending.count != count
                    || pending.byte_length != byte_length
                    || pending.next_index != index
                {
                    self.pending = None;
                    return Err("rpc chunk sequence mismatch".into());
                }
            }
        }

        let pending = self.pending.as_mut().expect("pending chunks exist");
        pending.received_bytes += bytes.len();
        pending.next_index += 1;
        pending.chunks.extend_from_slice(&bytes);
        if pending.received_bytes > pending.byte_length {
            self.pending = None;
            return Err("rpc chunk sequence exceeds declared length".into());
        }
        if pending.next_index < pending.count {
            return Ok(None);
        }

        let pending = self.pending.take().expect("pending chunks exist");
        if pending.received_bytes != pending.byte_length {
            return Err("rpc chunk sequence length mismatch".into());
        }
        let text = String::from_utf8(pending.chunks)
            .map_err(|_| "rpc chunk is not valid UTF-8".to_string())?;
        let value: Value =
            serde_json::from_str(&text).map_err(|e| format!("rpc chunk JSON parse failed: {e}"))?;
        if !value.is_object() {
            return Err("rpc frame must be a JSON object".into());
        }
        Ok(Some(value))
    }
}

fn as_usize(value: Option<&Value>) -> Option<usize> {
    let n = value?.as_u64()?;
    usize::try_from(n).ok()
}

/// Encode a logical JSON value into protocol v2 chunk frames (used by tests).
#[allow(dead_code)]
pub fn encode_chunks(json: &str, chunk_id: &str) -> Vec<Value> {
    let bytes = json.as_bytes();
    let count = bytes.len().div_ceil(CHUNK_PAYLOAD_BYTES);
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let slice =
            &bytes[index * CHUNK_PAYLOAD_BYTES..bytes.len().min((index + 1) * CHUNK_PAYLOAD_BYTES)];
        out.push(serde_json::json!({
            "type": "rpc_chunk",
            "chunkId": chunk_id,
            "index": index,
            "count": count,
            "byteLength": bytes.len(),
            "data": BASE64.encode(slice),
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big_message(min_bytes: usize) -> String {
        let payload = "x".repeat(min_bytes);
        serde_json::json!({ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": payload }] } })
            .to_string()
    }

    #[test]
    fn passes_small_frames_through() {
        let mut decoder = FrameDecoder::new();
        let frame = serde_json::json!({"type":"ready","protocolVersion":1});
        assert_eq!(decoder.push(frame.clone()).unwrap(), Some(frame));
    }

    #[test]
    fn reassembles_chunked_frame_in_order() {
        let json = big_message(MAX_FRAME_BYTES);
        let chunks = encode_chunks(&json, "rpc-1");
        assert!(chunks.len() >= 2, "payload must span multiple chunks");
        let mut decoder = FrameDecoder::new();
        let mut decoded = None;
        for chunk in chunks {
            decoded = decoder.push(chunk).unwrap();
        }
        let frame = decoded.expect("frame reassembled");
        assert_eq!(frame["type"], "message_end");
        assert_eq!(
            frame["message"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .len(),
            MAX_FRAME_BYTES
        );
    }

    #[test]
    fn rejects_out_of_order_chunks() {
        let json = big_message(MAX_FRAME_BYTES);
        let chunks = encode_chunks(&json, "rpc-1");
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(chunks[1].clone()).is_err());
        assert!(decoder.push(chunks[0].clone()).unwrap().is_none());
        assert!(decoder.push(chunks[0].clone()).is_err());
    }

    #[test]
    fn rejects_sequence_mismatch() {
        let json = big_message(MAX_FRAME_BYTES);
        let chunks = encode_chunks(&json, "rpc-1");
        let mut decoder = FrameDecoder::new();
        decoder.push(chunks[0].clone()).unwrap();
        let mut tampered = chunks[1].clone();
        tampered["chunkId"] = "rpc-2".into();
        assert!(decoder.push(tampered).is_err());
    }

    #[test]
    fn rejects_plain_frame_mid_sequence() {
        let json = big_message(MAX_FRAME_BYTES);
        let chunks = encode_chunks(&json, "rpc-1");
        let mut decoder = FrameDecoder::new();
        decoder.push(chunks[0].clone()).unwrap();
        assert!(
            decoder
                .push(serde_json::json!({"type":"agent_start"}))
                .is_err()
        );
    }

    #[test]
    fn rejects_declared_length_mismatch() {
        let json = big_message(MAX_FRAME_BYTES);
        let chunks = encode_chunks(&json, "rpc-1");
        let mut decoder = FrameDecoder::new();
        let mut tampered = chunks[1].clone();
        tampered["byteLength"] = serde_json::json!(chunks[1]["byteLength"].as_u64().unwrap() + 10);
        assert!(decoder.push(chunks[0].clone()).unwrap().is_none());
        assert!(decoder.push(tampered).is_err());
    }
}
