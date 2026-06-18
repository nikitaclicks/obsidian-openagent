import Ajv from "ajv";
import type { App } from "obsidian";
import groundedResearchDefault from "./defaults/grounded-research.json";
import { agentPackSchema, type AgentPack } from "./types";

const ajv = new Ajv({ allErrors: true, strict: false });

export class PackValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackValidationError";
	}
}

export async function ensureDefaultPacks(app: App, pluginDir: string): Promise<void> {
	const packDir = `${pluginDir}/packs`;
	if (!(await app.vault.adapter.exists(packDir))) {
		await app.vault.adapter.mkdir(packDir);
	}
	const listing = await app.vault.adapter.list(packDir).catch(() => ({ files: [] as string[] }));
	const jsonFiles = listing.files.filter((file) => file.endsWith(".json"));
	if (jsonFiles.length > 0) return;

	await app.vault.adapter.write(`${packDir}/grounded-research.json`, JSON.stringify(groundedResearchDefault, null, 2));
}

export async function loadPacks(app: App, pluginDir: string): Promise<AgentPack[]> {
	const packDir = `${pluginDir}/packs`;
	if (!(await app.vault.adapter.exists(packDir))) return [];
	const listing = await app.vault.adapter.list(packDir).catch(() => ({ files: [] as string[] }));
	const validate = ajv.compile<AgentPack>(agentPackSchema);
	const packs: AgentPack[] = [];

	for (const path of listing.files.filter((file) => file.endsWith(".json")).sort()) {
		const text = await app.vault.adapter.read(path);
		const parsed = JSON.parse(text) as unknown;
		if (!validate(parsed)) {
			const errors = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
			throw new PackValidationError(`Invalid pack at ${path}: ${errors}`);
		}
		const pack = resolvePackEnv(parsed, path);
		assertPackIntegrity(pack, path);
		packs.push(pack);
	}

	return packs;
}

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Resolves `${ENV_VAR}` references in a pack's provider strings (baseUrl, apiKey,
 * model) from the process environment, so secrets never need to live in committed
 * pack JSON. Throws PackValidationError if a referenced variable is unset or empty.
 * Mutates and returns the same pack object.
 */
export function resolvePackEnv(pack: AgentPack, path: string): AgentPack {
	const resolveString = (value: string): string =>
		value.replace(ENV_PATTERN, (_match, name: string) => {
			const env = typeof process !== "undefined" ? process.env?.[name] : undefined;
			if (env === undefined || env === "") {
				throw new PackValidationError(`Invalid pack at ${path}: environment variable ${name} is not set`);
			}
			return env;
		});

	for (const provider of Object.values(pack.providers)) {
		provider.baseUrl = resolveString(provider.baseUrl);
		provider.apiKey = resolveString(provider.apiKey);
		provider.model = resolveString(provider.model);
	}

	return pack;
}

function assertPackIntegrity(pack: AgentPack, path: string): void {
	if (Object.keys(pack.providers).length === 0) {
		throw new PackValidationError(`Invalid pack at ${path}: at least one provider is required`);
	}
	if (Object.keys(pack.agents).length === 0) {
		throw new PackValidationError(`Invalid pack at ${path}: at least one agent is required`);
	}
	for (const [agentId, agent] of Object.entries(pack.agents)) {
		const provider = pack.providers[agent.provider];
		if (!provider) {
			throw new PackValidationError(`Invalid pack at ${path}: agent ${agentId} references missing provider ${agent.provider}`);
		}
		if (!provider.baseUrl.trim() || !provider.model.trim() || !provider.apiKey.trim()) {
			throw new PackValidationError(`Invalid pack at ${path}: provider ${agent.provider} must declare baseUrl, apiKey, and model`);
		}
	}
	for (const step of pack.steps) {
		if (!pack.agents[step.agent]) {
			throw new PackValidationError(`Invalid pack at ${path}: step ${step.id} references missing agent ${step.agent}`);
		}
		if (step.kind === "structured" && step.schema !== "claims-v1") {
			throw new PackValidationError(`Invalid pack at ${path}: step ${step.id} must declare schema claims-v1`);
		}
	}
}
