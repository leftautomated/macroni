/**
 * Application configuration constants
 * Single source of truth for all configuration values
 */

export const PLAYBACK_CONFIG = {
  /** Initial delay before starting playback (ms) */
  INITIAL_DELAY_MS: 100,
  
  /** Delay after emitting first position (ms) */
  FIRST_POSITION_DELAY_MS: 50,
  
  /** Delay for first event simulation (ms) */
  FIRST_EVENT_DELAY_MS: 50,
  
  /** UI update delay when position changes (ms) */
  UI_UPDATE_DELAY_MS: 10,
  
  /** Minimum delay between mouse move events (ms) */
  MIN_MOUSE_MOVE_DELAY_MS: 5,
  
  /** Minimum delay between other events (ms) */
  MIN_EVENT_DELAY_MS: 1,
  
  /** Delay after simulating an event (ms) */
  POST_EVENT_DELAY_MS: 10,
  
  /** Delay before mouse button press/release after moving (ms) */
  MOUSE_ACTION_DELAY_MS: 10,
  
  /** Throttle UI updates for mouse moves (update every Nth event) */
  MOUSE_MOVE_UI_THROTTLE: 3,
  
  /** Time threshold for mouse move UI updates (ms) */
  MOUSE_MOVE_TIME_THRESHOLD_MS: 50,
} as const;

export const UI_CONFIG = {
  /** Frontend scroll throttle delay (ms) */
  SCROLL_THROTTLE_MS: 50,
  
  /** Playback status polling interval (ms) */
  PLAYBACK_STATUS_POLL_MS: 100,
} as const;

export const RECORDING_CONFIG = {
  /** Filename for saved recordings */
  RECORDINGS_FILE: "recordings.json",
} as const;

