import { importBaseCosts, refreshBaseCosts, type RefreshBaseCostsResponse } from '@/api/costsApi';
import type { GatewayConfig } from '@/types';

export type CostCatalogSource = { file?: string; inline?: unknown };

export function configuredCostSources(config: GatewayConfig | undefined): CostCatalogSource[] {
	return (config?.config?.modelCatalog ?? []) as unknown[] as CostCatalogSource[];
}

export function addBaseCostSource(config: GatewayConfig, file: string) {
	config.config = config.config ?? {};
	const existing = configuredCostSources(config);
	if (!existing.some(source => source.file === file)) {
		config.config.modelCatalog = [
			{ file },
			...existing.filter(source => source.file !== file)
		] as never;
	}
	return config;
}

type UpdateConfig = {
	mutateAsync: (updater: (config: GatewayConfig) => GatewayConfig | undefined) => Promise<unknown>;
};

/// When the response names a freshly written base-costs file, register it as a
/// catalog source so subsequent reloads pick it up.
async function configureBaseCostSource(
	updateConfig: UpdateConfig,
	response: RefreshBaseCostsResponse
) {
	if (response.file) {
		const file = response.file;
		await updateConfig.mutateAsync(next => addBaseCostSource(next, file));
	}
	return response;
}

export async function refreshBaseCostsAndConfigure(updateConfig: UpdateConfig) {
	return configureBaseCostSource(updateConfig, await refreshBaseCosts());
}

export async function importBaseCostsAndConfigure(
	updateConfig: UpdateConfig,
	catalog: unknown
) {
	return configureBaseCostSource(updateConfig, await importBaseCosts(catalog));
}
