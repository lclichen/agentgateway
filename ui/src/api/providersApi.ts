import { requestJson } from '@/api/base';
import type { LlmProvider } from '@/types';

export interface DiscoveredModel {
	id: string;
	ownedBy?: string;
	created?: number;
	contextLength?: number;
	maxOutputTokens?: number;
}

export interface DiscoverModelsResponse {
	endpoint: string;
	models: DiscoveredModel[];
}

export function discoverProviderModels(request: { name?: string; provider?: LlmProvider }) {
	return requestJson<DiscoverModelsResponse>('/api/providers/discover-models', {
		method: 'POST',
		body: JSON.stringify(request)
	});
}
