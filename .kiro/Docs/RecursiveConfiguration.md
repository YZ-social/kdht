# R/Kademlia Recursive Routing Configuration Guide

This document explains how to configure and run KDHT in R/Kademlia recursive routing mode.

## Overview

KDHT supports two routing modes:

1. **Iterative Routing** (default): The originator controls each hop of the lookup, sending queries and receiving responses directly.

2. **Recursive Routing** (R/Kademlia): Intermediate nodes forward requests on behalf of the originator, reducing round trips and enabling proximity-aware routing.

## Quick Start

### Running in Recursive Mode

```bash
# Start portal server with recursive routing
npm run start:recursive

# Start with Proximity Neighbor Selection (PNS) enabled
npm run start:recursive:pns

# Start locally (no external connection) with recursive routing
npm run start:local:recursive
```

### Running in Iterative Mode (Default)

```bash
# Standard iterative routing
npm start

# Local only
npm run start:local
```

## Configuration Options

### Node Class Static Properties

All R/Kademlia options are static properties on the `Node` class:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `recursiveRoutingEnabled` | boolean | `false` | Enable recursive routing mode |
| `proximityRoutingEnabled` | boolean | `true` | Enable RTT-weighted next-hop selection |
| `pnsEnabled` | boolean | `false` | Enable Proximity Neighbor Selection |
| `defaultTTL` | number | `20` | Maximum hops for recursive lookups |
| `dedupCacheSize` | number | `1000` | Maximum entries in deduplication cache |
| `dedupCacheTTL` | number | `10000` | Deduplication cache entry TTL (ms) |
| `proximityWeight` | number | `0.1` | RTT influence factor (0.0 - 1.0) |

### PNS-Specific Options (when pnsEnabled = true)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `pnsProbeRateLimit` | number | `10` | Max RTT probes per rate limit window |
| `pnsProbeWindowMs` | number | `60000` | Rate limit window (ms) |
| `pnsMinProbeIntervalMs` | number | `100` | Minimum time between probes (ms) |

## Browser Node Configuration

Browser nodes connecting to a recursive portal server must also be configured for recursive mode. The configuration functions are exported from the main module.

### Using nodeRecursive.html

For browser nodes that should run in recursive mode, use `nodeRecursive.html` instead of `node.html`:

```
http://localhost:3000/nodeRecursive.html
```

This page automatically calls `configureRecursive()` before creating the node.

### Manual Browser Configuration

If you're building custom browser code, import and call `configureRecursive()` before creating any nodes:

```javascript
import { WebContact, configureRecursive } from '@yz-social/kdht';

// Enable recursive mode BEFORE creating nodes
configureRecursive();

// Now create your node
const contact = await WebContact.create({name: 'my-node'});
```

### Important: Configuration Must Match

Browser nodes and server nodes should use the same routing mode. If the server runs in recursive mode but browser nodes don't call `configureRecursive()`, the browser nodes will use iterative routing while the server uses recursive routing. This can work but is suboptimal.

## Programmatic Configuration

### Using the Configuration Module

```javascript
// Node.js
import { configureRecursive, configureIterative, getConfiguration } from './scripts/configureRecursive.js';

// Browser (via main exports)
import { configureRecursive, configureIterative, getConfiguration } from '@yz-social/kdht';

// Enable recursive mode with defaults
configureRecursive();

// Enable recursive mode with custom options
configureRecursive({
  pnsEnabled: true,
  defaultTTL: 15,
  proximityWeight: 0.2,
});

// Restore iterative mode
configureIterative();

// Check current configuration
console.log(getConfiguration());
```

### Manual Configuration

```javascript
import { Node } from '@yz-social/kdht';

// Enable full recursive mode
Node.recursiveRoutingEnabled = true;
Node.proximityRoutingEnabled = true;
Node.pnsEnabled = false;  // Optional

// Tune parameters
Node.defaultTTL = 20;
Node.dedupCacheSize = 1000;
Node.dedupCacheTTL = 10000;
Node.proximityWeight = 0.1;
```

## Command Line Options

The `portalRecursive.js` script accepts these R/Kademlia-specific options:

```bash
node scripts/portalRecursive.js [options]

R/Kademlia Options:
  --pns              Enable Proximity Neighbor Selection (default: false)
  --ttl <number>     Maximum hops for recursive lookups (default: 20)
  --weight <number>  RTT influence factor 0-1 (default: 0.1)

Standard Portal Options:
  --nPortals, -p     Number of portal nodes (default: CPU cores - 1)
  --baseURL          Base URL of portal server (default: http://localhost:3000/kdht)
  --externalBaseURL  External portal to connect to
  --info, -i         Enable info logging (default: true)
  --verbose, -v      Enable verbose logging (default: false)
```

### Examples

```bash
# Basic recursive mode
node scripts/portalRecursive.js

# With PNS and custom TTL
node scripts/portalRecursive.js --pns --ttl 15

# Higher proximity weight (prefer faster nodes more)
node scripts/portalRecursive.js --weight 0.3

# Connect to external network
node scripts/portalRecursive.js --externalBaseURL https://ki1r0y.com/kdht

# Verbose logging for debugging
node scripts/portalRecursive.js --verbose
```

## What Changes in Recursive Mode

### Lookup Operations

| Operation | Iterative Mode | Recursive Mode |
|-----------|---------------|----------------|
| `locateNodes()` | Uses `iterate()` | Uses `recursiveLocateNodes()` |
| `locateValue()` | Uses `iterate()` | Uses `recursiveLocateValue()` |
| `storeValue()` | Uses iterative `locateNodes()` | Uses recursive `locateNodes()` |
| `join()` | Uses iterative `locateNodes()` | Uses recursive `locateNodes()` |

### Signaling

WebRTC signaling always uses the R/Kademlia recursive infrastructure via `initiateRecursiveSignals()`, regardless of the `recursiveRoutingEnabled` setting. This provides:

- Deduplication via `DedupCache`
- TTL-based termination
- Proximity-aware forwarding
- Alternate path selection on DUPLICATE responses

### New RPC Methods

Recursive mode adds these RPC handlers:

| Method | Purpose |
|--------|---------|
| `recursiveFindNodes` | Recursive node lookup |
| `recursiveFindValue` | Recursive value lookup |
| `recursiveSignals` | Recursive WebRTC signaling |

## Performance Considerations

### When to Use Recursive Mode

**Advantages:**
- Fewer round trips for lookups (O(log n) vs O(log n × α))
- Better latency in high-latency networks
- Proximity-aware routing reduces overall latency
- Intermediate nodes learn from trace paths

**Disadvantages:**
- More complex failure handling
- Deduplication cache memory overhead
- Potential for amplification if misconfigured

### Tuning Guidelines

| Scenario | Recommended Settings |
|----------|---------------------|
| Low-latency LAN | `recursiveRoutingEnabled: false` (iterative is fine) |
| High-latency WAN | `recursiveRoutingEnabled: true`, `proximityWeight: 0.2` |
| Stable network | `pnsEnabled: true` for optimized bucket ordering |
| High churn | `pnsEnabled: false`, higher `dedupCacheTTL` |
| Large network | Increase `dedupCacheSize` proportionally |

### TTL Guidelines

- **Small networks (< 100 nodes)**: TTL of 10-15 is sufficient
- **Medium networks (100-1000 nodes)**: TTL of 15-20
- **Large networks (> 1000 nodes)**: TTL of 20-30

The TTL should be at least `log₂(network_size)` to ensure reachability.

## Backward Compatibility

- With `recursiveRoutingEnabled = false`, behavior is identical to pre-R/Kademlia
- All existing tests pass in both modes
- Nodes can interoperate (iterative nodes can communicate with recursive nodes)
- The `recursiveFindNodes` and `recursiveFindValue` RPCs are only called when recursive mode is enabled

## Troubleshooting

### Lookups Failing

1. Check TTL is sufficient for network size
2. Verify dedup cache isn't evicting too quickly
3. Enable verbose logging: `--verbose`

### High Latency

1. Increase `proximityWeight` to prefer faster nodes
2. Enable PNS for bucket optimization
3. Check network connectivity

### Memory Usage

1. Reduce `dedupCacheSize` if memory constrained
2. Reduce `dedupCacheTTL` for faster eviction
3. Disable PNS if not needed

## Files Reference

| File | Purpose |
|------|---------|
| `scripts/configureRecursive.js` | Configuration helper module |
| `scripts/portalRecursive.js` | Portal server with recursive mode |
| `nodeRecursive.html` | Browser node page with recursive mode |
| `dht/nodeRecursive.js` | Recursive routing implementation |
| `dht/requestContext.js` | Request context for source routing |
| `dht/dedupCache.js` | Message deduplication cache |
| `nodes/node.js` | Node class with configuration options |
