//! Translation LLM for the Local engine: a GGUF model through llama.cpp —
//! Metal on Apple Silicon, CPU elsewhere. The default is Tencent Hy-MT2-1.8B
//! (Q6_K), a dedicated translation model; any instruct GGUF works as a custom
//! model. One model per session; a fresh context per sentence, which is cheap
//! and keeps sentences independent (no KV cache to manage).
//!
//! Prompts come in two families (see [`PromptFamily`]): Hy-MT takes the fixed
//! instruction from its model card in the user turn and no system prompt;
//! every other model gets a system prompt with role, languages and glossary.

use std::fmt::Write as _;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::TokenToStringError;

/// Context window per translation: instruction + glossary hits + sentence + output.
const N_CTX: u32 = 2048;
const MAX_NEW_TOKENS: usize = 256;
/// How often a growing translation is reported to the UI.
const PARTIAL_EVERY: Duration = Duration::from_millis(120);
/// Glossary entries injected per sentence (only those whose source term occurs in it).
const MAX_GLOSSARY_HITS: usize = 12;

/// llama.cpp's global backend: initialised once per process, never torn down.
static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();

fn backend() -> Result<&'static LlamaBackend, String> {
    BACKEND
        .get_or_init(|| {
            LlamaBackend::init()
                .map(|mut b| {
                    b.void_logs(); // llama.cpp is chatty; errors surface through Results
                    b
                })
                .map_err(|e| format!("llama backend init: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub struct TranslateRequest<'a> {
    pub text: &'a str,
    /// Language names for the prompt ("Chinese", "Vietnamese").
    pub source_lang: &'a str,
    pub target_lang: &'a str,
    pub glossary: &'a [(String, String)],
}

/// How the prompt is worded for the loaded model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptFamily {
    /// Tencent Hy-MT / Hunyuan-MT: no system prompt; the model card's fixed
    /// instruction (glossary as "参考下面的翻译") goes in the user turn.
    HyMt,
    /// Any other instruct model: system prompt (role, languages, glossary),
    /// then the sentence as the user turn.
    Chat,
}

impl PromptFamily {
    /// Hy-MT GGUFs carry no usable model name (`general.name` is a training
    /// step), so: a Hunyuan architecture plus "MT" in the file name — true
    /// for the bundled download and for Tencent's published file names.
    fn detect(arch: &str, file_name: &str) -> Self {
        let hunyuan = arch.starts_with("hunyuan") || arch.starts_with("hy_");
        let name = file_name.to_ascii_lowercase();
        let mt = ["hy-mt", "hy_mt", "hunyuan-mt"].iter().any(|k| name.contains(k));
        if hunyuan && mt {
            Self::HyMt
        } else {
            Self::Chat
        }
    }
}

pub struct Llm {
    model: LlamaModel,
    template: LlamaChatTemplate,
    threads: i32,
    family: PromptFamily,
    /// Render Hunyuan's dense template (`<｜hy_User｜>` … `<｜hy_Assistant｜>`)
    /// by hand: llama.cpp's legacy detector mistakes it for HunyuanVL and puts
    /// the text before `<｜hy_User｜>` with no assistant turn.
    hy_dense: bool,
    /// Qwen3-style hybrid template: prefill an empty think block so the
    /// model answers straight away instead of reasoning first.
    no_think: bool,
    /// BOS text when the model wants one (Gemma: without BOS it emits
    /// nothing); prepended unless the rendered prompt already starts with it.
    bos: Option<String>,
}

impl Llm {
    pub fn load(path: &Path, threads: i32) -> Result<Self, String> {
        let backend = backend()?;
        // All layers on the GPU where Metal is compiled in; ignored on CPU builds.
        let gpu_layers = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            999
        } else {
            0
        };
        let params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
        let model = LlamaModel::load_from_file(backend, path, &params)
            .map_err(|e| format!("load {}: {e}", path.display()))?;
        let template = model
            .chat_template(None)
            .map_err(|e| format!("model has no chat template: {e}"))?;

        let template_src = template.to_str().unwrap_or("");
        let arch = model.meta_val_str("general.architecture").unwrap_or_default();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let family = PromptFamily::detect(&arch, file_name);
        let hy_dense = template_src.contains("<｜hy_User｜>") && template_src.contains("<｜hy_Assistant｜>");
        let no_think = template_src.contains("enable_thinking");
        let bos = wants_bos(
            model.meta_val_str("tokenizer.ggml.add_bos_token").ok().as_deref(),
            model.meta_val_str("tokenizer.ggml.model").ok().as_deref(),
        )
        .then(|| model.token_to_piece_bytes(model.token_bos(), 64, true, None).ok())
        .flatten()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .filter(|s| !s.is_empty());

        Ok(Self {
            model,
            template,
            threads: threads.max(1),
            family,
            hy_dense,
            no_think,
            bos,
        })
    }

    /// Decode a single token once right after load. On Metal the first
    /// decode compiles ggml's kernels (~13 s the first time on a machine);
    /// doing it here, while the UI shows "khởi tạo Metal", keeps that cost off
    /// the first real sentence. No-op on CPU builds. Failures are ignored —
    /// the first translation simply pays the cost instead.
    pub fn warm_up(&self) {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return;
        }
        let Ok(backend) = backend() else { return };
        let Ok(tokens) = self.model.str_to_token("Hi", AddBos::Never) else { return };
        let Some(&tok) = tokens.first() else { return };
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_batch(512)
            .with_n_threads(self.threads)
            .with_n_threads_batch(self.threads);
        let Ok(mut ctx) = self.model.new_context(backend, ctx_params) else { return };
        let mut batch = LlamaBatch::new(1, 1);
        if batch.add(tok, 0, &[0], true).is_ok() {
            let _ = ctx.decode(&mut batch);
        }
    }

    /// Translate one sentence. `cancel` aborts generation between tokens
    /// (returns an empty string) so a stop never waits for a full sentence.
    ///
    /// Greedy decoding: deterministic, and measured on 25 lecture sentences
    /// Hy-MT2 needs no sampling tricks to stay clean (0 untranslated Chinese
    /// fragments, vs 15/25 for the former Qwen2.5-3B default).
    ///
    /// `partial` gets the translation so far, whole words only, at most every
    /// PARTIAL_EVERY while tokens come out, so the UI can show the first
    /// words before the sentence is done.
    pub fn translate(&self, req: &TranslateRequest, cancel: &AtomicBool, partial: &mut dyn FnMut(&str)) -> Result<String, String> {
        let prompt = self.render(req)?;
        self.generate(&prompt, LlamaSampler::greedy(), cancel, partial)
    }

    /// The full prompt text for one sentence, special tokens included.
    fn render(&self, req: &TranslateRequest) -> Result<String, String> {
        let (system, user) = match self.family {
            PromptFamily::HyMt => (None, hymt_prompt(req)),
            PromptFamily::Chat => (Some(chat_system_prompt(req)), req.text.to_string()),
        };
        let mut prompt = if self.hy_dense {
            hy_dense_render(system.as_deref(), &user)
        } else {
            let mut messages = Vec::with_capacity(2);
            if let Some(system) = system {
                messages.push(LlamaChatMessage::new("system".into(), system));
            }
            messages.push(LlamaChatMessage::new("user".into(), user));
            let messages = messages
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("message: {e}"))?;
            self.model
                .apply_chat_template(&self.template, &messages, true)
                .map_err(|e| format!("apply chat template: {e}"))?
        };
        if self.no_think {
            prompt.push_str("<think>\n\n</think>\n\n");
        }
        Ok(prompt)
    }

    /// Greedy/sampled completion of an already rendered prompt.
    fn generate(
        &self,
        prompt: &str,
        mut sampler: LlamaSampler,
        cancel: &AtomicBool,
        partial: &mut dyn FnMut(&str),
    ) -> Result<String, String> {
        let backend = backend()?;
        let add_bos = if needs_bos(self.bos.as_deref(), prompt) {
            AddBos::Always
        } else {
            AddBos::Never // the template carries its own special tokens
        };
        let tokens = self
            .model
            .str_to_token(prompt, add_bos)
            .map_err(|e| format!("tokenize: {e}"))?;
        if tokens.is_empty() {
            return Ok(String::new());
        }
        let max_prompt = (N_CTX as usize).saturating_sub(MAX_NEW_TOKENS + 8);
        if tokens.len() > max_prompt {
            return Err(format!("sentence too long ({} tokens)", tokens.len()));
        }

        // The whole prompt goes in one batch.
        let n_batch = tokens.len().max(512);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_batch(n_batch as u32)
            .with_n_threads(self.threads)
            .with_n_threads_batch(self.threads);
        let mut ctx = self
            .model
            .new_context(backend, ctx_params)
            .map_err(|e| format!("context: {e}"))?;

        let mut batch = LlamaBatch::new(n_batch, 1);
        let last = tokens.len() - 1;
        for (i, tok) in tokens.iter().enumerate() {
            batch
                .add(*tok, i as i32, &[0], i == last)
                .map_err(|e| format!("batch: {e}"))?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| format!("prompt decode: {e}"))?;

        let mut out: Vec<u8> = Vec::with_capacity(512);
        // None until the first report: the first words go out at once.
        let mut last_partial: Option<Instant> = None;
        // `pos` is the KV position of each newly generated token.
        for pos in (tokens.len() as i32..).take(MAX_NEW_TOKENS) {
            if cancel.load(Ordering::SeqCst) {
                return Ok(String::new());
            }
            let tok = sampler.sample(&ctx, -1);
            sampler.accept(tok);
            if self.model.is_eog_token(tok) {
                break;
            }
            // Bytes, not strings: a UTF-8 character (Chinese, Vietnamese
            // diacritics) can span several tokens.
            let piece = self.piece_bytes(tok)?;
            // A piece opening with a space starts a new word, so `out` holds
            // whole words: report them (no half word, no split character).
            if piece.first() == Some(&b' ') && last_partial.is_none_or(|t| t.elapsed() >= PARTIAL_EVERY) {
                if let Ok(so_far) = std::str::from_utf8(&out) {
                    let so_far = clean_output(so_far);
                    if !so_far.is_empty() {
                        partial(&so_far);
                        last_partial = Some(Instant::now());
                    }
                }
            }
            out.extend(piece);
            batch.clear();
            batch
                .add(tok, pos, &[0], true)
                .map_err(|e| format!("batch: {e}"))?;
            ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;
        }
        Ok(clean_output(&String::from_utf8_lossy(&out)))
    }

    fn piece_bytes(&self, tok: LlamaToken) -> Result<Vec<u8>, String> {
        match self.model.token_to_piece_bytes(tok, 16, false, None) {
            Ok(b) => Ok(b),
            Err(TokenToStringError::InsufficientBufferSpace(n)) => self
                .model
                .token_to_piece_bytes(tok, usize::try_from(-n).unwrap_or(64).max(1), false, None)
                .map_err(|e| format!("token piece: {e}")),
            Err(e) => Err(format!("token piece: {e}")),
        }
    }
}

/// Whether the tokenizer expects a BOS token, as llama.cpp decides it: the
/// GGUF flag when present, else the vocab type's default (SPM and WPM add
/// one; BPE and the rest don't).
fn wants_bos(add_bos_flag: Option<&str>, tokenizer_model: Option<&str>) -> bool {
    match add_bos_flag {
        Some(flag) => flag == "true",
        None => matches!(tokenizer_model, Some("llama" | "bert")),
    }
}

/// Prepend BOS only when the model wants one and the template didn't add it.
fn needs_bos(bos: Option<&str>, prompt: &str) -> bool {
    bos.is_some_and(|b| !prompt.starts_with(b))
}

/// Hunyuan dense chat template, as the GGUF's own Jinja renders it.
fn hy_dense_render(system: Option<&str>, user: &str) -> String {
    let mut s = String::with_capacity(user.len() + system.map_or(0, str::len) + 96);
    s.push_str("<｜hy_begin▁of▁sentence｜>");
    if let Some(system) = system {
        s.push_str(system);
        s.push_str("<｜hy_place▁holder▁no▁3｜>");
    }
    s.push_str("<｜hy_User｜>");
    s.push_str(user);
    s.push_str("<｜hy_Assistant｜>");
    s
}

/// Glossary entries whose source term occurs in the sentence.
fn glossary_hits<'a>(req: &TranslateRequest<'a>) -> impl Iterator<Item = (&'a str, &'a str)> + 'a {
    let text = req.text;
    req.glossary
        .iter()
        .filter(move |(src, _)| text.contains(src.as_str()))
        .take(MAX_GLOSSARY_HITS)
        .map(|(src, tgt)| (src.as_str(), tgt.as_str()))
}

/// Chinese name of a prompt language, for Hy-MT's Chinese instruction.
fn chinese_lang_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "Chinese" => "中文",
        "Vietnamese" => "越南语",
        "English" => "英语",
        "Japanese" => "日语",
        "Korean" => "韩语",
        "French" => "法语",
        "German" => "德语",
        "Spanish" => "西班牙语",
        "Russian" => "俄语",
        "Thai" => "泰语",
        _ => return None,
    })
}

/// Hy-MT user turn, worded exactly as the model card's "Default" and
/// "Terminology" prompts: the Chinese instruction when Chinese is one side
/// of the pair (the model's main direction), the English one otherwise.
fn hymt_prompt(req: &TranslateRequest) -> String {
    let hits: Vec<(&str, &str)> = glossary_hits(req).collect();
    let mut p = String::with_capacity(160 + req.text.len() + hits.len() * 48);
    let chinese_pair = req.source_lang == "Chinese" || req.target_lang == "Chinese";
    match chinese_lang_name(req.target_lang).filter(|_| chinese_pair) {
        Some(target) => {
            if !hits.is_empty() {
                p.push_str("参考下面的翻译：\n");
                for (src, tgt) in &hits {
                    let _ = writeln!(p, "{src} 翻译成 {tgt}");
                }
            }
            let _ = write!(p, "将以下文本翻译为{target}，注意只需要输出翻译后的结果，不要额外解释：\n\n");
        }
        None => {
            let target = req.target_lang;
            if hits.is_empty() {
                let _ = write!(
                    p,
                    "Translate the following text into {target}. Note that you should only output \
                     the translated result without any additional explanation:\n\n"
                );
            } else {
                p.push_str("Reference the following translations:\n");
                for (src, tgt) in &hits {
                    let _ = writeln!(p, "{src} translates to {tgt}");
                }
                let _ = write!(
                    p,
                    "\nTranslate the following text into {target}. Note that you must ONLY output \
                     the translated result without any additional explanation:\n\n"
                );
            }
        }
    }
    p.push_str(req.text);
    p
}

/// System prompt for general instruct models: role, languages, glossary hits.
fn chat_system_prompt(req: &TranslateRequest) -> String {
    let mut system = format!(
        "You are a professional interpreter for university lectures on finance, economics and accounting. \
         Translate the user's {src} sentence into {tgt}. Output only the translation — no explanations, \
         no quotes, no notes. Use precise, standard academic terminology in {tgt}; keep numbers, \
         formulas and proper names exact. If the sentence is a fragment, translate it as a fragment.",
        src = req.source_lang,
        tgt = req.target_lang,
    );
    let mut hits = glossary_hits(req).peekable();
    if hits.peek().is_some() {
        system.push_str("\nGlossary (must be followed):");
        for (src, tgt) in hits {
            let _ = write!(system, "\n{src} → {tgt}");
        }
    }
    system
}

/// Strip wrapping quotes / a stray "Translation:" label some models add.
fn clean_output(s: &str) -> String {
    let mut t = s.trim();
    for prefix in ["Translation:", "Bản dịch:", "翻译："] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim();
        }
    }
    let t = t.trim_matches(|c| c == '"' || c == '“' || c == '”' || c == '「' || c == '」');
    t.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glossary() -> Vec<(String, String)> {
        vec![
            ("资产负债表".to_string(), "bảng cân đối kế toán".to_string()),
            ("市盈率".to_string(), "hệ số giá trên lợi nhuận (P/E)".to_string()),
        ]
    }

    fn req<'a>(text: &'a str, src: &'a str, tgt: &'a str, g: &'a [(String, String)]) -> TranslateRequest<'a> {
        TranslateRequest { text, source_lang: src, target_lang: tgt, glossary: g }
    }

    #[test]
    fn detects_hymt_by_arch_and_file_name() {
        assert_eq!(PromptFamily::detect("hunyuan-dense", "Hy-MT2-1.8B-Q6_K.gguf"), PromptFamily::HyMt);
        assert_eq!(PromptFamily::detect("hunyuan-dense", "HY-MT1.5-1.8B-Q4_K_M.gguf"), PromptFamily::HyMt);
        assert_eq!(PromptFamily::detect("hunyuan-moe", "Hunyuan-MT-7B.Q4_K_M.gguf"), PromptFamily::HyMt);
        // General Hunyuan chat model, and a non-Hunyuan file that merely says "mt".
        assert_eq!(PromptFamily::detect("hunyuan-dense", "Hunyuan-4B-Instruct-Q4_K_M.gguf"), PromptFamily::Chat);
        assert_eq!(PromptFamily::detect("qwen2", "hy-mt-renamed.gguf"), PromptFamily::Chat);
    }

    #[test]
    fn hymt_prompt_matches_model_card() {
        let g = glossary();
        // Chinese pair, glossary hit → "Terminology" prompt, Chinese wording.
        assert_eq!(
            hymt_prompt(&req("资产负债表很重要。", "Chinese", "Vietnamese", &g)),
            "参考下面的翻译：\n资产负债表 翻译成 bảng cân đối kế toán\n\
             将以下文本翻译为越南语，注意只需要输出翻译后的结果，不要额外解释：\n\n资产负债表很重要。"
        );
        // No hit → "Default" prompt.
        assert_eq!(
            hymt_prompt(&req("大家好。", "Chinese", "Vietnamese", &g)),
            "将以下文本翻译为越南语，注意只需要输出翻译后的结果，不要额外解释：\n\n大家好。"
        );
        // No Chinese side → English wording.
        assert_eq!(
            hymt_prompt(&req("Hello.", "English", "Vietnamese", &g)),
            "Translate the following text into Vietnamese. Note that you should only output \
             the translated result without any additional explanation:\n\nHello."
        );
    }

    #[test]
    fn glossary_hits_are_capped() {
        let g: Vec<(String, String)> = (0..20).map(|i| (format!("词{i}"), format!("t{i}"))).collect();
        let text: String = (0..20).map(|i| format!("词{i}")).collect();
        assert_eq!(glossary_hits(&req(&text, "Chinese", "Vietnamese", &g)).count(), MAX_GLOSSARY_HITS);
        let sys = chat_system_prompt(&req("市盈率高", "Chinese", "Vietnamese", &glossary()));
        assert!(sys.ends_with("\nGlossary (must be followed):\n市盈率 → hệ số giá trên lợi nhuận (P/E)"));
    }

    #[test]
    fn hy_dense_render_matches_jinja() {
        assert_eq!(hy_dense_render(None, "X"), "<｜hy_begin▁of▁sentence｜><｜hy_User｜>X<｜hy_Assistant｜>");
        assert_eq!(
            hy_dense_render(Some("S"), "X"),
            "<｜hy_begin▁of▁sentence｜>S<｜hy_place▁holder▁no▁3｜><｜hy_User｜>X<｜hy_Assistant｜>"
        );
    }

    #[test]
    fn bos_follows_gguf_and_template() {
        assert!(wants_bos(Some("true"), Some("gpt2")));
        assert!(!wants_bos(Some("false"), Some("llama")));
        assert!(wants_bos(None, Some("llama"))); // SPM default
        assert!(!wants_bos(None, Some("gpt2"))); // BPE default
        assert!(needs_bos(Some("<bos>"), "<start_of_turn>user\n…"));
        assert!(!needs_bos(Some("<bos>"), "<bos><start_of_turn>user\n…"));
        assert!(!needs_bos(None, "<|im_start|>system\n…"));
    }

    /// Runtime check against the real GGUF (`MT_TEST_GGUF`): exercises
    /// prompt → tokenize → batch → decode → greedy sampling → byte assembly
    /// end to end. The sentences are ones the former Qwen2.5-3B default left
    /// partly in Chinese; no CJK may survive into the Vietnamese output.
    #[test]
    #[ignore]
    fn translates_finance_sentence() {
        let Ok(path) = std::env::var("MT_TEST_GGUF") else {
            eprintln!("MT_TEST_GGUF not set; skipping");
            return;
        };
        let t = std::time::Instant::now();
        let llm = Llm::load(Path::new(&path), 8).expect("load");
        eprintln!("LLM loaded in {:?} ({:?}, hy_dense={}, bos={:?})", t.elapsed(), llm.family, llm.hy_dense, llm.bos);
        let glossary = glossary();
        let cancel = AtomicBool::new(false);
        for text in [
            "资产负债表反映企业在某一特定日期的财务状况。",
            "这个公式期末考试会考，大家注意一下。",
            "央行下调存款准备金率，相当于释放了流动性。",
            "这家公司的市盈率是二十五倍，市净率是三点二倍，比行业平均水平高不少。",
        ] {
            let t = std::time::Instant::now();
            let mut partials: Vec<(String, std::time::Duration)> = Vec::new();
            let out = llm
                .translate(&req(text, "Chinese", "Vietnamese", &glossary), &cancel, &mut |p| {
                    partials.push((p.to_string(), t.elapsed()))
                })
                .expect("translate");
            eprintln!("{text}\n → {out}   ({:?})", t.elapsed());
            for (p, at) in &partials {
                eprintln!("   partial {at:?}: {p}");
                // Whole words of the final text, never a half word.
                assert!(out.starts_with(p.as_str()), "partial {p:?} is not a prefix of {out:?}");
                assert!(
                    out[p.len()..].starts_with(' ') || out.len() == p.len(),
                    "partial {p:?} ends mid-word in {out:?}"
                );
            }
            assert!(!out.is_empty());
            assert!(
                !out.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "untranslated Chinese in: {out}"
            );
        }
    }
}
