from pathlib import Path

from airllm import AirLLMBaseModel, AutoModel

# Persistent per-layer split of the model, kept next to this script (gitignored).
SPLIT_DIR = Path(__file__).resolve().parent / "airllm_split"


class AirLLMQwen3Moe(AirLLMBaseModel):
    """Qwen3-MoE with per-expert streaming.

    Each layer has 128 experts but a token is routed to only 8. The generic class loads whole
    layers (every expert, ~124GB per generated token). Setting expert_prefix makes AirLLM load
    just the experts a token actually uses. Needs transformers < 5, where experts are a ModuleList.
    """

    def set_layer_names_dict(self):
        self.layer_names_dict = {
            "embed": "model.embed_tokens",
            "layer_prefix": "model.layers",
            "norm": "model.norm",
            "lm_head": "lm_head",
            "expert_prefix": "mlp.experts",
        }



def main():

    MAX_LENGTH = 128
    # just pass a hugging face repo id — works with almost any popular model:
    # model = AutoModel.from_pretrained("Qwen/Qwen3-32B")

    # go bigger with the exact same one line:
    # model = AutoModel.from_pretrained("Qwen/Qwen3.8-27B")          # 27B dense VL, 3.33GB
    # model = AutoModel.from_pretrained("Qwen/Qwen3.8-Flash-Next")    # 125B MoE + 51B PLE, 5.95GB
    model = AirLLMQwen3Moe(
        "Qwen/Qwen3-235B-A22B",  # 235B, runs in ~3GB
        layer_shards_saving_path=str(SPLIT_DIR),  # split layers (persistent, gitignored)
        delete_original=True,  # free each original shard once it has been split
        compression="4bit",  # block-wise 4-bit layers: ~4x smaller on disk, faster loading
    )
    # model = AutoModel.from_pretrained("deepseek-ai/DeepSeek-V3")  # 671B, runs in ~12GB

    # or use a model's local path...
    # model = AutoModel.from_pretrained("/home/ubuntu/.cache/huggingface/hub/models--Qwen--Qwen3-32B/snapshots/...")

    input_text = [
        "What is the capital of United States?",
        #'I like',
    ]

    input_tokens = model.tokenizer(
        input_text,
        return_tensors="pt",
        return_attention_mask=False,
        truncation=True,
        max_length=MAX_LENGTH,
        padding=False,
    )

    generation_output = model.generate(
        input_tokens["input_ids"].cuda(),
        max_new_tokens=20,
        use_cache=True,
        return_dict_in_generate=True,
    )

    output = model.tokenizer.decode(generation_output.sequences[0])

    print(output)


if __name__ == "__main__":
    main()
