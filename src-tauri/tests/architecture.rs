//! Architecture rules enforcing ADRs 0001–0004.
//!
//! These tests fail the build when the structural decisions captured in
//! `docs/adrs/` are violated. Each rule is a forbidden-substring check
//! scoped to a specific module file, with a comment pointing at the ADR
//! it locks in.
//!
//! If a rule starts producing false positives, either fix the violation
//! or write a new ADR that supersedes the old one and update this file.

use std::fs;
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR points at src-tauri/
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read(rel: &str) -> String {
    let path = src_dir().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Forbid any line that contains any of `needles` inside `rel`, unless the
/// line also contains the substring `// arch-allow`. ADR references in
/// comments are ignored (anything in a `//!` doc comment or a line starting
/// with `//` followed by an ADR pointer).
fn assert_no_imports(rel: &str, needles: &[&str], adr: &str) {
    let content = read(rel);
    let violations: Vec<(usize, &str)> = content
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            // Skip comment lines so this file isn't fragile to mentioning the
            // forbidden imports in prose.
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                return false;
            }
            if line.contains("// arch-allow") {
                return false;
            }
            needles.iter().any(|n| line.contains(n))
        })
        .map(|(i, line)| (i + 1, line))
        .collect();
    if !violations.is_empty() {
        let mut msg = format!("Architecture rule violated in {} (see {}):\n", rel, adr);
        for (lineno, line) in violations {
            msg.push_str(&format!("  {}: {}\n", lineno, line.trim()));
        }
        msg.push_str(&format!("  Forbidden substrings: {:?}\n", needles));
        msg.push_str(
            "  Either remove the import, or amend the ADR and update tests/architecture.rs.\n",
        );
        panic!("{}", msg);
    }
}

#[test]
fn adr_0001_recordings_json_io_lives_only_in_recordings_store() {
    // ADR-0001: `recordings.json` IO is the RecordingsStore's responsibility.
    // No other module should mention the file directly.
    for rel in modules_other_than(&["recordings_store.rs"]) {
        let content = read(&rel);
        assert!(
            !content.contains("recordings.json"),
            "ADR-0001 violated: {} references `recordings.json` directly. \
             Use recordings_store::RecordingsStore.",
            rel
        );
    }
}

#[test]
fn adr_0002_event_capture_holds_no_arc_mutex_state() {
    // ADR-0002: EventCapture is single-threaded; its state lives in plain
    // HashSet/Option fields. Re-introducing Arc<Mutex<...>> would erode the
    // single-owner property the ADR commits to.
    assert_no_imports(
        "event_capture.rs",
        &["Arc<Mutex", "std::sync::Arc", "std::sync::Mutex"],
        "ADR-0002",
    );
}

#[test]
fn adr_0003_playback_plan_is_pure_no_io_no_threads_no_tauri() {
    // ADR-0003: PlaybackPlan::compile is pure. No I/O, no threads, no Tauri.
    // Everything in playback/plan.rs must remain side-effect-free.
    assert_no_imports(
        "playback/plan.rs",
        &[
            "std::fs",
            "std::thread",
            "std::time::Instant",
            "std::time::SystemTime",
            "tauri::",
            "rdev::listen",
            "rdev::simulate",
            "std::process",
        ],
        "ADR-0003",
    );
}

#[test]
fn adr_0003_playback_engine_owns_threading_not_simulation_logic() {
    // ADR-0003: the engine drives the plan. It must not contain the
    // event-translation logic (string_to_key etc.) — that lives in the plan.
    assert_no_imports(
        "playback/engine.rs",
        &["string_to_key", "string_to_button", "rdev::simulate"],
        "ADR-0003",
    );
}

#[test]
fn adr_0003_simulator_trait_owns_rdev_simulate_calls() {
    // ADR-0003: rdev::simulate is reachable only through the Simulator port.
    // Verify only ports.rs invokes it.
    for rel in rust_sources() {
        if rel.ends_with("ports.rs") {
            continue;
        }
        let content = read(&rel);
        // Whole-word check — "simulate" alone is too noisy (test helpers etc).
        assert!(
            !content.contains("rdev::simulate"),
            "ADR-0003 violated: {} calls rdev::simulate directly. \
             Go through the Simulator port (playback::ports::RdevSimulator).",
            rel
        );
    }
}

#[test]
fn adr_0004_recording_state_has_only_session_and_engine_fields() {
    // ADR-0004: RecordingState carries exactly two fields: `session` and
    // `engine`. New mutex fields would re-bloat the bag-of-state we
    // explicitly collapsed.
    let content = read("types.rs");
    // Find the RecordingState struct definition and walk until its closing
    // brace. Count `pub` lines inside as fields.
    let start = content
        .find("pub struct RecordingState")
        .expect("RecordingState struct missing");
    let after = &content[start..];
    let end = after.find('}').expect("RecordingState struct unterminated");
    let body = &after[..end];
    let field_lines: Vec<&str> = body
        .lines()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("pub ") && t.contains(':') && !t.starts_with("pub struct")
        })
        .collect();
    assert_eq!(
        field_lines.len(),
        2,
        "ADR-0004 violated: RecordingState has {} fields, expected exactly 2 \
         (session, engine). New fields belong inside RecordingSession or PlaybackEngine.\n\
         Fields found:\n{}",
        field_lines.len(),
        field_lines.join("\n")
    );
    let names: Vec<&str> = field_lines
        .iter()
        .map(|l| {
            l.trim()
                .strip_prefix("pub ")
                .and_then(|s| s.split(':').next())
                .unwrap_or("")
                .trim()
        })
        .collect();
    assert!(
        names.contains(&"session") && names.contains(&"engine"),
        "ADR-0004 violated: RecordingState fields are {:?}, expected [session, engine]",
        names
    );
}

/// All .rs files under src/ (recursive), as paths relative to src/.
fn rust_sources() -> Vec<String> {
    let mut out = Vec::new();
    walk(&src_dir(), &src_dir(), &mut out);
    out.sort();
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            out.push(rel);
        }
    }
}

/// All Rust sources except the named files (relative to src/).
fn modules_other_than(exclude: &[&str]) -> Vec<String> {
    rust_sources()
        .into_iter()
        .filter(|f| !exclude.iter().any(|e| f.ends_with(e)))
        .collect()
}
