// Minimal "obsidian" runtime stub for vitest. The real package ships no usable
// entry outside Obsidian, so engine/import chains that transitively touch it
// (settings/model → storage/registry → ui/notices) need value exports to load.
// Only runtime shape is provided; types collapse to `any`.

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isMacOS: false,
	isWin: true,
	isLinux: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
};

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T): T {
	return fn;
}

export function requestUrl(): Promise<unknown> {
	return Promise.resolve({
		status: 200,
		json: {},
		text: "",
		arrayBuffer: new ArrayBuffer(0),
	});
}

export function normalizePath(path: string): string {
	return path;
}

class Stub {}

export class Notice extends Stub {}
export class Modal extends Stub {}
export class Plugin extends Stub {}
export class PluginSettingTab extends Stub {}
export class Setting extends Stub {}
export class ButtonComponent extends Stub {}
export class MarkdownView extends Stub {}
export class ItemView extends Stub {}
export class Menu extends Stub {}
export class TFile extends Stub {}
export class TFolder extends Stub {}
export class TAbstractFile extends Stub {}

export type App = unknown;
export type WorkspaceLeaf = unknown;
export type ObsidianProtocolData = unknown;
export type ViewStateResult = unknown;
export type DataAdapter = unknown;
export type ListedFiles = { files: string[]; folders: string[] };
export type Stat = {
	type: "file" | "folder";
	ctime: number;
	mtime: number;
	size: number;
};
