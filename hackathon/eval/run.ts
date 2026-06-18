import Ajv from "ajv";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeWhitespace, quotePresent } from "../../src/agents/quote-match";
import type { ClaimVerificationStatus } from "../../src/agents/verifier";
import type { ClaimsV1 } from "../../src/agents/schemas/claims-v1";
import type { OpenAICompatibleConfig } from "../../src/provider-config";
import groundedResearchDefault from "../../src/packs/defaults/grounded-research.json";
import { resolvePackEnv } from "../../src/packs/loader";
import {
	preparePackExecution,
	runPackForEval,
	runPackRetrievalStep,
	runPackSynthesisStep,
	runPackVerificationStep,
	type PackRetrievalOutput,
	type PackRunResult,
} from "../../src/packs/runtime";
import type { AgentPack } from "../../src/packs/types";
import type { VaultAdapter } from "../../src/packs/vault-adapter";
import type { ChatMessage, ModelProvider, StreamEvent } from "../../src/types";
import { createMarkdownVaultAdapter } from "./fixture-vault";
import { createNodeEvalProvider } from "./live-provider";

type FixtureCategory = "single-fact" | "multi-note" | "conflict" | "no-support" | "adversarial";
type EvalOutcome = "supported" | "mixed" | "unsupported" | "partial";

interface EvalQueryExpectation {
	text: string;
	status: ClaimVerificationStatus;
}

interface EvalMockClaim {
	id: string;
	text: string;
	source_note: string;
	source_quote: string;
	confidence: number;
}

interface EvalQueryFixture {
	id: string;
	category: FixtureCategory;
	query: string;
	summary: string;
	retrieverBrief: string;
	notesExpected: string[];
	expectedSupport: EvalQueryExpectation[];
	expectedCitations: string[];
	expectedOutcome: EvalOutcome;
	mustNotClaim?: string[];
	mockClaims: EvalMockClaim[];
}

interface EvalFixtures {
	packId: string;
	queries: EvalQueryFixture[];
}

interface LiveEvalExpectedClaim {
	source_note: string;
	source_quote?: string;
	required_phrases: string[];
	forbidden_phrases?: string[];
}

interface LiveEvalQueryFixture {
	id: string;
	category: string;
	query: string;
	notesExpected: string[];
	expectedCitations: string[];
	expectedOutcome: EvalOutcome;
	expectedClaims: LiveEvalExpectedClaim[];
}

interface LiveEvalBenchmark {
	packId: string;
	datasetId: string;
	datasetName: string;
	queries: LiveEvalQueryFixture[];
}

interface ClaimBuckets {
	verified: number;
	unsupported: number;
	quoteMissing: number;
}

interface ScoredBaselineClaim {
	id: string;
	text: string;
	sourceNote: string;
	sourceQuote: string;
	status: ClaimVerificationStatus;
}

interface PerQueryReport {
	id: string;
	category: string;
	query: string;
	expectedOutcome: EvalOutcome;
	retrievedPaths: string[];
	notesExpected: string[];
	notesExpectedSatisfied: boolean;
	expectedCitations: string[];
	actualCitations: string[];
	expectedCitationsSatisfied: boolean;
	baselineSummary: string;
	verifiedSummary: string;
	baselineClaimCount: number;
	baselineFlaggedClaims: number;
	baselineHallucinationRate: number;
	baselineClaimBuckets: ClaimBuckets;
	verifiedClaimCount: number;
	verifiedSurfacedClaimCount: number;
	verifiedFlaggedClaims: number;
	verifiedHallucinationRate: number;
	verifiedClaimBuckets: ClaimBuckets;
	hallucinationRateDelta: number;
	baselineClaims: ScoredBaselineClaim[];
	verifiedClaims: PackRunResult["claims"];
	expectedStatuses: EvalQueryExpectation[];
}

export interface EvalReport {
	runId: string;
	timestamp: string;
	packId: string;
	mode?: "fixture" | "live";
	dataset?: {
		id: string;
		name: string;
		benchmarkPath: string;
	};
	fixture: {
		rootDir: string;
		queryCount: number;
		categories: Record<string, number>;
	};
	baselineHallucinationRate: number;
	verifiedHallucinationRate: number;
	hallucinationRateDelta: number;
	totalClaims: number;
	totalFlaggedClaims: number;
	claimBuckets: ClaimBuckets;
	baselineTotalClaims: number;
	baselineFlaggedClaims: number;
	baselineClaimBuckets: ClaimBuckets;
	verifiedSurfacedClaims: number;
	perQuery: PerQueryReport[];
}

export interface EvalRunResult {
	report: EvalReport;
	jsonPath: string;
	markdownPath: string;
}

interface EvalClaimLike {
	text: string;
	sourceNote: string;
	sourceQuote: string;
}

interface LiveQueryRun {
	retrieval: PackRetrievalOutput;
	draftClaims: ClaimsV1;
	verifications: PackRunResult["claims"];
}

type EvalProviderFactory = (config: OpenAICompatibleConfig, agentId: string, pack: AgentPack) => ModelProvider;

const ajv = new Ajv({ allErrors: true, strict: false });
const fixtureValidator = ajv.compile<EvalFixtures>({
	type: "object",
	properties: {
		packId: { type: "string", minLength: 1 },
		queries: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					id: { type: "string", minLength: 1 },
					category: {
						type: "string",
						enum: ["single-fact", "multi-note", "conflict", "no-support", "adversarial"],
					},
					query: { type: "string", minLength: 1 },
					summary: { type: "string", minLength: 1 },
					retrieverBrief: { type: "string", minLength: 1 },
					notesExpected: {
						type: "array",
						items: { type: "string", minLength: 1 },
					},
					expectedSupport: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							properties: {
								text: { type: "string", minLength: 1 },
								status: { type: "string", enum: ["verified", "unsupported", "quote-missing"] },
							},
							required: ["text", "status"],
							additionalProperties: false,
						},
					},
					expectedCitations: {
						type: "array",
						items: { type: "string", minLength: 1 },
					},
					expectedOutcome: { type: "string", enum: ["supported", "mixed", "unsupported"] },
					mustNotClaim: {
						type: "array",
						items: { type: "string", minLength: 1 },
					},
					mockClaims: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							properties: {
								id: { type: "string", minLength: 1 },
								text: { type: "string", minLength: 1 },
								source_note: { type: "string", minLength: 1 },
								source_quote: { type: "string", minLength: 1 },
								confidence: { type: "number", minimum: 0, maximum: 1 },
							},
							required: ["id", "text", "source_note", "source_quote", "confidence"],
							additionalProperties: false,
						},
					},
				},
				required: [
					"id",
					"category",
					"query",
					"summary",
					"retrieverBrief",
					"notesExpected",
					"expectedSupport",
					"expectedCitations",
					"expectedOutcome",
					"mockClaims",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["packId", "queries"],
	additionalProperties: false,
});

const liveBenchmarkValidator = ajv.compile<LiveEvalBenchmark>({
	type: "object",
	properties: {
		_schema_notes: { type: "object", nullable: true },
		packId: { type: "string", minLength: 1 },
		datasetId: { type: "string", minLength: 1 },
		datasetName: { type: "string", minLength: 1 },
		queries: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					id: { type: "string", minLength: 1 },
					category: { type: "string", minLength: 1 },
					query: { type: "string", minLength: 1 },
					trapNote: { type: "string", minLength: 1 },
					notesExpected: {
						type: "array",
						items: { type: "string", minLength: 1 },
					},
					expectedCitations: {
						type: "array",
						items: { type: "string", minLength: 1 },
					},
					expectedOutcome: { type: "string", enum: ["supported", "mixed", "unsupported", "partial"] },
					expectedClaims: {
						type: "array",
						minItems: 0,
						items: {
							type: "object",
							properties: {
								source_note: { type: "string", minLength: 1 },
								source_quote: { type: "string", minLength: 1 },
								required_phrases: {
									type: "array",
									minItems: 1,
									items: { type: "string", minLength: 1 },
								},
								forbidden_phrases: {
									type: "array",
									items: { type: "string", minLength: 1 },
								},
							},
							required: ["source_note", "required_phrases"],
							additionalProperties: false,
						},
					},
				},
				required: [
					"id",
					"category",
					"query",
					"notesExpected",
					"expectedCitations",
					"expectedOutcome",
					"expectedClaims",
				],
				additionalProperties: true,
			},
		},
	},
	required: ["packId", "datasetId", "datasetName", "queries"],
	additionalProperties: true,
});

const reportValidator = ajv.compile<EvalReport>({
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		timestamp: { type: "string", minLength: 1 },
		packId: { type: "string", minLength: 1 },
		fixture: {
			type: "object",
			properties: {
				rootDir: { type: "string", minLength: 1 },
				queryCount: { type: "integer", minimum: 1 },
				categories: { type: "object" },
			},
			required: ["rootDir", "queryCount", "categories"],
			additionalProperties: true,
		},
		baselineHallucinationRate: { type: "number", minimum: 0 },
		verifiedHallucinationRate: { type: "number", minimum: 0 },
		hallucinationRateDelta: { type: "number" },
		totalClaims: { type: "integer", minimum: 0 },
		totalFlaggedClaims: { type: "integer", minimum: 0 },
		claimBuckets: {
			type: "object",
			properties: {
				verified: { type: "integer", minimum: 0 },
				unsupported: { type: "integer", minimum: 0 },
				quoteMissing: { type: "integer", minimum: 0 },
			},
			required: ["verified", "unsupported", "quoteMissing"],
			additionalProperties: false,
		},
		baselineTotalClaims: { type: "integer", minimum: 0 },
		baselineFlaggedClaims: { type: "integer", minimum: 0 },
		baselineClaimBuckets: {
			type: "object",
			properties: {
				verified: { type: "integer", minimum: 0 },
				unsupported: { type: "integer", minimum: 0 },
				quoteMissing: { type: "integer", minimum: 0 },
			},
			required: ["verified", "unsupported", "quoteMissing"],
			additionalProperties: false,
		},
		verifiedSurfacedClaims: { type: "integer", minimum: 0 },
		perQuery: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					id: { type: "string", minLength: 1 },
					category: { type: "string", minLength: 1 },
					query: { type: "string", minLength: 1 },
					expectedOutcome: { type: "string", minLength: 1 },
					baselineHallucinationRate: { type: "number", minimum: 0 },
					verifiedHallucinationRate: { type: "number", minimum: 0 },
					hallucinationRateDelta: { type: "number" },
					baselineClaimCount: { type: "integer", minimum: 0 },
					baselineFlaggedClaims: { type: "integer", minimum: 0 },
					verifiedClaimCount: { type: "integer", minimum: 0 },
					verifiedSurfacedClaimCount: { type: "integer", minimum: 0 },
					verifiedFlaggedClaims: { type: "integer", minimum: 0 },
					retrievedPaths: { type: "array" },
					notesExpectedSatisfied: { type: "boolean" },
					expectedCitationsSatisfied: { type: "boolean" },
					baselineClaimBuckets: { type: "object" },
					verifiedClaimBuckets: { type: "object" },
				},
				required: [
					"id",
					"category",
					"query",
					"expectedOutcome",
					"baselineHallucinationRate",
					"verifiedHallucinationRate",
					"hallucinationRateDelta",
					"baselineClaimCount",
					"baselineFlaggedClaims",
					"verifiedClaimCount",
					"verifiedSurfacedClaimCount",
					"verifiedFlaggedClaims",
					"retrievedPaths",
					"notesExpectedSatisfied",
					"expectedCitationsSatisfied",
					"baselineClaimBuckets",
					"verifiedClaimBuckets",
				],
				additionalProperties: true,
			},
		},
	},
	required: [
		"runId",
		"timestamp",
		"packId",
		"fixture",
		"baselineHallucinationRate",
		"verifiedHallucinationRate",
		"hallucinationRateDelta",
		"totalClaims",
		"totalFlaggedClaims",
		"claimBuckets",
		"baselineTotalClaims",
		"baselineFlaggedClaims",
		"baselineClaimBuckets",
		"verifiedSurfacedClaims",
		"perQuery",
	],
	additionalProperties: true,
});

export async function runEvalHarness(options: {
	pack?: AgentPack;
	packPath?: string;
	fixturesDir?: string;
	resultsDir?: string;
	live?: boolean;
	benchmarkPath?: string;
	vaultDir?: string;
	providerFactory?: EvalProviderFactory;
} = {}): Promise<EvalRunResult> {
	if (options.live || options.benchmarkPath || options.vaultDir) {
		return runLiveEvalHarness(options);
	}
	return runFixtureEvalHarness(options);
}

async function runFixtureEvalHarness(options: {
	pack?: AgentPack;
	packPath?: string;
	fixturesDir?: string;
	resultsDir?: string;
	providerFactory?: EvalProviderFactory;
} = {}): Promise<EvalRunResult> {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const pack = options.pack ?? (options.packPath ? await loadPackFile(options.packPath) : (groundedResearchDefault as AgentPack));
	const fixturesDir = options.fixturesDir ?? path.join(scriptDir, "fixtures");
	const resultsDir = options.resultsDir ?? path.join(scriptDir, "results");
	const queryPath = path.join(fixturesDir, "queries.json");
	const vaultDir = path.join(fixturesDir, "vault");

	await ensureDirectory(vaultDir, "fixture vault");
	await ensureDirectory(resultsDir, "eval results");

	const fixtures = await loadFixtures(queryPath);
	if (fixtures.packId !== pack.id) {
		throw new Error(`Fixture packId ${fixtures.packId} does not match pack ${pack.id}`);
	}

	const vault = await createMarkdownVaultAdapter(vaultDir);
	const timestamp = new Date().toISOString();
	const runId = `fixture-${timestamp.replace(/[:.]/g, "-")}`;

	const claimBuckets = emptyBuckets();
	const baselineClaimBuckets = emptyBuckets();
	const perQuery: PerQueryReport[] = [];
	let totalClaims = 0;
	let totalFlaggedClaims = 0;
	let baselineTotalClaims = 0;
	let baselineFlaggedClaims = 0;
	let verifiedSurfacedClaims = 0;
	let verifiedEscapedHallucinations = 0;

	for (const queryFixture of fixtures.queries) {
		const providerFactory = options.providerFactory ?? createFixtureProviderFactory(queryFixture);
		const baseline = await runPackForEval({
			pack,
			query: queryFixture.query,
			vault,
			verifierEnabled: false,
			providerFactory,
		});
		const verified = await runPackForEval({
			pack,
			query: queryFixture.query,
			vault,
			verifierEnabled: true,
			providerFactory,
		});

		const queryReport = await buildPerQueryReport(queryFixture, vault, baseline, verified);
		perQuery.push(queryReport);

		totalClaims += queryReport.verifiedClaimCount;
		totalFlaggedClaims += queryReport.verifiedFlaggedClaims;
		baselineTotalClaims += queryReport.baselineClaimCount;
		baselineFlaggedClaims += queryReport.baselineFlaggedClaims;
		verifiedSurfacedClaims += queryReport.verifiedSurfacedClaimCount;
		verifiedEscapedHallucinations += countEscapedHallucinations(queryFixture, verified.claims);
		mergeBuckets(claimBuckets, queryReport.verifiedClaimBuckets);
		mergeBuckets(baselineClaimBuckets, queryReport.baselineClaimBuckets);
	}

	const baselineHallucinationRate = toRate(baselineFlaggedClaims, baselineTotalClaims);
	const verifiedHallucinationRate = toRate(verifiedEscapedHallucinations, verifiedSurfacedClaims);
	const report: EvalReport = {
		runId,
		timestamp,
		packId: pack.id,
		mode: "fixture",
		fixture: {
			rootDir: fixturesDir,
			queryCount: fixtures.queries.length,
			categories: countCategories(fixtures.queries),
		},
		baselineHallucinationRate,
		verifiedHallucinationRate,
		hallucinationRateDelta: toDelta(baselineHallucinationRate, verifiedHallucinationRate),
		totalClaims,
		totalFlaggedClaims,
		claimBuckets,
		baselineTotalClaims,
		baselineFlaggedClaims,
		baselineClaimBuckets,
		verifiedSurfacedClaims,
		perQuery,
	};

	if (!reportValidator(report)) {
		throw new Error(`Eval report failed validation: ${formatAjvErrors(reportValidator.errors)}`);
	}

	const jsonPath = path.join(resultsDir, `${runId}.json`);
	const markdownPath = path.join(resultsDir, `${runId}.md`);
	await Promise.all([
		fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
		fs.writeFile(markdownPath, `${renderMarkdownReport(report)}\n`, "utf8"),
	]);

	return { report, jsonPath, markdownPath };
}

async function runWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (item !== undefined) await fn(item);
		}
	});
	await Promise.all(workers);
}

async function runLiveEvalHarness(options: {
	pack?: AgentPack;
	packPath?: string;
	resultsDir?: string;
	benchmarkPath?: string;
	vaultDir?: string;
	providerFactory?: EvalProviderFactory;
	concurrency?: number;
} = {}): Promise<EvalRunResult> {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const pack = options.pack ?? (options.packPath ? await loadPackFile(options.packPath) : (groundedResearchDefault as AgentPack));
	const benchmarkPath =
		options.benchmarkPath ?? path.join(scriptDir, "..", "data", "nobel_physics", "benchmark.json");
	const vaultDir = options.vaultDir ?? path.join(scriptDir, "..", "data", "nobel_physics");
	const resultsDir = options.resultsDir ?? path.join(scriptDir, "results");
	const concurrency = options.concurrency ?? 1;

	await ensureDirectory(vaultDir, "live eval vault");
	await ensureDirectory(resultsDir, "eval results");

	const benchmark = await loadLiveBenchmark(benchmarkPath);
	if (!isCompatiblePackId(benchmark.packId, pack.id)) {
		throw new Error(`Benchmark packId ${benchmark.packId} does not match pack ${pack.id}`);
	}

	const vault = await createMarkdownVaultAdapter(vaultDir);
	const timestamp = new Date().toISOString();
	const runId = `live-${benchmark.datasetId}-${timestamp.replace(/[:.]/g, "-")}`;

	const claimBuckets = emptyBuckets();
	const baselineClaimBuckets = emptyBuckets();
	const perQuery: PerQueryReport[] = [];
	let totalClaims = 0;
	let totalFlaggedClaims = 0;
	let baselineTotalClaims = 0;
	let baselineFlaggedClaims = 0;
	let verifiedSurfacedClaims = 0;
	let verifiedEscapedHallucinations = 0;
	const providerFactory =
		options.providerFactory ??
		((config: OpenAICompatibleConfig) => createNodeEvalProvider(config));

	const prepared = await preparePackExecution(pack, providerFactory);
	const liveRuns = new Map<string, LiveQueryRun>();
	const total = benchmark.queries.length;
	let done = 0;

	console.log(`[eval:live] ${total} queries · concurrency ${concurrency}`);

	console.log(`[eval:live] stage 1/3: retrieval`);
	done = 0;
	await runWithConcurrency(benchmark.queries, concurrency, async (queryFixture) => {
		const retrieval = await runPackRetrievalStep(prepared, {
			vault,
			query: queryFixture.query,
		});
		liveRuns.set(queryFixture.id, {
			retrieval,
			draftClaims: { summary: "", claims: [] },
			verifications: [],
		});
		done += 1;
		console.log(`  retrieval  ${done}/${total}  ${queryFixture.id}`);
	});

	console.log(`[eval:live] stage 2/3: synthesis`);
	done = 0;
	await runWithConcurrency(benchmark.queries, concurrency, async (queryFixture) => {
		const existing = liveRuns.get(queryFixture.id);
		if (!existing) return;
		existing.draftClaims = await runPackSynthesisStep(prepared, {
			query: queryFixture.query,
			retrieval: existing.retrieval,
		});
		done += 1;
		console.log(`  synthesis  ${done}/${total}  ${queryFixture.id}`);
	});

	console.log(`[eval:live] stage 3/3: verification`);
	done = 0;
	await runWithConcurrency(benchmark.queries, concurrency, async (queryFixture) => {
		const existing = liveRuns.get(queryFixture.id);
		if (!existing) return;
		existing.verifications = await runPackVerificationStep(prepared, {
			vault,
			claims: existing.draftClaims,
		});
		done += 1;
		console.log(`  verification  ${done}/${total}  ${queryFixture.id}`);
	});

	for (const queryFixture of benchmark.queries) {
		const run = liveRuns.get(queryFixture.id);
		if (!run) {
			throw new Error(`Missing live run state for query ${queryFixture.id}`);
		}
		const queryReport = await buildLivePerQueryReport(queryFixture, vault, run);
		perQuery.push(queryReport);

		totalClaims += queryReport.verifiedClaimCount;
		totalFlaggedClaims += queryReport.verifiedFlaggedClaims;
		baselineTotalClaims += queryReport.baselineClaimCount;
		baselineFlaggedClaims += queryReport.baselineFlaggedClaims;
		verifiedSurfacedClaims += queryReport.verifiedSurfacedClaimCount;
		verifiedEscapedHallucinations += await countLiveEscapedHallucinations(queryFixture, vault, run.verifications);
		mergeBuckets(claimBuckets, queryReport.verifiedClaimBuckets);
		mergeBuckets(baselineClaimBuckets, queryReport.baselineClaimBuckets);
	}

	const baselineHallucinationRate = toRate(baselineFlaggedClaims, baselineTotalClaims);
	const verifiedHallucinationRate = toRate(verifiedEscapedHallucinations, verifiedSurfacedClaims);
	const report: EvalReport = {
		runId,
		timestamp,
		packId: pack.id,
		mode: "live",
		dataset: {
			id: benchmark.datasetId,
			name: benchmark.datasetName,
			benchmarkPath,
		},
		fixture: {
			rootDir: vaultDir,
			queryCount: benchmark.queries.length,
			categories: countCategories(benchmark.queries),
		},
		baselineHallucinationRate,
		verifiedHallucinationRate,
		hallucinationRateDelta: toDelta(baselineHallucinationRate, verifiedHallucinationRate),
		totalClaims,
		totalFlaggedClaims,
		claimBuckets,
		baselineTotalClaims,
		baselineFlaggedClaims,
		baselineClaimBuckets,
		verifiedSurfacedClaims,
		perQuery,
	};

	if (!reportValidator(report)) {
		throw new Error(`Eval report failed validation: ${formatAjvErrors(reportValidator.errors)}`);
	}

	const jsonPath = path.join(resultsDir, `${runId}.json`);
	const markdownPath = path.join(resultsDir, `${runId}.md`);
	await Promise.all([
		fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
		fs.writeFile(markdownPath, `${renderMarkdownReport(report)}\n`, "utf8"),
	]);

	return { report, jsonPath, markdownPath };
}

async function loadFixtures(queryPath: string): Promise<EvalFixtures> {
	const raw = await fs.readFile(queryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new Error(`Missing eval fixtures at ${queryPath}`);
		}
		throw error;
	});
	const parsed = JSON.parse(raw) as unknown;
	if (!fixtureValidator(parsed)) {
		throw new Error(`Eval fixtures failed validation: ${formatAjvErrors(fixtureValidator.errors)}`);
	}
	return parsed;
}

async function loadLiveBenchmark(benchmarkPath: string): Promise<LiveEvalBenchmark> {
	const raw = await fs.readFile(benchmarkPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new Error(`Missing live eval benchmark at ${benchmarkPath}`);
		}
		throw error;
	});
	const parsed = JSON.parse(raw) as unknown;
	if (!liveBenchmarkValidator(parsed)) {
		throw new Error(`Live eval benchmark failed validation: ${formatAjvErrors(liveBenchmarkValidator.errors)}`);
	}
	return parsed;
}

async function loadPackFile(packPath: string): Promise<AgentPack> {
	const raw = await fs.readFile(packPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new Error(`Missing pack file at ${packPath}`);
		}
		throw error;
	});
	return resolvePackEnv(JSON.parse(raw) as AgentPack, packPath);
}

async function buildPerQueryReport(
	queryFixture: EvalQueryFixture,
	vault: VaultAdapter,
	baseline: PackRunResult,
	verified: PackRunResult,
): Promise<PerQueryReport> {
	const baselineDraft = baseline.artifacts.draftClaims?.claims ?? [];
	const baselineClaims = await Promise.all(
		baselineDraft.map(async (claim) => ({
			id: claim.id,
			text: claim.text,
			sourceNote: claim.source_note,
			sourceQuote: claim.source_quote,
			status: await classifyDraftClaim(queryFixture, vault, claim),
		})),
	);
	const baselineClaimBuckets = countBuckets(baselineClaims.map((claim) => claim.status));
	const baselineFlaggedClaims = baselineClaims.filter((claim) => claim.status !== "verified").length;
	const retrievedPaths = uniqueSorted((verified.artifacts.retrieval?.notes ?? []).map((note) => note.path));
	const actualCitations = uniqueSorted(verified.claims.map((claim) => claim.sourceNote));
	const verifiedClaimBuckets = countBuckets(verified.claims.map((claim) => claim.status));
	const verifiedSurfacedClaims = verified.claims.filter((claim) => claim.status === "verified");
	const verifiedEscapedHallucinations = countEscapedHallucinations(queryFixture, verified.claims);

	return {
		id: queryFixture.id,
		category: queryFixture.category,
		query: queryFixture.query,
		expectedOutcome: queryFixture.expectedOutcome,
		retrievedPaths,
		notesExpected: [...queryFixture.notesExpected],
		notesExpectedSatisfied: queryFixture.notesExpected.every((note) => retrievedPaths.includes(note)),
		expectedCitations: [...queryFixture.expectedCitations],
		actualCitations,
		expectedCitationsSatisfied: queryFixture.expectedCitations.every((citation) => actualCitations.includes(citation)),
		baselineSummary: baseline.verifiedSummary,
		verifiedSummary: verified.verifiedSummary,
		baselineClaimCount: baselineClaims.length,
		baselineFlaggedClaims,
		baselineHallucinationRate: toRate(baselineFlaggedClaims, baselineClaims.length),
		baselineClaimBuckets,
		verifiedClaimCount: verified.claims.length,
		verifiedSurfacedClaimCount: verifiedSurfacedClaims.length,
		verifiedFlaggedClaims: verified.claims.filter((claim) => claim.status !== "verified").length,
		verifiedHallucinationRate: toRate(verifiedEscapedHallucinations, verifiedSurfacedClaims.length),
		verifiedClaimBuckets,
		hallucinationRateDelta: toDelta(
			toRate(baselineFlaggedClaims, baselineClaims.length),
			toRate(verifiedEscapedHallucinations, verifiedSurfacedClaims.length),
		),
		baselineClaims,
		verifiedClaims: verified.claims,
		expectedStatuses: queryFixture.expectedSupport,
	};
}

async function buildLivePerQueryReport(
	queryFixture: LiveEvalQueryFixture,
	vault: VaultAdapter,
	run: LiveQueryRun,
): Promise<PerQueryReport> {
	const baselineDraft = run.draftClaims.claims ?? [];
	const baselineClaims = await Promise.all(
		baselineDraft.map(async (claim) => ({
			id: claim.id,
			text: claim.text,
			sourceNote: claim.source_note,
			sourceQuote: claim.source_quote,
			status: await classifyLiveClaim(queryFixture, vault, {
				text: claim.text,
				sourceNote: claim.source_note,
				sourceQuote: claim.source_quote,
			}),
		})),
	);
	const baselineClaimBuckets = countBuckets(baselineClaims.map((claim) => claim.status));
	const baselineFlaggedClaims = baselineClaims.filter((claim) => claim.status !== "verified").length;
	const retrievedPaths = uniqueSorted(run.retrieval.notes.map((note) => note.path));
	const actualCitations = uniqueSorted(run.verifications.map((claim) => claim.sourceNote));
	const verifiedClaimBuckets = countBuckets(run.verifications.map((claim) => claim.status));
	const verifiedSurfacedClaims = run.verifications.filter((claim) => claim.status === "verified");
	const verifiedEscapedHallucinations = await countLiveEscapedHallucinations(queryFixture, vault, run.verifications);
	const baselineHallucinationRate = toRate(baselineFlaggedClaims, baselineClaims.length);
	const verifiedHallucinationRate = toRate(verifiedEscapedHallucinations, verifiedSurfacedClaims.length);

	return {
		id: queryFixture.id,
		category: queryFixture.category,
		query: queryFixture.query,
		expectedOutcome: queryFixture.expectedOutcome,
		retrievedPaths,
		notesExpected: [...queryFixture.notesExpected],
		notesExpectedSatisfied: queryFixture.notesExpected.every((note) => retrievedPaths.includes(note)),
		expectedCitations: [...queryFixture.expectedCitations],
		actualCitations,
		expectedCitationsSatisfied: queryFixture.expectedCitations.every((citation) => actualCitations.includes(citation)),
		baselineSummary: run.draftClaims.summary,
		verifiedSummary: verifiedSurfacedClaims.map((claim) => `- ${claim.text}`).join("\n"),
		baselineClaimCount: baselineClaims.length,
		baselineFlaggedClaims,
		baselineHallucinationRate,
		baselineClaimBuckets,
		verifiedClaimCount: run.verifications.length,
		verifiedSurfacedClaimCount: verifiedSurfacedClaims.length,
		verifiedFlaggedClaims: run.verifications.filter((claim) => claim.status !== "verified").length,
		verifiedHallucinationRate,
		verifiedClaimBuckets,
		hallucinationRateDelta: toDelta(baselineHallucinationRate, verifiedHallucinationRate),
		baselineClaims,
		verifiedClaims: run.verifications,
		expectedStatuses: [],
	};
}

function createFixtureProviderFactory(queryFixture: EvalQueryFixture) {
	const expectedByText = new Map(
		queryFixture.expectedSupport.map((expectation) => [normalizeWhitespace(expectation.text), expectation.status] as const),
	);
	return (_config: unknown, agentId: string): ModelProvider => ({
		async *stream(messages: ChatMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
			if (opts?.signal?.aborted) return;
			yield { kind: "text", text: renderFixtureResponse(queryFixture, agentId, messages, expectedByText) };
			yield { kind: "done", finishReason: "stop" };
		},
	});
}

function renderFixtureResponse(
	queryFixture: EvalQueryFixture,
	agentId: string,
	messages: ChatMessage[],
	expectedByText: Map<string, ClaimVerificationStatus>,
): string {
	if (agentId === "retriever") {
		return queryFixture.retrieverBrief;
	}
	if (agentId === "synthesizer") {
		const payload: ClaimsV1 = {
			summary: queryFixture.summary,
			claims: queryFixture.mockClaims,
		};
		return JSON.stringify(payload);
	}
	if (agentId === "verifier") {
		const prompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
		return JSON.stringify({
			decisions: extractVerifierClaims(prompt).map(({ claim_id, claim }) => {
				const status = expectedByText.get(normalizeWhitespace(claim)) ?? "unsupported";
				return {
					claim_id,
					supports_claim: status === "verified",
					explanation:
						status === "verified"
							? "Fixture ground truth marks this claim as supported by the cited note."
							: "Fixture ground truth marks this claim as not supported by the cited note.",
				};
			}),
		});
	}
	throw new Error(`Unsupported eval agent ${agentId}`);
}

async function classifyLiveClaim(
	queryFixture: LiveEvalQueryFixture,
	vault: VaultAdapter,
	claim: EvalClaimLike,
): Promise<ClaimVerificationStatus> {
	const sourceFile = vault.getFile(claim.sourceNote);
	if (!sourceFile) return "quote-missing";

	const body = await vault.read(sourceFile);
	if (!quotePresent(body, claim.sourceQuote)) return "quote-missing";

	return queryFixture.expectedClaims.some((expected) => matchesExpectedLiveClaim(claim, expected))
		? "verified"
		: "unsupported";
}

function extractVerifierClaims(prompt: string): Array<{ claim_id: string; claim: string }> {
	const match = prompt.match(/Claims:\s*([\s\S]*)$/);
	if (!match) return [];
	try {
		const parsed = JSON.parse(match[1]) as Array<{ claim_id?: string; claim?: string }>;
		return parsed
			.filter(
				(item): item is { claim_id: string; claim: string } =>
					typeof item?.claim_id === "string" && typeof item?.claim === "string",
			)
			.map((item) => ({ claim_id: item.claim_id, claim: item.claim }));
	} catch {
		return [];
	}
}

async function classifyDraftClaim(
	queryFixture: EvalQueryFixture,
	vault: VaultAdapter,
	claim: ClaimsV1["claims"][number],
): Promise<ClaimVerificationStatus> {
	const expected = findExpectedStatus(queryFixture, claim.text);
	if (expected) return expected;

	const sourceFile = vault.getFile(claim.source_note);
	if (!sourceFile) return "quote-missing";

	const body = await vault.read(sourceFile);
	return quotePresent(body, claim.source_quote) ? "unsupported" : "quote-missing";
}

function countEscapedHallucinations(
	queryFixture: EvalQueryFixture,
	claims: Array<{ text: string; status: ClaimVerificationStatus }>,
): number {
	return claims
		.filter((claim) => claim.status === "verified")
		.filter((claim) => findExpectedStatus(queryFixture, claim.text) !== "verified")
		.length;
}

function findExpectedStatus(queryFixture: EvalQueryFixture, text: string): ClaimVerificationStatus | null {
	const normalized = normalizeWhitespace(text);
	const expected = queryFixture.expectedSupport.find((item) => normalizeWhitespace(item.text) === normalized);
	if (expected) return expected.status;
	if (queryFixture.mustNotClaim?.some((item) => normalizeWhitespace(item) === normalized)) {
		return "unsupported";
	}
	return null;
}

async function countLiveEscapedHallucinations(
	queryFixture: LiveEvalQueryFixture,
	vault: VaultAdapter,
	claims: Array<{ text: string; sourceNote: string; sourceQuote: string; status: ClaimVerificationStatus }>,
): Promise<number> {
	const surfaced = claims.filter((claim) => claim.status === "verified");
	if (queryFixture.expectedOutcome === "unsupported") {
		return surfaced.length;
	}

	const statuses = await Promise.all(
		surfaced.map((claim) =>
			classifyLiveClaim(queryFixture, vault, {
				text: claim.text,
				sourceNote: claim.sourceNote,
				sourceQuote: claim.sourceQuote,
			}),
		),
	);
	return statuses.filter((status) => status !== "verified").length;
}

function matchesExpectedLiveClaim(claim: EvalClaimLike, expected: LiveEvalExpectedClaim): boolean {
	if (claim.sourceNote !== expected.source_note) return false;

	const normalizedText = normalizeWhitespace(claim.text).toLowerCase();
	if (expected.required_phrases.some((phrase) => !normalizedText.includes(normalizeWhitespace(phrase).toLowerCase()))) {
		return false;
	}
	if (
		expected.forbidden_phrases?.some((phrase) =>
			normalizedText.includes(normalizeWhitespace(phrase).toLowerCase()),
		)
	) {
		return false;
	}

	return true;
}

function countCategories<T extends { category: string }>(queries: T[]): Record<string, number> {
	const categories: Record<string, number> = {};
	for (const query of queries) {
		categories[query.category] = (categories[query.category] ?? 0) + 1;
	}
	return categories;
}

function emptyBuckets(): ClaimBuckets {
	return { verified: 0, unsupported: 0, quoteMissing: 0 };
}

function countBuckets(statuses: Iterable<ClaimVerificationStatus>): ClaimBuckets {
	const buckets = emptyBuckets();
	for (const status of statuses) {
		if (status === "verified") buckets.verified += 1;
		else if (status === "unsupported") buckets.unsupported += 1;
		else buckets.quoteMissing += 1;
	}
	return buckets;
}

function mergeBuckets(target: ClaimBuckets, source: ClaimBuckets): void {
	target.verified += source.verified;
	target.unsupported += source.unsupported;
	target.quoteMissing += source.quoteMissing;
}

function toRate(flagged: number, total: number): number {
	if (total === 0) return 0;
	return Number((flagged / total).toFixed(4));
}

function toDelta(baselineRate: number, verifiedRate: number): number {
	return Number((baselineRate - verifiedRate).toFixed(4));
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function ensureDirectory(targetPath: string, label: string): Promise<void> {
	const stat = await fs.stat(targetPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (stat === null) {
		await fs.mkdir(targetPath, { recursive: true });
		return;
	}
	if (!stat.isDirectory()) {
		throw new Error(`${label} path is not a directory: ${targetPath}`);
	}
}

function formatAjvErrors(errors: typeof fixtureValidator.errors): string {
	return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
}

function renderMarkdownReport(report: EvalReport): string {
	const lines = [
		`# Eval report ${report.runId}`,
		"",
		...(report.mode ? [`- **Mode:** ${report.mode}`] : []),
		...(report.dataset ? [`- **Dataset:** ${report.dataset.name}`] : []),
		`- **Pack:** ${report.packId}`,
		`- **Queries:** ${report.fixture.queryCount}`,
		`- **Baseline hallucination rate:** ${formatRate(report.baselineHallucinationRate)}`,
		`- **Verified hallucination rate:** ${formatRate(report.verifiedHallucinationRate)}`,
		`- **Delta (baseline - verified):** ${formatRate(report.hallucinationRateDelta)}`,
		`- **Total claims:** ${report.totalClaims}`,
		`- **Total flagged claims:** ${report.totalFlaggedClaims}`,
		"",
		"## Claim buckets",
		"",
		"| Bucket | Count |",
		"| --- | ---: |",
		`| verified | ${report.claimBuckets.verified} |`,
		`| unsupported | ${report.claimBuckets.unsupported} |`,
		`| quote-missing | ${report.claimBuckets.quoteMissing} |`,
		"",
		"## Per-query breakdown",
		"",
		"| ID | Category | Baseline rate | Verified rate | Flagged | Expected notes | Expected citations |",
		"| --- | --- | ---: | ---: | ---: | --- | --- |",
	];

	for (const query of report.perQuery) {
		lines.push(
			`| ${query.id} | ${query.category} | ${formatRate(query.baselineHallucinationRate)} | ${formatRate(query.verifiedHallucinationRate)} | ${query.verifiedFlaggedClaims} | ${query.notesExpectedSatisfied ? "yes" : "no"} | ${query.expectedCitationsSatisfied ? "yes" : "no"} |`,
		);
	}

	lines.push(
		"",
		"_Positive delta means verification reduced surfaced hallucinations._",
	);

	return lines.join("\n");
}

function formatRate(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

function isCompatiblePackId(expectedPackId: string, actualPackId: string): boolean {
	return (
		expectedPackId === actualPackId ||
		actualPackId.startsWith(`${expectedPackId}.`) ||
		expectedPackId.startsWith(`${actualPackId}.`)
	);
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	const { report, jsonPath, markdownPath } = await runEvalHarness(args);
	console.log(
		[
			`Created ${path.relative(process.cwd(), jsonPath)}`,
			`Created ${path.relative(process.cwd(), markdownPath)}`,
			...(report.dataset ? [`Dataset: ${report.dataset.name}`] : []),
			`Baseline hallucination rate: ${formatRate(report.baselineHallucinationRate)}`,
			`Verified hallucination rate: ${formatRate(report.verifiedHallucinationRate)}`,
		].join("\n"),
	);
}

function parseCliArgs(args: string[]): {
	packPath?: string;
	live?: boolean;
	benchmarkPath?: string;
	vaultDir?: string;
	resultsDir?: string;
} {
	const options: {
		packPath?: string;
		live?: boolean;
		benchmarkPath?: string;
		vaultDir?: string;
		resultsDir?: string;
	} = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--live") {
			options.live = true;
			continue;
		}
		if (arg === "--benchmark") {
			const value = args[index + 1];
			if (!value) throw new Error("Missing value after --benchmark");
			options.benchmarkPath = path.resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--pack") {
			const value = args[index + 1];
			if (!value) throw new Error("Missing value after --pack");
			options.packPath = path.resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--vault") {
			const value = args[index + 1];
			if (!value) throw new Error("Missing value after --vault");
			options.vaultDir = path.resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--results") {
			const value = args[index + 1];
			if (!value) throw new Error("Missing value after --results");
			options.resultsDir = path.resolve(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown eval argument: ${arg}`);
	}
	return options;
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
