/**
 * Example Vibe App Server
 * 
 * This is a simple Node.js server that runs inside each tenant's container.
 * It demonstrates what a "vibe coded" app might look like.
 * 
 * In a real scenario, this could be:
 * - A full Next.js/React app
 * - A Python Flask/FastAPI server
 * - A Go web server
 * - Any containerized application
 * 
 * KEY POINTS:
 * - Must listen on port 8080 (configurable in Container class)
 * - Should handle /health for health checks
 * - Can access X-App-Id header to know which tenant this is
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.APP_ID || "unknown";

// =============================================================================
// CONTAINER LOCATION (from Cloudflare runtime environment)
// These are automatically set by Cloudflare when the container starts
// =============================================================================
const CONTAINER_LOCATION = {
  location: process.env.CLOUDFLARE_LOCATION || "unknown",
  country: process.env.CLOUDFLARE_COUNTRY_A2 || "unknown",
  region: process.env.CLOUDFLARE_REGION || "unknown",
  applicationId: process.env.CLOUDFLARE_APPLICATION_ID || "unknown",
  durableObjectId: process.env.CLOUDFLARE_DURABLE_OBJECT_ID || "unknown",
};

// =============================================================================
// INSTANCE IDENTITY (proves same container is reached)
// =============================================================================
// This ID is generated ONCE when the container starts.
// If you see the same instanceId across requests, you're hitting the same container!
const INSTANCE_ID = Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);

// In-memory state (persists for container lifetime, resets on restart)
// For persistent state, use external storage (R2, D1, KV, etc.)
let requestCount = 0;
let startTime = Date.now();

// =============================================================================
// REQUEST HANDLER
// =============================================================================

const server = http.createServer((req, res) => {
  requestCount++;
  
  // Get app ID from header (set by the Worker) or environment
  const appId = req.headers["x-app-id"] || APP_ID;
  
  // Log request for debugging
  console.log(`[${appId}] ${req.method} ${req.url} (location: ${CONTAINER_LOCATION.location})`);
  
  // Set common headers
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-App-Id", appId);
  res.setHeader("X-Container-Location", CONTAINER_LOCATION.location);
  
  // ---------------------------------------------------------------------------
  // ROUTING
  // ---------------------------------------------------------------------------
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  
  // Health check endpoint (required for container health checks)
  if (pathname === "/health") {
    return sendJson(res, 200, {
      status: "healthy",
      appId,
      containerLocation: CONTAINER_LOCATION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      requestCount,
    });
  }
  
  // Root endpoint - app info
  if (pathname === "/") {
    return sendJson(res, 200, {
      message: `Welcome to Vibe App: ${appId}`,
      description: "This is your isolated container running on Cloudflare!",
      
      // PROOF OF SAME INSTANCE: These values prove you're hitting the same container
      proof: {
        instanceId: INSTANCE_ID,  // Same ID = same container instance
        requestCount,             // Increments with each request (resets on restart)
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        startedAt: new Date(startTime).toISOString(),
        explanation: "If instanceId stays the same across requests, you are reaching the SAME container!"
      },
      
      containerLocation: {
        ...CONTAINER_LOCATION,
        description: `Container running in ${CONTAINER_LOCATION.location} (${CONTAINER_LOCATION.region})`,
      },
      
      endpoints: {
        "/": "This info page",
        "/health": "Health check",
        "/api/echo": "Echo back your request (POST)",
        "/api/counter": "Get/increment a counter",
        "/api/env": "View environment info",
      },
    });
  }
  
  // Echo endpoint - useful for testing
  if (pathname === "/api/echo") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          sendJson(res, 200, {
            echo: data,
            appId,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          sendJson(res, 200, {
            echo: body,
            appId,
            timestamp: new Date().toISOString(),
          });
        }
      });
      return;
    }
    return sendJson(res, 200, {
      message: "Send a POST request to echo data back",
      appId,
    });
  }
  
  // Counter endpoint - demonstrates in-memory state
  if (pathname === "/api/counter") {
    // This counter persists within the container lifetime
    // When container sleeps/restarts, it resets
    // For persistent counters, use Durable Object storage
    return sendJson(res, 200, {
      appId,
      requestCount,
      message: "This counter tracks requests to this container instance",
    });
  }
  
  // Environment info endpoint
  if (pathname === "/api/env") {
    return sendJson(res, 200, {
      appId,
      containerLocation: CONTAINER_LOCATION,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      },
      // Don't expose actual env vars in production!
      // This is just for demonstration
      containerInfo: {
        startTime: new Date(startTime).toISOString(),
        requestsServed: requestCount,
      },
    });
  }
  
  // 404 for unknown routes
  sendJson(res, 404, {
    error: "Not Found",
    message: `Route ${pathname} not found`,
    appId,
    availableRoutes: ["/", "/health", "/api/echo", "/api/counter", "/api/env"],
  });
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(data, null, 2));
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log("Server closed. Goodbye!");
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.log("Forcing exit...");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// =============================================================================
// START SERVER
// =============================================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                     VIBE APP CONTAINER                         ║
╠════════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                                   ║
║  Instance ID: ${INSTANCE_ID.padEnd(44)}║
║  Location: ${CONTAINER_LOCATION.location.padEnd(47)}║
║  Node.js: ${process.version.padEnd(49)}║
║  Started: ${new Date().toISOString().padEnd(49)}║
╚════════════════════════════════════════════════════════════════╝
  `);
});
