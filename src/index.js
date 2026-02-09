/**
 * Multi-Tenant Container Platform
 * 
 * This template demonstrates how to build a multi-tenant platform where each
 * tenant (user/app) gets their own isolated container instance.
 * 
 * USE CASE: Hosting "vibe coded" apps - each user's app runs in its own container
 * with full isolation, automatic scaling, and global routing.
 * 
 * ARCHITECTURE OVERVIEW:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         Cloudflare's Global Network                      │
 * │                                                                          │
 * │   User Request                                                           │
 * │        │                                                                 │
 * │        ▼                                                                 │
 * │   ┌─────────┐    ┌──────────────────┐    ┌─────────────────────────┐   │
 * │   │ Worker  │───▶│  Durable Object  │───▶│  Container Instance     │   │
 * │   │ (Router)│    │  (App Manager)   │    │  (User's Vibe App)      │   │
 * │   └─────────┘    └──────────────────┘    └─────────────────────────┘   │
 * │                                                                          │
 * │   • Worker: Routes requests based on appId                              │
 * │   • Durable Object: Manages container lifecycle, persists state         │
 * │   • Container: Runs the actual user application in isolation            │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * KEY CONCEPTS:
 * 
 * 1. idFromName(appId) - Converts a string ID into a Durable Object ID
 *    This is DETERMINISTIC: same appId always routes to the same DO/container
 * 
 * 2. Container Class - Extends DurableObject with container management
 *    Handles starting, stopping, health checks, and request forwarding
 * 
 * 3. Isolation - Each appId gets its own:
 *    - Container instance (separate filesystem, processes, memory)
 *    - Durable Object (separate state storage)
 *    - Network namespace
 * 
 * LEARN MORE:
 * - Durable Objects: https://developers.cloudflare.com/durable-objects/
 * - Containers: https://developers.cloudflare.com/containers/
 */

import { Container } from "@cloudflare/containers";

// =============================================================================
// CONTAINER CLASS DEFINITION
// =============================================================================
/**
 * VibeAppContainer - Manages individual tenant app containers
 * 
 * Each instance of this class:
 * - Controls ONE container running ONE user's app
 * - Has its own persistent storage (SQLite via Durable Objects)
 * - Can be addressed globally by its appId
 * 
 * The Container class from @cloudflare/containers handles:
 * - Starting/stopping the container
 * - Health checks and port readiness
 * - Request forwarding to the container
 * - Auto-sleep after inactivity
 */
export class VibeAppContainer extends Container {
  // ---------------------------------------------------------------------------
  // CONFIGURATION
  // ---------------------------------------------------------------------------
  
  /**
   * Default port where the container app listens
   * Your containerized app should listen on this port
   */
  defaultPort = 8080;

  /**
   * Auto-sleep timeout - container sleeps after this period of inactivity
   * This saves costs when apps aren't being used
   * Container will automatically wake up on the next request
   * 
   * Format: "30s", "5m", "1h", etc.
   */
  sleepAfter = "10m";

  // ---------------------------------------------------------------------------
  // LIFECYCLE HOOKS (Optional - implement for custom behavior)
  // ---------------------------------------------------------------------------

  /**
   * Called when container starts
   * Use this for initialization, logging, metrics, etc.
   */
  async onStart() {
    const appId = this.ctx.id.name || "unknown";
    console.log(`[${appId}] Container started`);
    
    // Example: Track start time in Durable Object storage
    await this.ctx.storage.put("lastStarted", Date.now());
    await this.ctx.storage.put("startCount", 
      ((await this.ctx.storage.get("startCount")) || 0) + 1
    );
  }

  /**
   * Called when container stops (goes to sleep or is terminated)
   * Use this for cleanup, saving state, logging, etc.
   */
  async onStop() {
    const appId = this.ctx.id.name || "unknown";
    console.log(`[${appId}] Container stopped`);
    
    await this.ctx.storage.put("lastStopped", Date.now());
  }

  /**
   * Called when container encounters an error
   * Use this for error reporting, alerting, retry logic, etc.
   */
  async onError(error) {
    const appId = this.ctx.id.name || "unknown";
    console.error(`[${appId}] Container error:`, error.message);
    
    await this.ctx.storage.put("lastError", {
      message: error.message,
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // CUSTOM RPC METHODS
  // ---------------------------------------------------------------------------
  /**
   * These methods can be called directly from Workers using RPC:
   *   const container = env.VIBE_APP.getByName("my-app");
   *   const status = await container.getAppStatus();
   */

  /**
   * Get detailed status about this app's container
   * Useful for admin dashboards, monitoring, debugging
   */
  async getAppStatus() {
    const appId = this.ctx.id.name || "unknown";
    
    // this.ctx.container.running is a boolean property (not a method)
    // Returns true if container is currently running
    const isRunning = this.ctx.container.running;
    
    // Get the Durable Object ID - this is the PROOF of deterministic routing
    // Same appId ALWAYS produces same DO ID
    const doId = this.ctx.id.toString();
    
    return {
      appId,
      
      // PROOF: Durable Object identity
      durableObject: {
        id: doId,
        idShort: doId.substring(0, 16) + "...",  // Short version for display
        explanation: "Same appId ALWAYS routes to this exact Durable Object ID"
      },
      
      container: {
        running: isRunning,
        status: isRunning ? "running" : "stopped",
        port: this.defaultPort,
      },
      
      // Container location is stored when container is accessed
      containerLocation: await this.ctx.storage.get("containerLocation") || null,
      
      stats: {
        startCount: await this.ctx.storage.get("startCount") || 0,
        lastStarted: await this.ctx.storage.get("lastStarted"),
        lastStopped: await this.ctx.storage.get("lastStopped"),
        lastError: await this.ctx.storage.get("lastError"),
        totalRequests: await this.ctx.storage.get("totalRequests") || 0,
      },
      
      metadata: await this.ctx.storage.get("metadata") || {},
    };
  }
  
  /**
   * Store the container's location and increment request counter
   * Called from the Worker with CF location headers
   */
  async updateLocation(location) {
    // Increment total request count (persists in DO storage)
    const totalRequests = ((await this.ctx.storage.get("totalRequests")) || 0) + 1;
    await this.ctx.storage.put("totalRequests", totalRequests);
    await this.ctx.storage.put("containerLocation", location);
    return { totalRequests };
  }

  /**
   * Store custom metadata for this app
   * Example: app name, owner, configuration, etc.
   */
  async setMetadata(metadata) {
    await this.ctx.storage.put("metadata", {
      ...((await this.ctx.storage.get("metadata")) || {}),
      ...metadata,
      updatedAt: Date.now(),
    });
    return { success: true };
  }

  /**
   * Force restart the container
   * Useful for deploying updates or recovering from errors
   */
  async restart() {
    const appId = this.ctx.id.name || "unknown";
    console.log(`[${appId}] Restart requested`);
    
    // destroy() stops the container, start() boots it back up
    await this.ctx.container.destroy();
    this.ctx.container.start();
    
    return { success: true, message: "Container restarted" };
  }
}


// =============================================================================
// WORKER ENTRY POINT (Router)
// =============================================================================
/**
 * This is the main entry point for all HTTP requests.
 * 
 * The Worker acts as a router that:
 * 1. Extracts the appId from the request (URL path or query param)
 * 2. Gets or creates the Durable Object for that appId
 * 3. Forwards the request to the appropriate container
 * 
 * ROUTING PATTERNS SUPPORTED:
 * - Path-based:  https://your-worker.dev/app/{appId}/...
 * - Query-based: https://your-worker.dev/?appId={appId}
 * - Subdomain:   https://{appId}.your-domain.com (requires custom domain)
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // -------------------------------------------------------------------------
    // STEP 1: Extract the App ID from the request
    // -------------------------------------------------------------------------
    // Try multiple routing patterns - customize based on your needs
    
    let appId = null;
    
    // Pattern 1: Path-based routing - /app/{appId}/...
    // Example: https://platform.dev/app/my-cool-app/api/users
    const pathMatch = url.pathname.match(/^\/app\/([^\/]+)/);
    if (pathMatch) {
      appId = pathMatch[1];
    }
    
    // Pattern 2: Query parameter - ?appId={appId}
    // Example: https://platform.dev/?appId=my-cool-app
    if (!appId) {
      appId = url.searchParams.get("appId");
    }
    
    // Pattern 3: Subdomain routing (if using custom domains)
    // Example: https://my-cool-app.vibeapps.com
    // Uncomment to enable:
    // if (!appId) {
    //   const subdomain = url.hostname.split('.')[0];
    //   if (subdomain !== 'www' && subdomain !== 'platform') {
    //     appId = subdomain;
    //   }
    // }

    // -------------------------------------------------------------------------
    // STEP 2: Handle platform-level routes (no appId needed)
    // -------------------------------------------------------------------------
    
    // Interactive Learning UI - serves at root
    if (url.pathname === "/" || url.pathname === "/ui") {
      const baseUrl = url.protocol + "//" + url.host;
      try {
        const html = getUIHTML(baseUrl);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        return new Response("UI Error: " + e.message, { status: 500 });
      }
    }
    
    // Health check endpoint for the platform itself
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        platform: "Multi-Tenant Vibe App Platform",
        version: "1.0.0",
        usage: {
          pathRouting: "/app/{appId}/your-path",
          queryRouting: "/?appId={appId}",
          statusEndpoint: "/app/{appId}/_status",
        },
      });
    }
    
    // API endpoint for JSON response (for programmatic access)
    if (url.pathname === "/api") {
      return Response.json({
        status: "healthy",
        platform: "Multi-Tenant Vibe App Platform",
        version: "1.0.0",
        usage: {
          ui: "/",
          pathRouting: "/app/{appId}/your-path",
          queryRouting: "/?appId={appId}",
          statusEndpoint: "/app/{appId}/_status",
        },
      });
    }

    // -------------------------------------------------------------------------
    // STEP 3: Validate App ID
    // -------------------------------------------------------------------------
    
    if (!appId) {
      return Response.json(
        {
          error: "Missing App ID",
          message: "Please provide an appId to route to your application",
          examples: [
            "GET /app/my-app-123/",
            "GET /?appId=my-app-123",
          ],
        },
        { status: 400 }
      );
    }

    // Validate appId format (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
      return Response.json(
        {
          error: "Invalid App ID",
          message: "App ID must contain only letters, numbers, hyphens, and underscores",
          provided: appId,
        },
        { status: 400 }
      );
    }

    // -------------------------------------------------------------------------
    // STEP 4: Get or Create the Container Instance
    // -------------------------------------------------------------------------
    /**
     * This is the KEY PATTERN:
     * 
     * getByName(appId) does two things:
     * 1. idFromName(appId) - Deterministically converts appId to a DO ID
     * 2. get(id) - Gets a stub (reference) to that Durable Object
     * 
     * If this is the first request for this appId:
     * - A new Durable Object is created
     * - A new Container is started
     * 
     * If this appId was seen before:
     * - Routes to the existing Durable Object
     * - Wakes the container if it was sleeping
     */
    
    try {
      const appContainer = env.VIBE_APP.getByName(appId);
      
      // -----------------------------------------------------------------------
      // STEP 5: Handle special management endpoints
      // -----------------------------------------------------------------------
      
      // Strip the /app/{appId} prefix to get the actual path
      const appPath = url.pathname.replace(/^\/app\/[^\/]+/, "") || "/";
      
      // Status endpoint - get container info without forwarding to container
      if (appPath === "/_status") {
        const status = await appContainer.getAppStatus();
        // Add request location info (where the request originated)
        status.requestLocation = {
          colo: request.cf?.colo || "unknown",
          country: request.cf?.country || "unknown",
          city: request.cf?.city || "unknown",
          region: request.cf?.region || "unknown",
        };
        return Response.json(status);
      }
      
      // Restart endpoint - force restart the container
      if (appPath === "/_restart" && request.method === "POST") {
        const result = await appContainer.restart();
        return Response.json(result);
      }
      
      // Metadata endpoint - get/set app metadata
      if (appPath === "/_metadata") {
        if (request.method === "GET") {
          const status = await appContainer.getAppStatus();
          return Response.json(status.metadata);
        }
        if (request.method === "POST" || request.method === "PUT") {
          const metadata = await request.json();
          const result = await appContainer.setMetadata(metadata);
          return Response.json(result);
        }
      }

      // -----------------------------------------------------------------------
      // STEP 6: Forward request to the container
      // -----------------------------------------------------------------------
      /**
       * appContainer.fetch() does the following:
       * 1. Ensures the container is running (starts if sleeping)
       * 2. Waits for the container to be healthy
       * 3. Forwards the HTTP request to the container
       * 4. Returns the container's response
       * 
       * The container sees the original request headers, body, method, etc.
       */
      
      // Rewrite the URL to remove the /app/{appId} prefix
      const containerUrl = new URL(request.url);
      containerUrl.pathname = appPath;
      
      const containerRequest = new Request(containerUrl, request);
      
      // Add headers to help the container identify the request context
      containerRequest.headers.set("X-App-Id", appId);
      containerRequest.headers.set("X-Original-URL", request.url);
      
      // Pass Cloudflare location headers to the container
      // These help identify where the container is running
      const cfColo = request.cf?.colo || "unknown";
      const cfCountry = request.cf?.country || "unknown";
      const cfCity = request.cf?.city || "unknown";
      const cfRegion = request.cf?.region || "unknown";
      containerRequest.headers.set("X-CF-Colo", cfColo);
      containerRequest.headers.set("X-CF-Country", cfCountry);
      containerRequest.headers.set("X-CF-City", cfCity);
      containerRequest.headers.set("X-CF-Region", cfRegion);
      
      // Store container location in DO storage for status endpoint
      // This runs in the background, doesn't block the request
      ctx.waitUntil(appContainer.updateLocation({
        colo: cfColo,
        country: cfCountry,
        city: cfCity,
        region: cfRegion,
        lastUpdated: Date.now(),
      }));
      
      const response = await appContainer.fetch(containerRequest);
      
      // Add CORS headers if needed (customize based on your requirements)
      const corsResponse = new Response(response.body, response);
      corsResponse.headers.set("X-Served-By", `vibe-app-${appId}`);
      
      return corsResponse;
      
    } catch (error) {
      // -----------------------------------------------------------------------
      // Error Handling
      // -----------------------------------------------------------------------
      console.error(`[${appId}] Error:`, error.message);
      
      return Response.json(
        {
          error: "Container Error",
          message: error.message,
          appId: appId,
          // Don't expose stack traces in production
          // stack: error.stack,
        },
        { status: 500 }
      );
    }
  },
};
/**
 * Interactive Learning UI for Multi-Tenant Container Routing
 * 
 * This UI helps visualize how requests flow through:
 * Worker → Durable Object → Container
 */

function getUIHTML(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Multi-Tenant Container Routing - Interactive Demo</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e4e4e7;
      min-height: 100vh;
      padding: 2rem;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    h1 {
      text-align: center;
      margin-bottom: 0.5rem;
      background: linear-gradient(90deg, #f97316, #fb923c);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .subtitle {
      text-align: center;
      color: #a1a1aa;
      margin-bottom: 2rem;
    }
    
    /* Architecture Diagram */
    .architecture {
      background: #27272a;
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 2rem;
      border: 1px solid #3f3f46;
    }
    
    .architecture h2 {
      margin-bottom: 1.5rem;
      color: #f97316;
    }
    
    .flow-diagram {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    
    .flow-box {
      background: #18181b;
      border: 2px solid #3f3f46;
      border-radius: 8px;
      padding: 1.5rem;
      text-align: center;
      flex: 1;
      min-width: 150px;
      transition: all 0.3s ease;
    }
    
    .flow-box.active {
      border-color: #f97316;
      box-shadow: 0 0 20px rgba(249, 115, 22, 0.3);
    }
    
    .flow-box.worker { border-top: 3px solid #3b82f6; }
    .flow-box.durable-object { border-top: 3px solid #8b5cf6; }
    .flow-box.container { border-top: 3px solid #22c55e; }
    
    .flow-box h3 {
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
      color: #a1a1aa;
    }
    
    .flow-box .title {
      font-weight: bold;
      font-size: 1.1rem;
      margin-bottom: 0.5rem;
    }
    
    .flow-box .status {
      font-size: 0.8rem;
      color: #71717a;
    }
    
    .flow-arrow {
      font-size: 2rem;
      color: #f97316;
      animation: pulse 1.5s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    
    /* Interactive Demo */
    .demo-section {
      background: #27272a;
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 2rem;
      border: 1px solid #3f3f46;
    }
    
    .demo-section h2 {
      margin-bottom: 1rem;
      color: #f97316;
    }
    
    .input-group {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    
    .input-wrapper {
      flex: 1;
      min-width: 200px;
    }
    
    .input-wrapper label {
      display: block;
      margin-bottom: 0.5rem;
      color: #a1a1aa;
      font-size: 0.9rem;
    }
    
    input, select {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #18181b;
      border: 1px solid #3f3f46;
      border-radius: 6px;
      color: #e4e4e7;
      font-size: 1rem;
    }
    
    input:focus, select:focus {
      outline: none;
      border-color: #f97316;
    }
    
    .btn {
      padding: 0.75rem 1.5rem;
      background: linear-gradient(90deg, #f97316, #ea580c);
      border: none;
      border-radius: 6px;
      color: white;
      font-weight: bold;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(249, 115, 22, 0.4);
    }
    
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    
    /* Timeline */
    .timeline {
      margin-top: 1.5rem;
      border-left: 2px solid #3f3f46;
      padding-left: 1.5rem;
    }
    
    .timeline-item {
      position: relative;
      padding-bottom: 1.5rem;
      opacity: 0;
      transform: translateX(-20px);
      transition: all 0.3s ease;
    }
    
    .timeline-item.visible {
      opacity: 1;
      transform: translateX(0);
    }
    
    .timeline-item::before {
      content: '';
      position: absolute;
      left: -1.5rem;
      top: 0.5rem;
      width: 12px;
      height: 12px;
      background: #3f3f46;
      border-radius: 50%;
      transform: translateX(-5px);
    }
    
    .timeline-item.active::before {
      background: #f97316;
      box-shadow: 0 0 10px rgba(249, 115, 22, 0.5);
    }
    
    .timeline-item.success::before {
      background: #22c55e;
    }
    
    .timeline-step {
      font-size: 0.8rem;
      color: #f97316;
      margin-bottom: 0.25rem;
    }
    
    .timeline-title {
      font-weight: bold;
      margin-bottom: 0.25rem;
    }
    
    .timeline-detail {
      font-size: 0.9rem;
      color: #a1a1aa;
    }
    
    .timeline-code {
      background: #18181b;
      padding: 0.5rem 0.75rem;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.8rem;
      margin-top: 0.5rem;
      overflow-x: auto;
      border: 1px solid #3f3f46;
    }
    
    /* Response Panel */
    .response-panel {
      background: #18181b;
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      border: 1px solid #3f3f46;
    }
    
    .response-panel h3 {
      font-size: 0.9rem;
      color: #a1a1aa;
      margin-bottom: 0.5rem;
    }
    
    .response-content {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.85rem;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
    }
    
    .response-content.error {
      color: #ef4444;
    }
    
    .response-content.success {
      color: #22c55e;
    }
    
    /* Key Concepts */
    .concepts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-top: 2rem;
    }
    
    .concept-card {
      background: #27272a;
      border-radius: 8px;
      padding: 1.5rem;
      border: 1px solid #3f3f46;
    }
    
    .concept-card h3 {
      color: #f97316;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .concept-card p {
      color: #a1a1aa;
      font-size: 0.9rem;
      line-height: 1.6;
    }
    
    .concept-card code {
      background: #18181b;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #f97316;
    }
    
    /* Active Apps */
    .active-apps {
      margin-top: 2rem;
    }
    
    .apps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }
    
    .app-card {
      background: #18181b;
      border-radius: 8px;
      padding: 1rem;
      border: 1px solid #3f3f46;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .app-card:hover {
      border-color: #f97316;
      transform: translateY(-2px);
    }
    
    .app-card .app-name {
      font-weight: bold;
      margin-bottom: 0.5rem;
      color: #22c55e;
    }
    
    .app-card .app-status {
      font-size: 0.8rem;
      color: #a1a1aa;
    }
    
    .app-card .app-status span {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 0.5rem;
    }
    
    .app-card .app-status span.running {
      background: #22c55e;
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
    }
    
    .app-card .app-status span.stopped {
      background: #71717a;
    }
    
    /* Footer */
    .footer {
      text-align: center;
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #3f3f46;
      color: #71717a;
    }
    
    .footer a {
      color: #f97316;
      text-decoration: none;
    }
    
    .footer a:hover {
      text-decoration: underline;
    }
    
    /* Loading spinner */
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #3f3f46;
      border-top-color: #f97316;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 0.5rem;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      body {
        padding: 1rem;
      }
      
      .flow-diagram {
        flex-direction: column;
      }
      
      .flow-arrow {
        transform: rotate(90deg);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Multi-Tenant Container Routing</h1>
    <p class="subtitle">Interactive demo showing how requests flow through Workers, Durable Objects, and Containers</p>
    
    <!-- Architecture Diagram -->
    <div class="architecture">
      <h2>Architecture Flow</h2>
      <div class="flow-diagram">
        <div class="flow-box worker" id="flow-worker">
          <h3>STEP 1</h3>
          <div class="title">Worker</div>
          <div class="status">Routes by appId</div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="flow-box durable-object" id="flow-do">
          <h3>STEP 2</h3>
          <div class="title">Durable Object</div>
          <div class="status">Manages lifecycle</div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="flow-box container" id="flow-container">
          <h3>STEP 3</h3>
          <div class="title">Container</div>
          <div class="status">Runs your app</div>
        </div>
      </div>
    </div>
    
    <!-- Interactive Demo -->
    <div class="demo-section">
      <h2>Try It Yourself</h2>
      <p style="color: #a1a1aa; margin-bottom: 1rem;">
        Enter an App ID and watch how the request flows through the system. 
        Each unique App ID creates its own isolated container!
      </p>
      
      <div class="input-group">
        <div class="input-wrapper">
          <label for="appId">App ID (your tenant identifier)</label>
          <input type="text" id="appId" placeholder="e.g., my-cool-app" value="demo-app">
        </div>
        <div class="input-wrapper">
          <label for="endpoint">Endpoint</label>
          <select id="endpoint">
            <option value="/">/ (App Home)</option>
            <option value="/health">/health (Health Check)</option>
            <option value="/api/counter">/api/counter (Counter)</option>
            <option value="/api/env">/api/env (Environment)</option>
            <option value="/_status">/_status (Container Status)</option>
          </select>
        </div>
        <div class="input-wrapper" style="flex: 0; align-self: flex-end;">
          <button class="btn" id="sendRequest" onclick="sendRequest()">
            Send Request
          </button>
        </div>
      </div>
      
      <!-- Timeline -->
      <div class="timeline" id="timeline">
        <div class="timeline-item" id="step1">
          <div class="timeline-step">STEP 1</div>
          <div class="timeline-title">Request hits Worker</div>
          <div class="timeline-detail">Worker extracts appId from URL path</div>
          <div class="timeline-code" id="step1-code"></div>
        </div>
        <div class="timeline-item" id="step2">
          <div class="timeline-step">STEP 2</div>
          <div class="timeline-title">Get Durable Object stub</div>
          <div class="timeline-detail">idFromName() creates deterministic ID from appId</div>
          <div class="timeline-code" id="step2-code"></div>
        </div>
        <div class="timeline-item" id="step3">
          <div class="timeline-step">STEP 3</div>
          <div class="timeline-title">Forward to Durable Object</div>
          <div class="timeline-detail">DO checks if container is running, starts if needed</div>
          <div class="timeline-code" id="step3-code"></div>
        </div>
        <div class="timeline-item" id="step4">
          <div class="timeline-step">STEP 4</div>
          <div class="timeline-title">Container processes request</div>
          <div class="timeline-detail">Your app code runs inside the isolated container</div>
          <div class="timeline-code" id="step4-code"></div>
        </div>
        <div class="timeline-item" id="step5">
          <div class="timeline-step">STEP 5</div>
          <div class="timeline-title">Response returned</div>
          <div class="timeline-detail">Container → DO → Worker → You</div>
        </div>
      </div>
      
      <!-- Response -->
      <div class="response-panel" id="responsePanel" style="display: none;">
        <h3>Response from <span id="responseAppId"></span></h3>
        <div class="response-content" id="responseContent"></div>
      </div>
    </div>
    
    <!-- DO Class vs Instance Visualization -->
    <div class="demo-section">
      <h2>DO Class vs DO Instance</h2>
      <p style="color: #a1a1aa; margin-bottom: 1.5rem;">
        A Durable Object <strong>class</strong> is the blueprint. <strong>Instances</strong> are created from it, each with a unique ID.
      </p>
      
      <div style="display: flex; gap: 2rem; flex-wrap: wrap;">
        <!-- Class (Blueprint) -->
        <div style="flex: 1; min-width: 280px;">
          <div style="background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); border: 2px dashed #6366f1; border-radius: 12px; padding: 1.5rem;">
            <div style="color: #a5b4fc; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem;">Class (Blueprint)</div>
            <div style="color: #e0e7ff; font-size: 1.1rem; font-weight: bold; font-family: monospace;">VibeAppContainer</div>
            <div style="margin-top: 1rem; padding: 1rem; background: #0f0d1a; border-radius: 8px; font-family: monospace; font-size: 0.8rem;">
              <div style="color: #6b7280;">// Defined ONCE in code</div>
              <div><span style="color: #c084fc;">class</span> <span style="color: #22d3ee;">VibeAppContainer</span></div>
              <div style="padding-left: 1rem;">defaultPort = <span style="color: #34d399;">8080</span></div>
              <div style="padding-left: 1rem;">sleepAfter = <span style="color: #fbbf24;">"10m"</span></div>
            </div>
            <div style="margin-top: 1rem; color: #a5b4fc; font-size: 0.85rem;">
              One class definition shared by all instances
            </div>
          </div>
        </div>
        
        <!-- Arrow -->
        <div style="display: flex; align-items: center; color: #f97316; font-size: 2rem;">
          <span style="display: none;">→</span>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </div>
        
        <!-- Instances -->
        <div style="flex: 2; min-width: 350px;">
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <!-- Instance 1 -->
            <div style="background: linear-gradient(135deg, #14532d 0%, #166534 100%); border: 2px solid #22c55e; border-radius: 12px; padding: 1rem; display: flex; align-items: center; gap: 1rem;">
              <div style="background: #0f2a1a; border-radius: 8px; padding: 0.75rem; font-family: monospace; font-size: 0.75rem;">
                <div style="color: #4ade80;">Instance</div>
                <div style="color: #bbf7d0; font-weight: bold;">app-1</div>
              </div>
              <div style="flex: 1;">
                <div style="color: #86efac; font-size: 0.8rem;">ID: <span style="font-family: monospace;">a1b2c3...</span></div>
                <div style="color: #4ade80; font-size: 0.75rem;">Own storage, own container</div>
              </div>
              <div style="background: #052e16; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.7rem; color: #4ade80;">ams07</div>
            </div>
            
            <!-- Instance 2 -->
            <div style="background: linear-gradient(135deg, #7c2d12 0%, #9a3412 100%); border: 2px solid #f97316; border-radius: 12px; padding: 1rem; display: flex; align-items: center; gap: 1rem;">
              <div style="background: #1c0a00; border-radius: 8px; padding: 0.75rem; font-family: monospace; font-size: 0.75rem;">
                <div style="color: #fb923c;">Instance</div>
                <div style="color: #fed7aa; font-weight: bold;">app-2</div>
              </div>
              <div style="flex: 1;">
                <div style="color: #fdba74; font-size: 0.8rem;">ID: <span style="font-family: monospace;">d4e5f6...</span></div>
                <div style="color: #fb923c; font-size: 0.75rem;">Own storage, own container</div>
              </div>
              <div style="background: #1c0a00; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.7rem; color: #fb923c;">cdg12</div>
            </div>
            
            <!-- Instance 3 -->
            <div style="background: linear-gradient(135deg, #1e3a5f 0%, #1e40af 100%); border: 2px solid #3b82f6; border-radius: 12px; padding: 1rem; display: flex; align-items: center; gap: 1rem;">
              <div style="background: #0c1929; border-radius: 8px; padding: 0.75rem; font-family: monospace; font-size: 0.75rem;">
                <div style="color: #60a5fa;">Instance</div>
                <div style="color: #bfdbfe; font-weight: bold;">app-3</div>
              </div>
              <div style="flex: 1;">
                <div style="color: #93c5fd; font-size: 0.8rem;">ID: <span style="font-family: monospace;">g7h8i9...</span></div>
                <div style="color: #60a5fa; font-size: 0.75rem;">Own storage, own container</div>
              </div>
              <div style="background: #0c1929; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.7rem; color: #60a5fa;">fra03</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Key insight -->
      <div style="margin-top: 1.5rem; background: #18181b; border-radius: 8px; padding: 1rem; border-left: 4px solid #f97316;">
        <div style="color: #f97316; font-weight: bold; margin-bottom: 0.5rem;">Key Insight</div>
        <div style="color: #a1a1aa; font-size: 0.9rem;">
          <code style="background: #27272a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #22c55e;">getByName("app-1")</code> always returns the <strong>same instance</strong> (green box above).<br>
          <code style="background: #27272a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #f97316;">getByName("app-2")</code> always returns a <strong>different instance</strong> (orange box).
        </div>
      </div>
    </div>
    
    <!-- Key Concepts -->
    <div class="demo-section">
      <h2>Key Concepts</h2>
      <div class="concepts">
        <div class="concept-card">
          <h3>Deterministic Routing</h3>
          <p>
            <code>getByName("my-app")</code> always returns the same DO instance.
            Same appId = same instance, globally.
          </p>
        </div>
        <div class="concept-card">
          <h3>Complete Isolation</h3>
          <p>
            Each instance has its own storage and container.
            No shared state between instances.
          </p>
        </div>
        <div class="concept-card">
          <h3>Auto Sleep/Wake</h3>
          <p>
            Containers sleep after <code>sleepAfter</code> idle time.
            Wake automatically on next request.
          </p>
        </div>
        <div class="concept-card">
          <h3>Persistent State</h3>
          <p>
            DO storage persists across container restarts.
            Container state is ephemeral.
          </p>
        </div>
      </div>
    </div>
    
    <!-- Active Apps -->
    <div class="demo-section active-apps">
      <h2>Your Active Apps</h2>
      <p style="color: #a1a1aa; margin-bottom: 1rem;">
        Apps you've accessed in this session. Click to view status.
      </p>
      <div class="apps-grid" id="appsGrid">
        <div class="app-card" id="app-demo-app" onclick="quickAccess('demo-app')">
          <div class="app-name">demo-app</div>
          <div class="app-status"><span class="stopped"></span>Click to activate</div>
        </div>
      </div>
    </div>
    
    <!-- Code Example -->
    <div class="demo-section">
      <h2>The Code Behind It</h2>
      <p style="color: #a1a1aa; margin-bottom: 1rem;">
        This is the actual Worker routing logic. The key is <code style="background: #18181b; padding: 0.2rem 0.4rem; border-radius: 4px; color: #f97316;">getByName(appId)</code> which deterministically routes to the same Durable Object/Container.
      </p>
      <pre style="background: #18181b; border-radius: 8px; padding: 1.5rem; overflow-x: auto; border: 1px solid #3f3f46; margin: 0;"><code style="font-family: 'Monaco', 'Menlo', 'Consolas', monospace; font-size: 0.85rem; line-height: 1.7;"><span style="color: #6b7280;">// Worker entry point (src/index.js)</span>
<span style="color: #c084fc;">export default</span> {
  <span style="color: #c084fc;">async</span> <span style="color: #60a5fa;">fetch</span>(<span style="color: #f9a8d4;">request</span>, <span style="color: #f9a8d4;">env</span>) {
    <span style="color: #6b7280;">// 1. Extract appId from URL path</span>
    <span style="color: #c084fc;">const</span> url = <span style="color: #c084fc;">new</span> <span style="color: #22d3ee;">URL</span>(request.url);
    <span style="color: #c084fc;">const</span> match = url.pathname.<span style="color: #60a5fa;">match</span>(<span style="color: #fbbf24;">/^\\/app\\/([^\\/]+)/</span>);
    <span style="color: #c084fc;">const</span> appId = match[<span style="color: #34d399;">1</span>];  <span style="color: #6b7280;">// e.g., "my-cool-app"</span>

    <span style="color: #6b7280;">// 2. Get container by name - THE KEY PATTERN!</span>
    <span style="color: #6b7280;">//    Same appId ALWAYS routes to same Durable Object</span>
    <span style="color: #c084fc;">const</span> container = env.VIBE_APP.<span style="color: #f97316;">getByName</span>(appId);

    <span style="color: #6b7280;">// 3. Forward request to container</span>
    <span style="color: #6b7280;">//    - Auto-starts if container is sleeping</span>
    <span style="color: #6b7280;">//    - Routes to existing container if running</span>
    <span style="color: #c084fc;">return</span> container.<span style="color: #60a5fa;">fetch</span>(request);
  }
};

<span style="color: #6b7280;">// Container class extends DurableObject</span>
<span style="color: #c084fc;">export class</span> <span style="color: #22d3ee;">VibeAppContainer</span> <span style="color: #c084fc;">extends</span> <span style="color: #22d3ee;">Container</span> {
  defaultPort = <span style="color: #34d399;">8080</span>;    <span style="color: #6b7280;">// Container listens here</span>
  sleepAfter = <span style="color: #fbbf24;">"10m"</span>;    <span style="color: #6b7280;">// Auto-sleep after 10 min idle</span>
}</code></pre>
    </div>
    
    <div class="footer">
      <p>
        <a href="https://github.com/melhuang12/multi-tenant-container-template" target="_blank">View on GitHub</a>
        &nbsp;|&nbsp;
        <a href="https://developers.cloudflare.com/containers/" target="_blank">Cloudflare Containers Docs</a>
        &nbsp;|&nbsp;
        <a href="https://developers.cloudflare.com/durable-objects/" target="_blank">Durable Objects Docs</a>
      </p>
    </div>
  </div>
  
  <script>
    const BASE_URL = '${baseUrl}';
    const accessedApps = new Set(['demo-app']);
    
    async function sendRequest() {
      const appId = document.getElementById('appId').value.trim();
      const endpoint = document.getElementById('endpoint').value;
      
      if (!appId) {
        alert('Please enter an App ID');
        return;
      }
      
      // Validate appId
      if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
        alert('App ID must contain only letters, numbers, hyphens, and underscores');
        return;
      }
      
      // Disable button
      const btn = document.getElementById('sendRequest');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Sending...';
      
      // Reset timeline
      document.querySelectorAll('.timeline-item').forEach(el => {
        el.classList.remove('visible', 'active', 'success');
      });
      document.querySelectorAll('.flow-box').forEach(el => {
        el.classList.remove('active');
      });
      
      // Animate through steps
      await animateStep('step1', 'flow-worker', 
        'const url = new URL("' + BASE_URL + '/app/' + appId + endpoint + '");\\nconst appId = "' + appId + '";');
      
      await animateStep('step2', 'flow-do',
        'const container = env.VIBE_APP.getByName("' + appId + '");\\n// Deterministic: "' + appId + '" → always same DO');
      
      await animateStep('step3', 'flow-container',
        'await container.fetch(request);\\n// Container starts if not running');
      
      // Actually make the request
      try {
        const url = BASE_URL + '/app/' + appId + endpoint;
        const startTime = Date.now();
        const response = await fetch(url);
        const elapsed = Date.now() - startTime;
        const data = await response.json();
        
        // Step 4 - container processing
        document.getElementById('step4-code').textContent = 
          '// Container processed request in ' + elapsed + 'ms';
        await animateStep('step4', null);
        
        // Step 5 - response
        await animateStep('step5', null);
        document.getElementById('step5').classList.add('success');
        
        // Extract container location from response
        var containerLoc = data.containerLocation ? data.containerLocation.location : null;
        if (!containerLoc && data.container && data.container.running) {
          containerLoc = 'unknown';
        }
        
        // Show response
        const responsePanel = document.getElementById('responsePanel');
        responsePanel.style.display = 'block';
        document.getElementById('responseAppId').textContent = appId + (containerLoc ? ' (running in ' + containerLoc + ')' : '');
        const responseContent = document.getElementById('responseContent');
        responseContent.textContent = JSON.stringify(data, null, 2);
        responseContent.className = 'response-content success';
        
        // Add to accessed apps
        if (!accessedApps.has(appId)) {
          accessedApps.add(appId);
          addAppCard(appId, true, containerLoc);
        } else {
          updateAppCard(appId, true, containerLoc);
        }
        
      } catch (error) {
        document.getElementById('step4-code').textContent = '// Error: ' + error.message;
        document.getElementById('step4').classList.add('visible');
        
        const responsePanel = document.getElementById('responsePanel');
        responsePanel.style.display = 'block';
        document.getElementById('responseAppId').textContent = appId;
        const responseContent = document.getElementById('responseContent');
        responseContent.textContent = 'Error: ' + error.message;
        responseContent.className = 'response-content error';
      }
      
      // Re-enable button
      btn.disabled = false;
      btn.textContent = 'Send Request';
    }
    
    async function animateStep(stepId, flowId, code) {
      return new Promise(resolve => {
        setTimeout(() => {
          const step = document.getElementById(stepId);
          step.classList.add('visible', 'active');
          
          if (code) {
            document.getElementById(stepId + '-code').textContent = code;
          }
          
          if (flowId) {
            document.querySelectorAll('.flow-box').forEach(el => el.classList.remove('active'));
            document.getElementById(flowId).classList.add('active');
          }
          
          // Remove active from previous steps
          setTimeout(() => {
            step.classList.remove('active');
            step.classList.add('success');
          }, 400);
          
          resolve();
        }, 500);
      });
    }
    
    function addAppCard(appId, running, location) {
      const grid = document.getElementById('appsGrid');
      const card = document.createElement('div');
      card.className = 'app-card';
      card.id = 'app-' + appId;
      card.onclick = function() { quickAccess(appId); };
      var locationText = location ? ' in ' + location : '';
      card.innerHTML = '<div class="app-name">' + appId + '</div>' +
        '<div class="app-status"><span class="' + (running ? 'running' : 'stopped') + '"></span>' + 
        (running ? 'Running' + locationText : 'Stopped') + '</div>';
      grid.appendChild(card);
    }
    
    function updateAppCard(appId, running, location) {
      const card = document.getElementById('app-' + appId);
      if (card) {
        var locationText = location ? ' in ' + location : '';
        card.querySelector('.app-status').innerHTML = 
          '<span class="' + (running ? 'running' : 'stopped') + '"></span>' + 
          (running ? 'Running' + locationText : 'Stopped');
      }
    }
    
    function quickAccess(appId) {
      document.getElementById('appId').value = appId;
      document.getElementById('endpoint').value = '/_status';
      sendRequest();
    }
    
    // Handle enter key
    document.getElementById('appId').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendRequest();
    });
  </script>
</body>
</html>`;
}
