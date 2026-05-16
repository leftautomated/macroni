//! Playback split: a pure `PlaybackPlan` describing the timeline of steps to
//! execute, and a `PlaybackEngine` that pumps the plan against a `Simulator`
//! and `Emitter` port.

pub mod engine;
pub mod plan;
pub mod ports;

pub use engine::PlaybackEngine;
pub use plan::PlaybackPlan;
pub use ports::{RdevSimulator, TauriEmitter};
