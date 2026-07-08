# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "torch",
#   "numpy",
#   "transformers>=4.35.0",
#   "huggingface_hub",
# ]
# ///
#
# convert_whisper_myanmar.py
#
# Converts a HuggingFace fine-tuned Whisper model to GGML binary format
# compatible with whisper.cpp.
#
# Usage (via uv run):
#   uv run convert_whisper_myanmar.py --model-id chuuhtetnaing/whisper-small-myanmar --output-path /path/to/output.bin
#
# Arguments:
#   --model-id    HuggingFace model ID (e.g. chuuhtetnaing/whisper-small-myanmar)
#   --output-path Absolute path to the output .bin file

import argparse
import io
import os
import struct
import json
import sys
import tempfile
import shutil
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import WhisperForConditionalGeneration

# -----------------------------------------------------------------------
# Tensor name mapping: HuggingFace -> whisper.cpp GGML
# -----------------------------------------------------------------------
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


def bytes_to_unicode():
    """Build reversible utf-8 byte <-> unicode character mapping."""
    bs = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("¡"), ord("¬") + 1))
        + list(range(ord("®"), ord("ÿ") + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(2 ** 8):
        if b not in bs:
            bs.append(b)
            cs.append(2 ** 8 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


def remap_name(name: str) -> str:
    """Map a HuggingFace state-dict key to a whisper.cpp tensor name."""
    if name == "proj_out.weight":
        return CONV_MAP.get(name, name)

    nn = name.split(".")[1:]  # strip leading 'model.' prefix

    if nn[1] == "layers":
        nn[1] = "blocks"
        suffix = ".".join(nn[3:-1])
        if suffix == "encoder_attn.k_proj":
            mapped = "attn.key" if nn[0] == "encoder" else "cross_attn.key"
        else:
            mapped = CONV_MAP[suffix]
        return ".".join(nn[:3] + [mapped] + nn[-1:])
    else:
        joined = ".".join(nn)
        return CONV_MAP.get(joined, joined)


def convert(model_id: str, output_path: str) -> None:
    print(f"Loading configuration for model: {model_id}", flush=True)

    # ------------------------------------------------------------------
    # Download model snapshot to a temp directory so we can work with
    # the raw files (config.json, vocab.json, etc.)
    # ------------------------------------------------------------------
    cache_dir = tempfile.mkdtemp(prefix="whisper_hf_")
    print(f"Downloading model snapshot to: {cache_dir}", flush=True)
    try:
        local_dir = snapshot_download(
            repo_id=model_id,
            local_dir=cache_dir,
            local_dir_use_symlinks=False,
            ignore_patterns=["*.msgpack", "flax_model*", "tf_model*", "rust_model*"],
        )
    except Exception as exc:
        print(f"ERROR: Failed to download model: {exc}", flush=True)
        shutil.rmtree(cache_dir, ignore_errors=True)
        sys.exit(1)

    local_dir = Path(local_dir)

    # ------------------------------------------------------------------
    # Load hyperparameters from config.json
    # ------------------------------------------------------------------
    hparams = json.loads((local_dir / "config.json").read_text(encoding="utf-8"))

    # Handle missing or non-integer max_length gracefully
    if "max_length" not in hparams or hparams["max_length"] is None:
        hparams["max_length"] = hparams.get("max_target_positions", 448)
    else:
        try:
            hparams["max_length"] = int(hparams["max_length"])
        except (ValueError, TypeError):
            print("Warning: Invalid max_length value; defaulting to 448.", flush=True)
            hparams["max_length"] = 448

    # ------------------------------------------------------------------
    # Load mel filter bank (ship with the script directory as fallback)
    # ------------------------------------------------------------------
    script_dir = Path(__file__).resolve().parent
    mel_path = script_dir / "mel_filters.npz"
    if not mel_path.exists():
        print(f"ERROR: mel_filters.npz not found at {mel_path}", flush=True)
        shutil.rmtree(cache_dir, ignore_errors=True)
        sys.exit(1)

    print("Downloading mel_filters from local asset...", flush=True)
    n_mels = hparams["num_mel_bins"]
    with np.load(str(mel_path)) as f:
        filters = torch.from_numpy(f[f"mel_{n_mels}"])

    # ------------------------------------------------------------------
    # Load vocabulary
    # ------------------------------------------------------------------
    vocab_path = local_dir / "vocab.json"
    if not vocab_path.exists():
        # Some models store it under tokenizer_config / added_tokens; try alternatives
        vocab_path = local_dir / "tokenizer.json"
        if vocab_path.exists():
            tokenizer_data = json.loads(vocab_path.read_text(encoding="utf-8"))
            tokens = {item["content"]: item["id"] for item in tokenizer_data.get("added_tokens", [])}
            # Also pull in the main model vocab
            model_vocab = tokenizer_data.get("model", {}).get("vocab", {})
            tokens.update(model_vocab)
        else:
            print("ERROR: Could not find vocab.json or tokenizer.json", flush=True)
            shutil.rmtree(cache_dir, ignore_errors=True)
            sys.exit(1)
    else:
        tokens = json.loads(vocab_path.read_text(encoding="utf-8"))

    byte_decoder = {v: k for k, v in bytes_to_unicode().items()}

    # ------------------------------------------------------------------
    # Load PyTorch model weights
    # ------------------------------------------------------------------
    print("Loading model weights from HuggingFace...", flush=True)
    model = WhisperForConditionalGeneration.from_pretrained(str(local_dir))
    state_dict = model.state_dict()

    # ------------------------------------------------------------------
    # Write GGML binary
    # ------------------------------------------------------------------
    print(f"Converting and writing GGML binary to: {output_path}", flush=True)
    out_dir = Path(output_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(output_path, "wb") as fout:
        # Magic number
        fout.write(struct.pack("i", 0x67676D6C))

        # Hyperparameters
        fout.write(struct.pack("i", hparams["vocab_size"]))
        fout.write(struct.pack("i", hparams["max_source_positions"]))
        fout.write(struct.pack("i", hparams["d_model"]))
        fout.write(struct.pack("i", hparams["encoder_attention_heads"]))
        fout.write(struct.pack("i", hparams["encoder_layers"]))
        fout.write(struct.pack("i", hparams["max_length"]))
        fout.write(struct.pack("i", hparams["d_model"]))
        fout.write(struct.pack("i", hparams["decoder_attention_heads"]))
        fout.write(struct.pack("i", hparams["decoder_layers"]))
        fout.write(struct.pack("i", hparams["num_mel_bins"]))
        fout.write(struct.pack("i", 1))  # use_f16 = True

        # Mel filters
        fout.write(struct.pack("i", filters.shape[0]))
        fout.write(struct.pack("i", filters.shape[1]))
        for i in range(filters.shape[0]):
            for j in range(filters.shape[1]):
                fout.write(struct.pack("f", float(filters[i][j])))

        # Vocabulary
        sorted_tokens = sorted(tokens.items(), key=lambda x: x[1])
        fout.write(struct.pack("i", len(sorted_tokens)))
        for key, _ in sorted_tokens:
            try:
                text = bytearray([byte_decoder[c] for c in key])
            except KeyError:
                text = key.encode("utf-8")
            fout.write(struct.pack("i", len(text)))
            fout.write(text)

        # Tensors
        for src_name in state_dict.keys():
            if src_name == "proj_out.weight":
                print(f"Skipping {src_name}", flush=True)
                continue

            try:
                dst_name = remap_name(src_name)
            except (KeyError, IndexError) as exc:
                print(f"  Warning: skipping unmapped tensor {src_name}: {exc}", flush=True)
                continue

            print(f"encoder.{src_name} -> {dst_name}", flush=True)
            data = state_dict[src_name].squeeze().numpy().astype(np.float16)

            # Reshape conv bias [n] -> [n, 1]
            if dst_name in ("encoder.conv1.bias", "encoder.conv2.bias"):
                data = data.reshape(data.shape[0], 1)

            n_dims = len(data.shape)

            # Determine float type: most tensors stay f16; 1-D + positional embeddings -> f32
            use_f32_this = (
                n_dims < 2
                or dst_name == "encoder.conv1.bias"
                or dst_name == "encoder.conv2.bias"
                or dst_name == "encoder.positional_embedding"
                or dst_name == "decoder.positional_embedding"
            )
            if use_f32_this:
                data = data.astype(np.float32)
                ftype = 0
            else:
                ftype = 1

            str_bytes = dst_name.encode("utf-8")
            fout.write(struct.pack("iii", n_dims, len(str_bytes), ftype))
            for dim_idx in range(n_dims):
                fout.write(struct.pack("i", data.shape[n_dims - 1 - dim_idx]))
            fout.write(str_bytes)
            data.tofile(fout)

    print(f"Done. Output file: {output_path}", flush=True)

    # Cleanup temp download directory
    shutil.rmtree(cache_dir, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(
        description="Convert a HuggingFace fine-tuned Whisper model to GGML format for whisper.cpp"
    )
    parser.add_argument(
        "--model-id",
        required=True,
        help="HuggingFace model ID (e.g. chuuhtetnaing/whisper-small-myanmar)",
    )
    parser.add_argument(
        "--output-path",
        required=True,
        help="Absolute path for the output GGML .bin file",
    )
    args = parser.parse_args()
    convert(args.model_id, args.output_path)


if __name__ == "__main__":
    main()
