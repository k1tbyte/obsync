/// <reference types="node" />

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));
type FlatConfig = Parameters<typeof tseslint.config>[number];
const obsidianRecommended = obsidianmd.configs?.recommended as Iterable<FlatConfig> | undefined;
const obsidianConfigs = obsidianRecommended
    ? Array.from(obsidianRecommended)
    : [];

export default tseslint.config(
    {
        files: ["**/*.ts", "**/*.mts"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.mts", "manifest.json"],
                },
                tsconfigRootDir,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianConfigs,
    {
        rules: {
            "obsidianmd/ui/sentence-case": "off",
        },
    },
    globalIgnores([
        "**/node_modules",
        "**/dist",
        "**/main.js",
        "**/esbuild.config.mjs",
        "**/vitest.config.ts",
        "version-bump.mjs",
        "versions.json",
        "temp",
    ]),
);
