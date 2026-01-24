//! Configuration constants and settings for the application

/// Playback timing constants
pub mod playback {
    /// Initial delay before starting playback (ms)
    pub const INITIAL_DELAY_MS: u64 = 100;
    
    /// Delay after emitting first position (ms)
    pub const FIRST_POSITION_DELAY_MS: u64 = 50;
    
    /// Delay for first event simulation (ms)
    pub const FIRST_EVENT_DELAY_MS: u64 = 50;
    
    /// UI update delay when position changes (ms)
    pub const UI_UPDATE_DELAY_MS: u64 = 10;
    
    /// Minimum delay between mouse move events (ms)
    pub const MIN_MOUSE_MOVE_DELAY_MS: u64 = 5;
    
    /// Minimum delay between other events (ms)
    pub const MIN_EVENT_DELAY_MS: u64 = 1;
    
    /// Delay after simulating an event (ms)
    pub const POST_EVENT_DELAY_MS: u64 = 10;
    
    /// Delay before mouse button press/release after moving (ms)
    pub const MOUSE_ACTION_DELAY_MS: u64 = 10;
    
    /// Throttle UI updates for mouse moves (update every Nth event)
    pub const MOUSE_MOVE_UI_THROTTLE: usize = 3;
    
    /// Time threshold for mouse move UI updates (ms)
    pub const MOUSE_MOVE_TIME_THRESHOLD_MS: i64 = 50;
}

/// Recording constants
pub mod recording {
    /// Filename for saved recordings
    pub const RECORDINGS_FILE: &str = "recordings.json";
}

// Note: UI constants are defined in TypeScript config file

