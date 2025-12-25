/**
 * Multi-App Load Balancer with WebSocket Support
 *
 * Use this if you have multiple apps on different domains
 * managed by a single worker.
 *
 * Features:
 * - Fast failover with health caching (instant failover after first timeout)
 * - WebSocket support with failover
 * - Multi-tenant support via X-Original-Host header
 */

// ============================================
// CONFIGURATION - Add your apps here
// ============================================

const APPS = {
  'terminal.eqtrader.app': {
    primary: 'eqtrader-terminal.primary.equidity.app',
    backup: 'eqtrader-terminal.failover.equidity.app'
  },
  'admin.eqtrader.app': {
    primary: 'admin-primary.equidity.app',
    backup: 'admin-failover.equidity.app'
  },
  'api.eqtrader.app': {
    primary: 'api-primary.equidity.app',
    backup: 'api-failover.equidity.app'
  },
  'socket.eqcore.app': {
    primary: 'eqcore-socket.primary.equidity.app',
    backup: 'eqcore-socket.failover.equidity.app'
  },
  'api.eqcore.app': {
    primary: 'eqcore-api.primary.equidity.app',
    backup: 'eqcore-api.failover.equidity.app'
  },
  'admin.eqcore.app': {
    primary: 'eqcore-admin.primary.equidity.app',
    backup: 'eqcore-admin.failover.equidity.app'
  }
  // Add more apps as needed
};

// Terminal config (*.eqtrader.app broker subdomains like acme.eqtrader.app)
const TERMINAL_CONFIG = {
  domain: 'eqtrader.app',
  primary: 'eqtrader-terminal.primary.equidity.app',
  backup: 'eqtrader-terminal.failover.equidity.app'
};

// White-label client config (*.equidity.cloud and custom domains via SaaS)
const WHITE_LABEL_CONFIG = {
  domain: 'equidity.cloud',
  primary: 'eqcore-client.primary.equidity.app',
  backup: 'eqcore-client.failover.equidity.app'
};

const TIMEOUT = 3000; // 3 seconds - fast failover
const HEALTH_CACHE_TTL = 30; // Remember server down status for 30 seconds

// ============================================
// DO NOT MODIFY BELOW THIS LINE
// ============================================

// In-memory health cache (resets on worker cold start)
const healthCache = new Map();

function isServerMarkedDown(server) {
  const cached = healthCache.get(server);
  if (!cached) return false;

  // Check if cache expired
  if (Date.now() > cached.expiry) {
    healthCache.delete(server);
    return false;
  }

  return cached.isDown;
}

function markServerDown(server) {
  healthCache.set(server, {
    isDown: true,
    expiry: Date.now() + (HEALTH_CACHE_TTL * 1000)
  });
}

function markServerUp(server) {
  healthCache.delete(server);
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();

  // Use Promise.race for more reliable timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new Error('Request timeout'));
    }, timeout);
  });

  const fetchPromise = fetch(url, {
    ...options,
    signal: controller.signal,
    cf: {
      // Cloudflare-specific options for faster connection
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  return Promise.race([fetchPromise, timeoutPromise]);
}

async function tryServer(server, request, originalHost, bodyContent = null, skipHealthCheck = false) {
  // Skip if server is marked down (instant failover)
  if (!skipHealthCheck && isServerMarkedDown(server)) {
    return null;
  }

  const url = new URL(request.url);
  const targetUrl = `https://${server}${url.pathname}${url.search}`;

  // Clone headers and add X-Original-Host for tenant detection
  // Note: Using X-Original-Host instead of X-Forwarded-Host to avoid Traefik interference
  const headers = new Headers(request.headers);
  headers.set('X-Original-Host', originalHost);

  // Forward client IP in all common headers for proxy compatibility
  // X-Client-Real-IP is a custom header that won't be overwritten by Traefik
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  if (clientIp) {
    headers.set('X-Client-Real-IP', clientIp);
    headers.set('X-Real-IP', clientIp);
    headers.set('X-Forwarded-For', clientIp);
    headers.set('CF-Connecting-IP', clientIp);
  }

  try {
    const response = await fetchWithTimeout(
      targetUrl,
      {
        method: request.method,
        headers: headers,
        body: bodyContent,
        redirect: 'manual'
      },
      TIMEOUT
    );

    // Server responded - mark as up
    markServerUp(server);

    if (response.status < 500) {
      return response;
    }

    // 5xx error - mark as down
    markServerDown(server);
    return null;

  } catch (e) {
    // Connection failed or timeout - mark as down
    markServerDown(server);
    return null;
  }
}

async function handleWebSocket(request, config, originalHost) {
  const url = new URL(request.url);

  // Clone headers and add X-Original-Host for tenant detection
  const headers = new Headers(request.headers);
  headers.set('X-Original-Host', originalHost);

  // Forward client IP in all common headers for proxy compatibility
  // X-Client-Real-IP is a custom header that won't be overwritten by Traefik
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  if (clientIp) {
    headers.set('X-Client-Real-IP', clientIp);
    headers.set('X-Real-IP', clientIp);
    headers.set('X-Forwarded-For', clientIp);
    headers.set('CF-Connecting-IP', clientIp);
  }

  // Try primary WebSocket server (skip if marked down)
  if (!isServerMarkedDown(config.primary)) {
    const primaryUrl = `https://${config.primary}${url.pathname}${url.search}`;
    try {
      const response = await fetchWithTimeout(primaryUrl, {
        headers: headers,
        body: request.body
      }, TIMEOUT);

      if (response.status === 101) {
        markServerUp(config.primary);
        return response;
      }
    } catch (e) {
      markServerDown(config.primary);
    }
  }

  // Try backup WebSocket server
  const backupUrl = `https://${config.backup}${url.pathname}${url.search}`;
  try {
    const response = await fetch(backupUrl, {
      headers: headers,
      body: request.body
    });
    markServerUp(config.backup);
    return response;
  } catch (e) {
    markServerDown(config.backup);
    throw e;
  }
}

// Get config for hostname (supports exact match and wildcard)
function getConfig(host) {
  // Check exact match first
  if (APPS[host]) {
    return APPS[host];
  }

  // Check if it's a terminal broker subdomain (*.eqtrader.app like acme.eqtrader.app)
  if (host.endsWith('.' + TERMINAL_CONFIG.domain)) {
    return TERMINAL_CONFIG;
  }

  // Check if it's a white-label client domain (*.equidity.cloud)
  if (host.endsWith('.' + WHITE_LABEL_CONFIG.domain) || host === WHITE_LABEL_CONFIG.domain) {
    return WHITE_LABEL_CONFIG;
  }

  // For Cloudflare SaaS custom hostnames, route to white-label client
  // Custom domains will be handled here (they won't match APPS)
  return WHITE_LABEL_CONFIG;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    // Get config for this app (exact match or wildcard)
    const config = getConfig(host);

    if (!config) {
      return new Response(
        '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>App Not Configured</h1><p>This domain is not configured in the load balancer.</p></body></html>',
        {
          status: 404,
          headers: { 'Content-Type': 'text/html' }
        }
      );
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleWebSocket(request, config, host);
    }

    // Clone request body for potential retry (body stream can only be read once)
    const bodyContent = request.body ? await request.arrayBuffer() : null;

    // HTTP: Try primary server (pass original host for tenant detection)
    let response = await tryServer(config.primary, request, host, bodyContent);
    if (response) return response;

    // HTTP: Try backup server
    response = await tryServer(config.backup, request, host, bodyContent);
    if (response) return response;

    // Both servers down - try primary again (in case it just came back)
    response = await tryServer(config.primary, request, host, bodyContent, true);
    if (response) return response;

    // Both servers failed
    return new Response(
      '<!DOCTYPE html><html><head><title>Service Unavailable</title></head><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;"><div style="text-align: center;"><h1>Service Temporarily Unavailable</h1><p>We are experiencing technical difficulties. Please try again in a moment.</p></div></body></html>',
      {
        status: 503,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
};
