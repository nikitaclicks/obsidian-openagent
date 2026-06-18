# Eval Harness

The eval harness measures how much the grounded-research pipeline reduces hallucinations compared to a raw (unverified) baseline. It has two modes: **fixture** (deterministic, no models needed) and **live** (real models, real vault).

---

## How it works

Every eval run does the same thing in both modes:

1. **Baseline pass** — run the pipeline with the verifier disabled. The synthesizer's raw `claims-v1` JSON is scored directly against ground truth. This simulates what a single-agent LLM would surface.

2. **Verified pass** — run the full pipeline (retriever → synthesizer → verifier). Only claims the verifier marks `verified` are surfaced. These are scored against ground truth.

3. **Compare** — compute hallucination rates for both passes and report the delta.

### The three pipeline stages

| Stage | Model | What it does |
|---|---|---|
| Retriever | `Qwen/Qwen2.5-7B-Instruct` | Scans the vault, selects relevant notes, writes a brief summary of the evidence |
| Synthesizer | `meta-llama/Llama-3.3-70B-Instruct` | Reads the retriever brief + raw notes, produces structured `claims-v1` JSON (claim text + source note + source quote) |
| Verifier | `Qwen/Qwen2.5-32B-Instruct` | For each claim, checks whether the cited quote actually supports the claim text; outputs `verified`, `unsupported`, or `quote-missing` |

Models are served by vLLM on AMD Developer Cloud (ROCm) via OpenAI-compatible endpoints; see [../AMD-RUNBOOK.md](../AMD-RUNBOOK.md). A single 70B model can also serve all three roles (Option A).

### Claim statuses

| Status | Meaning |
|---|---|
| `verified` | Quote found in note AND verifier LLM says the quote supports the claim |
| `unsupported` | Quote found in note BUT verifier LLM says the quote does NOT support the claim |
| `quote-missing` | The cited quote does not appear in the note at all (fabricated citation) |

### Hallucination rate

```
hallucination rate = escaped hallucinations / surfaced claims
```

- **Baseline hallucination rate**: fraction of raw (unverified) claims that are wrong
- **Verified hallucination rate**: fraction of verified claims that are still wrong (escaped the verifier)
- **Delta**: baseline − verified (positive = improvement)

---

## Fixture eval (deterministic)

```bash
npm run eval
```

Uses mock providers seeded from ground-truth labels in `hackathon/eval/fixtures/queries.json`. No local model server needed. The verifier decisions come directly from the fixture's `expectedSupport` labels, so results are **100% reproducible** across runs.

Use this to verify the pipeline plumbing is correct and to run in CI without models.

Results written to: `hackathon/eval/results/fixture-<timestamp>.json` and `.md`

---

## Live eval (real models)

```bash
npm run eval:live
```

Runs against the real Nobel Physics vault (`hackathon/data/nobel_physics/`) with real open models served on AMD Developer Cloud. Results have run-to-run variance because inference is non-deterministic.

**Requirements:**
- vLLM (ROCm) serving the models over an OpenAI-compatible API on AMD Developer Cloud — see [../AMD-RUNBOOK.md](../AMD-RUNBOOK.md)
- The AMD pack and its env vars set: `--pack src/packs/defaults/grounded-research.amd.json`, with `AMD_RETRIEVER_URL` / `AMD_SYNTHESIZER_URL` / `AMD_VERIFIER_URL` / `AMD_API_KEY` exported
- Model IDs match what vLLM is serving (defaults: `Qwen/Qwen2.5-7B-Instruct`, `meta-llama/Llama-3.3-70B-Instruct`, `Qwen/Qwen2.5-32B-Instruct`)

**Optional flags:**

```bash
# Use a custom pack file (e.g. your installed plugin's pack)
npm run eval:live -- --pack /path/to/grounded-research.json

# Use a different benchmark file
npm run eval:live -- --benchmark /path/to/benchmark.json

# Use a different vault directory
npm run eval:live -- --vault /path/to/vault

# Write results somewhere else
npm run eval:live -- --results /path/to/results/dir
```

Results written to: `hackathon/eval/results/live-nobel-physics-<timestamp>.json` and `.md`

---

## Benchmark file (`benchmark.json`)

The Nobel Physics benchmark (`hackathon/data/nobel_physics/benchmark.json`) has 24 queries across categories:

| Category | What it tests |
|---|---|
| `single-fact` | One clear answer from one note |
| `multi-note` | Answer requires synthesizing across multiple notes |
| `adversarial` | Trap questions designed to trigger hallucination (e.g. prizes that were never awarded) |
| `no-support` | Questions whose answer is not in the vault at all |

Each query has:
- `expectedOutcome` — `supported`, `unsupported`, or `partial`
- `expectedClaims` — list of acceptable verified claims, each with `source_note`, `required_phrases` (must appear in claim text), and optional `forbidden_phrases`
- `notesExpected` — which notes the retriever should find
- `expectedCitations` — which notes the verifier should cite

---

## Results files

Each run produces two files with the same timestamp:

- **`.json`** — full machine-readable report with per-query claim details, retrieval paths, and verification statuses
- **`.md`** — human-readable summary table with per-query hallucination rates

The JSON structure has a `perQuery` array where each entry shows:
- `baselineHallucinationRate` vs `verifiedHallucinationRate` for that query
- `retrievedPaths` — what the retriever actually found
- `verifiedClaims` — each claim with its status and the verifier's explanation
- `notesExpectedSatisfied` — whether the right notes were retrieved

---

## Why baseline and verified rates can diverge non-monotonically

The baseline rate depends on which notes the retriever fetches and what claims the synthesizer generates from them. If retrieval changes (e.g. after tuning), the synthesizer sees different notes and generates different claims — which can shift the baseline up or down independently of the verifier. The verified rate can still improve even when the baseline rises, because the verifier is correctly filtering the new claims.
