---
name: dev-services
description: "Launch and control the local Java microservices dashboard at localhost:3333. Manages iuser, iwallet, iaccount, iriskops, imerchant plus Docker Compose infrastructure."
argument-hint: "[stop|status]"
allowed-tools:
  - Bash
---

Manage the local dev services dashboard.

## Usage

- `/dev-services` or `/dev-services start` — start the dashboard server and open the browser
- `/dev-services stop` — stop the dashboard server (kills all managed processes)
- `/dev-services status` — print current service states to the terminal

## Behavior

### start (default)

1. Check if port 3333 is already in use:
   ```bash
   lsof -ti:3333
   ```
2. If not running, start the server in the background:
   ```bash
   bun ~/.claude/tools/dev-services/server.ts > /tmp/dev-services.log 2>&1 &
   ```
3. Wait 2 seconds for startup, then open the browser:
   ```bash
   open http://localhost:3333
   ```
4. Report: "Dev Services dashboard running at http://localhost:3333"

### stop

Kill the process on port 3333:
```bash
kill $(lsof -ti:3333) 2>/dev/null && echo "Dev Services stopped." || echo "Dev Services was not running."
```

### status

Fetch and display current state:
```bash
curl -s http://localhost:3333/api/status | jq
```

If the server is not running, report that the dashboard is offline and suggest running `/dev-services`.
