/**
 * Multi-App Load Balancer
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
  }
  // Add more apps as needed
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

async function tryServer(server, request) {
  const url = new URL(request.url);
  const targetUrl = `https://${server}${url.pathname}${url.search}`;

  for (let i = 0; i <= RETRIES; i++) {
    try {
      const response = await fetchWithTimeout(
        targetUrl,
        {
          method: request.method,
          headers: request.headers,
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    // Get config for this app
    const config = APPS[host];

    if (!config) {
      return new Response(
        '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>App Not Configured</h1><p>This domain is not configured in the load balancer.</p></body></html>',
        {
          status: 404,
          headers: { 'Content-Type': 'text/html' }
        }
      );
    }

    // Try primary server
    let response = await tryServer(config.primary, request);
    if (response) return response;

    // Try backup server
    response = await tryServer(config.backup, request);
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
