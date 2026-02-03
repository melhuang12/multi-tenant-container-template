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
    
    return {
      appId,
      container: {
        status: await this.ctx.container.status(),
        port: this.defaultPort,
      },
      stats: {
        startCount: await this.ctx.storage.get("startCount") || 0,
        lastStarted: await this.ctx.storage.get("lastStarted"),
        lastStopped: await this.ctx.storage.get("lastStopped"),
        lastError: await this.ctx.storage.get("lastError"),
      },
      metadata: await this.ctx.storage.get("metadata") || {},
    };
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
    
    await this.ctx.container.stop();
    await this.ctx.container.start();
    
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
    
    // Health check endpoint for the platform itself
    if (url.pathname === "/health" || url.pathname === "/") {
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
