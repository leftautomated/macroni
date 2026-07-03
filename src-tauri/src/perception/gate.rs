//! Rate limiter for the continuous capture tee. Keeps the perception worker at
//! ~1–2 fps regardless of the capture fps, so OCR never chases the encoder.

pub const SAMPLE_INTERVAL_MS: i64 = 750;

pub struct SampleGate {
    interval_ms: i64,
    last: Option<i64>,
}

impl SampleGate {
    pub fn new(interval_ms: i64) -> Self {
        Self {
            interval_ms,
            last: None,
        }
    }

    /// First call is always due; subsequent calls are due only once
    /// `interval_ms` has elapsed since the last due sample.
    pub fn due(&mut self, now_ms: i64) -> bool {
        match self.last {
            Some(t) if now_ms - t < self.interval_ms => false,
            _ => {
                self.last = Some(now_ms);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_passes_first_then_rate_limits() {
        let mut g = SampleGate::new(750);
        assert!(g.due(1_000));
        assert!(!g.due(1_500));
        assert!(!g.due(1_749));
        assert!(g.due(1_750));
        assert!(g.due(10_000));
    }
}
