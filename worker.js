/**
 * Equidity Load Balancer Worker
 *
 * Automatic failover between primary and backup servers.
 *
 * Setup:
 * 1. Create a Cloudflare Worker
 * 2. Copy this code
 * 3. Update PRIMARY and BACKUP with your app domains
 * 4. Add route for your domain
 */

// ============================================
// CONFIGURATION - Update these for each app
// ============================================

const CONFIG = {
  // Primary server
  PRIMARY: 'yourapp-primary.equidity.app',

  // Backup server
  BACKUP: 'yourapp-failover.equidity.app',

  // Timeout in milliseconds (5 seconds)
  TIMEOUT: 5000,

  // Retry count for each server
  RETRIES: 1
};

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

  for (let i = 0; i <= CONFIG.RETRIES; i++) {
    try {
      const response = await fetchWithTimeout(
        targetUrl,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual'
        },
        CONFIG.TIMEOUT
      );

      // Return if not a server error
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
    // Try primary server
    let response = await tryServer(CONFIG.PRIMARY, request);
    if (response) return response;

    // Try backup server
    response = await tryServer(CONFIG.BACKUP, request);
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
