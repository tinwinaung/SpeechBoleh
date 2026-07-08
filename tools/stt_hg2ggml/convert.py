# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch>=2.0.0",
#   "numpy",
#   "transformers>=4.35.0",
#   "huggingface_hub>=0.20.0",
# ]
# ///
#
# convert.py — Whisper HuggingFace → GGML converter
#
# Downloads a fine-tuned Whisper model from HuggingFace and converts its
# weights to the GGML binary format understood by whisper.cpp.
#
# Usage (via uv, no manual pip install needed):
#   uv run convert.py --model-id <hf_model_id> --output <output.bin>
#
# Examples:
#   uv run convert.py --model-id chuuhtetnaing/whisper-small-myanmar --output ggml-whisper-small-myanmar.bin
#   uv run convert.py --model-id chuuhtetnaing/whisper-large-v3-myanmar --output ggml-whisper-large-v3-myanmar.bin
#   uv run convert.py --model-id openai/whisper-medium --output ggml-medium.bin

import argparse
import json
import shutil
import struct
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import WhisperForConditionalGeneration

# ---------------------------------------------------------------------------
# Tensor name mapping: HuggingFace state-dict keys → whisper.cpp GGML names
# ---------------------------------------------------------------------------
CONV_MAP = {
    'self_attn.k_proj':               'attn.key',
    'self_attn.q_proj':               'attn.query',
    'self_attn.v_proj':               'attn.value',
    'self_attn.out_proj':             'attn.out',
    'self_attn_layer_norm':           'attn_ln',
    'encoder_attn.q_proj':            'cross_attn.query',
    'encoder_attn.v_proj':            'cross_attn.value',
    'encoder_attn.out_proj':          'cross_attn.out',
    'encoder_attn_layer_norm':        'cross_attn_ln',
    'fc1':                            'mlp.0',
    'fc2':                            'mlp.2',
    'final_layer_norm':               'mlp_ln',
    'encoder.layer_norm.bias':        'encoder.ln_post.bias',
    'encoder.layer_norm.weight':      'encoder.ln_post.weight',
    'encoder.embed_positions.weight': 'encoder.positional_embedding',
    'decoder.layer_norm.bias':        'decoder.ln.bias',
    'decoder.layer_norm.weight':      'decoder.ln.weight',
    'decoder.embed_positions.weight': 'decoder.positional_embedding',
    'decoder.embed_tokens.weight':    'decoder.token_embedding.weight',
    'proj_out.weight':                'decoder.proj.weight',
}

# ---------------------------------------------------------------------------
# Mel filter bank
# ---------------------------------------------------------------------------
MEL_FILTERS_URL = (
    'https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/mel_filters.npz'
)

def find_or_download_mel_filters(script_dir: Path) -> Path:
    """Look for mel_filters.npz next to this script, in parent dirs, or download it."""
    # 1. Same directory as the script
    local = script_dir / 'mel_filters.npz'
    if local.exists():
        return local

    # 2. Project root (one or two levels up — handles tools/2ggml/)
    for parent in script_dir.parents:
        candidate = parent / 'mel_filters.npz'
        if candidate.exists():
            print(f'[mel_filters] Found at {candidate}', flush=True)
            return candidate

    # 3. Download from openai/whisper GitHub
    print(f'[mel_filters] Not found locally — downloading from {MEL_FILTERS_URL}', flush=True)
    dest = script_dir / 'mel_filters.npz'
    try:
        urllib.request.urlretrieve(MEL_FILTERS_URL, str(dest))
        print(f'[mel_filters] Saved to {dest}', flush=True)
        return dest
    except Exception as exc:
        print(f'ERROR: Could not download mel_filters.npz: {exc}', flush=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Byte-level BPE unicode helper (same as OpenAI's encoder.py)
# ---------------------------------------------------------------------------
def bytes_to_unicode():
    bs = (
        list(range(ord('!'), ord('~') + 1))
        + list(range(ord('¡'), ord('¬') + 1))
        + list(range(ord('®'), ord('ÿ') + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


# ---------------------------------------------------------------------------
# Tensor name remapping
# ---------------------------------------------------------------------------
def remap_name(name: str) -> str:
    """Convert a HuggingFace state-dict key to its whisper.cpp GGML tensor name."""
    if name == 'proj_out.weight':
        return CONV_MAP.get(name, name)

    nn = name.split('.')[1:]  # strip leading 'model.' prefix

    if len(nn) > 1 and nn[1] == 'layers':
        nn[1] = 'blocks'
        inner = '.'.join(nn[3:-1])
        if inner == 'encoder_attn.k_proj':
            mapped = 'attn.key' if nn[0] == 'encoder' else 'cross_attn.key'
        else:
            mapped = CONV_MAP[inner]
        return '.'.join(nn[:3] + [mapped] + nn[-1:])
    else:
        joined = '.'.join(nn)
        return CONV_MAP.get(joined, joined)


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------
def convert(model_id: str, output_path: str, use_f16: bool = True) -> None:
    script_dir = Path(__file__).resolve().parent
    output = Path(output_path).resolve()

    print(f'[1/5] Loading configuration for model: {model_id}', flush=True)

    # Step 1 — Download model snapshot
    print(f'[2/5] Downloading model snapshot from HuggingFace...', flush=True)
    cache_dir = tempfile.mkdtemp(prefix='hf_whisper_')
    try:
        local_dir = Path(snapshot_download(
            repo_id=model_id,
            local_dir=cache_dir,
            local_dir_use_symlinks=False,
            ignore_patterns=['*.msgpack', 'flax_model*', 'tf_model*', 'rust_model*', '*.ot'],
        ))
    except Exception as exc:
        print(f'ERROR: Failed to download model: {exc}', flush=True)
        shutil.rmtree(cache_dir, ignore_errors=True)
        sys.exit(1)

    # Step 2 — Load hyperparameters
    hparams = json.loads((local_dir / 'config.json').read_text(encoding='utf-8'))

    if 'max_length' not in hparams or hparams['max_length'] is None:
        hparams['max_length'] = hparams.get('max_target_positions', 448)
    else:
        try:
            hparams['max_length'] = int(hparams['max_length'])
        except (ValueError, TypeError):
            hparams['max_length'] = 448

    # Step 3 — Mel filter bank
    mel_path = find_or_download_mel_filters(script_dir)
    n_mels = hparams['num_mel_bins']
    with np.load(str(mel_path)) as f:
        filters = torch.from_numpy(f[f'mel_{n_mels}'])

    # Step 4 — Load vocabulary
    vocab_path = local_dir / 'vocab.json'
    if vocab_path.exists():
        tokens = json.loads(vocab_path.read_text(encoding='utf-8'))
    else:
        # Fall back to tokenizer.json (some newer checkpoints)
        tk_path = local_dir / 'tokenizer.json'
        if tk_path.exists():
            tk = json.loads(tk_path.read_text(encoding='utf-8'))
            tokens = tk.get('model', {}).get('vocab', {})
            for item in tk.get('added_tokens', []):
                tokens[item['content']] = item['id']
        else:
            print('ERROR: No vocab.json or tokenizer.json found.', flush=True)
            shutil.rmtree(cache_dir, ignore_errors=True)
            sys.exit(1)

    byte_decoder = {v: k for k, v in bytes_to_unicode().items()}

    # Step 5 — Load model weights
    print(f'[3/5] Loading model weights...', flush=True)
    model = WhisperForConditionalGeneration.from_pretrained(str(local_dir))
    state_dict = model.state_dict()

    # Step 6 — Write GGML binary
    print(f'[4/5] Converting and writing GGML binary: {output}', flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    with open(output, 'wb') as fout:
        # Magic
        fout.write(struct.pack('i', 0x67676D6C))

        # Hyperparameters (11 integers)
        fout.write(struct.pack('i', hparams['vocab_size']))
        fout.write(struct.pack('i', hparams['max_source_positions']))
        fout.write(struct.pack('i', hparams['d_model']))
        fout.write(struct.pack('i', hparams['encoder_attention_heads']))
        fout.write(struct.pack('i', hparams['encoder_layers']))
        fout.write(struct.pack('i', hparams['max_length']))
        fout.write(struct.pack('i', hparams['d_model']))
        fout.write(struct.pack('i', hparams['decoder_attention_heads']))
        fout.write(struct.pack('i', hparams['decoder_layers']))
        fout.write(struct.pack('i', hparams['num_mel_bins']))
        fout.write(struct.pack('i', 1 if use_f16 else 0))

        # Mel filter bank
        fout.write(struct.pack('i', filters.shape[0]))
        fout.write(struct.pack('i', filters.shape[1]))
        for i in range(filters.shape[0]):
            for j in range(filters.shape[1]):
                fout.write(struct.pack('f', float(filters[i][j])))

        # Vocabulary
        sorted_tokens = sorted(tokens.items(), key=lambda x: x[1])
        fout.write(struct.pack('i', len(sorted_tokens)))
        for key, _ in sorted_tokens:
            try:
                text = bytearray([byte_decoder[c] for c in key])
            except KeyError:
                text = key.encode('utf-8')
            fout.write(struct.pack('i', len(text)))
            fout.write(text)

        # Tensor weights
        skipped = 0
        written = 0
        for src_name in state_dict.keys():
            if src_name == 'proj_out.weight':
                print(f'  Skipping {src_name}', flush=True)
                skipped += 1
                continue

            try:
                dst_name = remap_name(src_name)
            except (KeyError, IndexError) as exc:
                print(f'  Warning: skipping unmapped tensor {src_name}: {exc}', flush=True)
                skipped += 1
                continue

            print(f'  {src_name} → {dst_name}', flush=True)
            data = state_dict[src_name].squeeze().numpy().astype(np.float16)

            # Conv bias must be [n, 1] not [n]
            if dst_name in ('encoder.conv1.bias', 'encoder.conv2.bias'):
                data = data.reshape(data.shape[0], 1)

            n_dims = len(data.shape)

            # 1-D tensors and positional embeddings must stay as float32
            needs_f32 = (
                not use_f16
                or n_dims < 2
                or dst_name in ('encoder.conv1.bias', 'encoder.conv2.bias',
                                'encoder.positional_embedding', 'decoder.positional_embedding')
            )
            if needs_f32:
                data = data.astype(np.float32)
                ftype = 0
            else:
                ftype = 1

            name_bytes = dst_name.encode('utf-8')
            fout.write(struct.pack('iii', n_dims, len(name_bytes), ftype))
            for d in range(n_dims):
                fout.write(struct.pack('i', data.shape[n_dims - 1 - d]))
            fout.write(name_bytes)
            data.tofile(fout)
            written += 1

    size_mb = output.stat().st_size / (1024 * 1024)
    print(f'[5/5] Done! Written {written} tensors, skipped {skipped}.', flush=True)
    print(f'      Output: {output} ({size_mb:.1f} MB)', flush=True)

    # Cleanup
    shutil.rmtree(cache_dir, ignore_errors=True)
    print('      Temp files cleaned up.', flush=True)


def main():
    parser = argparse.ArgumentParser(
        description='Convert a HuggingFace Whisper model to GGML binary format for whisper.cpp',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  uv run convert.py --model-id chuuhtetnaing/whisper-small-myanmar --output ggml-whisper-small-myanmar.bin
  uv run convert.py --model-id chuuhtetnaing/whisper-large-v3-myanmar --output ggml-whisper-large-v3-myanmar.bin
  uv run convert.py --model-id openai/whisper-medium --output ggml-medium.bin --f32
        '''
    )
    parser.add_argument(
        '--model-id', required=True,
        help='HuggingFace model ID (e.g. chuuhtetnaing/whisper-small-myanmar)'
    )
    parser.add_argument(
        '--output', required=True,
        help='Output path for the .bin file (e.g. ./ggml-whisper-small-myanmar.bin)'
    )
    parser.add_argument(
        '--f32', action='store_true', default=False,
        help='Write all weights as float32 instead of float16 (larger file, rarely needed)'
    )
    args = parser.parse_args()
    convert(args.model_id, args.output, use_f16=not args.f32)


if __name__ == '__main__':
    main()
