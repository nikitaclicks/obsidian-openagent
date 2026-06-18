# OpenAgent: Grounded — Multi-Agent Research with Verified Citations

## Context

OpenAgent is an existing Obsidian plugin (this repo) that provides a single AI
agent with vault read/write tools, consent dialogs, and an OpenAI-compatible
provider. Current code: src/main.ts, src/loop.ts (agent loop), src/provider.ts
(HTTP client), src/tools/ (vault tools), src/consent/ (confirmation UI),
src/view.ts (chat panel).

We are extending it for submission to the AMD Developer Hackathon: Act II. The
submission is a grounded research assistant: a multi-agent pipeline that goes
beyond simple RAG, running on open models served by vLLM on AMD Developer Cloud
(ROCm), with an independent verifier agent that catches hallucinated citations.

The existing single-agent flow must continue to work unchanged. The new
multi-agent flow is opt-in via "agent packs."

## Goals

1. Refactor the agent loop into a first-class Agent abstraction so multiple
   agents with different models, prompts, and tool allowlists can run in a
   pipeline.
2. Add a pipeline orchestrator that chains agents and passes typed context
   between them.
3. Add a structured-output mode where an agent's response is validated against
   a JSON schema, with one retry on parse failure.
4. Build a verifier agent that takes the synthesizer's claims, does an
   exact-match check on each cited quote against the actual note (in code, not
   in the LLM), and uses a small LLM only to judge whether the quote supports
   the claim.
5. Define an Agent Pack JSON format that bundles providers, agents,
   orchestration, and schemas. Load packs from
   <vault>/.obsidian/plugins/open-agent/packs/*.json. Ship one default pack
   named "grounded-research" that wires retriever → synthesizer → verifier.
6. Allow each agent in a pack to use a different provider/model endpoint. The
   AMD pack should point at open models served by vLLM on AMD Developer Cloud
   (per-role or a single shared endpoint) but be trivially swappable to any
   OpenAI-compatible provider by editing the providers block / env vars.
7. Render verifier results in the chat panel: per-claim badges (✅ verified,
   ⚠️ quote present but doesn't support, ❌ quote not found), collapsible
   claim details, clickable source-note links, and a footer line showing which
   model ran which agent.
8. Add a CLI-runnable eval harness under hackathon/eval/ that runs a fixture
   set of queries against a fixture vault, computes per-claim hallucination
   rates with and without the verifier, and writes a JSON results file plus a
   markdown summary.

## Non-goals

- No pack marketplace, no in-UI pack authoring, no migration tooling for
  multiple pack versions.
- No support for non-Obsidian vaults or non-markdown file types.
- No new agent orchestration patterns beyond linear pipeline (leave the
  format extensible for future router/graph patterns, but don't build them).
- No write tools for the new agents in the grounded-research pack. The pack
  is read-only by design.
- No changes to the existing single-agent chat flow — it must keep working
  exactly as today when no pack is selected.
- No new providers beyond what the existing OpenAI-compatible client already
  supports. vLLM on AMD Developer Cloud is reached via its standard
  OpenAI-compatible endpoint.

## Acceptance criteria

- A user can select "Grounded Research" from a new pack picker in the chat
  panel and run a query. The pipeline executes retriever → synthesizer →
  verifier in order, streaming progress per step.
- The synthesizer's output is a JSON object matching the claims-v1 schema
  (summary + claims with id, text, source_note, source_quote, confidence).
  Invalid output triggers exactly one retry with the parse error in context,
  then fails loudly with a user-visible error.
- The verifier produces a verifications-v1 result. For each claim:
    - quote_present is determined by whitespace-normalized substring match
      against the live note contents (not by the LLM).
    - supports_claim is determined by a separate LLM call (the verifier model)
      that receives the claim, the quote, and the surrounding note context.
- Grounded-research turns render a primary `Research result` answer surface,
  followed by the existing Retriever / Synthesizer / Verifier step rows as the
  only transparency surface. Whole step rows expand inline for live and final
  details instead of opening a separate `Agent work` panel.
- Inline citation links in `Research result` jump to exact matched phrases in
  source notes when exact anchors are available, while claim cards remain the
  secondary evidence surface with safe fallback note-opening behavior.
- The UI shows verified / unsupported / quote-missing claims with distinct
  visual treatment, working Obsidian note links, and a footer with the model
  names that ran.
- The default grounded-research.json pack lives in the plugin bundle and is
  copied to the user's plugin folder on first run if no packs are present.
- The grounded-research pack keeps its provider block fully editable so the
  same architecture can target hosted OpenAI-compatible endpoints without
  code changes.
- The eval harness can be run with `npm run eval` against
  hackathon/eval/fixtures/, produces hackathon/eval/results/<timestamp>.json,
  and writes hackathon/eval/results/<timestamp>.md with hallucination rate
  baseline-vs-verified, total claims, total flagged, and per-query breakdown.
- README on main is unchanged except for a small banner near the top pointing
  to hackathon/. hackathon/README.md tells the submission story end to end:
  problem, architecture, how to run on AMD Developer Cloud (ROCm), eval results.
- All existing tests pass. New unit tests cover: pack loading + schema
  validation, structured-output validation + retry, the in-code quote-match
  function, and the orchestrator running a pipeline end-to-end against a
  mocked provider.

## Constraints

- TypeScript, existing ESLint config, existing esbuild setup. No new
  build-time dependencies unless strictly necessary; prefer adding a small
  JSON Schema validator (ajv) over rolling our own.
- The plugin must remain pure JS at runtime (no native deps) and must keep
  working on Obsidian mobile. New agents should run on desktop only is
  acceptable; the pack picker should hide multi-agent packs on mobile rather
  than crash.
- The Agent abstraction must be usable by future packs without modifying core
  code. New tools, new schemas, new orchestration steps should be additions,
  not edits to the orchestrator.
- The existing consent system applies: any tool call that writes still goes
  through the existing consent modal. The grounded-research pack does not use
  write tools, so consent dialogs should not appear in its happy path.
- Keep the diff reviewable. Land the Agent refactor first as a no-behavior-
  change PR (the existing single-agent flow becomes a single-agent pack
  internally), then add the pipeline, then the verifier, then the UI, then
  the eval.

## Implemented file layout

```
src/
  agents/
    agent.ts              # Reusable agent loop
    orchestrator.ts       # Linear pipeline runner
    structured-output.ts  # JSON schema validation + retry helper
    quote-match.ts        # Exact vs fuzzy quote resolution
    verifier.ts           # Claim verification + exact phrase anchors
  citations.ts            # Research-result composition + citation targeting
  packs/
    loader.ts             # Bundled-pack install + user pack loading
    runtime.ts            # Grounded-research pack execution runtime
    defaults/
      grounded-research.json
  sessions.ts             # Stored pack-turn persistence + sanitization
  view.ts                 # Chat panel mode switch, pack execution, transcript UI
hackathon/
  README.md               # Submission writeup + reviewer flow
  spec.md                 # Final hackathon implementation spec
  eval/
    run.ts                # Eval harness CLI
    fixtures/
      vault/              # Committed fixture vault
      queries.json        # 20 query corpus + ground truth
    results/              # Timestamped eval outputs
  demo/
    script.md             # Demo video script
```

## Resolved design decisions

- The grounded-research mode lives in the existing chat panel as a mode switch,
  preserving the classic path when no pack is selected.
- Pipeline progress streams into the transcript through the existing Retriever /
  Synthesizer / Verifier step rows instead of a separate transparency panel.
- Verifier support judgment stays boolean in v0.1 to keep eval output and user
  interpretation clean.
- Citation-ready grounded results are composed from verified claims with exact
  phrase anchors instead of rewriting the synthesizer summary heuristically.

## Deliverables

- Working repo that keeps Classic mode intact and ships the grounded-research
  pipeline end to end.
- One bundled default pack in `src/packs/defaults/grounded-research.json`.
- `hackathon/README.md`, `hackathon/eval/` with a committed 20-query corpus and
  generated results, and `hackathon/demo/script.md`.
- Release tagged `v0.2.0-amd-hackathon` at submission time.
