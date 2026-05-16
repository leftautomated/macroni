//! Playback split: a pure `PlaybackPlan` describing the timeline of steps to
//! execute, and a `PlaybackEngine` that pumps the plan against a `Simulator`
//! and `Emitter` port.

pub mod plan;
pub mod engine;
pub mod ports;

pub use plan::PlaybackPlan;
pub use engine::PlaybackEngine;
pub use ports::{RdevSimulator, TauriEmitter};
