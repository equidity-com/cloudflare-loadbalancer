/**
 * Multi-App Load Balancer with WebSocket Support
 *
 * Use this if you have multiple apps on different domains
 * managed by a single worker.
 */

// ============================================
// CONFIGURATION - Add your apps here
// ============================================

const APPS = {
  'terminal.eqtrader.app': {
    primary: 'terminal-primary.equidity.app',
    backup: 'terminal-failover.equidity.app'
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
  }
  // Add more apps as needed
};

// White-label client config (*.equidity.cloud and custom domains via SaaS)
const WHITE_LABEL_CONFIG = {
  domain: 'equidity.cloud',
  primary: 'eqcore-client.primary.equidity.app',
  backup: 'eqcore-client.failover.equidity.app'
};

const TIMEOUT = 5000;
const RETRIES = 1;

// ============================================
// DO NOT MODIFY BELOW THIS LINE
// ============================================

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function tryServer(server, request, originalHost) {
  const url = new URL(request.url);
  const targetUrl = `https://${server}${url.pathname}${url.search}`;

  // Clone headers and add X-Forwarded-Host for tenant detection
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', originalHost);
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

  for (let i = 0; i <= RETRIES; i++) {
    try {
      const response = await fetchWithTimeout(
        targetUrl,
        {
          method: request.method,
          headers: headers,
          body: request.body,
          redirect: 'manual'
        },
        TIMEOUT
      );

      if (response.status < 500) {
        return response;
      }
    } catch (e) {
      // Continue to retry or next server
    }
  }

  return null;
}

async function handleWebSocket(request, config, originalHost) {
  const url = new URL(request.url);

  // Clone headers and add X-Forwarded-Host for tenant detection
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', originalHost);
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

  // Try primary WebSocket server
  const primaryUrl = `https://${config.primary}${url.pathname}${url.search}`;
  try {
    const response = await fetch(primaryUrl, {
      headers: headers,
      body: request.body
    });
    if (response.status === 101) {
      return response;
    }
  } catch (e) {
    // Primary failed, try backup
  }

  // Try backup WebSocket server
  const backupUrl = `https://${config.backup}${url.pathname}${url.search}`;
  return fetch(backupUrl, {
    headers: headers,
    body: request.body
  });
}

// Get config for hostname (supports exact match and wildcard)
function getConfig(host) {
  // Check exact match first
  if (APPS[host]) {
    return APPS[host];
  }

  // Check if it's a white-label domain (*.equidity.cloud or custom domain via SaaS)
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

    // HTTP: Try primary server (pass original host for tenant detection)
    let response = await tryServer(config.primary, request, host);
    if (response) return response;

    // HTTP: Try backup server
    response = await tryServer(config.backup, request, host);
    if (response) return response;

    // Both servers failed
    return new Response(
      '<!DOCTYPE html><html><head><title>Service Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1><p>Please try again later.</p></body></html>',
      {
        status: 503,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
};
