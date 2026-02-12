import { useMemo, useState } from "react";
import type { SessionRecord } from "../../lib/tauri-commands";

function toDateMilliseconds(createdAt: number): number {
  if (!Number.isFinite(createdAt)) {
    return Date.now();
  }

  return createdAt > 1_000_000_000_000 ? createdAt : createdAt * 1_000;
}

function formatSessionDate(createdAt: number): string {
  return new Date(toDateMilliseconds(createdAt)).toLocaleString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }

  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return mins === 0 ? `${secs}s` : `${mins}m ${secs}s`;
}

function statusClass(status: string): string {
  return `history-view__status history-view__status--${status || "unknown"}`;
}

export interface HistoryViewProps {
  sessions: SessionRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onReopenSession: (session: SessionRecord) => void;
  onExportSession: (session: SessionRecord) => void;
  onDeleteSession: (session: SessionRecord) => void;
  onRevealPath: (path: string) => void;
}

export function HistoryView({
  sessions,
  loading,
  error,
  onRefresh,
  onReopenSession,
  onExportSession,
  onDeleteSession,
  onRevealPath,
}: HistoryViewProps) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [provider, setProvider] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const providerOptions = useMemo(
    () => Array.from(new Set(sessions.map((session) => session.provider))).sort((a, b) => a.localeCompare(b)),
    [sessions]
  );

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;

    return sessions.filter((session) => {
      if (provider && session.provider !== provider) {
        return false;
      }

      const createdAtMs = toDateMilliseconds(session.createdAt);
      if (fromTime !== null && createdAtMs < fromTime) {
        return false;
      }
      if (toTime !== null && createdAtMs > toTime) {
        return false;
      }

      if (!query) {
        return true;
      }

      const searchable = [
        session.id,
        session.provider,
        session.model,
        session.status,
        ...session.files.map((file) => file.name),
      ]
        .join(" ")
        .toLowerCase();

      return searchable.includes(query);
    });
  }, [dateFrom, dateTo, provider, search, sessions]);

  const effectiveSelectedSessionId = useMemo(() => {
    if (filteredSessions.length === 0) {
      return null;
    }

    if (
      selectedSessionId &&
      filteredSessions.some((session) => session.id === selectedSessionId)
    ) {
      return selectedSessionId;
    }

    return filteredSessions[0].id;
  }, [filteredSessions, selectedSessionId]);

  const selectedSession = useMemo(
    () => filteredSessions.find((session) => session.id === effectiveSelectedSessionId) ?? null,
    [effectiveSelectedSessionId, filteredSessions]
  );

  return (
    <section className="history-view panel-blur" data-testid="history-view">
      <header className="history-view__header">
        <div>
          <p className="history-view__eyebrow">History</p>
          <h2>Session History</h2>
        </div>
        <button type="button" className="actions-bar__secondary" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      <div className="history-view__filters">
        <label className="history-view__field">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Session, provider, model, file..."
          />
        </label>
        <label className="history-view__field">
          <span>Date From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label className="history-view__field">
          <span>Date To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>
        <label className="history-view__field">
          <span>Provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">All providers</option>
            {providerOptions.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <p className="history-view__error">{error}</p> : null}
      {loading ? <p className="history-view__loading">Loading history...</p> : null}

      <div className="history-view__body">
        <ul className="history-view__list" data-testid="history-list">
          {filteredSessions.length === 0 ? (
            <li className="history-view__empty">No sessions match the current filters.</li>
          ) : (
            filteredSessions.map((session) => {
              const selected = session.id === effectiveSelectedSessionId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`history-view__item${selected ? " history-view__item--selected" : ""}`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <span className="history-view__item-top">
                      <strong>{session.provider}</strong>
                      <span className={statusClass(session.status)}>{session.status}</span>
                    </span>
                    <span className="history-view__item-meta">{session.model}</span>
                    <span className="history-view__item-meta">{formatSessionDate(session.createdAt)}</span>
                    <span className="history-view__item-meta">
                      {session.processed}/{session.total} succeeded, {session.failed} failed
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <aside className="history-view__detail" data-testid="history-detail">
          {!selectedSession ? (
            <p className="history-view__empty">Select a session to inspect details.</p>
          ) : (
            <>
              <h3>{selectedSession.id}</h3>
              <p>
                {selectedSession.provider} / {selectedSession.model}
              </p>
              <p>{formatSessionDate(selectedSession.createdAt)}</p>
              <p>Duration: {formatDuration(selectedSession.durationSeconds)}</p>
              <p>
                Total {selectedSession.total} | Processed {selectedSession.processed} | Skipped{" "}
                {selectedSession.skipped} | Failed {selectedSession.failed}
              </p>
              <p>
                Output:{" "}
                <button
                  type="button"
                  className="history-view__path"
                  onClick={() => onRevealPath(selectedSession.outputDir)}
                >
                  {selectedSession.outputDir}
                </button>
              </p>
              <p>
                Manifest:{" "}
                <button
                  type="button"
                  className="history-view__path"
                  onClick={() => onRevealPath(selectedSession.manifestPath)}
                >
                  {selectedSession.manifestPath}
                </button>
              </p>

              <div className="history-view__detail-actions">
                <button
                  type="button"
                  className="actions-bar__secondary"
                  onClick={() => onReopenSession(selectedSession)}
                >
                  Reopen Session
                </button>
                <button
                  type="button"
                  className="actions-bar__secondary"
                  onClick={() => onExportSession(selectedSession)}
                >
                  Export Transcripts
                </button>
                <button
                  type="button"
                  className="actions-bar__stop-confirm"
                  onClick={() => onDeleteSession(selectedSession)}
                >
                  Delete Session
                </button>
              </div>

              <ul className="history-view__files">
                {selectedSession.files.map((file) => (
                  <li key={`${file.id}-${file.path}`}>
                    <span>{file.name}</span>
                    <span className={statusClass(file.status)}>{file.status}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
