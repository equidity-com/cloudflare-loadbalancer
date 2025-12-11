/**
 * Health-Aware Load Balancer with Failover
 *
 * Smart features:
 * - Tracks server response times
 * - Auto-adjusts weights based on performance
 * - Circuit breaker for failing servers
 * - Automatic recovery detection
 *
 * Modes:
 * - "failover": All traffic to primary, backup only if primary fails
 * - "weighted": Distributes by weight percentage
 * - "smart": Auto-adjusts based on server health (recommended)
 */

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Load balancing mode: "failover", "weighted", or "smart"
  MODE: 'smart',

  // Servers
  SERVERS: [
    {
      name: 'primary',
      url: 'yourapp-primary.equidity.app',
      weight: 80 // Base weight (used in weighted mode)
    },
    {
      name: 'backup',
      url: 'yourapp-failover.equidity.app',
      weight: 20 // Base weight (used in weighted mode)
    }
  ],

  // Timeout in milliseconds
  TIMEOUT: 5000,

  // Retry count
  RETRIES: 1,

  // Smart mode settings
  SMART: {
    // Response time threshold (ms) - server considered slow above this
    SLOW_THRESHOLD: 2000,

    // Number of failures before circuit breaker opens
    FAILURE_THRESHOLD: 3,

    // Time to wait before retrying failed server (ms)
    CIRCUIT_RESET_TIME: 30000,

    // Minimum weight (never goes below this)
    MIN_WEIGHT: 10,

    // Maximum weight (never goes above this)
    MAX_WEIGHT: 90
  }
};

// ============================================
// HEALTH TRACKING (In-memory, resets on restart)
// ============================================

const serverHealth = new Map();

function getServerHealth(serverName) {
  if (!serverHealth.has(serverName)) {
    serverHealth.set(serverName, {
      failures: 0,
      lastFailure: 0,
      avgResponseTime: 0,
      requestCount: 0,
      circuitOpen: false
    });
  }
  return serverHealth.get(serverName);
}

function recordSuccess(serverName, responseTime) {
  const health = getServerHealth(serverName);

  // Update average response time (rolling average)
  health.requestCount++;
  health.avgResponseTime = health.avgResponseTime +
    (responseTime - health.avgResponseTime) / Math.min(health.requestCount, 100);

  // Reset failures on success
  health.failures = 0;
  health.circuitOpen = false;
}

function recordFailure(serverName) {
  const health = getServerHealth(serverName);
  health.failures++;
  health.lastFailure = Date.now();

  // Open circuit breaker if too many failures
  if (health.failures >= CONFIG.SMART.FAILURE_THRESHOLD) {
    health.circuitOpen = true;
  }
}

function isCircuitOpen(serverName) {
  const health = getServerHealth(serverName);

  if (!health.circuitOpen) return false;

  // Check if enough time has passed to retry
  const timeSinceFailure = Date.now() - health.lastFailure;
  if (timeSinceFailure >= CONFIG.SMART.CIRCUIT_RESET_TIME) {
    // Half-open: allow one request to test
    health.circuitOpen = false;
    health.failures = CONFIG.SMART.FAILURE_THRESHOLD - 1; // Will reopen on next failure
    return false;
  }

  return true;
}

function calculateSmartWeight(server) {
  const health = getServerHealth(server.name);
  let weight = server.weight;

  // Reduce weight if server is slow
  if (health.avgResponseTime > CONFIG.SMART.SLOW_THRESHOLD) {
    const slowFactor = health.avgResponseTime / CONFIG.SMART.SLOW_THRESHOLD;
    weight = weight / slowFactor;
  }

  // Reduce weight based on recent failures
  if (health.failures > 0) {
    weight = weight / (health.failures + 1);
  }

  // Circuit is open - minimal weight (only for recovery testing)
  if (health.circuitOpen) {
    weight = CONFIG.SMART.MIN_WEIGHT;
  }

  // Clamp weight to min/max
  return Math.max(CONFIG.SMART.MIN_WEIGHT, Math.min(CONFIG.SMART.MAX_WEIGHT, weight));
}

// ============================================
// CORE LOGIC
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
  const targetUrl = `https://${server.url}${url.pathname}${url.search}`;
  const startTime = Date.now();

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

      if (response.status < 500) {
        // Record success with response time
        const responseTime = Date.now() - startTime;
        recordSuccess(server.name, responseTime);
        return response;
      }
    } catch (e) {
      // Continue to retry
    }
  }

  // Record failure
  recordFailure(server.name);
  return null;
}

function selectServerFailover() {
  return CONFIG.SERVERS.filter(s => !isCircuitOpen(s.name));
}

function selectServerWeighted() {
  const availableServers = CONFIG.SERVERS.filter(s => !isCircuitOpen(s.name));

  if (availableServers.length === 0) {
    // All circuits open, try anyway (last resort)
    return [...CONFIG.SERVERS];
  }

  const totalWeight = availableServers.reduce((sum, s) => sum + s.weight, 0);
  const random = Math.random() * totalWeight;

  let cumulative = 0;
  let selectedIndex = 0;

  for (let i = 0; i < availableServers.length; i++) {
    cumulative += availableServers[i].weight;
    if (random <= cumulative) {
      selectedIndex = i;
      break;
    }
  }

  const servers = [...availableServers];
  const selected = servers.splice(selectedIndex, 1)[0];
  return [selected, ...servers];
}

function selectServerSmart() {
  // Calculate dynamic weights based on health
  const serversWithHealth = CONFIG.SERVERS.map(s => ({
    ...s,
    dynamicWeight: calculateSmartWeight(s),
    circuitOpen: isCircuitOpen(s.name)
  }));

  // Filter out servers with open circuits (unless all are open)
  let availableServers = serversWithHealth.filter(s => !s.circuitOpen);

  if (availableServers.length === 0) {
    // All circuits open, try all servers (last resort)
    availableServers = serversWithHealth;
  }

  // Select based on dynamic weights
  const totalWeight = availableServers.reduce((sum, s) => sum + s.dynamicWeight, 0);
  const random = Math.random() * totalWeight;

  let cumulative = 0;
  let selectedIndex = 0;

  for (let i = 0; i < availableServers.length; i++) {
    cumulative += availableServers[i].dynamicWeight;
    if (random <= cumulative) {
      selectedIndex = i;
      break;
    }
  }

  const servers = [...availableServers];
  const selected = servers.splice(selectedIndex, 1)[0];
  return [selected, ...servers];
}

function selectServers() {
  switch (CONFIG.MODE) {
    case 'weighted':
      return selectServerWeighted();
    case 'smart':
      return selectServerSmart();
    case 'failover':
    default:
      return selectServerFailover();
  }
}

// ============================================
// MAIN HANDLER
// ============================================

export default {
  async fetch(request) {
    const servers = selectServers();

    // Try each server in order
    for (const server of servers) {
      const response = await tryServer(server, request);
      if (response) {
        // Add debug headers (remove in production if not needed)
        const newResponse = new Response(response.body, response);
        newResponse.headers.set('X-Served-By', server.name);
        newResponse.headers.set('X-LB-Mode', CONFIG.MODE);
        return newResponse;
      }
    }

    // All servers failed
    return new Response(
      '<!DOCTYPE html><html><head><title>Service Unavailable</title></head><body><h1>Service Temporarily Unavailable</h1><p>All servers are currently unavailable. Please try again later.</p></body></html>',
      {
        status: 503,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
};
