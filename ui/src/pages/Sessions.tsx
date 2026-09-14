import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, MessagesSquare, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { getLog, searchLogs, searchSessions } from '@/api/logsApi';
import {
	EmptyState,
	formatDate,
	formatNumber,
	formatRelativeTime,
	PageHeader,
	Panel,
	StatusBanner
} from '@/components/Primitives';
import { queryParam } from '@/drawerRouteState';
import {
	CopyButton,
	formatCost,
	LogMessageView,
	logConversation,
	trajectoryEvents
} from '@/pages/Logs';
import type { LogEntry, SessionSummary } from '@/types';

const SESSION_PAGE_SIZE = 50;
const TURNS_PAGE_SIZE = 100;

export function SessionsPage() {
	const navigate = useNavigate({ from: '/llm/sessions' });
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sessionId, setSessionId] = useState<string | null>(() => queryParam('session'));
	const loadSeqRef = useRef(0);

	useEffect(() => {
		function syncSessionId() {
			setSessionId(queryParam('session'));
		}
		window.addEventListener('popstate', syncSessionId);
		return () => window.removeEventListener('popstate', syncSessionId);
	}, []);

	async function load(cursor?: string) {
		const loadingMore = Boolean(cursor);
		const loadSeq = loadSeqRef.current + 1;
		loadSeqRef.current = loadSeq;
		if (loadingMore) setLoadingMore(true);
		else setLoading(true);
		setError(null);
		try {
			const response = await searchSessions({ limit: SESSION_PAGE_SIZE, cursor });
			if (loadSeq !== loadSeqRef.current) return;
			setSessions(current => (cursor ? [...current, ...response.sessions] : response.sessions));
			setNextCursor(response.nextCursor ?? null);
		} catch (err) {
			if (loadSeq !== loadSeqRef.current) return;
			setError(err instanceof Error ? err.message : 'Failed to load sessions');
		} finally {
			if (loadSeq === loadSeqRef.current) {
				if (loadingMore) setLoadingMore(false);
				else setLoading(false);
			}
		}
	}

	useEffect(() => {
		void load();
	}, []);

	function openSession(id: string | null) {
		setSessionId(id);
		void navigate({
			to: '/llm/sessions',
			replace: true,
			resetScroll: false,
			search: previous => {
				const search = { ...(previous as Record<string, unknown>) };
				if (id) search.session = id;
				else delete search.session;
				return search;
			}
		});
	}

	const selected = sessionId
		? (sessions.find(session => session.session === sessionId) ?? null)
		: null;

	return (
		<div className="page-stack">
			<PageHeader
				title="Sessions"
				description="Group LLM calls into conversations and read each conversation end to end."
				actions={
					<button className="button" type="button" disabled={loading} onClick={() => void load()}>
						<RefreshCw size={16} className={loading ? 'spin' : undefined} />
						Refresh
					</button>
				}
			/>
			{error ? (
				<StatusBanner state="bad" title="Sessions API error">
					{error}
				</StatusBanner>
			) : null}
			{sessionId ? (
				<SessionDetail session={sessionId} summary={selected} onBack={() => openSession(null)} />
			) : (
				<Panel className="logs-results-panel">
					{sessions.length === 0 && !loading ? (
						<EmptyState
							title="No sessions yet"
							description="Sessions group requests that share a session id header (x-session-id). Ensure request logging is enabled and clients send session ids."
						/>
					) : sessions.length === 0 ? (
						<StatusBanner state="loading" title="Loading sessions" />
					) : (
						<div className="log-table-wrap">
							<table className="log-table sessions-table">
								<thead>
									<tr>
										<th>Title</th>
										<th>Session</th>
										<th className="num">Calls</th>
										<th className="num">Errors</th>
										<th className="num">Tokens</th>
										<th className="num">Cost</th>
										<th>Last activity</th>
										<th aria-label="Open" />
									</tr>
								</thead>
								<tbody>
									{sessions.map(session => (
										<SessionRow
											key={session.session}
											session={session}
											onOpen={() => openSession(session.session)}
										/>
									))}
								</tbody>
							</table>
							<div className="log-table-footer">
								{loading ? 'Refreshing...' : `Showing ${formatNumber(sessions.length)} sessions`}
								{nextCursor ? (
									<button
										className="button"
										type="button"
										disabled={loadingMore}
										onClick={() => void load(nextCursor)}
									>
										{loadingMore ? 'Loading...' : 'Load more'}
									</button>
								) : null}
							</div>
						</div>
					)}
				</Panel>
			)}
		</div>
	);
}

function SessionRow(props: { session: SessionSummary; onOpen: () => void }) {
	const session = props.session;
	const title = session.title?.trim() || session.session;
	return (
		<tr
			className="session-row"
			role="button"
			tabIndex={0}
			onClick={props.onOpen}
			onKeyDown={event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					props.onOpen();
				}
			}}
		>
			<td className="session-title">{title}</td>
			<td>
				<code className="session-id">{session.session}</code>
			</td>
			<td className="num">{formatNumber(session.requests)}</td>
			<td className="num">{session.errors ? formatNumber(session.errors) : '—'}</td>
			<td className="num">{formatNumber(session.totalTokens)}</td>
			<td className="num">{formatCost(session.cost)}</td>
			<td title={formatDate(session.lastSeen) ?? undefined}>
				{formatRelativeTime(session.lastSeen)}
			</td>
			<td className="center">
				<ChevronRight size={14} />
			</td>
		</tr>
	);
}

function SessionDetail(props: {
	session: string;
	summary: SessionSummary | null;
	onBack: () => void;
}) {
	const navigate = useNavigate({ from: '/llm/sessions' });
	const [turns, setTurns] = useState<LogEntry[]>([]);
	const [turnsCursor, setTurnsCursor] = useState<string | null>(null);
	const [transcript, setTranscript] = useState<LogEntry | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		abortRef.current = controller;
		void load(controller.signal);
		return () => controller.abort();
	}, [props.session]);

	async function load(signal: AbortSignal) {
		setLoading(true);
		setError(null);
		setTurns([]);
		setTranscript(null);
		setTurnsCursor(null);
		try {
			const response = await searchLogs({
				limit: TURNS_PAGE_SIZE,
				filters: { attributes: { 'agentgateway.session': props.session } }
			});
			if (signal.aborted) return;
			setTurns([...response.logs].reverse());
			setTurnsCursor(response.nextCursor ?? null);
			await loadTranscript(response.logs, signal);
		} catch (err) {
			if (!signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load session');
		} finally {
			if (!signal.aborted) setLoading(false);
		}
	}

	async function loadTranscript(descending: LogEntry[], signal: AbortSignal) {
		const latest = descending.find(entry => entry.hasPayload);
		if (!latest) return;
		const detail = await getLog(latest.id);
		if (signal.aborted) return;
		setTranscript(detail.log ?? latest);
	}

	async function loadOlder() {
		const signal = abortRef.current?.signal;
		if (!turnsCursor || signal?.aborted) return;
		const sessionAtStart = props.session;
		setLoadingOlder(true);
		setError(null);
		try {
			const response = await searchLogs({
				limit: TURNS_PAGE_SIZE,
				cursor: turnsCursor,
				filters: { attributes: { 'agentgateway.session': sessionAtStart } }
			});
			if (signal?.aborted || sessionAtStart !== props.session) return;
			setTurns(current => [...response.logs].reverse().concat(current));
			setTurnsCursor(response.nextCursor ?? null);
		} catch (err) {
			if (!signal?.aborted && sessionAtStart === props.session) {
				setError(err instanceof Error ? err.message : 'Failed to load older turns');
			}
		} finally {
			if (!signal?.aborted && sessionAtStart === props.session) {
				setLoadingOlder(false);
			}
		}
	}

	function openLatestInLogs() {
		const latest = turns[turns.length - 1];
		if (!latest) return;
		void navigate({
			to: '/llm/logs',
			search: previous => {
				const search = { ...(previous as Record<string, unknown>) };
				search.log = latest.id;
				return search;
			}
		});
	}

	const messages = transcript ? logConversation(transcript) : [];
	const trajectory = transcript ? trajectoryEvents(messages) : [];

	return (
		<Panel className="logs-results-panel">
			<div className="session-detail-header">
				<button className="button" type="button" onClick={props.onBack}>
					<ArrowLeft size={15} />
					Sessions
				</button>
				<div className="session-detail-title">
					<h3>
						<MessagesSquare size={16} />
						{props.summary?.title?.trim() || props.session}
					</h3>
					<div className="log-detail-id-row">
						<code>{props.session}</code>
						<CopyButton value={props.session} />
					</div>
				</div>
				{props.summary ? (
					<div className="session-detail-stats">
						<span>{formatNumber(props.summary.requests)} calls</span>
						<span>{formatNumber(props.summary.totalTokens)} tokens</span>
						<span>{formatCost(props.summary.cost)}</span>
					</div>
				) : null}
				{turns.length ? (
					<button className="button" type="button" onClick={openLatestInLogs}>
						Open latest call in Logs
					</button>
				) : null}
			</div>
			{loading ? (
				<StatusBanner state="loading" title="Loading session" />
			) : error ? (
				<StatusBanner state="bad" title="Session API error">
					{error}
				</StatusBanner>
			) : (
				<>
					<div className="log-table-wrap">
						<table className="log-table sessions-turns-table">
							<thead>
								<tr>
									<th>Time</th>
									<th>Model</th>
									<th>Turn</th>
									<th className="num">In</th>
									<th className="num">Out</th>
									<th className="num">Cost</th>
									<th className="center">Status</th>
								</tr>
							</thead>
							<tbody>
								{turns.map(turn => (
									<TurnRow key={turn.id} entry={turn} />
								))}
							</tbody>
						</table>
						<div className="log-table-footer">
							{turns.length
								? `${formatNumber(turns.length)} calls in this session`
								: 'No calls found for this session.'}
							{turnsCursor ? (
								<button
									className="button"
									type="button"
									disabled={loadingOlder}
									onClick={() => void loadOlder()}
								>
									{loadingOlder ? 'Loading...' : 'Load older calls'}
								</button>
							) : null}
						</div>
					</div>
					<section className="session-transcript">
						<h4>Conversation</h4>
						{messages.length ? (
							<div className="log-thread">
								{messages.map((message, index) => (
									<LogMessageView
										events={trajectory.filter(event => event.messageIndex === index)}
										message={message}
										key={`${message.role}-${index}`}
									/>
								))}
							</div>
						) : (
							<StatusBanner state="info" title="Prompt logging is off">
								Enable "Include prompts and completions in logs" in log settings to read the
								conversation here. Per-call metrics above are always available.
							</StatusBanner>
						)}
					</section>
				</>
			)}
		</Panel>
	);
}

function TurnRow(props: { entry: LogEntry }) {
	const entry = props.entry;
	const labels: Record<string, string> = {
		user: 'User',
		assistant: 'Assistant',
		toolCall: 'Tool call',
		toolResult: 'Tool result'
	};
	const turn = entry.turn?.input ? labels[entry.turn.input] : null;
	return (
		<tr>
			<td title={formatDate(entry.startedAt) ?? undefined}>
				{formatRelativeTime(entry.startedAt)}
			</td>
			<td>{entry.genAi.requestModel ?? '—'}</td>
			<td>{turn ?? '—'}</td>
			<td className="num">{entry.usage.inputTokens ?? '—'}</td>
			<td className="num">{entry.usage.outputTokens ?? '—'}</td>
			<td className="num">{entry.cost != null ? formatCost(entry.cost) : '—'}</td>
			<td className="center">{entry.httpStatus ?? '—'}</td>
		</tr>
	);
}
