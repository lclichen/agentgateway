use std::collections::HashSet;
use std::io::Write;

use agentgateway::cel;
use anyhow::{Result, bail};
use schemars::JsonSchema;

pub fn generate_schema() -> Result<()> {
	struct SchemaDoc {
		name: &'static str,
		mdfile: Option<&'static str>,
		file: &'static str,
		schema_json: String,
		schema_inline_json: Option<String>,
	}

	let xtask_path = std::env::var("CARGO_MANIFEST_DIR")?;
	let schemas = vec![
		SchemaDoc {
			name: "Configuration File",
			mdfile: Some("config.md"),
			file: "config.json",
			schema_json: make::<agentgateway::types::local::LocalConfig>(false)?,
			schema_inline_json: Some(make::<agentgateway::types::local::LocalConfig>(true)?),
		},
		SchemaDoc {
			name: "CEL context",
			mdfile: Some("cel.md"),
			file: "cel.json",
			// CEL is simpler so we just always inline
			schema_json: make::<cel::ExecutorSerde>(true)?,
			schema_inline_json: Some(make::<cel::ExecutorSerde>(true)?),
		},
		SchemaDoc {
			name: "Admin Configuration Dump",
			mdfile: None,
			file: "admin.json",
			schema_json: make_with_contract::<agentgateway::store::StoresDump>(
				false,
				schemars::generate::Contract::Serialize,
			)?,
			schema_inline_json: None,
		},
	];
	for schema in &schemas {
		let rule_path = format!("{xtask_path}/../../schema/{}", schema.file);
		let mut file = fs_err::File::create(rule_path)?;
		file.write_all(schema.schema_json.as_bytes())?;
	}

	for schema in schemas {
		let Some(mdfile) = schema.mdfile else {
			continue;
		};
		let mut readme = format!("# {} Schema\n\n", schema.name);
		let rule_path = format!("{xtask_path}/../../schema/{}", schema.file);
		// Prefer the PowerShell helper when present; fall back to the shell helper through
		// bash so `cargo xtask schema` also works on Windows checkouts without the ps1.
		let ps1_path = format!("{xtask_path}/../../tools/schema-to-md.ps1");
		let use_ps1 = cfg!(target_os = "windows") && std::path::Path::new(&ps1_path).exists();
		let o = if use_ps1 {
			std::process::Command::new("powershell")
				.arg("-Command")
				.arg(&ps1_path)
				.arg(&rule_path)
				.output()?
		} else {
			let inline_rule_path = format!("{xtask_path}/../../schema/.inline-{}", schema.file);
			let mut file = fs_err::File::create(&inline_rule_path)?;
			file.write_all(
				schema
					.schema_inline_json
					.as_ref()
					.expect("markdown schemas must have inline JSON")
					.as_bytes(),
			)?;

			let cmd_path: String = format!("{xtask_path}/../../tools/schema-to-md.sh");
			let mut command = if cfg!(target_os = "windows") {
				let mut command = windows_bash().ok_or_else(|| {
					anyhow::anyhow!("bash not found; install Git for Windows or add tools/schema-to-md.ps1")
				})?;
				command.arg(&cmd_path);
				command
			} else {
				std::process::Command::new(&cmd_path)
			};
			let output = command.arg(&inline_rule_path).output();
			let _ = fs_err::remove_file(&inline_rule_path);
			output?
		};
		if !o.stderr.is_empty() {
			bail!(
				"schema documentation generation failed: {}",
				String::from_utf8_lossy(&o.stderr)
			);
		}
		readme.push_str(&dedupe_lines(&String::from_utf8_lossy(&o.stdout)));

		let mut file = fs_err::File::create(format!("{xtask_path}/../../schema/{mdfile}"))?;
		file.write_all(readme.as_bytes())?;
	}
	Ok(())
}

/// Locate a usable bash on Windows. Plain `bash` resolves to the WSL launcher in
/// System32, which cannot run these scripts, so derive bash from the Git installation
/// found on PATH (git.exe lives at `<root>/cmd` or `<root>/mingw64/bin`).
fn windows_bash() -> Option<std::process::Command> {
	let exec_path = std::process::Command::new("git")
		.arg("--exec-path")
		.output()
		.ok()
		.map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
	let git_root = exec_path
		.as_deref()
		.and_then(|exec| std::path::Path::new(exec).ancestors().nth(3))
		.map(std::path::Path::to_path_buf);
	let mut candidates: Vec<std::path::PathBuf> = Vec::new();
	if let Some(root) = git_root {
		candidates.push(root.join("bin").join("bash.exe"));
		candidates.push(root.join("usr").join("bin").join("bash.exe"));
	}
	if let Ok(shell) = std::env::var("SHELL") {
		candidates.push(std::path::PathBuf::from(shell));
	}
	candidates
		.into_iter()
		.find(|candidate| candidate.is_file())
		.map(std::process::Command::new)
}

fn dedupe_lines(input: &str) -> String {
	let mut seen = HashSet::new();
	let mut output = input
		.lines()
		.filter(|line| seen.insert(*line))
		.collect::<Vec<_>>()
		.join("\n");
	if !output.is_empty() {
		output.push('\n');
	}
	output
}

pub fn make<T: JsonSchema>(inline_subschemas: bool) -> anyhow::Result<String> {
	make_with_contract::<T>(inline_subschemas, schemars::generate::Contract::Deserialize)
}

pub fn make_with_contract<T: JsonSchema>(
	inline_subschemas: bool,
	contract: schemars::generate::Contract,
) -> anyhow::Result<String> {
	let settings = schemars::generate::SchemaSettings::default().with(|s| {
		s.inline_subschemas = inline_subschemas;
		s.contract = contract;
	});
	let gens = schemars::SchemaGenerator::new(settings);
	let schema = gens.into_root_schema_for::<T>();
	Ok(serde_json::to_string_pretty(&schema)?)
}
