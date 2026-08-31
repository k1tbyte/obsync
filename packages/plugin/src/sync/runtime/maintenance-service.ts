import { LOG_PATH_LIMIT } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import type { EngineDependencies } from "@/sync/engine";
import {
	type CleanResult,
	deepCleanOrphans,
	type VerifyResult,
	verifyRemote,
} from "@/sync/maintenance";

interface MaintenanceServiceDeps {
	openSession: () => Promise<EngineDependencies | null>;
	logInfo: (
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	) => Promise<void>;
}

export class MaintenanceService {
	constructor(private readonly deps: MaintenanceServiceDeps) {}

	async verifyRemote(deep: boolean): Promise<VerifyResult | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		const result = await verifyRemote(session.storage, session.key, deep);
		await this.deps.logInfo(
			ESyncLogOperation.Compare,
			`Integrity check: ${result.checked} object(s), ${result.missing.length} missing, ${result.corrupt.length} corrupt.`,
			[...result.missing, ...result.corrupt].slice(0, LOG_PATH_LIMIT),
		);
		return result;
	}

	async deepCleanRemote(): Promise<CleanResult | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		const result = await deepCleanOrphans(session.storage, session.key);
		await this.deps.logInfo(
			ESyncLogOperation.Reset,
			`Deep-clean removed ${result.deletedObjects} object(s) and ${result.deletedSnapshots} snapshot(s).`,
		);
		return result;
	}
}
