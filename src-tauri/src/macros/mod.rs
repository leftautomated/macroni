//! Reactive-rules macro runtime: doc model, serde, and rule validation.
//!
//! A `MacroDoc` is an unordered-in-storage, ordered-in-list set of
//! `MacroRule`s. Each rule pairs a perception `Target` (the trigger) with a
//! `RuleAction` (what to do when it matches). List order is priority order:
//! the watcher loop in `runner.rs` evaluates rules top-to-bottom each tick
//! and fires the first armed match. `validate_runnable` checks the doc is
//! non-trivially runnable (at least one enabled rule, no empty actions) and
//! gates on the platform (every rule needs the live perception probe).

pub mod commands;
#[cfg(target_os = "macos")]
pub mod probe;
pub mod runner;
pub mod store;

use serde::{Deserialize, Serialize};

use crate::perception::Target;
use crate::types::InputEvent;

fn default_speed() -> f64 {
    1.0
}

fn default_poll_interval_ms() -> u64 {
    250
}

fn default_true() -> bool {
    true
}

/// Links a `PlayInputs` action back to the recording range it was carved from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    pub recording_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// The recording frame a rule's trigger was authored on, so the editor can
/// seek back to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuleAnchor {
    pub recording_id: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum RuleAction {
    PlayInputs {
        events: Vec<InputEvent>,
        #[serde(default = "default_speed")]
        speed: f64,
        provenance: Option<Provenance>,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroRule {
    pub id: String,
    pub trigger: Target,
    pub action: RuleAction,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub anchor: Option<RuleAnchor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroDoc {
    pub id: String,
    pub name: String,
    pub rules: Vec<MacroRule>,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
    pub created_at: i64,
}

#[derive(Debug, PartialEq)]
#[allow(dead_code)] // WaitUnsupportedPlatform only constructed off-macOS
pub enum MacroError {
    NoEnabledRules,
    EmptyAction(String),
    WaitUnsupportedPlatform,
}

impl std::fmt::Display for MacroError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MacroError::NoEnabledRules => write!(f, "Macro has no enabled rules"),
            MacroError::EmptyAction(id) => write!(f, "Rule '{id}' plays no events"),
            MacroError::WaitUnsupportedPlatform => {
                write!(f, "Reactive macros require macOS")
            }
        }
    }
}

/// Runnable = at least one enabled rule, every enabled PlayInputs rule has
/// events, and (off macOS) never — every rule needs the perception probe.
pub fn validate_runnable(doc: &MacroDoc) -> Result<(), MacroError> {
    let enabled: Vec<&MacroRule> = doc.rules.iter().filter(|r| r.enabled).collect();
    if enabled.is_empty() {
        return Err(MacroError::NoEnabledRules);
    }
    for rule in &enabled {
        if let RuleAction::PlayInputs { events, .. } = &rule.action {
            if events.is_empty() {
                return Err(MacroError::EmptyAction(rule.id.clone()));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        return Err(MacroError::WaitUnsupportedPlatform);
    }
    #[cfg(target_os = "macos")]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{Modality, Region, Target, TargetKind};
    use crate::types::InputEvent;

    fn text_trigger(id: &str) -> Target {
        Target {
            id: id.into(),
            name: "t".into(),
            modality: Modality::Visual,
            region: Some(Region {
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.05,
            }),
            kind: TargetKind::TextOcr {
                expect: Some("Go".into()),
            },
            created_at: 1,
        }
    }

    fn play_rule(id: &str) -> MacroRule {
        MacroRule {
            id: id.into(),
            trigger: text_trigger("t1"),
            action: RuleAction::PlayInputs {
                events: vec![InputEvent::KeyPress {
                    key: "A".into(),
                    timestamp: 0,
                }],
                speed: 1.0,
                provenance: None,
            },
            enabled: true,
            anchor: None,
        }
    }

    fn doc(rules: Vec<MacroRule>) -> MacroDoc {
        MacroDoc {
            id: "m1".into(),
            name: "test".into(),
            rules,
            poll_interval_ms: 250,
            created_at: 1,
        }
    }

    #[test]
    fn serde_round_trips_with_tagging_and_defaults() {
        let d = doc(vec![play_rule("r1")]);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"type\":\"PlayInputs\""), "{json}");
        let back: MacroDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
        // enabled / anchor / poll_interval_ms default when omitted.
        let minimal = r#"{"id":"m","name":"n","created_at":1,"rules":[{"id":"r","trigger":{"id":"t","name":"n","modality":"visual","region":null,"kind":{"type":"TextOcr","expect":"Go"},"created_at":1},"action":{"type":"Stop"}}]}"#;
        let back: MacroDoc = serde_json::from_str(minimal).unwrap();
        assert_eq!(back.poll_interval_ms, 250);
        assert!(back.rules[0].enabled);
        assert!(back.rules[0].anchor.is_none());
    }

    #[test]
    fn old_node_graph_docs_fail_to_deserialize() {
        let old = r#"{"id":"m","name":"n","nodes":[],"edges":[],"created_at":1}"#;
        assert!(serde_json::from_str::<MacroDoc>(old).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn validate_requires_an_enabled_rule_with_events() {
        assert_eq!(
            validate_runnable(&doc(vec![])),
            Err(MacroError::NoEnabledRules)
        );
        let mut disabled = play_rule("r1");
        disabled.enabled = false;
        assert_eq!(
            validate_runnable(&doc(vec![disabled])),
            Err(MacroError::NoEnabledRules)
        );
        let mut empty = play_rule("r2");
        empty.action = RuleAction::PlayInputs {
            events: vec![],
            speed: 1.0,
            provenance: None,
        };
        assert_eq!(
            validate_runnable(&doc(vec![empty])),
            Err(MacroError::EmptyAction("r2".into()))
        );
        assert_eq!(validate_runnable(&doc(vec![play_rule("r3")])), Ok(()));
        // A Stop-only doc is technically runnable (silly but harmless).
        let stop = MacroRule {
            id: "s".into(),
            trigger: text_trigger("t"),
            action: RuleAction::Stop,
            enabled: true,
            anchor: None,
        };
        assert_eq!(validate_runnable(&doc(vec![stop])), Ok(()));
    }

    #[test]
    fn error_display_strings_are_stable() {
        assert_eq!(
            MacroError::NoEnabledRules.to_string(),
            "Macro has no enabled rules"
        );
        assert_eq!(
            MacroError::EmptyAction("x".into()).to_string(),
            "Rule 'x' plays no events"
        );
        assert_eq!(
            MacroError::WaitUnsupportedPlatform.to_string(),
            "Reactive macros require macOS"
        );
    }
}
