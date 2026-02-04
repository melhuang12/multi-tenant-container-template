# Multi-Tenant Container Platform Template

A template for building multi-tenant platforms on Cloudflare Containers. Each tenant gets their own isolated container instance.

**Live Demo:** https://multi-tenant-vibe-apps.mel-dev.workers.dev

## How It Works

```
Request: /app/my-app/api/data
           │
           ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│     Worker       │────▶│  Durable Object  │────▶│    Container     │
│  extracts appId  │     │  manages state   │     │  runs your app   │
└──────────────────┘     └──────────────────┘     └──────────────────┘

Same appId    = Same container (deterministic routing)
Different appId = Different container (complete isolation)
```

## The Routing Pattern

```javascript
export default {
  async fetch(request, env) {
    // Extract appId from URL
    const match = new URL(request.url).pathname.match(/^\/app\/([^\/]+)/);
    const appId = match[1];

    // Deterministic routing - same appId ALWAYS hits same container
    const container = env.VIBE_APP.getByName(appId);

    // Forward request (auto-starts container if sleeping)
    return container.fetch(request);
  }
};

export class VibeAppContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";  // Auto-sleep after 10 min idle
}
```

## Quick Start

```bash
git clone https://github.com/melhuang12/multi-tenant-container-template
cd multi-tenant-container-template
npm install
npx wrangler login
npx wrangler deploy
```

## Test It

```bash
# Access an app (creates container on first request)
curl https://your-worker.workers.dev/app/my-app/

# Same appId = same container (notice instanceId stays the same)
curl https://your-worker.workers.dev/app/my-app/
curl https://your-worker.workers.dev/app/my-app/

# Different appId = different container
curl https://your-worker.workers.dev/app/other-app/
```

## Project Structure

```
├── src/index.js       # Worker routing + Container class
├── example-app/       # App that runs inside container
├── Dockerfile         # Container image
└── wrangler.toml      # Cloudflare config
```

## Configuration

**wrangler.toml:**
```toml
[[containers]]
max_instances = 50  # Max concurrent containers
```

**src/index.js:**
```javascript
export class VibeAppContainer extends Container {
  defaultPort = 8080;   // Container port
  sleepAfter = "10m";   // Sleep after idle
}
```

## Management Endpoints

| Endpoint | Description |
|----------|-------------|
| `/app/{appId}/_status` | Container status and location |
| `/app/{appId}/_restart` | Force restart (POST) |

## Customization

Replace `example-app/` with your own application, or modify the Dockerfile:

```dockerfile
# Python
FROM python:3.11-slim
COPY . /app
CMD ["python", "app.py"]

# Go  
FROM golang:1.21-alpine
COPY . /app
RUN go build -o server .
CMD ["/server"]
```

## Learn More

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)

## License

MIT
