import index from "./index.html";
import { infraGroups, services, frontendServices, type InfraGroup, type JavaService, type FrontendService } from "./config";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

type State = "running" | "stopped" | "starting" | "building" | "error";

interface ServiceState {
  state: State;
  pid?: number;
  lastError?: string;
}

const processMap = new Map<string, ReturnType<typeof Bun.spawn>>();
const stateMap = new Map<string, ServiceState>();
const logBuffer = new Map<string, string[]>();
const wsClients = new Set<import("bun").ServerWebSocket<unknown>>();

for (const g of infraGroups) stateMap.set(g.name, { state: "stopped" });
for (const s of services) stateMap.set(s.name, { state: "stopped" });
for (const s of frontendServices) stateMap.set(s.name, { state: "stopped" });

function pushLog(service: string, line: string) {
  if (!logBuffer.has(service)) logBuffer.set(service, []);
  const buf = logBuffer.get(service)!;
  buf.push(line);
  if (buf.length > 500) buf.shift();
  const msg = JSON.stringify({ service, line });
  for (const ws of wsClients) ws.send(msg);
}

function setState(name: string, state: State, pid?: number, lastError?: string) {
  const prev = stateMap.get(name);
  stateMap.set(name, { state, pid, lastError: lastError ?? (state === "error" ? prev?.lastError : undefined) });
  const msg = JSON.stringify({ type: "state", service: name, state, pid, lastError });
  for (const ws of wsClients) ws.send(msg);
}

async function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  service: string,
  onError?: (lastLine: string) => void,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = "";
  let lastNonEmpty = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = partial + decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      pushLog(service, line);
      if (line.trim()) lastNonEmpty = line.trim();
    }
  }
  if (partial) {
    pushLog(service, partial);
    if (partial.trim()) lastNonEmpty = partial.trim();
  }
  onError?.(lastNonEmpty);
}

async function tcpHealthCheck(port: number, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await Bun.connect({
        hostname: "localhost",
        port,
        socket: { open: (s) => s.end(), data: () => {}, close: () => {}, error: () => {} },
      });
      return true;
    } catch {
      await Bun.sleep(2000);
    }
  }
  return false;
}

function isPortConflict(msg: string): boolean {
  const l = msg.toLowerCase();
  return (
    l.includes("address already in use") ||
    l.includes("eaddrinuse") ||
    l.includes("bind: address") ||
    l.includes("is already in use")
  );
}

function isSofaConflict(logs: string[]): boolean {
  return logs.some((l) => l.includes("SOFA-BOOT-01-03004") || l.includes("Failed to resolve and active component"));
}

async function freePort(port: number, service: string): Promise<boolean> {
  const lsof = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(lsof.stdout).text();
  await lsof.exited;
  const pids = text.trim().split("\n").filter(Boolean);
  if (!pids.length) return false;
  pushLog(service, `[auto-fix] Port :${port} held by PID ${pids.join(", ")} — killing`);
  for (const pid of pids) Bun.spawn(["kill", "-9", pid.trim()]);
  return true;
}

async function freePorts(ports: number[], service: string): Promise<void> {
  for (const port of ports) await freePort(port, service);
  await Bun.sleep(1500);
}

async function findJar(serviceDir: string): Promise<string | null> {
  const glob = new Bun.Glob("app/web/target/*.jar");
  for await (const file of glob.scan({ cwd: serviceDir })) {
    if (!file.includes("-sources") && !file.includes("-javadoc")) {
      return join(serviceDir, file);
    }
  }
  return null;
}

async function buildService(svc: JavaService): Promise<boolean> {
  setState(svc.name, "building");
  pushLog(svc.name, `[build] mvn clean install -DskipTests in ${svc.dir}`);
  const proc = Bun.spawn(["mvn", "clean", "install", "-DskipTests"], {
    cwd: svc.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  let buildError = "";
  pipeStream(proc.stdout, svc.name, (last) => { if (last) buildError = buildError || last; });
  pipeStream(proc.stderr, svc.name, (last) => { if (last) buildError = last; });
  const code = await proc.exited;
  if (code !== 0) {
    const msg = `Build failed (exit ${code})${buildError ? ": " + buildError : ""}`;
    pushLog(svc.name, `[build] FAILED (exit ${code})`);
    setState(svc.name, "error", undefined, msg);
    return false;
  }
  pushLog(svc.name, "[build] SUCCESS");
  return true;
}

async function deleteJars(serviceDir: string) {
  const glob = new Bun.Glob("app/web/target/*.jar");
  for await (const file of glob.scan({ cwd: serviceDir })) {
    await Bun.file(join(serviceDir, file)).delete?.();
    Bun.spawn(["rm", "-f", join(serviceDir, file)]);
  }
}

async function startService(svc: JavaService, retried = false) {
  if (stateMap.get(svc.name)?.state === "running") return;
  setState(svc.name, "starting");

  let jar = await findJar(svc.dir);
  if (!jar) {
    const ok = await buildService(svc);
    if (!ok) return;
    jar = await findJar(svc.dir);
    if (!jar) {
      setState(svc.name, "error", undefined, "JAR not found after build");
      pushLog(svc.name, "[error] JAR not found after build");
      return;
    }
  }

  pushLog(svc.name, `[start] java -jar ${jar}`);
  const proc = Bun.spawn(["java", "-jar", jar], {
    cwd: svc.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  processMap.set(svc.name, proc);
  setState(svc.name, "running", proc.pid);
  let runtimeError = "";
  pipeStream(proc.stdout, svc.name, (last) => { if (last) runtimeError = runtimeError || last; });
  pipeStream(proc.stderr, svc.name, (last) => { if (last) runtimeError = last; });
  proc.exited.then(async (code) => {
    pushLog(svc.name, `[exit] exited with code ${code}`);
    processMap.delete(svc.name);
    if (code === 0) {
      setState(svc.name, "stopped");
    } else if (!retried) {
      const recentLogs = logBuffer.get(svc.name) ?? [];
      const portsToFree = [svc.port, ...(svc.boltPort ? [svc.boltPort] : [])];
      if (isPortConflict(runtimeError)) {
        pushLog(svc.name, `[auto-fix] Port conflict on :${svc.port} — freeing and restarting`);
        await freePorts([svc.port], svc.name);
        startService(svc, true);
      } else if (isSofaConflict(recentLogs)) {
        pushLog(svc.name, `[auto-fix] SOFA-BOOT-01-03004 detected — freeing ports :${portsToFree.join(", ")} and restarting`);
        await freePorts(portsToFree, svc.name);
        startService(svc, true);
      } else {
        const msg = `Exited ${code}${runtimeError ? ": " + runtimeError : ""}`;
        setState(svc.name, "error", undefined, msg);
      }
    } else {
      const msg = `Exited ${code}${runtimeError ? ": " + runtimeError : ""}`;
      setState(svc.name, "error", undefined, msg);
    }
  });
}

async function rebuildService(svc: JavaService) {
  stopService(svc.name);
  pushLog(svc.name, "[rebuild] Deleting old JARs…");
  await deleteJars(svc.dir);
  await startService(svc);
}

function stopService(name: string) {
  processMap.get(name)?.kill();
  processMap.delete(name);
  setState(name, "stopped");
}

async function startFrontendService(svc: FrontendService, retried = false) {
  if (stateMap.get(svc.name)?.state === "running") return;
  setState(svc.name, "starting");
  pushLog(svc.name, `[start] ${svc.startCmd.join(" ")} in ${svc.dir}`);
  const proc = Bun.spawn(svc.startCmd, {
    cwd: svc.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  processMap.set(svc.name, proc);
  setState(svc.name, "running", proc.pid);
  let feError = "";
  pipeStream(proc.stdout, svc.name, (last) => { if (last) feError = feError || last; });
  pipeStream(proc.stderr, svc.name, (last) => { if (last) feError = last; });
  proc.exited.then(async (code) => {
    pushLog(svc.name, `[exit] exited with code ${code}`);
    processMap.delete(svc.name);
    if (code === 0) {
      setState(svc.name, "stopped");
    } else if (!retried) {
      const recentLogs = logBuffer.get(svc.name) ?? [];
      const portInLogs = recentLogs.some((l) => isPortConflict(l));
      if (portInLogs || isPortConflict(feError)) {
        pushLog(svc.name, `[auto-fix] Port :${svc.port} in use — freeing and restarting`);
        await freePorts([svc.port], svc.name);
        startFrontendService(svc, true);
      } else {
        setState(svc.name, "error", undefined, `Exited ${code}${feError ? ": " + feError : ""}`);
      }
    } else {
      setState(svc.name, "error", undefined, `Exited ${code}${feError ? ": " + feError : ""}`);
    }
  });
}

function stopFrontendService(name: string) {
  processMap.get(name)?.kill();
  processMap.delete(name);
  setState(name, "stopped");
}

async function startInfra(group: InfraGroup) {
  if (stateMap.get(group.name)?.state === "running") return;
  setState(group.name, "starting");
  pushLog(group.name, `[infra] docker compose -f ${group.composePath} up -d`);
  const proc = Bun.spawn(["docker", "compose", "-f", group.composePath, "up", "-d"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  pipeStream(proc.stdout, group.name);
  pipeStream(proc.stderr, group.name);
  const code = await proc.exited;
  if (code !== 0) { setState(group.name, "error"); return; }

  pushLog(group.name, `[infra] Waiting for ports ${group.healthPorts.join(", ")}…`);
  const ok = await Promise.all(group.healthPorts.map((p) => tcpHealthCheck(p)));
  if (ok.every(Boolean)) {
    setState(group.name, "running");
    pushLog(group.name, "[infra] All ports healthy");
  } else {
    setState(group.name, "error");
    pushLog(group.name, "[infra] Health check timed out");
  }
}

async function stopInfra(group: InfraGroup) {
  setState(group.name, "starting");
  pushLog(group.name, `[infra] docker compose -f ${group.composePath} down`);
  const proc = Bun.spawn(["docker", "compose", "-f", group.composePath, "down"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  pipeStream(proc.stdout, group.name);
  pipeStream(proc.stderr, group.name);
  await proc.exited;
  setState(group.name, "stopped");
}

async function startAll(selected: string[]) {
  const sel = new Set(selected);
  for (const g of infraGroups) if (sel.has(g.name)) await startInfra(g);
  await Promise.all([
    ...services.filter((s) => sel.has(s.name)).map((s) => startService(s)),
    ...frontendServices.filter((s) => sel.has(s.name)).map((s) => startFrontendService(s)),
  ]);
}

async function stopAll() {
  for (const s of services) stopService(s.name);
  for (const s of frontendServices) stopFrontendService(s.name);
  for (const g of infraGroups) await stopInfra(g);
}

function buildSystemPrompt(focusedService?: string): string {
  const states: Record<string, string> = {};
  for (const [k, v] of stateMap) states[k] = v.lastError ? `${v.state} — ${v.lastError}` : v.state;
  const recentLogs = focusedService ? (logBuffer.get(focusedService) ?? []).slice(-60).join("\n") : "";
  return [
    "You are a dev assistant embedded in a local microservices dashboard.",
    "The user is running Java SOFABoot services and frontend apps on their local machine.",
    "",
    "Current service states:",
    JSON.stringify(states, null, 2),
    "",
    focusedService ? `Recent logs for ${focusedService}:\n${recentLogs}` : "",
    "",
    "Help diagnose and fix issues. When suggesting shell commands, wrap them in ```sh code blocks.",
    "Be concise — the user is a developer who wants direct answers.",
  ].join("\n");
}

process.on("SIGINT", async () => {
  for (const s of services) stopService(s.name);
  for (const s of frontendServices) stopFrontendService(s.name);
  for (const g of infraGroups) Bun.spawn(["docker", "compose", "-f", g.composePath, "down"]);
  process.exit(0);
});

Bun.serve({
  port: 3333,
  routes: {
    "/": index,
    "/api/status": {
      GET: () => {
        const out: Record<string, ServiceState> = {};
        for (const [k, v] of stateMap) out[k] = v;
        return Response.json(out);
      },
    },
    "/api/start-all": {
      POST: async (req) => {
        const { selected } = await req.json() as { selected: string[] };
        startAll(selected);
        return Response.json({ ok: true });
      },
    },
    "/api/stop-all":  { POST: () => { stopAll();  return Response.json({ ok: true }); } },
    "/api/chat": {
      POST: async (req) => {
        const { message, service } = await req.json() as { message: string; service?: string };
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(ctrl) {
            try {
              const s = anthropic.messages.stream({
                model: "claude-sonnet-4-6",
                max_tokens: 1024,
                system: buildSystemPrompt(service),
                messages: [{ role: "user", content: message }],
              });
              for await (const chunk of s) {
                if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
                  ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`));
                }
              }
            } catch (e: any) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ text: `\n[error] ${e.message}` })}\n\n`));
            }
            ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
            ctrl.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      },
    },
    "/api/run-command": {
      POST: async (req) => {
        const { command } = await req.json() as { command: string };
        const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return Response.json({ output: (out + err).trim() });
      },
    },
    "/api/:name/start": {
      POST: (req: Request & { params: { name: string } }) => {
        const { name } = req.params;
        const infra = infraGroups.find((g) => g.name === name);
        const svc = services.find((s) => s.name === name);
        const fe = frontendServices.find((s) => s.name === name);
        if (infra) { startInfra(infra); return Response.json({ ok: true }); }
        if (svc)   { startService(svc); return Response.json({ ok: true }); }
        if (fe)    { startFrontendService(fe); return Response.json({ ok: true }); }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    },
    "/api/:name/rebuild": {
      POST: (req: Request & { params: { name: string } }) => {
        const { name } = req.params;
        const svc = services.find((s) => s.name === name);
        if (svc) { rebuildService(svc); return Response.json({ ok: true }); }
        return Response.json({ error: "not a java service" }, { status: 400 });
      },
    },
    "/api/:name/stop": {
      POST: (req: Request & { params: { name: string } }) => {
        const { name } = req.params;
        const infra = infraGroups.find((g) => g.name === name);
        const svc = services.find((s) => s.name === name);
        const fe = frontendServices.find((s) => s.name === name);
        if (infra) { stopInfra(infra); return Response.json({ ok: true }); }
        if (svc)   { stopService(svc.name); return Response.json({ ok: true }); }
        if (fe)    { stopFrontendService(fe.name); return Response.json({ ok: true }); }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      server.upgrade(req);
      return;
    }
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      for (const [service, lines] of logBuffer) {
        for (const line of lines.slice(-100)) ws.send(JSON.stringify({ service, line }));
      }
      for (const [service, s] of stateMap) {
        ws.send(JSON.stringify({ type: "state", service, state: s.state, pid: s.pid, lastError: s.lastError }));
      }
    },
    message() {},
    close(ws) { wsClients.delete(ws); },
  },
  development: { hmr: true, console: true },
});

console.log("Dev Services running at http://localhost:3333");
