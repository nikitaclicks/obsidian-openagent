# AMD Act II — exact steps to run

What you do, in order. Steps 1–3 are on an **AMD Developer Cloud GPU instance**.
Steps 4–6 are on your **local machine** (the eval harness runs locally and calls the
cloud endpoint over HTTP). Pick **Option A** (one model, simplest) unless you want the
three-model story for judges.

---

## 1. Get an AMD Developer Cloud GPU

1. Sign in: <https://www.amd.com/en/developer/resources/cloud-access/amd-developer-cloud.html> (via the hackathon's AMD AI Developer Program access).
2. Launch a GPU instance (MI300X, 192 GB — fits a 70B comfortably). ROCm is preinstalled on the image.
3. Note the instance's public host/IP and open the port(s) you'll use (8000, plus 8001/8002 for Option B).

## 2. Serve the model(s) with vLLM (on the instance)

```bash
pip install vllm        # use the ROCm wheel per the AMD Dev Cloud image
export VLLM_KEY=amd-hackathon   # any token; you'll reuse it locally as AMD_API_KEY
```

**Option A — one model, one port (recommended first):**

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key "$VLLM_KEY"
```

**Option B — three models, three ports (run each in its own shell/tmux):**

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct        --port 8001 --api-key "$VLLM_KEY"
vllm serve meta-llama/Llama-3.3-70B-Instruct --port 8000 --api-key "$VLLM_KEY"
vllm serve Qwen/Qwen2.5-32B-Instruct       --port 8002 --api-key "$VLLM_KEY"
```

> First launch downloads weights (minutes). Llama gated models need `huggingface-cli login`.

## 3. Smoke-test the endpoint (on the instance)

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $VLLM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.3-70B-Instruct","messages":[{"role":"user","content":"say hi"}]}' | head
```

Expect a normal JSON completion. If this works, the rest is local.

---

## 4. Point the local pack at the cloud (your machine)

Replace `<HOST>` with the instance's public host/IP.

```bash
cd /Users/nikita/dev/obsidian-ai-agent
git checkout amd-hackathon-act-ii

# Option A: all three point at the one server
export AMD_RETRIEVER_URL=http://<HOST>:8000/v1
export AMD_SYNTHESIZER_URL=http://<HOST>:8000/v1
export AMD_VERIFIER_URL=http://<HOST>:8000/v1
export AMD_API_KEY=amd-hackathon
```

> For Option A you must also set all three pack models to the one you served. Either edit
> `src/packs/defaults/grounded-research.amd.json` so every `model` is
> `meta-llama/Llama-3.3-70B-Instruct`, or just use Option B env URLs (8001/8000/8002) and
> leave the pack as-is.

## 5. Run the live eval (your machine)

```bash
npm install   # first time only
npm run eval:live -- \
  --pack src/packs/defaults/grounded-research.amd.json \
  --benchmark hackathon/data/nobel_physics/benchmark.json
```

Faster smoke check first (4 queries):

```bash
npm run eval:live -- \
  --pack src/packs/defaults/grounded-research.amd.json \
  --benchmark hackathon/data/nobel_physics/benchmark.quick.json
```

Results land in `hackathon/eval/results/live-nobel-physics-<timestamp>.{json,md}`.

## 6. Hand the results back

Send me (or paste) the new `live-nobel-physics-*.md`. I'll update `RESULTS.md` and
`README.md` to the AMD/ROCm framing with the real numbers, and reframe the submission story.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `environment variable AMD_* is not set` | You didn't `export` it in the same shell. |
| `401 / AuthError` | `AMD_API_KEY` ≠ the vLLM `--api-key` token. |
| `Benchmark packId ... does not match pack` | Use the committed pack id `grounded-research.amd` (already correct). |
| Connection refused / timeout | Port not open on the instance, or wrong `<HOST>`. |
| Model id mismatch (404 model) | The pack `model` must equal what `vllm serve` is hosting. |

## Sanity before you submit (local, no cloud needed)

```bash
npm run build && npm run lint && npm test -- --run
```

(Two pre-existing `loop`/`view` test failures are flaky DOM mocks unrelated to this work.)
