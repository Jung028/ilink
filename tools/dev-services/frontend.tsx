import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

type State = "running" | "stopped" | "starting" | "building" | "error";
type StatusMap = Record<string, { state: State; pid?: number; lastError?: string }>;

const STATE_COLOR: Record<State, string> = {
  running: "#22c55e",
  stopped: "#ef4444",
  starting: "#eab308",
  building: "#f97316",
  error: "#f97316",
};

const STATE_LABEL: Record<State, string> = {
  running: "running",
  stopped: "stopped",
  starting: "starting…",
  building: "building…",
  error: "error",
};

const INFRA = ["postgres-redis", "kafka-nacos"];
const SERVICES = ["iaccount", "iuser", "iwallet", "imerchant", "iriskops"];
const FRONTENDS = ["ipay", "imerchantmng"];
const ALL_NAMES = [...INFRA, ...SERVICES, ...FRONTENDS];

const PORTS: Record<string, string> = {
  "postgres-redis": "5432, 6379",
  "kafka-nacos": "9092, 8848",
  iaccount: "8887",
  iuser: "8085",
  iwallet: "8180",
  imerchant: "8188",
  iriskops: "8181",
  ipay: "8089",
  imerchantmng: "8021",
};

const FRONTEND_PORT: Record<string, number> = {
  ipay: 8089,
  imerchantmng: 8021,
};

const FRONTEND_PATH: Record<string, string> = {
  ipay: "/login",
  imerchantmng: "",
};

const DEFAULT_SELECTION = Object.fromEntries(ALL_NAMES.map((n) => [n, true]));

function loadSelection(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem("dev-services-selection");
    return raw ? { ...DEFAULT_SELECTION, ...JSON.parse(raw) } : DEFAULT_SELECTION;
  } catch {
    return DEFAULT_SELECTION;
  }
}

function StatusDot({ state }: { state: State }) {
  const color = STATE_COLOR[state];
  const pulse = state === "starting" || state === "building";
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: pulse ? `0 0 0 3px ${color}33` : undefined,
        animation: pulse ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function ServiceCard({
  name,
  state,
  lastError,
  selected,
  onToggle,
  onStart,
  onStop,
  onRebuild,
  openUrl,
}: {
  name: string;
  state: State;
  lastError?: string;
  selected: boolean;
  onToggle: () => void;
  onStart: () => void;
  onStop: () => void;
  onRebuild?: () => void;
  openUrl?: string;
}) {
  const running = state === "running";
  const busy = state === "starting" || state === "building";
  const errored = state === "error";
  return (
    <div
      style={{
        background: errored ? "#1a0f0f" : "#1e2130",
        border: `1px solid ${errored ? "#5c1a1a" : selected ? "#2d3148" : "#1a1c2e"}`,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: selected ? 1 : 0.6,
        transition: "opacity 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          title="Include in Start All"
          style={{ accentColor: "#6366f1", cursor: "pointer", flexShrink: 0 }}
        />
        <StatusDot state={state} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{name}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>
            :{PORTS[name]} &nbsp;·&nbsp;
            <span style={{ color: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {openUrl && running && (
            <button
              onClick={() => window.open(openUrl, "_blank")}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #2d3148",
                cursor: "pointer",
                background: "transparent",
                color: "#94a3b8",
                fontSize: 11,
              }}
            >
              Open ↗
            </button>
          )}
          {onRebuild && (errored || (!running && !busy)) && (
            <button
              onClick={onRebuild}
              disabled={busy}
              title="Delete JAR and rebuild from source"
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #2d3148",
                cursor: busy ? "not-allowed" : "pointer",
                background: "transparent",
                color: "#f97316",
                fontSize: 11,
                opacity: busy ? 0.5 : 1,
              }}
            >
              Rebuild ↺
            </button>
          )}
          <button
            onClick={running ? onStop : onStart}
            disabled={busy}
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              background: running ? "#3f1515" : "#143326",
              color: running ? "#f87171" : "#4ade80",
              fontWeight: 600,
              fontSize: 12,
              opacity: busy ? 0.5 : 1,
              transition: "opacity 0.15s",
            }}
          >
            {running ? "Stop" : "Start"}
          </button>
        </div>
      </div>
      {errored && lastError && (
        <div
          style={{
            fontSize: 11,
            color: "#f87171",
            background: "#2a0f0f",
            borderRadius: 5,
            padding: "5px 8px",
            fontFamily: "monospace",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={lastError}
        >
          {lastError}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", marginBottom: 10 }}>
      {label}
    </div>
  );
}

function LogPanel({
  logs,
  selected,
  onSelect,
  onClear,
}: {
  logs: Record<string, string[]>;
  selected: string;
  onSelect: (s: string) => void;
  onClear: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lines = logs[selected] ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  return (
    <div
      style={{
        background: "#0a0c14",
        border: "1px solid #2d3148",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        height: 260,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderBottom: "1px solid #1e2130",
        }}
      >
        <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>LOGS</span>
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          style={{
            background: "#1e2130",
            color: "#e2e8f0",
            border: "1px solid #2d3148",
            borderRadius: 5,
            padding: "3px 8px",
            fontSize: 12,
          }}
        >
          {ALL_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          onClick={onClear}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "1px solid #2d3148",
            color: "#64748b",
            borderRadius: 5,
            padding: "3px 10px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>
      <pre
        style={{
          flex: 1,
          overflow: "auto",
          padding: "10px 14px",
          fontSize: 12,
          lineHeight: 1.6,
          color: "#94a3b8",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {lines.length > 0 ? lines.join("\n") : <span style={{ color: "#334155" }}>No output yet.</span>}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}

interface ChatMessage { role: "user" | "assistant"; text: string; }

function parseBlocks(text: string): Array<{ type: "text" | "code"; content: string }> {
  const parts: Array<{ type: "text" | "code"; content: string }> = [];
  const re = /```(?:sh|bash|shell)?\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", content: text.slice(last, m.index) });
    parts.push({ type: "code", content: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: "text", content: text.slice(last) });
  return parts;
}

function ChatPanel({ focusedService }: { focusedService: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send() {
    const msg = input.trim();
    if (!msg || streaming) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: msg }]);
    setStreaming(true);
    setMessages(prev => [...prev, { role: "assistant", text: "" }]);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, service: focusedService }),
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") break;
        try {
          const { text } = JSON.parse(raw);
          setMessages(prev => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", text: copy[copy.length - 1].text + text };
            return copy;
          });
        } catch {}
      }
    }
    setStreaming(false);
  }

  async function runCommand(cmd: string) {
    setRunOutput("running…");
    const res = await fetch("/api/run-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    });
    const { output } = await res.json();
    setRunOutput(output || "(no output)");
  }

  return (
    <div style={{ background: "#0a0c14", border: "1px solid #2d3148", borderRadius: 10, display: "flex", flexDirection: "column", height: 320, marginTop: 20 }}>
      <div style={{ padding: "8px 14px", borderBottom: "1px solid #1e2130", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#6366f1" }}>CLAUDE</span>
        <span style={{ fontSize: 11, color: "#475569" }}>context: {focusedService}</span>
        {messages.length > 0 && (
          <button onClick={() => { setMessages([]); setRunOutput(null); }} style={{ marginLeft: "auto", background: "none", border: "1px solid #2d3148", color: "#475569", borderRadius: 5, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>Clear</button>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && (
          <p style={{ color: "#334155", fontSize: 12, margin: "auto 0" }}>Ask about any service — errors, logs, fixes. Context from "{focusedService}" is included automatically.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
            {m.role === "user" ? (
              <div style={{ background: "#1e2130", borderRadius: 8, padding: "6px 12px", fontSize: 13, maxWidth: "80%", color: "#e2e8f0" }}>{m.text}</div>
            ) : (
              <div style={{ fontSize: 13, maxWidth: "90%", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: 6 }}>
                {parseBlocks(m.text).map((b, j) =>
                  b.type === "text" ? (
                    <span key={j} style={{ whiteSpace: "pre-wrap" }}>{b.content}</span>
                  ) : (
                    <div key={j} style={{ background: "#1a1c2e", borderRadius: 6, padding: "8px 12px", fontFamily: "monospace", fontSize: 12 }}>
                      <div style={{ color: "#94a3b8", marginBottom: 4 }}>{b.content}</div>
                      <button onClick={() => runCommand(b.content)} style={{ background: "#143326", color: "#4ade80", border: "none", borderRadius: 5, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>▶ Run</button>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
        {runOutput && (
          <pre style={{ background: "#1a1c2e", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#94a3b8", whiteSpace: "pre-wrap", marginTop: 4 }}>{runOutput}</pre>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: "8px 12px", borderTop: "1px solid #1e2130", display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask anything… (Enter to send)"
          style={{ flex: 1, background: "#1e2130", border: "1px solid #2d3148", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 13, outline: "none" }}
        />
        <button onClick={send} disabled={streaming} style={{ background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontWeight: 600, fontSize: 13, cursor: streaming ? "not-allowed" : "pointer", opacity: streaming ? 0.6 : 1 }}>
          {streaming ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<StatusMap>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [selectedLog, setSelectedLog] = useState("iaccount");
  const [selection, setSelection] = useState<Record<string, boolean>>(loadSelection);

  const api = useCallback(async (path: string, method = "GET", body?: unknown) => {
    await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
  }, []);

  const toggleSelection = useCallback((name: string) => {
    setSelection((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      localStorage.setItem("dev-services-selection", JSON.stringify(next));
      return next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs((prev) => ({ ...prev, [selectedLog]: [] }));
  }, [selectedLog]);

  // Poll status every 5s
  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok) setStatus(await res.json());
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  // WebSocket for live state + logs, with auto-reconnect
  useEffect(() => {
    let ws: WebSocket;
    let dead = false;

    function connect() {
      ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "state") {
          setStatus((prev) => {
            const prevState = prev[msg.service]?.state;
            // auto-switch log panel when a service transitions to error
            if (msg.state === "error" && prevState !== "error") {
              setSelectedLog(msg.service);
            }
            return { ...prev, [msg.service]: { state: msg.state, pid: msg.pid, lastError: msg.lastError } };
          });
        } else {
          setLogs((prev) => {
            const existing = prev[msg.service] ?? [];
            return { ...prev, [msg.service]: [...existing.slice(-499), msg.line] };
          });
        }
      };
      ws.onclose = () => {
        if (!dead) setTimeout(connect, 2000);
      };
    }

    connect();
    return () => { dead = true; ws?.close(); };
  }, []);

  const stateOf = (name: string): State => status[name]?.state ?? "stopped";
  const errorOf = (name: string) => status[name]?.lastError;

  const selectedList = ALL_NAMES.filter((n) => selection[n]);

  return (
    <>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        * { box-sizing: border-box; }
      `}</style>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>Dev Services</h1>
            <p style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
              localhost process manager &nbsp;·&nbsp; {selectedList.length}/{ALL_NAMES.length} selected
            </p>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button
              onClick={() => api("/api/start-all", "POST", { selected: selectedList })}
              style={{
                background: "#143326",
                color: "#4ade80",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Start All
            </button>
            <button
              onClick={() => api("/api/stop-all", "POST")}
              style={{
                background: "#3f1515",
                color: "#f87171",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Stop All
            </button>
          </div>
        </div>

        {/* 3-column grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 20 }}>
          {/* Infrastructure */}
          <div>
            <SectionHeader label="INFRASTRUCTURE" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {INFRA.map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  state={stateOf(name)}
                  lastError={errorOf(name)}
                  selected={selection[name] ?? true}
                  onToggle={() => toggleSelection(name)}
                  onStart={() => api(`/api/${name}/start`, "POST")}
                  onStop={() => api(`/api/${name}/stop`, "POST")}
                />
              ))}
            </div>
          </div>

          {/* Java Services */}
          <div>
            <SectionHeader label="SERVICES" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SERVICES.map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  state={stateOf(name)}
                  lastError={errorOf(name)}
                  selected={selection[name] ?? true}
                  onToggle={() => toggleSelection(name)}
                  onStart={() => api(`/api/${name}/start`, "POST")}
                  onStop={() => api(`/api/${name}/stop`, "POST")}
                  onRebuild={() => api(`/api/${name}/rebuild`, "POST")}
                />
              ))}
            </div>
          </div>

          {/* Frontend Services */}
          <div>
            <SectionHeader label="FRONTENDS" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {FRONTENDS.map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  state={stateOf(name)}
                  lastError={errorOf(name)}
                  selected={selection[name] ?? true}
                  onToggle={() => toggleSelection(name)}
                  onStart={() => api(`/api/${name}/start`, "POST")}
                  onStop={() => api(`/api/${name}/stop`, "POST")}
                  openUrl={`http://localhost:${FRONTEND_PORT[name]}${FRONTEND_PATH[name] ?? ""}`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Log Panel */}
        <LogPanel
          logs={logs}
          selected={selectedLog}
          onSelect={setSelectedLog}
          onClear={clearLogs}
        />

        {/* Claude Chat Panel */}
        <ChatPanel focusedService={selectedLog} />
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
