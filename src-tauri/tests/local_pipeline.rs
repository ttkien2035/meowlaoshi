//! End-to-end Local pipeline against real models (ignored; QA runs it):
//!   MT_TEST_XASR_DIR=<extracted x-asr punct dir> MT_TEST_VAD=<silero_vad.onnx> \
//!   MT_TEST_LONG_WAV=<16 kHz mono wav with continuous speech + babble> \
//!   cargo test --release --test local_pipeline -- --ignored --nocapture
//! Checks the utterance cap: under continuous babble sherpa's VAD produced a
//! 46 s segment (translation 46 s late; X-ASR aborts at ≥ 50 s). With the
//! pipeline's own cut, 130 s of such audio must yield many short utterances
//! and no error.
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use my_translator_lib::test_api::*;

struct Echo;
impl Translator for Echo {
    fn translate(&self, req: &TranslateRequest, _cancel: &AtomicBool, _partial: &mut dyn FnMut(&str)) -> Result<String, String> {
        Ok(req.text.to_string())
    }
}

fn read_wav(p: &Path) -> Vec<i16> {
    let b = std::fs::read(p).expect("wav");
    let mut pos = 12;
    while pos + 8 <= b.len() {
        let size = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        if &b[pos..pos + 4] == b"data" {
            let d = &b[pos + 8..(pos + 8 + size).min(b.len())];
            return (0..d.len() / 2).map(|i| i16::from_le_bytes([d[2 * i], d[2 * i + 1]])).collect();
        }
        pos += 8 + size + (size & 1);
    }
    panic!("no data chunk");
}

#[test]
#[ignore]
fn long_speech_is_cut_into_short_utterances() {
    let (Ok(asr_dir), Ok(vad), Ok(wav)) = (
        std::env::var("MT_TEST_XASR_DIR"),
        std::env::var("MT_TEST_VAD"),
        std::env::var("MT_TEST_LONG_WAV"),
    ) else {
        eprintln!("MT_TEST_XASR_DIR / MT_TEST_VAD / MT_TEST_LONG_WAV not set; skipping");
        return;
    };
    let asr_dir = PathBuf::from(asr_dir);
    ensure_bpe_vocab(&asr_dir).expect("bpe.vocab");
    let events: Arc<Mutex<Vec<LocalEvent>>> = Arc::default();
    let sink = {
        let events = events.clone();
        Box::new(move |e: LocalEvent| events.lock().unwrap().push(e))
    };
    let cfg = SessionConfig {
        asr: AsrFiles::in_dir(&asr_dir),
        llm_model: PathBuf::from("/unused-stub"),
        vad_model: PathBuf::from(vad),
        source_lang_name: "Chinese".into(),
        target_lang_name: "Vietnamese".into(),
        glossary: vec![("资产负债表".into(), "bảng cân đối kế toán".into())],
        timing: Default::default(),
    };
    let factory: TranslatorFactory = Box::new(|| Ok(Box::new(Echo) as Box<dyn Translator>));
    let mut session = start_with_translator(cfg, sink, factory).expect("start");

    // Seconds 200–330 of the file: continuous lecturer + babble, where the
    // uncut VAD produced 19 s, 19 s and 46 s segments.
    let pcm = read_wav(Path::new(&wav));
    let (from, to) = (200 * 16000, (330 * 16000).min(pcm.len()));
    // 200 ms chunks, paced at 10× real time: `push_audio` drops when the
    // 10 s queue is full, and this test is about cutting, not backlog.
    for chunk in pcm[from..to].chunks(3200) {
        session.push_audio(chunk.iter().flat_map(|s| s.to_le_bytes()).collect()).expect("audio accepted");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    session.finish();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if events.lock().unwrap().iter().any(|e| matches!(e, LocalEvent::Closed { .. })) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let events = events.lock().unwrap();
    let results: Vec<&str> = events.iter().filter_map(|e| match e { LocalEvent::Result { src, .. } => Some(src.as_str()), _ => None }).collect();
    let errors: Vec<&LocalEvent> = events.iter().filter(|e| matches!(e, LocalEvent::Error { .. })).collect();
    for r in &results {
        eprintln!("  → {r}");
    }
    eprintln!("{} utterances, {} errors", results.len(), errors.len());
    assert!(errors.is_empty(), "{errors:?}");
    assert!(events.iter().any(|e| matches!(e, LocalEvent::Closed { .. })), "session did not close");
    assert!(results.len() >= 9, "expected the 130 s to be cut into ≥ 9 utterances, got {}", results.len());
}
