# AMD Developer Hackathon: Act II — migration sketch

Goal: re-target the existing retriever → synthesizer → verifier pipeline from local
MLX/Gemma to open models served on **AMD Developer Cloud** (vLLM on ROCm), with no
architecture or language change. The plugin and orchestrator stay as-is; only the
`providers` block and the eval results change.

Hackathon: <https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-ii> · ends 2026-07-11.

## What does NOT change

- `src/agents/*`, `src/packs/runtime.ts`, `src/view.ts`, orchestrator, verifier — untouched.
- Provider client (`src/provider.ts`) already speaks OpenAI `/v1/chat/completions` + `Bearer`.
  vLLM exposes exactly that, so the swap is configuration only.

## The one change: provider endpoints

vLLM serves **one model per server process**. Two ways to wire the three roles:

- **Option A — single model, single endpoint (fastest path).** One 70B-class model on one
  MI300X (192 GB) serves all three roles. Mirrors the current single-endpoint Gemma setup.
- **Option B — three models, three ports (best "model integration" story for judges).**
  Small/fast retriever, strong synthesizer, mid verifier — three vLLM servers.

New pack lives at `src/packs/defaults/grounded-research.amd.json` (draft committed on this
branch). Edit `baseUrl` to the AMD Dev Cloud instance host/port.

### Suggested open models (all ROCm/vLLM-supported, hackathon-listed families)

| Role        | Option A (single)            | Option B (per-role)                 |
| ----------- | ---------------------------- | ----------------------------------- |
| retriever   | Llama-3.3-70B-Instruct       | Qwen2.5-7B-Instruct (fast)          |
| synthesizer | Llama-3.3-70B-Instruct       | Llama-3.3-70B-Instruct (reasoning)  |
| verifier    | Llama-3.3-70B-Instruct       | Qwen2.5-32B-Instruct                |

The served `model` id = the HF repo id you launch vLLM with (`--served-model-name` overrides it).

## Stand up the endpoint (AMD Dev Cloud)

```bash
# on an AMD Developer Cloud GPU instance (ROCm preinstalled)
pip install vllm   # ROCm build per AMD Dev Cloud image
vllm serve meta-llama/Llama-3.3-70B-Instruct \
  --port 8000 --api-key amd-hackathon   # any token; must match pack apiKey
# Option B: repeat on ports 8001/8002 with the smaller models
```

Then point the pack at it: `baseUrl: "http://<instance-host>:8000/v1"`.

## Secrets via env vars (implemented)

`resolvePackEnv` in `src/packs/loader.ts` now interpolates `${ENV_VAR}` references in
any provider `baseUrl` / `apiKey` / `model` from the process environment, for both the
Obsidian plugin loader and the eval CLI. Unset/empty vars fail loudly with a
`PackValidationError`. So no host or token ever needs to be committed.

The committed `grounded-research.amd.json` references:

| Variable             | Example                       |
| -------------------- | ----------------------------- |
| `AMD_RETRIEVER_URL`  | `http://<host>:8001/v1`       |
| `AMD_SYNTHESIZER_URL`| `http://<host>:8000/v1`       |
| `AMD_VERIFIER_URL`   | `http://<host>:8002/v1`       |
| `AMD_API_KEY`        | the vLLM `--api-key` token    |

For Option A (single endpoint) point all three URLs at the same host:port.

## Re-run the eval against AMD

```bash
export AMD_RETRIEVER_URL=http://<host>:8001/v1
export AMD_SYNTHESIZER_URL=http://<host>:8000/v1
export AMD_VERIFIER_URL=http://<host>:8002/v1
export AMD_API_KEY=amd-hackathon

npm run eval:live -- --pack src/packs/defaults/grounded-research.amd.json \
  --benchmark hackathon/data/nobel_physics/benchmark.json
```

The pack id is `grounded-research.amd` (dot variant), which `isCompatiblePackId` in
`run.ts` accepts against the existing benchmark `packId: "grounded-research"` — so the
committed Nobel benchmark works without edits.

Then update `hackathon/RESULTS.md` headline numbers to reflect the AMD-hosted model
(currently Gemma). The hallucination-delta story carries over unchanged.

## Submission checklist

- [ ] vLLM up on AMD Dev Cloud, pack `baseUrl` set, smoke query returns in Obsidian
- [ ] `npm run build && npm run lint && npm test -- --run` green
- [ ] `eval:live` re-run on AMD model; RESULTS.md numbers + model names updated
- [ ] README/RESULTS reframed: AMD Dev Cloud + ROCm + open model (drop Gemma/MLX framing)
- [ ] LICENSE confirmed MIT (already is)
- [ ] Demo video: show the verifier catching a hallucination, note "running on AMD MI300X"
```
