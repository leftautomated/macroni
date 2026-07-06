//! Node-graph macro runtime: doc model, serde, and chain validation.
//!
//! A `MacroDoc` is a small directed graph of `MacroNode`s connected by
//! `MacroEdge`s. For Task 1 the graph is constrained to a single linear
//! chain (no forks, no cycles) — `chain_order` resolves that chain from an
//! arbitrarily-ordered node/edge list, and `validate_runnable` layers a
//! platform check (`WaitFor` nodes need macOS) on top.

pub mod store;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::perception::Target;
use crate::types::InputEvent;

fn default_speed() -> f64 {
    1.0
}

fn default_timeout_ms() -> u64 {
    10_000
}

fn default_poll_interval_ms() -> u64 {
    500
}

/// Links a `Segment` node back to the recording it was carved from, so the
/// editor can re-derive or re-slice the source clip later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(dead_code)] // consumed by Task 2 (store)
pub struct Provenance {
    pub recording_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
#[allow(dead_code)] // consumed by Task 4 (runner)
pub enum MacroNodeKind {
    Segment {
        events: Vec<InputEvent>,
        #[serde(default = "default_speed")]
        speed: f64,
        provenance: Option<Provenance>,
    },
    WaitFor {
        target: Target,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
        #[serde(default = "default_poll_interval_ms")]
        poll_interval_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(dead_code)] // consumed by Task 4 (runner)
pub struct MacroNode {
    pub id: String,
    pub kind: MacroNodeKind,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[allow(dead_code)] // consumed by Task 2 (store)
pub struct MacroDoc {
    pub id: String,
    pub name: String,
    pub nodes: Vec<MacroNode>,
    pub edges: Vec<MacroEdge>,
    pub created_at: i64,
}

#[derive(Debug, PartialEq)]
#[allow(dead_code)] // consumed by Task 2 (store) / Task 4 (runner)
pub enum MacroError {
    EmptyMacro,
    NotAChain,
    UnknownNode(String),
    DuplicateEdge,
    WaitUnsupportedPlatform,
}

impl std::fmt::Display for MacroError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MacroError::EmptyMacro => write!(f, "Macro has no nodes"),
            MacroError::NotAChain => write!(f, "Macro nodes must form a single linear chain"),
            MacroError::UnknownNode(id) => write!(f, "Edge references unknown node '{id}'"),
            MacroError::DuplicateEdge => write!(f, "Duplicate or conflicting edge"),
            MacroError::WaitUnsupportedPlatform => write!(f, "Wait nodes require macOS"),
        }
    }
}

/// Resolve `doc`'s nodes into a single linear order, if they form one.
///
/// Nodes may appear in any order in `doc.nodes`; edges define the chain.
/// Rejects: no nodes (`EmptyMacro`), edges naming a node id that doesn't
/// exist (`UnknownNode`), a node with more than one outgoing or incoming
/// edge — including a self-edge — (`DuplicateEdge`), and anything that
/// isn't exactly one linear path covering every node — forks, cycles,
/// disconnected/orphan nodes (`NotAChain`).
#[allow(dead_code)] // consumed by Task 2 (store) / Task 4 (runner)
pub fn chain_order(doc: &MacroDoc) -> Result<Vec<&MacroNode>, MacroError> {
    if doc.nodes.is_empty() {
        return Err(MacroError::EmptyMacro);
    }

    let by_id: HashMap<&str, &MacroNode> = doc.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut out_edge: HashMap<&str, &str> = HashMap::new();
    let mut in_degree: HashMap<&str, u32> = HashMap::new();
    let mut out_degree: HashMap<&str, u32> = HashMap::new();

    for e in &doc.edges {
        if !by_id.contains_key(e.from.as_str()) {
            return Err(MacroError::UnknownNode(e.from.clone()));
        }
        if !by_id.contains_key(e.to.as_str()) {
            return Err(MacroError::UnknownNode(e.to.clone()));
        }
        if e.from == e.to {
            return Err(MacroError::DuplicateEdge);
        }

        let from_out = out_degree.entry(e.from.as_str()).or_insert(0);
        *from_out += 1;
        if *from_out > 1 {
            return Err(MacroError::DuplicateEdge);
        }

        let to_in = in_degree.entry(e.to.as_str()).or_insert(0);
        *to_in += 1;
        if *to_in > 1 {
            return Err(MacroError::DuplicateEdge);
        }

        out_edge.insert(e.from.as_str(), e.to.as_str());
    }

    // Single node, no edges: trivially a valid one-node chain.
    if doc.nodes.len() == 1 && doc.edges.is_empty() {
        return Ok(vec![doc.nodes.first().expect("len checked above")]);
    }

    let starts: Vec<&str> = doc
        .nodes
        .iter()
        .map(|n| n.id.as_str())
        .filter(|id| *in_degree.get(id).unwrap_or(&0) == 0)
        .collect();
    let ends: Vec<&str> = doc
        .nodes
        .iter()
        .map(|n| n.id.as_str())
        .filter(|id| *out_degree.get(id).unwrap_or(&0) == 0)
        .collect();

    if starts.len() != 1 || ends.len() != 1 {
        return Err(MacroError::NotAChain);
    }

    let mut order = Vec::with_capacity(doc.nodes.len());
    let mut current = starts[0];
    loop {
        order.push(by_id[current]);
        match out_edge.get(current) {
            Some(next) => current = next,
            None => break,
        }
        // A degree-<=1-everywhere graph that isn't a single chain can only
        // be a cycle plus (possibly) disconnected pieces — walking would
        // loop forever without this guard.
        if order.len() > doc.nodes.len() {
            return Err(MacroError::NotAChain);
        }
    }

    if order.len() != doc.nodes.len() {
        return Err(MacroError::NotAChain);
    }

    Ok(order)
}

/// `chain_order` plus a platform check: `WaitFor` nodes are only runnable
/// on macOS (the only platform with a live perception probe).
#[allow(dead_code)] // consumed by Task 2 (store) / Task 4 (runner)
pub fn validate_runnable(doc: &MacroDoc) -> Result<(), MacroError> {
    let order = chain_order(doc)?;

    #[cfg(not(target_os = "macos"))]
    {
        if order
            .iter()
            .any(|n| matches!(n.kind, MacroNodeKind::WaitFor { .. }))
        {
            return Err(MacroError::WaitUnsupportedPlatform);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = order;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InputEvent;

    fn seg(id: &str) -> MacroNode {
        MacroNode {
            id: id.into(),
            kind: MacroNodeKind::Segment {
                events: vec![InputEvent::KeyPress {
                    key: "A".into(),
                    timestamp: 0,
                }],
                speed: 1.0,
                provenance: None,
            },
            x: 0.0,
            y: 0.0,
        }
    }
    fn edge(from: &str, to: &str) -> MacroEdge {
        MacroEdge {
            from: from.into(),
            to: to.into(),
        }
    }
    fn doc(nodes: Vec<MacroNode>, edges: Vec<MacroEdge>) -> MacroDoc {
        MacroDoc {
            id: "m1".into(),
            name: "test".into(),
            nodes,
            edges,
            created_at: 1,
        }
    }

    #[test]
    fn chain_order_resolves_a_valid_chain_regardless_of_vec_order() {
        let d = doc(
            vec![seg("c"), seg("a"), seg("b")],
            vec![edge("a", "b"), edge("b", "c")],
        );
        let order: Vec<&str> = chain_order(&d)
            .unwrap()
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn chain_order_single_node_no_edges_is_valid() {
        let d = doc(vec![seg("only")], vec![]);
        assert_eq!(chain_order(&d).unwrap().len(), 1);
    }

    #[test]
    fn chain_order_rejects_invalid_shapes_with_typed_errors() {
        assert_eq!(
            chain_order(&doc(vec![], vec![])),
            Err(MacroError::EmptyMacro)
        );
        // Fork: a -> b and a -> c.
        let fork = doc(
            vec![seg("a"), seg("b"), seg("c")],
            vec![edge("a", "b"), edge("a", "c")],
        );
        assert_eq!(chain_order(&fork), Err(MacroError::DuplicateEdge));
        // Cycle: a -> b -> a (no start node).
        let cycle = doc(
            vec![seg("a"), seg("b")],
            vec![edge("a", "b"), edge("b", "a")],
        );
        assert_eq!(chain_order(&cycle), Err(MacroError::NotAChain));
        // Orphan: two nodes, no edge between them (two starts).
        let orphan = doc(vec![seg("a"), seg("b")], vec![]);
        assert_eq!(chain_order(&orphan), Err(MacroError::NotAChain));
        // Unknown node id in an edge.
        let unknown = doc(vec![seg("a")], vec![edge("a", "ghost")]);
        assert_eq!(
            chain_order(&unknown),
            Err(MacroError::UnknownNode("ghost".into()))
        );
        // Self-edge.
        let selfe = doc(vec![seg("a")], vec![edge("a", "a")]);
        assert!(chain_order(&selfe).is_err());
    }

    #[test]
    fn macro_doc_serde_round_trips_with_house_tagging_and_defaults() {
        let d = doc(vec![seg("a")], vec![]);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"type\":\"Segment\""), "{json}");
        let back: MacroDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
        // Missing optional fields default.
        let wait_json = r#"{"id":"w","kind":{"type":"WaitFor","target":{"id":"t","name":"n","modality":"visual","region":{"x":0.1,"y":0.1,"w":0.1,"h":0.1},"kind":{"type":"TextOcr","expect":"Go"},"created_at":1}},"x":0,"y":0}"#;
        let node: MacroNode = serde_json::from_str(wait_json).unwrap();
        match node.kind {
            MacroNodeKind::WaitFor {
                timeout_ms,
                poll_interval_ms,
                ..
            } => {
                assert_eq!(timeout_ms, 10_000);
                assert_eq!(poll_interval_ms, 500);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn error_display_strings_are_stable() {
        assert_eq!(MacroError::EmptyMacro.to_string(), "Macro has no nodes");
        assert_eq!(
            MacroError::NotAChain.to_string(),
            "Macro nodes must form a single linear chain"
        );
        assert_eq!(
            MacroError::UnknownNode("x".into()).to_string(),
            "Edge references unknown node 'x'"
        );
        assert_eq!(
            MacroError::DuplicateEdge.to_string(),
            "Duplicate or conflicting edge"
        );
        assert_eq!(
            MacroError::WaitUnsupportedPlatform.to_string(),
            "Wait nodes require macOS"
        );
    }
}
