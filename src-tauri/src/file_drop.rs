use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
pub struct DroppedFiles(Mutex<Vec<PathBuf>>);

impl DroppedFiles {
    pub fn remember(&self, paths: &[PathBuf]) {
        let mut dropped = self.0.lock().unwrap();
        dropped.clear();
        dropped.extend_from_slice(paths);
    }

    fn claim(&self, paths: &[PathBuf]) -> bool {
        let mut dropped = self.0.lock().unwrap();
        if dropped.is_empty() || paths.iter().any(|path| !dropped.contains(path)) {
            return false;
        }
        dropped.clear();
        true
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedImage {
    mime_type: &'static str,
    data: String,
}

#[tauri::command]
pub async fn read_dropped_images(
    state: tauri::State<'_, DroppedFiles>,
    paths: Vec<PathBuf>,
) -> Result<Vec<Option<DroppedImage>>, String> {
    // A renderer cannot use this command to read an arbitrary local path.
    if !state.claim(&paths) {
        return Err("The files are no longer available from the latest drop".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut remaining = MAX_IMAGE_BYTES;
        paths.iter().map(|path| read_image(path, &mut remaining)).collect()
    })
    .await
    .map_err(|_| "Could not read the dropped images".into())
}

fn read_image(path: &Path, remaining: &mut usize) -> Option<DroppedImage> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > *remaining as u64 {
        return None;
    }

    let mut file = File::open(path).ok()?.take(*remaining as u64 + 1);
    let mut header = [0; 12];
    file.read_exact(&mut header).ok()?;
    let mime_type = match header {
        [137, b'P', b'N', b'G', 13, 10, 26, 10, ..] => "image/png",
        [255, 216, 255, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => return None,
    };

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    bytes.extend_from_slice(&header);
    file.read_to_end(&mut bytes).ok()?;
    if bytes.len() > *remaining {
        return None;
    }
    *remaining -= bytes.len();
    Some(DroppedImage {
        mime_type,
        data: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drop_grants_only_its_paths_and_can_only_be_claimed_once() {
        let state = DroppedFiles::default();
        let image = PathBuf::from("image.png");
        let other = PathBuf::from("other.png");
        assert!(!state.claim(std::slice::from_ref(&image)));
        state.remember(&[image.clone(), PathBuf::from("report.txt")]);
        assert!(!state.claim(&[image.clone(), other.clone()]));
        assert!(state.claim(std::slice::from_ref(&image)));
        assert!(!state.claim(std::slice::from_ref(&image)));
        state.remember(std::slice::from_ref(&other));
        assert!(!state.claim(&[image]));
        assert!(state.claim(&[other]));
    }

    #[test]
    fn dropped_images_check_type_and_read_budget_before_attaching() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ompd-drop-{}-{unique}.png", std::process::id()));
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7FoAAAAASUVORK5CYII=";
        let bytes = STANDARD.decode(png).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let mut remaining = bytes.len();
        let image = read_image(&path, &mut remaining);
        let oversized = read_image(&path, &mut (bytes.len() - 1));
        std::fs::write(&path, b"Not a valid image").unwrap();
        let mut invalid_budget = MAX_IMAGE_BYTES;
        let invalid = read_image(&path, &mut invalid_budget);
        std::fs::remove_file(path).unwrap();
        let image = image.unwrap();
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, png);
        assert_eq!(remaining, 0);
        assert!(oversized.is_none());
        assert!(invalid.is_none());
    }
}
