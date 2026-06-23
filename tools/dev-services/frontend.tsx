import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

type State = "running" | "stopped" | "starting" | "building" | "error";
type StatusMap = Record<string, { state: State; pid?: number }>;

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
const PORTS: Record<string, string> = {
  "postgres-redis": "5432, 6379",
  "kafka-nacos": "9092, 8848",
  iaccount: "8887",
  iuser: "8085",
  iwallet: "8180",
  imerchant: "8188",
  iriskops: "8181",
};

const ALL_NAMES = [...INFRA, ...SERVICES];

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
  onStart,
  onStop,
}: {
  name: string;
  state: State;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = state === "running";
  const busy = state === "starting" || state === "building";
  return (
    <div
      style={{
        background: "#1e2130",
        border: "1px solid #2d3148",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <StatusDot state={state} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
          :{PORTS[name]} &nbsp;·&nbsp;
          <span style={{ color: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>
        </div>
      </div>
      <button
        onClick={running ? onStop : onStart}
        disabled={busy}
        style={{
          padding: "5px 14px",
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
  );
}

function LogPanel({
  logs,
  selected,
  onSelect,
}: {
  logs: Record<string, string[]>;
  selected: string;
  onSelect: (s: string) => void;
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
          onClick={() => {}}
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
        {lines.join("\n") || <span style={{ color: "#334155" }}>No output yet.</span>}
        <div ref={bottomRef} />
      </pre>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<StatusMap>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [selectedLog, setSelectedLog] = useState("iaccount");

  const api = useCallback(async (path: string, method = "GET") => {
    await fetch(path, { method }).catch(() => {});
  }, []);

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

  // WebSocket for live state + logs
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") {
        setStatus((prev) => ({ ...prev, [msg.service]: { state: msg.state, pid: msg.pid } }));
      } else {
        setLogs((prev) => {
          const existing = prev[msg.service] ?? [];
          return { ...prev, [msg.service]: [...existing.slice(-499), msg.line] };
        });
      }
    };
    return () => ws.close();
  }, []);

  const stateOf = (name: string): State => status[name]?.state ?? "stopped";

  return (
    <>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "28px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>Dev Services</h1>
            <p style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>localhost process manager</p>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <button
              onClick={() => api("/api/start-all", "POST")}
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

        {/* Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
          {/* Infrastructure */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", marginBottom: 10 }}>
              INFRASTRUCTURE
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {INFRA.map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  state={stateOf(name)}
                  onStart={() => api(`/api/${name}/start`, "POST")}
                  onStop={() => api(`/api/${name}/stop`, "POST")}
                />
              ))}
            </div>
          </div>

          {/* Services */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", marginBottom: 10 }}>
              SERVICES
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SERVICES.map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  state={stateOf(name)}
                  onStart={() => api(`/api/${name}/start`, "POST")}
                  onStop={() => api(`/api/${name}/stop`, "POST")}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Log Panel */}
        <LogPanel logs={logs} selected={selectedLog} onSelect={setSelectedLog} />
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
