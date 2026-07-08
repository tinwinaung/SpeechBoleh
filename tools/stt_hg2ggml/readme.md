# 2ggml — Whisper Model Converter

Converts any HuggingFace fine-tuned Whisper model into a **GGML binary** (`.bin`) file
that can be loaded directly by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) —
the inference engine powering the local STT pipeline in SpeechBoleh.

---

## How It Works

Whisper models on HuggingFace are stored as **PyTorch weight files** (`.safetensors` or `.bin`).
`whisper.cpp` requires a compact custom binary format called **GGML** which is optimised for
CPU inference without the full PyTorch/transformers stack.

The conversion has five stages:

```
HuggingFace Repo
      │
      ▼
  snapshot_download()          ← pulls config.json, vocab.json, model weights
      │
      ▼
  Load hparams (config.json)   ← vocab size, layers, d_model, mel bins, max length ...
      │
      ▼
  Load mel filter bank         ← 80-ch or 128-ch triangular filters (mel_filters.npz)
      │
      ▼
  Load vocab (vocab.json)      ← BPE token <-> byte mapping
      │
      ▼
  Remap + write tensors        ← rename HF keys to whisper.cpp names, cast f16/f32, write binary
      │
      ▼
  .bin file  OK
```

### GGML Binary Layout

| Section | Contents |
|---------|----------|
| Magic `0x67676D6C` | 4 bytes — file type identifier |
| Hyperparameters | 11 x `int32` — vocab size, sequence lengths, model dims, layers, mel bins, float type |
| Mel filter bank | `shape[0] x shape[1]` x `float32` |
| Vocabulary | N tokens: each is `len (int32)` + raw bytes |
| Tensors | For each weight: `n_dims`, `name_len`, `ftype`, shape dims, name bytes, raw data |

---

## Prerequisites

| Tool | Install |
|------|---------|
| **uv** | `pip install uv` or `winget install astral-sh.uv` |
| **Python >= 3.10** | Managed automatically by `uv` |
| **Internet** | Required to download model from HuggingFace |

No manual `pip install` needed — `uv` reads the dependency list embedded in the script header
and installs `torch`, `transformers`, `huggingface_hub`, and `numpy` into an isolated
environment automatically on first run.

---

## Usage

Open a terminal inside `tools/2ggml/` and run:

```powershell
uv run convert.py --model-id <huggingface_model_id> --output <output_filename.bin>
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--model-id` | Yes | HuggingFace model ID (e.g. `chuuhtetnaing/whisper-small-myanmar`) |
| `--output` | Yes | Path for the output `.bin` file |
| `--f32` | No | Write all weights as `float32` instead of `float16` (bigger file, rarely needed) |

---

## Examples

### Convert Myanmar Fine-Tuned Small (~466 MB output)
```powershell
uv run convert.py `
  --model-id chuuhtetnaing/whisper-small-myanmar `
  --output ggml-whisper-small-myanmar.bin
```

### Convert Myanmar Fine-Tuned Large V3 (~3.1 GB output)
```powershell
uv run convert.py `
  --model-id chuuhtetnaing/whisper-large-v3-myanmar `
  --output ggml-whisper-large-v3-myanmar.bin
```

### Convert Any Standard OpenAI Whisper Model
```powershell
uv run convert.py --model-id openai/whisper-medium --output ggml-medium.bin
```

---

## Expected Output

```
[1/5] Loading configuration for model: chuuhtetnaing/whisper-small-myanmar
[2/5] Downloading model snapshot from HuggingFace...
[mel_filters] Found at C:\...\mel_filters.npz
[3/5] Loading model weights...
[4/5] Converting and writing GGML binary: C:\...\ggml-whisper-small-myanmar.bin
  model.encoder.conv1.weight -> encoder.conv1.weight
  model.encoder.conv1.bias   -> encoder.conv1.bias
  ... (hundreds of tensors)
[5/5] Done! Written 312 tensors, skipped 1.
      Output: ggml-whisper-small-myanmar.bin (466.2 MB)
      Temp files cleaned up.
```

Typical conversion times:

| Model | Download | Conversion | Output Size |
|-------|----------|------------|-------------|
| whisper-small-myanmar | ~5 min | ~2 min | ~466 MB |
| whisper-large-v3-myanmar | ~20 min | ~8 min | ~3.1 GB |

> Times depend on internet speed and CPU. No GPU required.

---

## mel_filters.npz

The script looks for `mel_filters.npz` in this order:

1. **Same folder** as `convert.py` — `tools/2ggml/mel_filters.npz`
2. **Parent directories** — the project root already contains one, so this usually resolves automatically
3. **Auto-download** from `https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/mel_filters.npz`

You don't need to do anything — it resolves automatically.

---

## After Conversion — Using in SpeechBoleh

1. Upload the `.bin` file to a **GitHub Release** on your repo
2. Copy the download URL (right-click the asset → Copy link address)
3. Update `CUSTOM_MODEL_URLS` in `main.js`:

```js
const CUSTOM_MODEL_URLS = {
  'ggml-whisper-small-myanmar.bin':
    'https://github.com/tinwinaung/SpeechBoleh/releases/download/v1.0/ggml-whisper-small-myanmar.bin',
  'ggml-whisper-large-v3-myanmar.bin':
    'https://github.com/tinwinaung/SpeechBoleh/releases/download/v1.0/ggml-whisper-large-v3-myanmar.bin',
};
```

4. Users click **Download** in the app — the standard HTTP progress bar handles the rest.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `uv: command not found` | Install uv: `pip install uv` or `winget install astral-sh.uv` |
| `ERROR: Failed to download model` | Check internet; HuggingFace occasionally rate-limits — try again |
| `KeyError` on a tensor name | Unexpected model architecture — check the model ID is a Whisper checkpoint |
| Output file is 0 bytes | Disk full, or output directory write permission denied |
| Very slow download | Large-v3 models are 3+ GB — expected, leave it running |
