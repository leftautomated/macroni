//! macOS Vision OCR. Kept behind the Extractor seam; this file is excluded
//! from the coverage gate (not CI-testable) and verified manually via the
//! Studio "Test" buttons.

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequestTextRecognitionLevel};

pub struct RecognizedSpan {
    pub text: String,
    pub confidence: f32,
    /// Vision-normalized [x, y, w, h], bottom-left origin, crop-relative.
    pub bbox: [f32; 4],
}

/// Run Vision text recognition over a PNG-encoded crop. `fast` picks the Fast
/// recognition level (used by continuous capture); on-demand uses Accurate.
pub fn recognize(png: &[u8], fast: bool) -> Result<Vec<RecognizedSpan>, String> {
    unsafe {
        let data = NSData::with_bytes(png);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(if fast {
            VNRequestTextRecognitionLevel::Fast
        } else {
            VNRequestTextRecognitionLevel::Accurate
        });
        // performRequests wants an NSArray<VNRequest>; upcast the concrete
        // request (VNRecognizeTextRequest -> VNImageBasedRequest -> VNRequest).
        let requests = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(
            request.clone(),
        ))]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| e.to_string())?;
        let Some(results) = request.results() else {
            return Ok(Vec::new());
        };
        let mut spans = Vec::new();
        for obs in results.iter() {
            let Some(candidate) = obs.topCandidates(1).firstObject() else {
                continue;
            };
            let rect = obs.boundingBox();
            spans.push(RecognizedSpan {
                text: candidate.string().to_string(),
                confidence: candidate.confidence(),
                bbox: [
                    rect.origin.x as f32,
                    rect.origin.y as f32,
                    rect.size.width as f32,
                    rect.size.height as f32,
                ],
            });
        }
        Ok(spans)
    }
}
