//! Local mode latency probe against real models (ignored; for tuning `Timing`):
//!   MT_TEST_XASR_DIR=<extracted x-asr punct dir> MT_TEST_VAD=<silero_vad.onnx> \
//!   MT_TEST_LECTURE_WAV=<16 kHz mono wav> MT_TEST_TIMING=<min_silence,soft,hard,pause> \
//!   [MT_TEST_CHUNK_MS=100] \
//!   MT_TEST_OUT=<events.jsonl> \
//!   cargo test --release --test local_latency -- --ignored --nocapture
//! Streams the wav at real-time pace in 100 ms chunks (as the app captures)
//! through VAD → ASR → a stub translator that takes as long as Hy-MT2 on an
//! M-series Mac (≈ 0.15 s + 15 ms per source character), and writes one JSON
//! line per transcript / result with its wall time since the first chunk.
//! Because the audio is real time, "wall ms − end_ms" is how far behind the
//! lecturer that text shows up.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use my_translator_lib::test_api::*;

struct SlowEcho;
impl Translator for SlowEcho {
    fn translate(&self, req: &TranslateRequest, _cancel: &AtomicBool, _partial: &mut dyn FnMut(&str)) -> Result<String, String> {
        let chars = req.text.chars().count() as u64;
        std::thread::sleep(Duration::from_millis(150 + 15 * chars));
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

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[test]
#[ignore]
fn lecture_latency_probe() {
    let (Ok(asr_dir), Ok(vad), Ok(wav), Ok(out)) = (
        std::env::var("MT_TEST_XASR_DIR"),
        std::env::var("MT_TEST_VAD"),
        std::env::var("MT_TEST_LECTURE_WAV"),
        std::env::var("MT_TEST_OUT"),
    ) else {
        eprintln!("MT_TEST_XASR_DIR / MT_TEST_VAD / MT_TEST_LECTURE_WAV / MT_TEST_OUT not set; skipping");
        return;
    };
    let timing = match std::env::var("MT_TEST_TIMING") {
        Ok(v) => {
            let n: Vec<f32> = v.split(',').map(|x| x.trim().parse().expect("MT_TEST_TIMING: min_silence,soft,hard,pause")).collect();
            Timing { min_silence_s: n[0], soft_cut_s: n[1], hard_cut_s: n[2], pause_s: n[3] }
        }
        Err(_) => Timing::default(),
    };
    let asr_dir = PathBuf::from(asr_dir);
    ensure_bpe_vocab(&asr_dir).expect("bpe.vocab");
    let t0: Arc<Mutex<Option<Instant>>> = Arc::default();
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let closed = Arc::new(AtomicBool::new(false));
    let sink = {
        let (t0, lines, closed) = (t0.clone(), lines.clone(), closed.clone());
        Box::new(move |e: LocalEvent| {
            let at = t0.lock().unwrap().map_or(0, |t| t.elapsed().as_millis() as u64);
            let line = match &e {
                LocalEvent::Transcript { src, start_ms, end_ms } => {
                    format!("{{\"k\":\"transcript\",\"at\":{at},\"start\":{start_ms},\"end\":{end_ms},\"src\":{}}}", json_str(src))
                }
                LocalEvent::Result { src, start_ms, end_ms, .. } => {
                    format!("{{\"k\":\"result\",\"at\":{at},\"start\":{start_ms},\"end\":{end_ms},\"src\":{}}}", json_str(src))
                }
                LocalEvent::Partial { start_ms, .. } => format!("{{\"k\":\"partial\",\"at\":{at},\"start\":{start_ms}}}"),
                LocalEvent::Status { state, .. } => format!("{{\"k\":\"status\",\"at\":{at},\"state\":{}}}", json_str(state)),
                LocalEvent::Error { code, message } => {
                    format!("{{\"k\":\"error\",\"at\":{at},\"code\":{},\"message\":{}}}", json_str(code), json_str(message))
                }
                LocalEvent::Closed { .. } => {
                    closed.store(true, std::sync::atomic::Ordering::SeqCst);
                    format!("{{\"k\":\"closed\",\"at\":{at}}}")
                }
            };
            lines.lock().unwrap().push(line);
        })
    };
    let cfg = SessionConfig {
        asr: AsrFiles::in_dir(&asr_dir),
        llm_model: PathBuf::from("/unused-stub"),
        vad_model: PathBuf::from(vad),
        source_lang_name: "Chinese".into(),
        target_lang_name: "Vietnamese".into(),
        glossary: vec![],
        timing,
    };
    let factory: TranslatorFactory = Box::new(|| Ok(Box::new(SlowEcho) as Box<dyn Translator>));
    let mut session = start_with_translator(cfg, sink, factory).expect("start");
    // Let the models load before the clock starts, as the app does.
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !lines.lock().unwrap().iter().any(|l| l.contains("\"ready\"")) {
        std::thread::sleep(Duration::from_millis(50));
    }

    let pcm = read_wav(Path::new(&wav));
    let start = Instant::now();
    *t0.lock().unwrap() = Some(start);
    let chunk_ms: u64 = std::env::var("MT_TEST_CHUNK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(100);
    for (k, chunk) in pcm.chunks(16 * chunk_ms as usize).enumerate() {
        let due = start + Duration::from_millis(chunk_ms * k as u64);
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        session.push_audio(chunk.iter().flat_map(|s| s.to_le_bytes()).collect()).expect("audio accepted");
    }
    session.finish();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !closed.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let lines = lines.lock().unwrap();
    let mut f = std::fs::File::create(&out).expect("out");
    for l in lines.iter() {
        writeln!(f, "{l}").unwrap();
    }
    eprintln!("{timing:?}: {} events → {out}", lines.len());
    assert!(!lines.iter().any(|l| l.contains("\"k\":\"error\"")), "pipeline error");
}
