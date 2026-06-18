# AMD Developer Hackathon: Act II — Project

OpenAgent for Obsidian turns a normal vault into a grounded research workspace. The core plugin keeps the existing classic chat flow intact, and the **Grounded Research** pack adds a retriever -> synthesizer -> verifier pipeline that catches hallucinated citations before they reach the user as verified facts. For this hackathon the pipeline runs on **open models served by vLLM on AMD Developer Cloud (ROCm)** — the same vault-grounded, verification-first workflow, now powered end to end on AMD GPUs.

Hackathon: <https://lablab.ai/ai-hackathons/amd-developer-hackathon-act-ii>

![Grounded research - positive result](assets/result-positive.png)

![Grounded research - corrected result](assets/result-negative.png)

## Problem

Single-agent note assistants are fast, but they are hard to trust when they summarize across many notes. This submission goes **beyond simple RAG**: instead of retrieve-then-answer, it adds an independent verifier agent that checks every cited quote against the live note text before surfacing a claim as verified.

- keep the default chat workflow unchanged for everyday use
- add an opt-in grounded-research mode for higher-trust answers
- verify every claim against the live note text before surfacing it as verified
- run the whole multi-agent pipeline on AMD GPUs through OpenAI-compatible endpoints (vLLM on ROCm)
- coordinate three specialized agents so the workflow balances retrieval speed, reasoning quality, and verification

## What shipped

| Area | What is in the repo |
| --- | --- |
| Classic mode | The existing single-agent chat path still runs when no pack is selected. |
| Agent packs | `src/packs/` loads bundled and user-edited pack JSON files. |
| Grounded pipeline | `src/packs/runtime.ts` runs retriever, synthesizer, and verifier as a linear pack pipeline. |
| Claim verification | `src/agents/verifier.ts` combines exact quote checks with a verifier model decision. |
| AMD pack | `src/packs/defaults/grounded-research.amd.json` targets open models on AMD Developer Cloud; credentials come from env vars. |
| Obsidian UI | `src/view.ts` shows step progress, verified vs flagged claims, note links, and recovery guidance. |
| Eval harness | `hackathon/eval/run.ts` runs the committed fixture corpus and a live real-corpus benchmark, writing timestamped JSON + markdown reports. |

## Architecture

![OpenAgent grounded-research pipeline: retriever -> synthesizer -> verifier](assets/architecture-pipeline.png)

Three specialized agents, each an open model served by vLLM on AMD Developer Cloud. Endpoints and credentials are supplied via environment variables (`${AMD_*_URL}`, `${AMD_API_KEY}`) so nothing sensitive lives in the repo.

| Stage | Default model (open) | Responsibility |
| --- | --- | --- |
| Retriever | `Qwen/Qwen2.5-7B-Instruct` | Pull likely notes and summarize the strongest evidence with a fast model. |
| Synthesizer | `meta-llama/Llama-3.3-70B-Instruct` | Produce `claims-v1` JSON grounded in the retrieved notes with the strongest reasoning model in the stack. |
| Verifier | `Qwen/Qwen2.5-32B-Instruct` | Check whether each cited quote actually supports the claim before it is shown as verified. |

> A single 70B model can also serve all three roles on one MI300X (192 GB) — see [AMD-RUNBOOK.md](./AMD-RUNBOOK.md) Option A.

Key code paths:

- `src/agents/` - reusable agent runtime, orchestrator, structured output, quote match, verifier
- `src/packs/` - pack schema, bundled defaults, pipeline runtime, `${ENV_VAR}` resolution
- `src/view.ts` - chat panel mode switch, pack execution, verification rendering, recovery UI
- `hackathon/eval/` - committed fixture vault, query corpus, deterministic + live eval harness

## Running on AMD Developer Cloud

Full, copy-paste steps are in **[AMD-RUNBOOK.md](./AMD-RUNBOOK.md)**. Migration rationale and what does/doesn't change is in **[AMD-MIGRATION.md](./AMD-MIGRATION.md)**. In short:

1. Launch an AMD Developer Cloud GPU (MI300X, ROCm preinstalled) and serve the model(s) with vLLM:
   ```bash
   vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key amd-hackathon
   ```
2. Locally, export the endpoint env vars and build the plugin:
   ```bash
   export AMD_RETRIEVER_URL=http://<host>:8000/v1
   export AMD_SYNTHESIZER_URL=http://<host>:8000/v1
   export AMD_VERIFIER_URL=http://<host>:8000/v1
   export AMD_API_KEY=amd-hackathon
   npm install && npm run build
   ```
3. Copy `main.js`, `styles.css`, and `manifest.json` into `<vault>/.obsidian/plugins/open-agent/`, enable **OpenAgent**, and switch the chat panel to **Grounded Research (AMD)**.

The plugin only requires a standard OpenAI-compatible `/v1/chat/completions` API, so the same pack works against any OpenAI-compatible provider by changing the env vars.

## Running the eval harness

Deterministic pipeline-correctness check (mocked providers, no GPU needed):

```bash
npm run eval
```

Live real-corpus benchmark against the AMD-hosted models:

```bash
export AMD_RETRIEVER_URL=... AMD_SYNTHESIZER_URL=... AMD_VERIFIER_URL=... AMD_API_KEY=...
npm run eval:live -- \
  --pack src/packs/defaults/grounded-research.amd.json \
  --benchmark hackathon/data/nobel_physics/benchmark.json
```

Both write timestamped JSON + markdown reports under `hackathon/eval/results/`.

## Results

> **Pending the AMD live eval run.** Run step 5 of [AMD-RUNBOOK.md](./AMD-RUNBOOK.md), then
> fill in the numbers below from the generated `hackathon/eval/results/live-nobel-physics-*.md`.

| Metric | Value (AMD run) |
| --- | ---: |
| Models | retriever / synthesizer / verifier (open, on AMD MI300X via vLLM) |
| Queries | _TBD_ |
| Baseline hallucination rate | _TBD_ |
| Verified hallucination rate | _TBD_ |
| Improvement | _TBD_ |
| Total claims / flagged | _TBD_ |

The consolidated outcomes write-up lives in [RESULTS.md](./RESULTS.md).

## Submission review flow

1. Read root `README.md` for the plugin overview and the hackathon banner.
2. Read this file for the submission story, AMD setup, and evaluation context.
3. Read [AMD-RUNBOOK.md](./AMD-RUNBOOK.md) to reproduce the AMD run, and [AMD-MIGRATION.md](./AMD-MIGRATION.md) for what changed.
4. Review `hackathon/demo/script.md` for the demo narrative.
5. Run the gate: `npm run build && npm run lint && npm test -- --run && npm run eval`.
6. Manual smoke pass in Obsidian (Classic still works; Grounded Research runs end to end; claim badges, note links, and model attribution render; broken-pack recovery banner appears).

## Demo assets

- Demo script: `hackathon/demo/script.md`
- Evaluation harness: `hackathon/eval/run.ts`
- Results summary: `hackathon/RESULTS.md`
- Fixture corpus: `hackathon/eval/fixtures/`
- Live Nobel benchmarks: `hackathon/data/nobel_physics/benchmark.quick.json`, `hackathon/data/nobel_physics/benchmark.json`
- AMD runbook & migration: `hackathon/AMD-RUNBOOK.md`, `hackathon/AMD-MIGRATION.md`
