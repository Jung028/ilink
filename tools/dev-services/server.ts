import index from "./index.html";
import { infraGroups, services, frontendServices, type InfraGroup, type JavaService, type FrontendService } from "./config";
import { join } from "path";

type State = "running" | "stopped" | "starting" | "building" | "error";

interface ServiceState {
  state: State;
  pid?: number;
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

function setState(name: string, state: State, pid?: number) {
  stateMap.set(name, { state, pid });
  const msg = JSON.stringify({ type: "state", service: name, state, pid });
  for (const ws of wsClients) ws.send(msg);
}

async function pipeStream(stream: ReadableStream<Uint8Array> | null, service: string) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = partial + decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) pushLog(service, line);
  }
  if (partial) pushLog(service, partial);
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
  pipeStream(proc.stdout, svc.name);
  pipeStream(proc.stderr, svc.name);
  const code = await proc.exited;
  if (code !== 0) {
    setState(svc.name, "error");
    pushLog(svc.name, `[build] FAILED (exit ${code})`);
    return false;
  }
  pushLog(svc.name, "[build] SUCCESS");
  return true;
}

async function startService(svc: JavaService) {
  if (stateMap.get(svc.name)?.state === "running") return;
  setState(svc.name, "starting");

  let jar = await findJar(svc.dir);
  if (!jar) {
    const ok = await buildService(svc);
    if (!ok) return;
    jar = await findJar(svc.dir);
    if (!jar) {
      setState(svc.name, "error");
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
  pipeStream(proc.stdout, svc.name);
  pipeStream(proc.stderr, svc.name);
  proc.exited.then((code) => {
    pushLog(svc.name, `[exit] exited with code ${code}`);
    processMap.delete(svc.name);
    setState(svc.name, code === 0 ? "stopped" : "error");
  });
}

function stopService(name: string) {
  processMap.get(name)?.kill();
  processMap.delete(name);
  setState(name, "stopped");
}

async function startFrontendService(svc: FrontendService) {
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
  pipeStream(proc.stdout, svc.name);
  pipeStream(proc.stderr, svc.name);
  proc.exited.then((code) => {
    pushLog(svc.name, `[exit] exited with code ${code}`);
    processMap.delete(svc.name);
    setState(svc.name, code === 0 ? "stopped" : "error");
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
        ws.send(JSON.stringify({ type: "state", service, state: s.state, pid: s.pid }));
      }
    },
    message() {},
    close(ws) { wsClients.delete(ws); },
  },
  development: { hmr: true, console: true },
});

console.log("Dev Services running at http://localhost:3333");
