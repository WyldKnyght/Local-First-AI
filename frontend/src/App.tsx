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
type ChatResult = {
  conversation_id: string;
  model: string;
  reply: string;
  memory_used: MemoryRecord[];
};
const CONVERSATION_KEY = "local-first-ai.conversation-id";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null &&
          "detail" in body && typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch { /* Proxy failures may return non-JSON content. */ }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function convertMessage(message: StoredMessage): ThreadMessageLike {
  return {
    id: String(message.id), role: message.role,
    content: [{ type: "text", text: message.content }],
    createdAt: new Date(message.created_at),
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
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [lastMemoryUsed, setLastMemoryUsed] = useState<MemoryRecord[] | null>(null);
  const requestInFlight = useRef(false);
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
    if (!text || loading || loadFailed || requestInFlight.current) return;
    if (text.length > 2000) { setError("Messages must be 2,000 characters or fewer."); return; }
    requestInFlight.current = true;
    setError("");
    setLastMemoryUsed(null);
    setRunning(true);
    onBusyChange(true);
    try {
      const result = await api<ChatResult>("/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message: text,
          memory_key: selectedMemoryKey,
        }),
      });
      setLastMemoryUsed(result.memory_used);
      const data = await api<Conversation>(`/conversations/${conversationId}`);
      setMessages(data.messages);
    } catch (problem) {
      setError(`${errorText(problem)} If the response was interrupted, refresh to check saved history before resending.`);
    } finally {
      requestInFlight.current = false;
      setRunning(false);
      onBusyChange(false);
    }
  }, [conversationId, loading, loadFailed, onBusyChange, selectedMemoryKey]);
  const runtime = useExternalStoreRuntime({
    messages, convertMessage, isRunning: running,
    isDisabled: loading || loadFailed, onNew,
  });
  const empty = messages.length === 0;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        {loading ? <div className="loading">Loading conversation…</div> : (
          <ThreadPrimitive.Viewport className={`viewport ${empty ? "empty-viewport" : ""}`}>
            {empty && <div className="welcome"><h1>Where shall we begin?</h1><p>Your local space for thinking and continuity.</p></div>}
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <ThreadPrimitive.ViewportFooter className="composer-footer">
              {running && <p className="status" role="status">Generating locally…</p>}
              {error && <p className="error" role="alert">{error}</p>}
              <div className="memory-chat-status">
                <span>For next request: {selectedMemoryKey || "no selected memory"}</span>
                {lastMemoryUsed !== null && <details className="memory-used">
                  <summary>Memory supplied to latest successful request ({lastMemoryUsed.length})</summary>
                  {lastMemoryUsed.length === 0 ? <p>No explicit memory record was supplied.</p> : lastMemoryUsed.map((record) => <RecordCard key={record.id} record={record} />)}
                  <p>Context provenance, not proof the model relied on it. This panel resets on refresh or conversation change.</p>
                </details>}
              </div>
              <Composer empty={empty} />
              <p className="footnote">Completed exchanges are saved locally. Model context: latest three exchanges. No live web access.</p>
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
