# Equidity Load Balancer

Cloudflare Worker for automatic failover and load balancing between servers.

## Features

- Automatic failover when primary server is down
- Optional weighted load balancing for heavy traffic
- Configurable timeout and retry settings
- Zero downtime during server failures
- Free to use with Cloudflare Workers

## Setup Instructions

### Step 1: Create Worker

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Click **Workers & Pages**
3. Click **Create** → **Start with Hello World!**
4. Name your worker (e.g., `my-app-loadbalancer`)
5. Click **Deploy**

### Step 2: Add Code

1. Click **Edit Code**
2. Delete default code
3. Copy contents of `worker.js` (for failover) or `examples/load-balancer.js` (for weighted load balancing)
4. Update `CONFIG` section with your domains
5. Click **Save and Deploy**

### Step 3: DNS Setup

In Cloudflare DNS for your domain:

| Type  | Name | Content   | Proxy       |
| ----- | ---- | --------- | ----------- |
| A     | @    | 192.0.2.1 | Proxied     |
| A     | www  | 192.0.2.1 | Proxied     |

> Note: The IP doesn't matter as the worker intercepts all traffic.

For your server subdomains (DNS only, not proxied):

| Type  | Name    | Content          | Proxy     |
| ----- | ------- | ---------------- | --------- |
| A     | primary | YOUR_PRIMARY_IP  | DNS only  |
| A     | backup  | YOUR_BACKUP_IP   | DNS only  |

### Step 4: Add Route

1. Go to your worker → **Settings** → **Domains & Routes**
2. Click **Add Route**
3. Enter:
   - Route: `yourdomain.com/*`
   - Zone: Select your domain
4. Select **Fail open**
5. Click **Add**

### Step 5: Test

1. Visit your domain - should load from primary
2. Stop primary server
3. Visit again - should load from backup

## Available Scripts

| File | Description |
|------|-------------|
| `worker.js` | Simple failover (primary → backup) |
| `examples/load-balancer.js` | Weighted load balancing + failover |
| `examples/multi-app-config.js` | Multiple apps in one worker |

## Configuration Options

### worker.js (Failover Only)

```javascript
const CONFIG = {
  PRIMARY: 'yourapp-primary.equidity.app',
  BACKUP: 'yourapp-failover.equidity.app',
  TIMEOUT: 5000,
  RETRIES: 1
};
```

### load-balancer.js (Weighted)

```javascript
const CONFIG = {
  MODE: 'weighted', // "failover", "round-robin", or "weighted"
  SERVERS: [
    { name: 'primary', url: 'yourapp-primary.equidity.app', weight: 70 },
    { name: 'backup', url: 'yourapp-failover.equidity.app', weight: 30 }
  ],
  TIMEOUT: 5000,
  RETRIES: 1
};
```

## Load Balancing Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `failover` | All traffic to primary, backup only on failure | Low traffic, DR only |
| `round-robin` | Alternates between servers | Equal server capacity |
| `weighted` | Distributes by percentage | Different server capacities |

## How It Works

### Failover Mode
```
All Traffic → Primary Server
                   ↓
             Primary down?
                   ↓
             Yes → Backup Server
```

### Weighted Mode (70/30)
```
Traffic → 70% Primary Server
        → 30% Backup Server
        → Automatic failover if one fails
```

## Support

Contact: support@equidity.com
