# Multi-Tenant Container Platform Template

A production-ready template for building multi-tenant platforms on Cloudflare, where each tenant gets their own isolated container instance. Perfect for hosting "vibe coded" apps, AI agents, dev environments, or any workload requiring tenant isolation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare's Global Network                          │
│                                                                              │
│   User Request: /app/my-cool-app/api/data                                   │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────┐    ┌────────────────────┐    ┌───────────────────────┐   │
│   │   Worker    │───▶│   Durable Object   │───▶│  Container Instance   │   │
│   │  (Router)   │    │  (App Manager)     │    │  (User's App)         │   │
│   │             │    │                    │    │                       │   │
│   │ Extracts    │    │ • Manages lifecycle│    │ • Runs user code      │   │
│   │ appId from  │    │ • Persists state   │    │ • Isolated filesystem │   │
│   │ URL path    │    │ • Auto-sleep/wake  │    │ • Own network space   │   │
│   └─────────────┘    └────────────────────┘    └───────────────────────┘   │
│                                                                              │
│   Same appId = Same container (globally routable)                           │
│   Different appId = Different container (complete isolation)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### 1. Deterministic Routing with `idFromName()`

The magic of this pattern is in how requests are routed:

```javascript
// This is DETERMINISTIC - same appId always routes to the same instance
const container = env.VIBE_APP.getByName("my-cool-app");
```

- `"my-cool-app"` → Always routes to Container A
- `"another-app"` → Always routes to Container B
- Requests from anywhere in the world reach the correct container

### 2. Automatic Lifecycle Management

Containers are managed automatically:

- **First request**: Container is created and started
- **Subsequent requests**: Routed to existing container
- **Idle timeout** (configurable): Container sleeps to save costs
- **Next request after sleep**: Container wakes automatically

### 3. Complete Tenant Isolation

Each tenant (appId) gets:

- Own container instance (separate processes, filesystem, memory)
- Own Durable Object (separate persistent storage)
- Own network namespace
- No cross-tenant data leakage

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Docker](https://www.docker.com/products/docker-desktop/) running locally
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Containers beta access

### Deploy

```bash
# Clone the template
git clone https://github.com/cloudflare/multi-tenant-container-template
cd multi-tenant-container-template

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Deploy (builds Docker image and deploys Worker + Container)
npx wrangler deploy
```

### Test Your Deployment

```bash
# Get platform info
curl https://multi-tenant-vibe-apps.<your-subdomain>.workers.dev/

# Access an app (creates container on first request)
curl https://multi-tenant-vibe-apps.<your-subdomain>.workers.dev/app/my-first-app/

# Check app status
curl https://multi-tenant-vibe-apps.<your-subdomain>.workers.dev/app/my-first-app/_status

# Access another app (creates separate container)
curl https://multi-tenant-vibe-apps.<your-subdomain>.workers.dev/app/another-app/

# Test the echo endpoint
curl -X POST \
  https://multi-tenant-vibe-apps.<your-subdomain>.workers.dev/app/my-first-app/api/echo \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'
```

## Project Structure

```
multi-tenant-container-template/
├── src/
│   └── index.js          # Worker + Container class (the routing magic)
├── example-app/
│   ├── server.js         # Example app that runs in container
│   └── package.json
├── Dockerfile            # Container image definition
├── wrangler.toml         # Cloudflare configuration
├── package.json
└── README.md
```

## Configuration

### wrangler.toml

Key settings you may want to customize:

```toml
# Maximum concurrent containers (cost control)
[[containers]]
max_instances = 50        # Increase for more tenants

# Instance size
instance_type = "standard"  # "small", "standard", or "large"
```

### src/index.js

Container behavior settings:

```javascript
export class VibeAppContainer extends Container {
  defaultPort = 8080;     // Port your app listens on
  sleepAfter = "10m";     // Sleep after 10 mins idle (saves costs)
}
```

## URL Routing Patterns

The template supports multiple routing patterns:

### Path-based (Default)
```
https://your-worker.dev/app/{appId}/your-path
https://your-worker.dev/app/my-app/api/users
```

### Query Parameter
```
https://your-worker.dev/?appId={appId}
https://your-worker.dev/?appId=my-app
```

### Subdomain (Requires Custom Domain)
```
https://{appId}.your-domain.com
https://my-app.vibeapps.com
```

To enable subdomain routing, uncomment the code in `src/index.js` and configure your custom domain.

## Management Endpoints

Each app has built-in management endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/app/{appId}/_status` | GET | Container status, stats, metadata |
| `/app/{appId}/_restart` | POST | Force restart the container |
| `/app/{appId}/_metadata` | GET | Get app metadata |
| `/app/{appId}/_metadata` | POST | Set app metadata |

### Example: Check App Status

```bash
curl https://your-worker.dev/app/my-app/_status
```

```json
{
  "appId": "my-app",
  "container": {
    "status": "running",
    "port": 8080
  },
  "stats": {
    "startCount": 3,
    "lastStarted": 1699900000000,
    "lastStopped": 1699899000000
  },
  "metadata": {
    "owner": "user@example.com",
    "appName": "My Cool App"
  }
}
```

## Customization Guide

### Replace the Example App

1. Modify `example-app/` with your own application, or
2. Replace the `Dockerfile` to use a different base image:

```dockerfile
# Python example
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["python", "app.py"]
```

```dockerfile
# Go example
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o server .

FROM alpine:latest
COPY --from=builder /app/server /server
EXPOSE 8080
CMD ["/server"]
```

### Add Persistent Storage

Containers are ephemeral - use Cloudflare storage for persistence:

```javascript
// In your Container class, use Durable Object storage
async saveUserData(data) {
  await this.ctx.storage.put("userData", data);
}

async getUserData() {
  return await this.ctx.storage.get("userData");
}
```

Or bind external storage in `wrangler.toml`:

```toml
# KV Namespace
[[kv_namespaces]]
binding = "APP_DATA"
id = "your-kv-namespace-id"

# R2 Bucket
[[r2_buckets]]
binding = "APP_FILES"
bucket_name = "your-bucket"

# D1 Database
[[d1_databases]]
binding = "APP_DB"
database_name = "your-database"
database_id = "your-database-id"
```

### Add Authentication

Add authentication in the Worker before routing:

```javascript
export default {
  async fetch(request, env, ctx) {
    // Verify auth before routing to container
    const authHeader = request.headers.get("Authorization");
    if (!isValidAuth(authHeader)) {
      return new Response("Unauthorized", { status: 401 });
    }
    
    // ... rest of routing logic
  }
}
```

## Cost Optimization

### Auto-Sleep

Containers sleep after `sleepAfter` period of inactivity:

```javascript
sleepAfter = "10m";  // Sleep after 10 minutes
sleepAfter = "1h";   // Sleep after 1 hour
sleepAfter = "0";    // Never sleep (not recommended)
```

### Instance Limits

Control max concurrent containers:

```toml
[[containers]]
max_instances = 50  # Adjust based on your needs
```

### Instance Types

Choose appropriate sizing:

| Type | Use Case |
|------|----------|
| `small` | Simple apps, low traffic |
| `standard` | Most applications |
| `large` | Compute-intensive workloads |

## Monitoring & Debugging

### View Logs

```bash
# Stream Worker logs
npx wrangler tail

# View in Cloudflare Dashboard
# Workers & Pages > your-worker > Logs
```

### Container Status

```bash
# Check specific app
curl https://your-worker.dev/app/my-app/_status

# List all Durable Objects (via Dashboard)
# Workers & Pages > your-worker > Durable Objects
```

## Learn More

### Documentation

- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Container Package](https://developers.cloudflare.com/containers/container-package/)

### Examples

- [Container Examples](https://developers.cloudflare.com/containers/examples/)
- [Durable Objects Examples](https://developers.cloudflare.com/durable-objects/examples/)

### Reference Architecture

- [Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)

## Troubleshooting

### "Container failed to start"

1. Check Docker is running locally during deploy
2. Verify Dockerfile builds locally: `docker build -t test .`
3. Check container logs in Cloudflare Dashboard

### "App ID not found"

Ensure you're using the correct URL format:
- `/app/{appId}/...` (path-based)
- `/?appId={appId}` (query-based)

### Container not waking up

Check the `_status` endpoint to see container state and any errors.

## License

MIT
