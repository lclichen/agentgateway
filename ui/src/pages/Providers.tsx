import { Link } from '@tanstack/react-router';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { DiscoveredModel } from '@/api/providersApi';
import { discoverProviderModels } from '@/api/providersApi';
import { ConfigDiffSaveActions } from '@/components/ConfigDiffDrawer';
import { LostFieldsWarning, useMergedEdits } from '@/components/EditorContracts';
import {
	ConfirmDialog,
	Drawer,
	EmptyState,
	Field,
	FieldGroup,
	PageHeader,
	Panel,
	StatusBanner,
	Tooltip
} from '@/components/Primitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import {
	invalidProviderApiKey,
	isDatabaseConfigResource,
	makeEmptyLlmProvider,
	providerDisplayName,
	providerLabel,
	upsertLlmProvider
} from '@/config';
import { useStickyQueryParam } from '@/drawerRouteState';
import {
	useDeleteConfigResource,
	useLlmConfigData,
	usePutConfigResources,
	useUpsertConfigResource
} from '@/hooks';
import { ProviderConfigEditor } from '@/pages/models/ProviderConfigEditor';
import { cleanEmpty } from '@/policies/policyUtils';
import { type SchemaHelp, useSchemaHelp } from '@/schemaHelp';
import type { GatewayConfig, LlmModel, LlmProvider, ProviderName } from '@/types';

export function ProvidersPage() {
	const { config, hybrid, resources, models, providers, isLoading, error } = useLlmConfigData();
	const upsertResource = useUpsertConfigResource();
	const putResources = usePutConfigResources();
	const deleteResource = useDeleteConfigResource();
	const help = useSchemaHelp();
	const [editing, setEditing] = useState<{
		previousName?: string;
		provider: LlmProvider;
	} | null>(null);
	const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
	const [providerDrawer, setProviderDrawer] = useStickyQueryParam('provider');
	const linkedProvider =
		providerDrawer && providerDrawer !== 'new'
			? providers.find(provider => provider.name === providerDrawer)
			: null;
	const activeEditing =
		editing ??
		(providerDrawer === 'new'
			? { provider: makeEmptyLlmProvider() }
			: linkedProvider
				? {
						previousName: linkedProvider.name,
						provider: structuredClone(linkedProvider)
					}
				: null);
	const editingDatabaseProvider = Boolean(
		hybrid &&
			activeEditing &&
			(!activeEditing.previousName ||
				isDatabaseConfigResource(resources, 'llm.provider', activeEditing.previousName))
	);

	function openNewProvider() {
		resetSaves();
		setEditing(null);
		setProviderDrawer('new');
	}

	function openEditProvider(provider: LlmProvider) {
		resetSaves();
		setEditing(null);
		setProviderDrawer(provider.name);
	}

	function closeProviderEditor() {
		resetSaves();
		setEditing(null);
		setProviderDrawer(null, 'replace');
	}

	const saving = upsertResource.isPending || deleteResource.isPending || putResources.isPending;
	const saveError =
		upsertResource.error?.message ??
		deleteResource.error?.message ??
		putResources.error?.message ??
		null;
	const saved = upsertResource.isSuccess || deleteResource.isSuccess;

	function resetSaves() {
		upsertResource.reset();
		deleteResource.reset();
		putResources.reset();
	}

	function saveProvider(
		provider: LlmProvider,
		previousName?: string,
		discoveredModels?: DiscoveredModel[]
	) {
		upsertResource.mutate(
			{ kind: 'llm.provider', value: provider, previousId: previousName },
			{
				onSuccess: () => {
					if (discoveredModels?.length) {
						const existing = new Set(models.map(model => model.name));
						const toAdd = discoveredModels.filter(model => !existing.has(model.id));
						if (toAdd.length) {
							putResources.mutate({
								kind: 'llm.model',
								values: toAdd.map((model): LlmModel => {
									const metadata: LlmModel['metadata'] = {};
									if (model.contextLength) metadata.contextLength = model.contextLength;
									if (model.maxOutputTokens) metadata.maxOutputTokens = model.maxOutputTokens;
									if (model.inputModalities?.length)
										metadata.inputModalities = model.inputModalities;
									if (model.outputModalities?.length)
										metadata.outputModalities = model.outputModalities;
									return {
										name: model.id,
										provider: { reference: provider.name },
										...(Object.keys(metadata).length ? { metadata } : {})
									};
								})
							});
						}
					}
					closeProviderEditor();
				}
			}
		);
	}

	function deleteProvider(name: string) {
		deleteResource.mutate(
			{ kind: 'llm.provider', id: name },
			{
				onSuccess: () => setDeletingProvider(null)
			}
		);
	}

	return (
		<div className="page-stack">
			<PageHeader
				title="LLM Providers"
				description="Define reusable provider credentials and connection settings for models."
				actions={
					<button className="button primary" type="button" onClick={openNewProvider}>
						<Plus size={16} />
						Add provider
					</button>
				}
			/>

			{saveError ? (
				<StatusBanner state="bad" title="Save failed">
					{saveError}
				</StatusBanner>
			) : null}
			{saved ? <StatusBanner state="ok" title="Configuration saved" /> : null}

			<Panel>
				{isLoading ? (
					<StatusBanner state="loading" title="Loading providers" />
				) : error ? (
					<StatusBanner state="bad" title="Configuration API unavailable">
						{error.message}
					</StatusBanner>
				) : providers.length === 0 ? (
					<EmptyState
						title="No shared providers configured"
						description="Add a provider when multiple models should share the same credentials or upstream connection settings."
						action={
							<button className="button primary" type="button" onClick={openNewProvider}>
								<Plus size={16} />
								Add provider
							</button>
						}
					/>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Name</th>
									{hybrid ? <th>Source</th> : null}
									<th>Provider</th>
									<th>Upstream model</th>
									<th>Used by</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{providers.map(provider => {
									const usage = providerUsage(provider.name, models);
									const databaseBacked = isDatabaseConfigResource(
										resources,
										'llm.provider',
										provider.name
									);
									return (
										<tr key={provider.name}>
											<td className="strong">{provider.name}</td>
											{hybrid ? (
												<td>
													<span className="badge">{databaseBacked ? 'Database' : 'File'}</span>
												</td>
											) : null}
											<td>
												<ProviderBadge
													provider={providerLabel(provider.provider) as ProviderName}
												/>
											</td>
											<td>{provider.params?.model || 'Incoming model'}</td>
											<td>
												{usage.length ? (
													<span className="badge ok">
														{usage.length} {usage.length === 1 ? 'model' : 'models'}
													</span>
												) : (
													<span className="badge">unused</span>
												)}
											</td>
											<td className="row-actions">
												<Tooltip content="Add model using this provider">
													<Link
														className="icon-button"
														aria-label="Add model using provider"
														to="/llm/models"
														search={{ provider: provider.name }}
													>
														<Bot size={16} />
													</Link>
												</Tooltip>
												<Tooltip content="Edit provider">
													<button
														className="icon-button"
														aria-label="Edit provider"
														type="button"
														onClick={() => openEditProvider(provider)}
													>
														<Pencil size={16} />
													</button>
												</Tooltip>
												<Tooltip
													content={
														usage.length
															? 'Provider is referenced by models'
															: hybrid && !databaseBacked
																? 'File-owned providers cannot be deleted here'
																: 'Delete provider'
													}
												>
													<button
														className="icon-button danger"
														aria-label="Delete provider"
														type="button"
														disabled={usage.length > 0 || saving || (hybrid && !databaseBacked)}
														onClick={() => setDeletingProvider(provider.name)}
													>
														<Trash2 size={16} />
													</button>
												</Tooltip>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			{activeEditing ? (
				<ProviderEditor
					key={activeEditing.previousName ?? 'new'}
					initial={activeEditing.provider}
					config={config.data}
					databaseBacked={editingDatabaseProvider}
					previousName={activeEditing.previousName}
					help={help}
					saving={saving}
					existingModelNames={models.map(model => model.name)}
					onCancel={closeProviderEditor}
					onSave={saveProvider}
				/>
			) : null}
			{deletingProvider ? (
				<ConfirmDialog
					title="Delete provider?"
					destructive
					confirmLabel="Delete provider"
					confirmDisabled={saving}
					onCancel={() => setDeletingProvider(null)}
					onConfirm={() => deleteProvider(deletingProvider)}
				>
					<p>
						Delete <strong>{deletingProvider}</strong>? This cannot be undone.
					</p>
				</ConfirmDialog>
			) : null}
		</div>
	);
}

function ProviderEditor(props: {
	initial: LlmProvider;
	config?: GatewayConfig;
	databaseBacked: boolean;
	previousName?: string;
	help: SchemaHelp;
	saving: boolean;
	existingModelNames: string[];
	onCancel: () => void;
	onSave: (
		provider: LlmProvider,
		previousName?: string,
		discoveredModels?: DiscoveredModel[]
	) => void;
}) {
	const [provider, setProvider] = useState<LlmProvider>(props.initial);
	const [initialDraft] = useState(() => JSON.stringify(props.initial));
	const [saveAttempted, setSaveAttempted] = useState(false);
	const merged = useMergedEdits(
		props.previousName ? props.initial : undefined,
		cleanEmpty(provider) as LlmProvider | undefined,
		['$defs', 'LocalLLMProvider']
	);
	const preview = merged.value;
	const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
	const invalidApiKey = invalidProviderApiKey(provider.params?.apiKey);
	const providerApiKeyError =
		saveAttempted && invalidApiKey ? 'Enter a value, or choose Unset.' : null;

	function save() {
		setSaveAttempted(true);
		if (invalidApiKey) return;
		props.onSave(preview ?? provider, props.previousName, discoveredModels);
	}

	function validateBeforeDiff() {
		setSaveAttempted(true);
		if (!provider.name.trim()) return false;
		if (invalidApiKey) return false;
		return true;
	}

	return (
		<Drawer
			title={props.previousName ? 'Edit provider' : 'Add provider'}
			onClose={props.onCancel}
			dirty={JSON.stringify(provider) !== initialDraft}
			saving={props.saving}
			raw={{
				schemaPath: ['$defs', 'LocalLLMProvider'],
				value: () => preview ?? provider,
				onChange: value => {
					setProvider(value as LlmProvider);
					merged.reset(value);
				},
				empty: makeEmptyLlmProvider()
			}}
			footer={requestClose => (
				<ConfigDiffSaveActions
					config={props.config}
					resourceDiff={
						props.databaseBacked
							? {
									original: props.previousName ? props.initial : {},
									modified: preview ?? {}
								}
							: undefined
					}
					diffTitle={props.databaseBacked ? 'Provider resource diff' : 'Provider config diff'}
					saveLabel="Save provider"
					saving={props.saving}
					onCancel={requestClose}
					onSave={save}
					beforeDiff={validateBeforeDiff}
					applyDiff={next => upsertLlmProvider(next, preview ?? provider, props.previousName)}
				/>
			)}
		>
			<LostFieldsWarning lost={merged.lost} />
			<div className="form-grid">
				<Field
					label="Provider name"
					path="name"
					tooltip={props.help.field<LlmProvider>(
						'LocalLLMProvider',
						'name',
						'Models reference this name from their provider field.'
					)}
				>
					<input
						value={provider.name}
						onChange={event => setProvider({ ...provider, name: event.target.value })}
						placeholder="openai-prod"
					/>
				</Field>
			</div>

			<ProviderConfigEditor
				provider={provider.provider}
				params={provider.params}
				auth={provider.defaults?.auth}
				help={props.help}
				apiKeyError={providerApiKeyError}
				onProviderChange={(nextProvider, params) =>
					setProvider(current => ({
						...current,
						provider: nextProvider,
						params
					}))
				}
				onParamsChange={params => setProvider(current => ({ ...current, params }))}
				onAuthChange={auth =>
					setProvider(current => ({
						...current,
						defaults: auth
							? { ...(current.defaults ?? {}), auth }
							: removeProviderAuth(current.defaults)
					}))
				}
			/>
			<DiscoverModelsSection
				provider={provider}
				previousName={props.previousName}
				existingModelNames={props.existingModelNames}
				selected={discoveredModels}
				onSelectedChange={setDiscoveredModels}
			/>
		</Drawer>
	);
}

function DiscoverModelsSection(props: {
	provider: LlmProvider;
	previousName?: string;
	existingModelNames: string[];
	selected: DiscoveredModel[];
	onSelectedChange: (models: DiscoveredModel[]) => void;
}) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<{ endpoint: string; models: DiscoveredModel[] } | null>(
		null
	);

	async function discover() {
		setLoading(true);
		setError(null);
		try {
			const response = await discoverProviderModels({
				name: props.previousName ?? props.provider.name.trim(),
				provider: props.provider
			});
			setResult(response);
			// Opt-in selection: discovering must not mass-create models on a
			// later accidental save. "Select new" picks the unconfigured ones.
			props.onSelectedChange([]);
		} catch (err) {
			setResult(null);
			setError(err instanceof Error ? err.message : 'Discovery failed');
			props.onSelectedChange([]);
		} finally {
			setLoading(false);
		}
	}

	function toggle(model: DiscoveredModel, checked: boolean) {
		props.onSelectedChange(
			checked ? [...props.selected, model] : props.selected.filter(entry => entry.id !== model.id)
		);
	}

	const existingSet = new Set(props.existingModelNames);
	const selectable = result?.models.filter(model => !existingSet.has(model.id)) ?? [];

	return (
		<section className="discover-models">
			<FieldGroup
				label="Discover models"
				tooltip="Probe the provider's OpenAI-compatible /v1/models endpoint and add the models you want as llm.model entries."
			>
				<div className="discover-models-actions">
					<button
						className="button"
						type="button"
						disabled={loading || !props.provider.name.trim()}
						onClick={() => void discover()}
					>
						{loading ? 'Discovering…' : result ? 'Refresh models' : 'Discover upstream models'}
					</button>
					{result ? (
						<span className="muted">
							{result.models.length} models · {result.endpoint}
						</span>
					) : (
						<span className="muted">Requires a baseUrl (or a provider preset).</span>
					)}
				</div>
			</FieldGroup>
			{error ? (
				<StatusBanner state="bad" title="Model discovery failed">
					{error}
				</StatusBanner>
			) : null}
			{result && result.models.length === 0 ? (
				<StatusBanner state="warn" title="No models reported">
					The upstream model list at {result.endpoint} is empty.
				</StatusBanner>
			) : null}
			{result && result.models.length > 0 ? (
				<div className="discover-models-list">
					<div className="discover-models-list-actions">
						<button
							className="button small"
							type="button"
							onClick={() => props.onSelectedChange(selectable)}
						>
							Select new
						</button>
						<button
							className="button small"
							type="button"
							onClick={() => props.onSelectedChange([])}
						>
							Clear
						</button>
						<span className="muted">
							{props.selected.length} selected · added when you save the provider
						</span>
					</div>
					<div className="discover-models-scroll">
						{result.models.map(model => {
							const existing = existingSet.has(model.id);
							const checked = props.selected.some(entry => entry.id === model.id);
							return (
								<label key={model.id} className="toggle-row discover-model-row">
									<input
										type="checkbox"
										checked={checked}
										disabled={existing}
										onChange={event => toggle(model, event.target.checked)}
									/>
									<span className="discover-model-id">{model.id}</span>
									{existing ? (
										<span className="muted">already configured</span>
									) : (
										<span className="muted">
											{[
												model.contextLength ? `ctx ${model.contextLength}` : null,
												model.maxOutputTokens ? `out ${model.maxOutputTokens}` : null,
												model.ownedBy
											]
												.filter(Boolean)
												.join(' · ')}
										</span>
									)}
								</label>
							);
						})}
					</div>
				</div>
			) : null}
		</section>
	);
}

function removeProviderAuth(defaults: LlmProvider['defaults']) {
	if (!defaults) return null;
	const next = { ...defaults, auth: null };
	return Object.values(next).some(value => value !== null && value !== undefined) ? next : null;
}

function ProviderBadge(props: { provider: ProviderName }) {
	return (
		<span className="badge provider-badge">
			<ProviderIcon provider={props.provider} />
			{providerDisplayName(props.provider)}
		</span>
	);
}

function providerUsage(providerName: string, models: LlmModel[]) {
	return models.filter(
		model =>
			typeof model.provider === 'object' &&
			'reference' in model.provider &&
			model.provider.reference === providerName
	);
}
