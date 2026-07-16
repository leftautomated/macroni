//! Minimal Windows.Graphics.Capture adapter for the recorder's BGRA pipeline.
//! Keeping this boundary local avoids relying on wrappers that lag behind the
//! `windows-capture` frame API.

use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type HandlerError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug)]
pub struct BgraFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

struct CaptureHandler {
    frame_tx: SyncSender<BgraFrame>,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = SyncSender<BgraFrame>;
    type Error = HandlerError;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            frame_tx: context.flags,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let width = frame.width();
        let height = frame.height();
        let mut buffer = frame.buffer()?;
        let data = buffer.as_nopadding_buffer()?.to_vec();

        match self.frame_tx.try_send(BgraFrame {
            width,
            height,
            data,
        }) {
            Ok(()) | Err(TrySendError::Full(_)) => {}
            Err(TrySendError::Disconnected(_)) => capture_control.stop(),
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

pub struct Capturer {
    frame_rx: Receiver<BgraFrame>,
    control: Option<CaptureControl<CaptureHandler, HandlerError>>,
}

impl Capturer {
    pub fn start() -> Result<Self, String> {
        if !GraphicsCaptureApi::is_supported().map_err(|error| error.to_string())? {
            return Err("Screen capture requires Windows 10 version 1903 or newer".to_string());
        }

        let monitor = Monitor::primary().map_err(|error| error.to_string())?;
        let (frame_tx, frame_rx) = mpsc::sync_channel(3);
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::WithCursor,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            frame_tx,
        );
        let control = CaptureHandler::start_free_threaded(settings)
            .map_err(|error| format!("Failed to start Windows screen capture: {error}"))?;

        Ok(Self {
            frame_rx,
            control: Some(control),
        })
    }

    pub fn try_next_frame(&self) -> Result<Option<BgraFrame>, String> {
        match self.frame_rx.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err("Windows screen capture ended unexpectedly".to_string())
            }
        }
    }

    pub fn stop(mut self) -> Result<(), String> {
        let Some(control) = self.control.take() else {
            return Ok(());
        };
        control
            .stop()
            .map_err(|error| format!("Failed to stop Windows screen capture: {error}"))
    }
}
