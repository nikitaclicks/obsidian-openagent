# Project Results — AMD Developer Hackathon: Act II

## Project

OpenAgent for Obsidian has a grounded-research mode that answers from vault notes through a retriever -> synthesizer -> verifier pipeline instead of relying on a single ungrounded response. For this hackathon the pipeline runs on **open models served by vLLM on AMD Developer Cloud (ROCm)**. The goal: keep classic chat unchanged, add a higher-trust research path that goes beyond simple RAG with an independent verifier, and prove it with a real-corpus live benchmark running on AMD GPUs. A deterministic fixture harness is kept alongside as a pipeline-correctness check.

## What shipped

| Area | Outcome |
| --- | --- |
| Grounded pack runtime | `src/packs/runtime.ts` runs retriever, synthesizer, and verifier as a reusable staged pipeline. |
| AMD pack | `src/packs/defaults/grounded-research.amd.json` targets open models on AMD Developer Cloud; endpoints/keys via `${ENV_VAR}` resolution in `src/packs/loader.ts`. |
| Verification | `src/agents/verifier.ts` verifies claims in a single batched structured step per query. |
| Retrieval | `src/agents/retrieval.ts` tuned to reduce generic note matches and surface the right pages on hard benchmark queries. |
| Live eval harness | `hackathon/eval/run.ts` supports real-corpus live evals against a real vault and pack config. |
| Tests | Retrieval, eval, and env-interpolation coverage. |

## Final evaluation snapshot

### Live Nobel benchmark on AMD — headline result

> **Pending the AMD live eval run.** Run step 5 of [AMD-RUNBOOK.md](./AMD-RUNBOOK.md):
> `npm run eval:live -- --pack src/packs/defaults/grounded-research.amd.json --benchmark hackathon/data/nobel_physics/benchmark.json`,
> then copy the numbers from the generated `hackathon/eval/results/live-nobel-physics-*.md` into the table below.

| Metric | Value |
| --- | ---: |
| Compute | AMD Developer Cloud (MI300X, ROCm) via vLLM |
| Models | retriever `Qwen2.5-7B` / synthesizer `Llama-3.3-70B` / verifier `Qwen2.5-32B` (or single-model, Option A) |
| Queries | _TBD_ |
| Baseline hallucination rate | _TBD_ |
| Verified hallucination rate | _TBD_ |
| **Improvement** | _TBD_ |
| Total claims | _TBD_ |
| Total flagged claims | _TBD_ |
| Claim buckets | _TBD_ verified / _TBD_ unsupported / _TBD_ quote-missing |

**Note on live numbers:** the benchmark scores quote wording strictly, so factually-correct claims phrased slightly differently from `expectedClaims` still count as flagged. The improvement delta is therefore a conservative lower bound. Run-to-run variance is real because local/served models are not forced to temperature 0.

### Pipeline correctness check — mocked-provider fixture

This is *not* a model-performance result. The fixture harness uses mocked providers throughout (synthesizer returns canned claims, verifier returns ground-truth-labeled decisions). It proves the pipeline routes claims correctly when the verifier is right — independent of which model or GPU backs it. Run with `npm run eval`.

| Metric | Value |
| --- | ---: |
| Baseline flagged-claim rate | 37.0% |
| Escaped-hallucination rate (with mocked verifier) | 0.0% |
| Total claims | 27 |
| Total flagged claims | 10 |

## Application-ready summary

Built a grounded-research mode for an Obsidian AI plugin aimed at anyone who summarizes across many notes and needs to trust the result. It goes beyond simple RAG: every claim it surfaces is verified against the cited note text before reaching the user. The system coordinates three specialized open-model agents — a fast retriever, a strong synthesizer, and an independent verifier — running entirely on **AMD Developer Cloud GPUs via vLLM on ROCm**, reachable through standard OpenAI-compatible endpoints. A live end-to-end eval over the Nobel Physics corpus measures the hallucination-rate improvement the verifier delivers (numbers from the AMD run, above).

## Submission notes

- Repo: `https://github.com/nikitaclicks/obsidian-openagent`
- Hackathon README: `hackathon/README.md`
- AMD runbook / migration: `hackathon/AMD-RUNBOOK.md`, `hackathon/AMD-MIGRATION.md`
- Demo script: `hackathon/demo/script.md`
- Main results file: `hackathon/RESULTS.md`
