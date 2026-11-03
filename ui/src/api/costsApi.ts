import { requestJson } from '@/api/base';

export interface RefreshBaseCostsResponse {
	file?: string;
	providers: number;
	models: number;
}

export interface CostCatalogModelsResponse {
	loaded: boolean;
	providers: Array<{
		provider: string;
		models: string[];
	}>;
}

export function refreshBaseCosts() {
	return requestJson<RefreshBaseCostsResponse>('/api/costs/refresh-base', {
		method: 'POST'
	});
}

/// Installs an uploaded base catalog for air-gapped deployments; the body is
/// the catalog JSON itself (generate with `agctl catalog import --out`).
export function importBaseCosts(catalog: unknown) {
	return requestJson<RefreshBaseCostsResponse>('/api/costs/import-base', {
		method: 'POST',
		body: JSON.stringify(catalog)
	});
}

export function listCostModels() {
	return requestJson<CostCatalogModelsResponse>('/api/costs/models');
}
