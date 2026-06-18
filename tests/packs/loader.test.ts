import { describe, expect, it, vi } from "vitest";
import groundedResearchDefault from "../../src/packs/defaults/grounded-research.json";
import { ensureDefaultPacks, loadPacks, PackValidationError } from "../../src/packs/loader";
import { createMockApp } from "../setup";

describe("pack loader", () => {
	it("installs bundled defaults when no pack files exist", async () => {
		const app = createMockApp();

		await ensureDefaultPacks(app as never, "/plugin");

		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith("/plugin/packs");
		expect(app.vault.adapter.write).toHaveBeenCalledOnce();
		expect(app.vault.adapter.write).toHaveBeenCalledWith(
			"/plugin/packs/grounded-research.json",
			JSON.stringify(groundedResearchDefault, null, 2),
		);
	});

	it("loads pack json files in sorted order and validates integrity", async () => {
		const app = createMockApp({
			files: {
				"/plugin/packs/z-pack.json": JSON.stringify({
					...groundedResearchDefault,
					id: "z-pack",
					name: "Z Pack",
				}),
				"/plugin/packs/a-pack.json": JSON.stringify({
					...groundedResearchDefault,
					id: "a-pack",
					name: "A Pack",
				}),
			},
		});

		const packs = await loadPacks(app as never, "/plugin");

		expect(packs.map((pack) => pack.id)).toEqual(["a-pack", "z-pack"]);
	});

	it("throws when a pack references a missing provider", async () => {
		const app = createMockApp({
			files: {
				"/plugin/packs/invalid.json": JSON.stringify({
					...groundedResearchDefault,
					agents: {
						retriever: {
							...groundedResearchDefault.agents.retriever,
							provider: "missing",
						},
					},
				}),
			},
		});

		await expect(loadPacks(app as never, "/plugin")).rejects.toThrow(PackValidationError);
		await expect(loadPacks(app as never, "/plugin")).rejects.toThrow(
			"Invalid pack at /plugin/packs/invalid.json: agent retriever references missing provider missing",
		);
	});

	it("interpolates ${ENV_VAR} references in provider fields from the environment", async () => {
		const envPack = structuredClone(groundedResearchDefault);
		envPack.id = "env-pack";
		envPack.providers.retriever.baseUrl = "${AMD_RETRIEVER_URL}";
		envPack.providers.retriever.apiKey = "${AMD_API_KEY}";
		const app = createMockApp({
			files: { "/plugin/packs/env.json": JSON.stringify(envPack) },
		});
		vi.stubEnv("AMD_RETRIEVER_URL", "http://amd-host:8001/v1");
		vi.stubEnv("AMD_API_KEY", "secret-token");

		try {
			const packs = await loadPacks(app as never, "/plugin");
			expect(packs[0].providers.retriever.baseUrl).toBe("http://amd-host:8001/v1");
			expect(packs[0].providers.retriever.apiKey).toBe("secret-token");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("throws when a referenced environment variable is not set", async () => {
		const envPack = structuredClone(groundedResearchDefault);
		envPack.id = "env-missing";
		envPack.providers.retriever.apiKey = "${AMD_MISSING_KEY}";
		const app = createMockApp({
			files: { "/plugin/packs/env-missing.json": JSON.stringify(envPack) },
		});
		vi.stubEnv("AMD_MISSING_KEY", "");

		try {
			await expect(loadPacks(app as never, "/plugin")).rejects.toThrow(
				"environment variable AMD_MISSING_KEY is not set",
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("loads packs that still have placeholder credentials so runtime can reject them with recovery guidance", async () => {
		const placeholderPack = structuredClone(groundedResearchDefault);
		placeholderPack.id = "placeholder-pack";
		placeholderPack.providers.retriever.apiKey = "replace-me";
		const app = createMockApp({
			files: {
				"/plugin/packs/placeholder.json": JSON.stringify(placeholderPack),
			},
		});

		const packs = await loadPacks(app as never, "/plugin");

		expect(packs).toHaveLength(1);
		expect(packs[0].providers.retriever.apiKey).toBe("replace-me");
	});
});
