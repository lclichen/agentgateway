//! One-shot upstream model discovery for provider setup.
//!
//! The gateway never probes upstreams while serving; this module powers the
//! admin API used by the provider editor: given a provider config (draft or
//! stored), issue a single GET against the upstream OpenAI-compatible model
//! list endpoint and report the model ids plus whatever limits the upstream
//! advertises.

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const REDACTED: &str = "<redacted>";
const DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// OpenAI-compatible list endpoints can be large (OpenRouter exposes hundreds
/// of models); cap both the parsed entries and the raw body so a hostile
/// upstream cannot exhaust the admin process's memory.
const MAX_MODELS: usize = 1000;
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverModelsRequest {
	/// Name of an already-saved provider. When set, stored secrets (API keys)
	/// are resolved server-side because the UI only ever sees redacted values.
	pub name: Option<String>,
	/// Draft provider config from the editor. Explicit draft values win over
	/// the stored provider's.
	pub provider: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
	pub id: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub owned_by: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub created: Option<i64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub context_length: Option<i64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub max_output_tokens: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverModelsResponse {
	/// The endpoint that was probed.
	pub endpoint: String,
	pub models: Vec<DiscoveredModel>,
}

/// Merge a UI draft over a stored provider value. The draft wins for every
/// field it sets, except `params.apiKey`: a redacted placeholder means the UI
/// never saw the real key, so the stored value is kept.
pub fn merge_draft_over_stored(stored: &Value, draft: &Value) -> Value {
	let mut merged = stored.clone();
	let (Some(merged_obj), Some(draft_obj)) = (merged.as_object_mut(), draft.as_object()) else {
		return draft.clone();
	};
	for (key, draft_value) in draft_obj {
		if key == "params"
			&& let (Some(merged_params), Some(draft_params)) =
				(merged_obj.get_mut("params"), draft_value.as_object())
		{
			merge_params_over(merged_params, draft_params);
			continue;
		}
		merged_obj.insert(key.clone(), draft_value.clone());
	}
	merged
}

fn merge_params_over(merged_params: &mut Value, draft_params: &serde_json::Map<String, Value>) {
	if !merged_params.is_object() {
		// Hand-written configs may carry `params: null`; the draft params replace it whole.
		*merged_params = Value::Object(draft_params.clone());
		return;
	}
	let Some(merged_params) = merged_params.as_object_mut() else {
		return;
	};
	for (key, value) in draft_params {
		if key == "apiKey" && !is_usable_api_key(value) {
			continue;
		}
		if key == "baseUrl" && value.as_str().unwrap_or_default().trim().is_empty() {
			continue;
		}
		merged_params.insert(key.clone(), value.clone());
	}
}

/// A draft key the gateway can adopt: inline text only. Redacted placeholders,
/// empty values, and file references are not — a file path typed into the UI
/// must not make the admin server read arbitrary local files, so `{"file": …}`
/// drafts are skipped and the stored provider's key is used instead.
fn is_usable_api_key(value: &Value) -> bool {
	match value {
		Value::String(key) => !key.trim().is_empty() && key != REDACTED,
		_ => false,
	}
}

fn resolve_api_key(provider: &Value) -> anyhow::Result<Option<String>> {
	let Some(raw) = provider.pointer("/params/apiKey") else {
		return Ok(None);
	};
	match raw {
		Value::String(key) => {
			let key = key.trim();
			if key.is_empty() {
				return Ok(None);
			}
			if key == REDACTED {
				bail!(
					"the provider's API key is redacted in the UI; re-enter it or save the provider first so the stored key can be used"
				);
			}
			if key.starts_with('$') {
				bail!(
					"apiKey looks like an environment variable reference; discovery needs the literal key — set it inline for this provider"
				);
			}
			Ok(Some(key.to_string()))
		},
		Value::Object(fields) => {
			if let Some(Value::String(file)) = fields.get("file") {
				let key =
					fs_err::read_to_string(file).with_context(|| format!("read apiKey file {}", file))?;
				let key = key.trim();
				if key.is_empty() {
					bail!("apiKey file {} is empty", file);
				}
				return Ok(Some(key.to_string()));
			}
			if let Some(Value::String(key)) = fields.get("inline") {
				let key = key.trim();
				if key.is_empty() {
					return Ok(None);
				}
				return Ok(Some(key.to_string()));
			}
			Ok(None)
		},
		_ => Ok(None),
	}
}

fn resolve_base_url(provider: &Value) -> anyhow::Result<String> {
	if let Some(Value::String(base_url)) = provider.pointer("/params/baseUrl") {
		let base_url = base_url.trim();
		if !base_url.is_empty() {
			return Ok(base_url.to_string());
		}
	}
	// Provider presets carry a default base URL that the editor applies on
	// save; honor it for discovery so probing works before the first save.
	if let Some(provider_value) = provider.get("provider")
		&& let Ok(preset) =
			serde_json::from_value::<crate::llm::custom::ProviderPreset>(provider_value.clone())
	{
		return Ok(preset.base_url().to_string());
	}
	bail!("provider has no baseUrl; set one to discover upstream models")
}

/// Compose the model list URL the same way the gateway composes request paths
/// (`apply_base_url` + `set_default_path`): the baseUrl path becomes the base
/// path with trailing slashes trimmed — a bare host yields an empty base path —
/// and the endpoint suffix is appended to it.
fn models_endpoint(base_url: &str) -> anyhow::Result<String> {
	let mut url = url::Url::parse(base_url).context("parse provider baseUrl")?;
	if !matches!(url.scheme(), "http" | "https") {
		bail!("provider baseUrl must use http or https");
	}
	if url.host_str().is_none() {
		bail!("provider baseUrl must include a host");
	}
	// Mirror `apply_base_url`: user info, query, and fragment are rejected.
	if !url.username().is_empty()
		|| url.password().is_some()
		|| url.query().is_some()
		|| url.fragment().is_some()
	{
		bail!("provider baseUrl cannot include user info, query parameters, or a fragment");
	}
	let path = url.path().trim_end_matches('/');
	url.set_path(&format!("{path}/models"));
	Ok(url.to_string())
}

/// Keys various upstreams use for the context window on `/v1/models` entries.
const CONTEXT_KEYS: [&str; 5] = [
	"max_model_len",
	"context_length",
	"max_context_length",
	"n_ctx",
	"context_window",
];
/// Keys various upstreams use for the output token limit.
const OUTPUT_KEYS: [&str; 3] = ["max_completion_tokens", "max_output_tokens", "max_tokens"];

fn first_int(entry: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
	keys.iter().find_map(|key| entry.get(*key)?.as_i64())
}

fn parse_model_entry(entry: &Value) -> Option<DiscoveredModel> {
	let object = entry.as_object()?;
	let id = object.get("id")?.as_str()?.trim().to_string();
	if id.is_empty() {
		return None;
	}
	// llama.cpp puts limits under a `meta` object on some builds.
	let meta = object.get("meta").and_then(Value::as_object);
	let lookup = |keys: &[&str]| -> Option<i64> {
		first_int(object, keys).or_else(|| meta.and_then(|meta| first_int(meta, keys)))
	};
	Some(DiscoveredModel {
		id,
		owned_by: object
			.get("owned_by")
			.and_then(Value::as_str)
			.map(str::to_string),
		created: object.get("created").and_then(Value::as_i64),
		context_length: lookup(&CONTEXT_KEYS),
		max_output_tokens: lookup(&OUTPUT_KEYS),
	})
}

pub async fn discover_models(provider: &Value) -> anyhow::Result<DiscoverModelsResponse> {
	let endpoint = models_endpoint(&resolve_base_url(provider)?)?;
	let request = reqwest::Client::builder()
		.timeout(DISCOVERY_TIMEOUT)
		.redirect(reqwest::redirect::Policy::limited(5))
		.build()?
		.get(&endpoint)
		.header("accept", "application/json");
	let request = match resolve_api_key(provider)? {
		Some(key) => request.bearer_auth(key),
		None => request,
	};
	let response = request.send().await.context("probe upstream model list")?;
	let status = response.status();
	if !status.is_success() {
		// Status only: reflecting upstream bodies back would turn the admin
		// endpoint into a read oracle for whatever the probe hit.
		bail!("upstream returned {status} for {endpoint}");
	}
	let payload = read_bounded_json(response, MAX_BODY_BYTES)
		.await
		.with_context(|| format!("read upstream model list from {endpoint}"))?;
	let entries = payload
		.get("data")
		.or_else(|| payload.get("models"))
		.and_then(Value::as_array)
		.with_context(|| format!("upstream model list at {endpoint} has no data/models array"))?;
	let mut models: Vec<DiscoveredModel> = entries
		.iter()
		.filter_map(parse_model_entry)
		.take(MAX_MODELS)
		.collect();
	models.sort_by(|a, b| a.id.cmp(&b.id));
	models.dedup_by(|a, b| a.id == b.id);
	Ok(DiscoverModelsResponse { endpoint, models })
}

/// Read a response body as JSON without letting a hostile upstream stream the
/// process out of memory: reject oversized Content-Length up front and cap the
/// streamed bytes regardless of the declared header.
async fn read_bounded_json(response: reqwest::Response, limit: usize) -> anyhow::Result<Value> {
	if let Some(length) = response.content_length()
		&& length as usize > limit
	{
		bail!("upstream response is {length} bytes; refusing to read beyond {limit}");
	}
	use futures_util::StreamExt;
	let mut body: Vec<u8> = Vec::new();
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.context("read upstream response body")?;
		if body.len() + chunk.len() > limit {
			bail!("upstream response exceeds {limit} bytes");
		}
		body.extend_from_slice(&chunk);
	}
	serde_json::from_slice(&body).context("decode upstream model list as JSON")
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn models_endpoint_appends_suffix_by_base_path() {
		// Bare host: the gateway serves from an empty base path, so the list
		// endpoint is /models — the same composition live traffic uses.
		assert_eq!(
			models_endpoint("http://localhost:8080").unwrap(),
			"http://localhost:8080/models"
		);
		assert_eq!(
			models_endpoint("http://localhost:11434/v1/").unwrap(),
			"http://localhost:11434/v1/models"
		);
		assert_eq!(
			models_endpoint("https://api.deepinfra.com/v1/openai").unwrap(),
			"https://api.deepinfra.com/v1/openai/models"
		);
		assert!(models_endpoint("https://user:pass@example.com").is_err());
		assert!(models_endpoint("https://example.com/v1?x=1").is_err());
	}

	#[test]
	fn parse_model_entry_reads_known_limit_keys() {
		let entry = json!({
			"id": "qwen3-8b",
			"owned_by": "vllm",
			"created": 1234,
			"max_model_len": 40960,
			"max_completion_tokens": 512
		});
		let parsed = parse_model_entry(&entry).unwrap();
		assert_eq!(parsed.id, "qwen3-8b");
		assert_eq!(parsed.context_length, Some(40960));
		assert_eq!(parsed.max_output_tokens, Some(512));
	}

	#[test]
	fn parse_model_entry_reads_meta_limits() {
		let entry = json!({"id": "llama-3", "meta": {"n_ctx": 8192}});
		let parsed = parse_model_entry(&entry).unwrap();
		assert_eq!(parsed.context_length, Some(8192));
		assert!(parse_model_entry(&json!({"object": "model"})).is_none());
	}

	#[test]
	fn merge_keeps_stored_key_over_redacted_draft() {
		let stored = json!({"name": "p", "params": {"baseUrl": "http://x", "apiKey": "real"}});
		let draft = json!({"name": "p", "params": {"baseUrl": "http://y", "apiKey": "<redacted>"}});
		let merged = merge_draft_over_stored(&stored, &draft);
		assert_eq!(merged["params"]["baseUrl"], "http://y");
		assert_eq!(merged["params"]["apiKey"], "real");
	}

	#[test]
	fn merge_takes_fresh_draft_key() {
		let stored = json!({"params": {"apiKey": "old"}});
		let draft = json!({"params": {"apiKey": "new"}});
		let merged = merge_draft_over_stored(&stored, &draft);
		assert_eq!(merged["params"]["apiKey"], "new");
	}

	#[test]
	fn merge_ignores_draft_file_key_and_null_stored_params() {
		// A file path typed into the UI must not make the admin read local files.
		let stored = json!({"params": {"apiKey": {"file": "/etc/gateway/real-key"}}});
		let draft = json!({"params": {"apiKey": {"file": "C:/secrets.txt"}}});
		let merged = merge_draft_over_stored(&stored, &draft);
		assert_eq!(merged["params"]["apiKey"]["file"], "/etc/gateway/real-key");

		// `params: null` in hand-written configs adopts the draft params whole.
		let stored = json!({"params": null});
		let draft = json!({"params": {"baseUrl": "http://y", "apiKey": "new"}});
		let merged = merge_draft_over_stored(&stored, &draft);
		assert_eq!(merged["params"]["baseUrl"], "http://y");
		assert_eq!(merged["params"]["apiKey"], "new");
	}
}
