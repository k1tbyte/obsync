import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { reconcileBaselineResetGenerations } from "@/sync/config-reset";
import { EFileKind, type Manifest } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

describe("reconcileBaselineResetGenerations", () => {
	const scope = createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		configDir: ".obsidian",
	});

	const baseManifest: Manifest = {
		version: 2,
		vaultId: "vault-1",
		snapshotId: "snap-1",
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "dev-1",
		files: {
			"note.md": {
				hash: "hash1",
				size: 10,
				mtime: 1000,
				kind: EFileKind.Vault,
			},
			".obsidian/app.json": {
				hash: "hash2",
				size: 20,
				mtime: 2000,
				kind: EFileKind.Config,
			},
			".obsidian/plugins/dataview/data.json": {
				hash: "hash3",
				size: 30,
				mtime: 3000,
				kind: EFileKind.Plugin,
			},
		},
		folders: ["empty/", ".obsidian/plugins/empty-plugin/"],
		resetGenerations: {
			".obsidian/coreSettings": 1,
			".obsidian/pluginConfigs": 1,
		},
	};

	it("returns unchanged baseline when generations match", () => {
		const remoteManifest: Manifest = {
			...baseManifest,
			resetGenerations: {
				".obsidian/coreSettings": 1,
				".obsidian/pluginConfigs": 1,
			},
		};

		const reconciled = reconcileBaselineResetGenerations(
			baseManifest,
			remoteManifest,
			scope,
		);
		expect(reconciled).toBe(baseManifest);
	});

	it("returns unchanged baseline when remote has lower generations", () => {
		const remoteManifest: Manifest = {
			...baseManifest,
			resetGenerations: {
				".obsidian/coreSettings": 0,
			},
		};

		const reconciled = reconcileBaselineResetGenerations(
			baseManifest,
			remoteManifest,
			scope,
		);
		expect(reconciled).toBe(baseManifest);
	});

	it("removes paths for categories with higher remote generations", () => {
		const remoteManifest: Manifest = {
			...baseManifest,
			resetGenerations: {
				".obsidian/coreSettings": 1,
				".obsidian/pluginConfigs": 2, // Advanced
			},
		};

		const reconciled = reconcileBaselineResetGenerations(
			baseManifest,
			remoteManifest,
			scope,
		);
		expect(reconciled).not.toBe(baseManifest);
		expect(reconciled?.files["note.md"]).toBeDefined();
		expect(reconciled?.files[".obsidian/app.json"]).toBeDefined();
		expect(
			reconciled?.files[".obsidian/plugins/dataview/data.json"],
		).toBeUndefined();

		expect(reconciled?.folders).toContain("empty/");
		expect(reconciled?.folders).not.toContain(
			".obsidian/plugins/empty-plugin/",
		);

		expect(reconciled?.resetGenerations).toEqual({
			".obsidian/coreSettings": 1,
			".obsidian/pluginConfigs": 2,
		});
	});

	it("handles missing generations gracefully", () => {
		const baselineNoGen: Manifest = {
			...baseManifest,
			resetGenerations: undefined,
		};

		const remoteManifest: Manifest = {
			...baseManifest,
			resetGenerations: {
				".obsidian/coreSettings": 1,
			},
		};

		const reconciled = reconcileBaselineResetGenerations(
			baselineNoGen,
			remoteManifest,
			scope,
		);
		expect(reconciled?.files[".obsidian/app.json"]).toBeUndefined();
		expect(reconciled?.resetGenerations).toEqual({
			".obsidian/coreSettings": 1,
		});
	});
});
