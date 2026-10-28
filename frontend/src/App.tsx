// Adapted from assistant-ui's Perplexity layout. See THIRD_PARTY_NOTICES.txt.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive,
  ThreadPrimitive, useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
type Conversation = { conversation_id: string; messages: StoredMessage[] };
type Created = { conversation_id: string };
type MemoryRecord = {
  id: number;
  memory_key: string;
  value: string;
  origin: string;
  confirmation_status: string;
  created_at: string;
};
type Saved = {
  saved: boolean;
  memory_key: string;
  value: string;
  revision_id: number;
};
type StreamOutcome = {
  request_id: string;
  status: "completed" | "cancelled" | "inference_error" | "transport_error" |
    "save_error" | "request_error" | "disconnected" | "active" | "cancelling" |
    "pending" | "unknown";
  saved?: boolean;
  conversation_id?: string;
  model?: string;
  memory_used?: MemoryRecord[];
  detail?: string;
  cancellation_requested?: boolean;
};
type ActiveStream = {
  requestId: string;
  controller: AbortController;
  exchange: PendingExchange;
  terminalHandled: boolean;
  registered: boolean;
};
type PendingMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  displayLabel?: string;
};
type PendingExchange = {
  user: PendingMessage;
  assistant: PendingMessage;
  status: "streaming" | "stopping" | "unknown" | "failed" | "confirmed" | "cancelled";
};
const CONVERSATION_KEY = "local-first-ai.conversation-id";

async function responseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status}).`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null &&
        "detail" in body && typeof body.detail === "string") {
      detail = body.detail;
    }
  } catch { /* Proxy failures may return non-JSON content. */ }
  return new Error(detail);
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}
function isMemoryRecord(value: unknown): value is MemoryRecord {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "number" &&
    "memory_key" in value && typeof value.memory_key === "string" &&
    "value" in value && typeof value.value === "string" &&
    "origin" in value && typeof value.origin === "string" &&
    "confirmation_status" in value && typeof value.confirmation_status === "string" &&
    "created_at" in value && typeof value.created_at === "string";
}
function parseStreamFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\n")) as unknown };
}
function isStreamOutcome(value: unknown): value is StreamOutcome {
  if (typeof value !== "object" || value === null ||
      !("request_id" in value) || typeof value.request_id !== "string" ||
      !("status" in value) || typeof value.status !== "string") return false;
  const statuses = ["completed", "cancelled", "inference_error", "transport_error",
    "save_error", "request_error", "disconnected", "active", "cancelling", "pending", "unknown"];
  if (!statuses.includes(value.status)) return false;
  return !("memory_used" in value) || (Array.isArray(value.memory_used) && value.memory_used.every(isMemoryRecord));
}
function isTerminalOutcome(outcome: StreamOutcome): boolean {
  return ["completed", "cancelled", "inference_error", "transport_error", "save_error", "request_error", "disconnected"]
    .includes(outcome.status);
}
async function boundedJsonRequest(path: string, options: RequestInit = {}): Promise<StreamOutcome> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`/api${path}`, { ...options, signal: controller.signal });
    if (!response.ok) throw await responseError(response);
    const body: unknown = await response.json();
    if (!isStreamOutcome(body)) throw new Error("The server returned an invalid request status.");
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}
async function requestCancellation(requestId: string): Promise<StreamOutcome> {
  return boundedJsonRequest(`/chat/stream/${requestId}/cancel`, { method: "POST" });
}
async function requestStreamStatus(requestId: string): Promise<StreamOutcome> {
  return boundedJsonRequest(`/chat/stream/${requestId}/status`);
}
async function streamChat(
  conversationId: string,
  requestId: string,
  message: string,
  memoryKey: string | null,
  controller: AbortController,
  onRegistered: () => void,
  onText: (text: string) => void,
): Promise<StreamOutcome> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: conversationId,
      request_id: requestId,
      message,
      memory_key: memoryKey,
    }),
    signal: controller.signal,
  });
  if (!response.ok) throw await responseError(response);
  onRegistered();
  if (!response.body) throw new Error("Streaming response body is unavailable; request outcome is unknown.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const parsed = parseStreamFrame(frame);
        if (parsed) {
          if (parsed.event === "text" && typeof parsed.data === "object" && parsed.data !== null &&
              "request_id" in parsed.data && parsed.data.request_id === requestId &&
              "text" in parsed.data && typeof parsed.data.text === "string") {
            onText(parsed.data.text);
          } else if (["completion", "cancelled", "error"].includes(parsed.event) && isStreamOutcome(parsed.data)) {
            if (parsed.data.request_id !== requestId || !isTerminalOutcome(parsed.data)) {
              throw new Error("The server sent an invalid terminal chat event; request outcome is unknown.");
            }
            if (parsed.event === "completion" && parsed.data.status !== "completed" ||
                parsed.event === "cancelled" && parsed.data.status !== "cancelled" ||
                parsed.event === "error" && !["inference_error", "transport_error", "save_error", "request_error"].includes(parsed.data.status)) {
              throw new Error("The server sent an inconsistent terminal chat event; request outcome is unknown.");
            }
            return parsed.data;
          } else {
            throw new Error("The server sent an invalid chat stream event; request outcome is unknown.");
          }
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
    throw new Error("Connection closed without a terminal request outcome.");
  } finally {
    reader.releaseLock();
  }
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function convertMessage(message: StoredMessage | PendingMessage): ThreadMessageLike {
  const content = "displayLabel" in message && message.displayLabel
    ? `${message.displayLabel}\n\n${message.content}`
    : message.content;
  return {
    id: String(message.id), role: message.role,
    content: [{ type: "text", text: content }],
    createdAt: "created_at" in message ? new Date(message.created_at) : message.createdAt,
  };
}
function RecordCard({ record }: { record: MemoryRecord }) {
  return (
    <div className="memory-record">
      <div>{record.memory_key} · revision {record.id}</div>
      <pre>{record.value}</pre>
      <small>{record.origin} · {record.confirmation_status}<br />{record.created_at}</small>
    </div>
  );
}
function MemoryPanel({ selectedKey, onSelect, disabled }: {
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  disabled: boolean;
}) {
  const [key, setKey] = useState("ui_test_word");
  const [value, setValue] = useState("");
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const locked = disabled || working;

  function checkedKey() {
    const candidate = key.trim();
    if (!/^[a-z0-9_-]{1,64}$/.test(candidate)) {
      throw new Error("Use 1–64 lowercase letters, digits, _ or - for the key.");
    }
    return candidate;
  }
  async function inspect(select: boolean) {
    if (locked || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    setRecord(null);
    try {
      const candidate = checkedKey();
      const current = await api<MemoryRecord>(`/memory/${candidate}`);
      setRecord(current);
      setValue(current.value);
      if (select) {
        onSelect(candidate);
        setNotice(`Selected ${candidate}. Each chat request fetches its latest revision.`);
      } else {
        setNotice("Current saved revision loaded. Editing the value does not save it.");
      }
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    setRecord(null);
    try {
      const candidate = checkedKey();
      const content = value.trim();
      if (!content || content.length > 1000) {
        throw new Error("Enter a value of 1–1,000 characters.");
      }
      const saved = await api<Saved>(`/memory/${candidate}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: content }),
      });
      if (!saved.saved) throw new Error("The application did not confirm the save.");
      setNotice(`Application confirmed: ${saved.memory_key} saved as revision ${saved.revision_id}.`);
      try {
        setRecord(await api<MemoryRecord>(`/memory/${candidate}`));
      } catch (problem) {
        setError(`Save confirmed, but read-back failed: ${errorText(problem)}`);
      }
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  return (
    <details className="memory-panel">
      <summary>Memory controls <span>{selectedKey ? `Selected: ${selectedKey}` : "No memory selected"}</span></summary>
      <div className="memory-content">
        <p className="memory-help">Save / correct creates a new revision. Select a key explicitly to supply its current record to chat, including new conversations.</p>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={locked}>
            <label htmlFor="memory-key">Memory key</label>
            <input id="memory-key" value={key} maxLength={64} autoComplete="off"
              onChange={(event) => {
                setKey(event.target.value);
                setRecord(null);
                setNotice("");
                setError("");
              }} />
            <label htmlFor="memory-value">Value to save or correct</label>
            <textarea id="memory-value" value={value} rows={3} maxLength={1000}
              onChange={(event) => setValue(event.target.value)} />
            <div className="memory-actions">
              <button type="button" onClick={() => void inspect(false)}>Inspect current</button>
              <button type="submit">Save / correct</button>
              <button type="button" onClick={() => void inspect(true)}>Use this key in chat</button>
              <button type="button" disabled={!selectedKey} onClick={() => {
                onSelect(null);
                setNotice("Selection cleared. Future chat requests will not fetch a memory record.");
                setError("");
              }}>Clear selection</button>
            </div>
          </fieldset>
        </form>
        {working && <p className="status" role="status">Processing memory request…</p>}
        {notice && <p className="memory-notice" role="status">{notice}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {record && <RecordCard record={record} />}
        <p className="memory-help">User-confirmed means explicitly saved by you, not independently verified. Clearing selection does not delete memory or erase earlier messages.</p>
      </div>
    </details>
  );
}
function Composer({ empty }: { empty: boolean }) {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input className="composer-input"
        placeholder={empty ? "Ask anything..." : "Ask a follow-up..."}
        aria-label="Message" rows={2} maxLength={2000} />
      <div className="composer-toolbar">
        <span className="local-badge">Local · Mistral 7B</span>
        <ComposerPrimitive.Send className="send-button" aria-label="Send message">↑</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
function UserMessage() {
  return <MessagePrimitive.Root className="message user-message">
    <div className="user-bubble"><MessagePrimitive.Parts /></div>
  </MessagePrimitive.Root>;
}
function AssistantMessage() {
  return <MessagePrimitive.Root className="message assistant-message">
    <div className="assistant-avatar" aria-hidden="true">AI</div>
    <div className="assistant-text"><MessagePrimitive.Parts /></div>
  </MessagePrimitive.Root>;
}
function ChatSession({ conversationId, onBusyChange, selectedMemoryKey }: {
  conversationId: string;
  onBusyChange: (busy: boolean) => void;
  selectedMemoryKey: string | null;
}) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [pending, setPending] = useState<PendingExchange | null>(null);
  const [cancelledExchanges, setCancelledExchanges] = useState<PendingExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [streamRegistered, setStreamRegistered] = useState(false);
  const [error, setError] = useState("");
  const [lastMemoryUsed, setLastMemoryUsed] = useState<MemoryRecord[] | null>(null);
  const activeStream = useRef<ActiveStream | null>(null);
  const requestInFlight = useRef(false);

  const reconcileHistory = useCallback(async () => {
    const data = await api<Conversation>(`/conversations/${conversationId}`);
    setMessages(data.messages);
    setLoadFailed(false);
  }, [conversationId]);

  const applyTerminalOutcome = useCallback(async (session: ActiveStream, outcome: StreamOutcome) => {
    if (outcome.request_id !== session.requestId || !isTerminalOutcome(outcome) || session.terminalHandled) return;
    session.terminalHandled = true;
    setRunning(false);
    setStreamRegistered(false);
    if (outcome.status === "cancelled") {
      try {
        await reconcileHistory();
        setCancelledExchanges((current) => [...current, {
          ...session.exchange,
          assistant: { ...session.exchange.assistant, displayLabel: "Cancelled - unsaved partial output" },
          status: "cancelled",
        }]);
        setPending((current) => current?.user.id === session.exchange.user.id ? null : current);
        setError("Cancelled and not saved. Ollama may continue computing after its connection is closed.");
      } catch (problem) {
        setPending({
          ...session.exchange,
          assistant: { ...session.exchange.assistant, displayLabel: "Cancelled - unsaved partial output" },
          status: "cancelled",
        });
        setError(`Cancellation was acknowledged, but saved history could not be reconciled: ${errorText(problem)}`);
      }
    } else if (outcome.status === "completed" && outcome.saved === true) {
      setPending({ ...session.exchange, status: "confirmed" });
      setLastMemoryUsed(outcome.memory_used ?? []);
      try {
        await reconcileHistory();
        setPending((current) => current?.user.id === session.exchange.user.id ? null : current);
        setError("");
      } catch (problem) {
        setError(`The exchange was confirmed saved, but saved history could not be refreshed: ${errorText(problem)}`);
      }
    } else {
      const descriptions: Record<string, string> = {
        inference_error: "Model inference failed.",
        transport_error: "Connection to Ollama failed.",
        save_error: "The response could not be saved; the exchange was not committed.",
        request_error: outcome.detail ?? "The chat request was rejected.",
        disconnected: "The browser connection ended without application cancellation.",
      };
      setPending({ ...session.exchange, status: "failed" });
      setError(`${descriptions[outcome.status] ?? "The request failed."} ${outcome.detail ?? ""}`.trim());
      try {
        await reconcileHistory();
      } catch (problem) {
        setError(`${errorText(problem)} Saved history could not be reconciled.`);
      }
    }
    if (activeStream.current === session) activeStream.current = null;
    requestInFlight.current = false;
    onBusyChange(false);
  }, [onBusyChange, reconcileHistory]);

  const refreshHistory = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setRefreshing(true);
    onBusyChange(true);
    try {
      await reconcileHistory();
      if (pending?.status === "cancelled") {
        setCancelledExchanges((current) => [...current, {
          ...pending,
          assistant: { ...pending.assistant, displayLabel: "Cancelled - unsaved partial output" },
          status: "cancelled",
        }]);
        setPending(null);
      } else if (pending?.status === "confirmed" || pending?.status === "failed") {
        setPending(null);
      }
      setError("");
    } catch (problem) {
      setError(`Could not refresh saved history: ${errorText(problem)}`);
    } finally {
      requestInFlight.current = false;
      setRefreshing(false);
      onBusyChange(false);
    }
  }, [onBusyChange, pending, reconcileHistory]);

  const checkRequestStatus = useCallback(async () => {
    const session = activeStream.current;
    if (!session) return;
    setError("");
    try {
      const outcome = await requestStreamStatus(session.requestId);
      if (session.terminalHandled) return;
      if (isTerminalOutcome(outcome)) {
        await applyTerminalOutcome(session, outcome);
        session.controller.abort();
      } else if (outcome.status === "unknown") {
        setPending({ ...session.exchange, status: "unknown" });
        setError("The backend no longer has this request's outcome. Do not retry until its result can be established.");
        onBusyChange(true);
      } else {
        setStreamRegistered(outcome.status === "active" || outcome.status === "cancelling");
        setPending({ ...session.exchange, status: "unknown" });
        setError("The request is still active or stopping. Check its status again before retrying.");
        onBusyChange(true);
      }
    } catch (problem) {
      if (session.terminalHandled) return;
      setPending({ ...session.exchange, status: "unknown" });
      setError(`Request outcome is unknown; status lookup failed: ${errorText(problem)}`);
      onBusyChange(true);
    }
  }, [applyTerminalOutcome, onBusyChange]);

  const stopRequest = useCallback(async () => {
    const session = activeStream.current;
    if (!session || session.terminalHandled) return;
    setPending({ ...session.exchange, status: "stopping" });
    setError("");
    try {
      const outcome = await requestCancellation(session.requestId);
      if (session.terminalHandled) return;
      if (isTerminalOutcome(outcome)) {
        await applyTerminalOutcome(session, outcome);
        session.controller.abort();
      } else {
        setPending({ ...session.exchange, status: "unknown" });
        setError("Cancellation is not yet acknowledged. The request outcome is unknown; check status before retrying.");
      }
    } catch (problem) {
      if (session.terminalHandled) return;
      setPending({ ...session.exchange, status: "unknown" });
      setError(`Cancellation acknowledgment was not received. The request outcome is unknown: ${errorText(problem)}`);
    }
  }, [applyTerminalOutcome]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await api<Conversation>(`/conversations/${conversationId}`);
        if (active) setMessages(data.messages);
      } catch (problem) {
        if (active) {
          setLoadFailed(true);
          setError(errorText(problem));
        }
      } finally {
        if (active) { setLoading(false); onBusyChange(false); }
      }
    }
    void load();
    return () => { active = false; };
  }, [conversationId, onBusyChange]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
    if (!text || loading || loadFailed || pending || requestInFlight.current) return;
    if (text.length > 2000) { setError("Messages must be 2,000 characters or fewer."); return; }
    requestInFlight.current = true;
    const requestId = crypto.randomUUID();
    const exchange: PendingExchange = {
      user: { id: `pending-user-${requestId}`, role: "user", content: text, createdAt: new Date() },
      assistant: { id: `pending-assistant-${requestId}`, role: "assistant", content: "", createdAt: new Date() },
      status: "streaming",
    };
    const session: ActiveStream = {
      requestId,
      controller: new AbortController(),
      exchange,
      terminalHandled: false,
      registered: false,
    };
    activeStream.current = session;
    setPending(exchange);
    setError("");
    setLastMemoryUsed(null);
    setStreamRegistered(false);
    setRunning(true);
    onBusyChange(true);
    try {
      const outcome = await streamChat(conversationId, requestId, text, selectedMemoryKey, session.controller, () => {
        session.registered = true;
        setStreamRegistered(true);
      }, (chunk) => {
        session.exchange = {
          ...session.exchange,
          assistant: { ...session.exchange.assistant, content: session.exchange.assistant.content + chunk },
        };
        setPending((current) => current?.user.id === session.exchange.user.id
          ? { ...current, assistant: session.exchange.assistant }
          : current);
      });
      await applyTerminalOutcome(session, outcome);
    } catch (problem) {
      if (!session.terminalHandled) {
        setStreamRegistered(false);
        setPending({ ...session.exchange, status: "unknown" });
        setError(`Request outcome is unknown: ${errorText(problem)} Check backend status before retrying.`);
        onBusyChange(true);
      }
    }
  }, [applyTerminalOutcome, conversationId, loading, loadFailed, onBusyChange, pending, selectedMemoryKey]);

  const displayMessages: (StoredMessage | PendingMessage)[] = [
    ...messages,
    ...cancelledExchanges.flatMap((exchange) => [exchange.user, exchange.assistant]),
    ...(pending ? [pending.user, pending.assistant] : []),
  ].sort((left, right) => {
    const leftTime = "created_at" in left ? Date.parse(left.created_at) : left.createdAt.getTime();
    const rightTime = "created_at" in right ? Date.parse(right.created_at) : right.createdAt.getTime();
    return leftTime - rightTime;
  });
  const runtime = useExternalStoreRuntime({
    messages: displayMessages,
    convertMessage,
    isRunning: running,
    isDisabled: loading || loadFailed,
    isSendDisabled: pending !== null,
    onNew,
  });
  const empty = displayMessages.length === 0;
  const needsHistoryRefresh = pending?.status === "failed" || pending?.status === "confirmed" ||
    pending?.status === "cancelled" || loadFailed;
  const needsStatusCheck = pending?.status === "unknown";
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        {loading ? <div className="loading">Loading conversation...</div> : (
          <ThreadPrimitive.Viewport className={`viewport ${empty ? "empty-viewport" : ""}`}>
            {empty && <div className="welcome"><h1>Where shall we begin?</h1><p>Your local space for thinking and continuity.</p></div>}
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <ThreadPrimitive.ViewportFooter className="composer-footer">
              {running && <p className="status" role="status">Generating locally. Pending messages are not saved yet.</p>}
              {pending?.status === "stopping" && <p className="status" role="status">Stopping…</p>}
              {error && <p className="error" role="alert">{error}</p>}
              {pending?.status === "cancelled" && <p className="pending-notice" role="status">
                Cancelled and unsaved. Partial output is provisional and is not included in canonical history or future model context.
              </p>}
              {pending?.status === "failed" && <p className="pending-notice" role="status">
                The request failed. Any generated text above is provisional, not canonical history. Refresh saved history before retrying.
              </p>}
              {pending?.status === "confirmed" && <p className="pending-notice" role="status">
                The application confirmed the exchange was saved. Refresh saved history to reconcile the conversation before continuing.
              </p>}
              {needsHistoryRefresh && <button className="refresh-history" type="button" onClick={() => void refreshHistory()} disabled={refreshing}>
                {refreshing ? "Refreshing saved history..." : "Refresh saved history before retrying"}
              </button>}
              {needsStatusCheck && <button className="refresh-history" type="button" onClick={() => void checkRequestStatus()}>
                Check request status
              </button>}
              {running && streamRegistered && <button className="stop-button" type="button" onClick={() => void stopRequest()}>
                Stop
              </button>}
              <div className="memory-chat-status">
                <span>For next request: {selectedMemoryKey || "no selected memory"}</span>
                {lastMemoryUsed !== null && <details className="memory-used">
                  <summary>Memory supplied to latest successful request ({lastMemoryUsed.length})</summary>
                  {lastMemoryUsed.length === 0 ? <p>No explicit memory record was supplied.</p> : lastMemoryUsed.map((record) => <RecordCard key={record.id} record={record} />)}
                  <p>Context provenance, not proof the model relied on it. This panel resets on refresh or conversation change.</p>
                </details>}
              </div>
              <Composer empty={empty} />
              <p className="footnote">Completed exchanges are saved locally. Model context: latest three saved exchanges. No live web access.</p>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        )}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export default function App() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selectedMemoryKey, setSelectedMemoryKey] = useState<string | null>(null);
  const creating = useRef(false);
  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        let id = localStorage.getItem(CONVERSATION_KEY);
        if (!id) {
          const created = await api<Created>("/conversations", { method: "POST" });
          id = created.conversation_id;
          localStorage.setItem(CONVERSATION_KEY, id);
        }
        if (active) setConversationId(id);
      } catch (problem) {
        if (active) { setError(errorText(problem)); setBusy(false); }
      }
    }
    void initialize();
    return () => { active = false; };
  }, []);
  async function newConversation() {
    if (busy || creating.current) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const created = await api<Created>("/conversations", { method: "POST" });
      localStorage.setItem(CONVERSATION_KEY, created.conversation_id);
      setConversationId(created.conversation_id);
    } catch (problem) { setError(errorText(problem)); setBusy(false); }
    finally { creating.current = false; }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">L</span>Local-first AI</div>
        <button className="new-conversation" onClick={() => void newConversation()} disabled={busy}>
          <span aria-hidden="true">＋</span> New conversation
        </button>
        <div className="sidebar-note">
          <span className="connection-dot" /> Desktop-only prototype
          <p>Conversations and memory stay in the existing local application.</p>
          <p>Select memory explicitly. Conversation browsing and deletion are not included yet.</p>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar"><span>Personal workspace</span><span className="topbar-badge">Local inference</span></header>
        <MemoryPanel selectedKey={selectedMemoryKey} onSelect={setSelectedMemoryKey} disabled={busy} />
        {error && <p className="app-error" role="alert">{error}</p>}
        {conversationId ? <ChatSession key={conversationId} conversationId={conversationId}
          onBusyChange={setBusy} selectedMemoryKey={selectedMemoryKey} /> :
          !error ? <div className="loading">Opening workspace…</div> : null}
      </main>
    </div>
  );
}
