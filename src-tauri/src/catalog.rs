//! Read-only CLI catalog/config queries, independent of RPC discovery.

use std::collections::{BTreeMap, HashSet};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

use crate::agent::StartOptions;

struct CatalogExtension(std::path::PathBuf);

impl CatalogExtension {
    fn create() -> Result<Self, String> {
        use std::io::Write;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Cannot create catalog extension".to_string())?.as_nanos();
        let path = std::env::temp_dir().join(format!("omp-d-catalog-{}-{nonce}.mjs", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
            .open(&path).map_err(|_| "Cannot create catalog extension".to_string())?;
        let extension = Self(path);
        file.write_all(include_bytes!("catalog-extension.mjs"))
            .map_err(|_| "Cannot write catalog extension".to_string())?;
        Ok(extension)
    }
}

impl Drop for CatalogExtension {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// Forward only catalog-relevant arguments, never session prompts or credentials.
fn catalog_args(options: &StartOptions, models: bool) -> (Vec<String>, Option<String>) {
    let mut args = Vec::new();
    let mut profile = None;
    let extra = options.extra_args.as_deref().unwrap_or_default();
    let mut index = 0;
    while index < extra.len() {
        let arg = &extra[index];
        let (flag, inline) = arg.split_once('=').map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        let takes_value = flag == "--profile"
            || (models && matches!(flag, "--config" | "--extension" | "-e" | "--hook"));
        if takes_value {
            let value = inline.map(str::to_string).or_else(|| {
                index += 1;
                extra.get(index).cloned()
            });
            if let Some(value) = value {
                if flag == "--profile" {
                    profile = Some(value);
                } else {
                    args.push(if flag == "--hook" { "--extension" } else { flag }.to_string());
                    args.push(value);
                }
            }
        } else if models && flag == "--no-extensions" {
            args.push(arg.clone());
        }
        index += 1;
    }
    (args, profile)
}

async fn query(options: StartOptions, models: bool) -> Result<Value, String> {
    let cwd = std::fs::canonicalize(&options.cwd).map_err(|_| "Cannot open catalog project directory".to_string())?;
    if !cwd.is_dir() {
        return Err("Catalog project path is not a directory".into());
    }
    let program = options.binary.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("omp");
    let (extra, profile) = catalog_args(&options, models);
    let mut command = Command::new(program);
    let extension = if models { Some(CatalogExtension::create()?) } else { None };
    if models {
        command.args(["models", "--json", "--kind", "all"]);
    } else {
        command.args(["config", "get", "modelRoles", "--json"]);
    }
    command.args(extra).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(extension) = &extension {
        command.arg("--extension").arg(&extension.0);
    }
    if let Some(profile) = profile {
        command.env("OMP_PROFILE", profile);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await.map_err(|_| "Model catalog CLI timed out after 30 seconds".to_string())?
        .map_err(|_| "Cannot execute configured omp binary for model catalog".to_string())?;
    if !output.status.success() {
        return Err(format!("Model catalog CLI exited unsuccessfully ({})", output.status));
    }
    if models {
        let stdout = std::str::from_utf8(&output.stdout).map_err(|_| "Model catalog CLI returned invalid UTF-8")?;
        let (available, catalog) = stdout.rsplit_once("\nOMP_D_CATALOG:")
            .ok_or("Model catalog extension returned no full registry")?;
        let mut result: Value = serde_json::from_str(available)
            .map_err(|_| "Model catalog CLI returned invalid JSON")?;
        let full: Vec<Value> = serde_json::from_str(catalog.trim())
            .map_err(|_| "Model catalog extension returned invalid JSON")?;
        let models = result.get_mut("models").and_then(Value::as_array_mut)
            .ok_or("Model catalog CLI returned no models array")?;
        let mut seen = HashSet::new();
        for model in models.iter_mut() {
            seen.insert((model["provider"].as_str().unwrap_or("").to_owned(), model["id"].as_str().unwrap_or("").to_owned()));
            model["available"] = Value::Bool(true);
        }
        for mut model in full {
            let provider = model["provider"].as_str().ok_or("Invalid catalog provider")?;
            let id = model["id"].as_str().ok_or("Invalid catalog model")?;
            if seen.insert((provider.to_owned(), id.to_owned())) {
                model["available"] = Value::Bool(false);
                models.push(model);
            }
        }
        Ok(result)
    } else {
        serde_json::from_slice(&output.stdout).map_err(|_| "Model catalog CLI returned invalid JSON".to_string())
    }
}

pub async fn models(options: StartOptions) -> Result<Value, String> {
    let mut output = query(options, true).await?;
    let models = output.get_mut("models").map(Value::take).ok_or("Model catalog CLI returned no models array")?;
    let entries = models.as_array().ok_or("Model catalog CLI returned no models array")?;
    if entries.iter().any(|model| model.get("provider").and_then(Value::as_str).is_none() || model.get("id").and_then(Value::as_str).is_none()) {
        return Err("Model catalog CLI returned an invalid model".into());
    }
    Ok(models)
}

pub async fn roles(options: StartOptions) -> Result<BTreeMap<String, String>, String> {
    let mut output = query(options, false).await?;
    let value = output.get_mut("value").map(Value::take).ok_or("Model role CLI returned no value")?;
    serde_json::from_value(value).map_err(|_| "Model role CLI returned invalid assignments".to_string())
}
