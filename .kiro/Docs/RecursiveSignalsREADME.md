# Recursive Signals - R/Kademlia WebRTC Signaling

This document describes the implementation of recursive WebRTC signaling using R/Kademlia routing infrastructure.

## Overview

WebRTC signaling in KDHT requires forwarding signal messages through the DHT to reach nodes that aren't directly connected. The original implementation used a "fan-out" recursive approach that could generate excessive traffic. The new implementation uses proper R/Kademlia routing with deduplication, TTL enforcement, and proximity-aware forwarding.

## Architecture

### Call Flow

```
Contact.messageSignals(signals)
    │
    ├── Try sponsors first (direct connections)
    │
    └── NodeMessages.signals(key, signals, forwardingExclusions)
            │
            ├── If key === this.key → handle locally
            │
            ├── If direct connection exists → forward directly
            │
            └── NodeRecursive.initiateRecursiveSignals(key, signals, ...)
                    │
                    └── NodeRecursive.recursiveSignals(ctxData) [RPC]
                            │
                            ├── Deduplication check
                            ├── Loop detection
                            ├── Direct connection check
                            └── forwardSignalsWithAlternatePaths()
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `RequestContext` | `dht/requestContext.js` | Carries routing metadata + signals payload |
| `DedupCache` | `dht/dedupCache.js` | Prevents duplicate message processing |
| `NodeRecursive` | `dht/nodeRecursive.js` | Recursive routing logic |
| `NodeMessages` | `nodes/nodeMessages.js` | Entry point for signals RPC |

## Implementation Details

### RequestContext with Payload

The `RequestContext` class was extended to carry arbitrary payload data:

```javascript
const ctx = this.createLookupContext(targetKey);
ctx.payload = { signals, targetNameForDebugging };
```

The payload is preserved through `forward()` and `markTried()` operations and serialized/deserialized for wire transport.

### New Methods in NodeRecursive

#### `recursiveSignals(ctxData)` - RPC Handler

Handles incoming recursive signal requests:

1. Deserializes the `RequestContext`
2. Checks deduplication cache for `lookupId`
3. Checks trace path for loop detection
4. Records in dedup cache
5. Updates routing table from trace path
6. If target reached → handle signals locally
7. If direct connection exists → forward directly
8. Otherwise → forward recursively with alternate path selection

#### `forwardSignalsWithAlternatePaths(ctx, signals, ...)`

Forwards signals to the next hop, trying alternates on failure:

1. Gets closest helpers to target
2. Selects next hop using `selectProximityAware()`
3. Skips nodes without connections or already tried
4. Forwards via `recursiveSignals` RPC
5. On failure/DUPLICATE → marks node as tried, continues to next candidate

#### `initiateRecursiveSignals(key, signals, forwardingExclusions, ...)`

Entry point replacing the old `recursiveSignals`:

1. Creates `RequestContext` with signals payload
2. Adds self to dedup cache
3. Iterates through candidates using `selectProximityAware()`
4. Returns `{result, forwardingExclusions}` for backward compatibility

## Comparison: Old vs New

| Aspect | Old Implementation | New Implementation |
|--------|-------------------|-------------------|
| **Branching** | Fan-out: α contacts at each level (α³ = 27 total) | Single-path: one best candidate per hop |
| **Deduplication** | Simple array (`forwardingExclusions`) | `DedupCache` with TTL + `RequestContext.triedPaths` |
| **Loop Detection** | `forwardingExclusions.includes(name)` | `ctx.hasVisited(nodeId)` via trace path |
| **Termination** | Timeout + max tries | TTL counter decremented each hop |
| **Progress** | None - could wander | Strict XOR-distance progress required |
| **Proximity** | None | RTT-weighted scoring when enabled |
| **Alternate Paths** | Tries next in local list | Marks tried, selects next XOR-valid candidate |
| **Learning** | None | Updates routing table from trace path |

### Old Implementation (Removed)

```javascript
// NodeMessages.recursiveSignals - REMOVED
async recursiveSignals(key, signals, forwardingExclusions, expiration, targetNameForDebugging) {
  let remainingThisNode = this.constructor.alpha;
  if (Date.now() > expiration) return null;  // Timeout
  if (forwardingExclusions.length > maxTries) return {forwardingExclusions};
  
  const helpers = this.findClosestHelpers(key);
  forwardingExclusions.push(this.name);
  
  for (const contact of helpers.map(h => h.contact)) {
    if (!remainingThisNode--) break;
    // ... try each contact
  }
}
```

### New Implementation

```javascript
// NodeRecursive.initiateRecursiveSignals
async initiateRecursiveSignals(key, signals, forwardingExclusions, expiration, targetNameForDebugging) {
  const ctx = this.createLookupContext(key);
  ctx.payload = { signals, targetNameForDebugging };
  this.dedupCache.add(ctx.lookupId);
  
  while (true) {
    const nextHop = this.selectProximityAware(helpers, currentCtx);
    if (!nextHop) return { result: null, forwardingExclusions };
    
    const result = await nextHop.contact.sendRPC('recursiveSignals', forwardCtx.serialize());
    if (result?.status === 'DUPLICATE') {
      currentCtx = currentCtx.markTried(nextHop.key);
      continue;
    }
    return { result: result?.result, forwardingExclusions };
  }
}
```

## Benefits

1. **Reduced Traffic**: Single-path routing instead of fan-out reduces network load
2. **Deduplication**: Prevents processing the same signal request multiple times
3. **Guaranteed Progress**: XOR-distance progress ensures convergence
4. **Proximity Awareness**: RTT-weighted selection reduces latency
5. **Better Failure Handling**: Alternate path selection on DUPLICATE responses
6. **Routing Table Learning**: Trace path updates accelerate convergence

## Backward Compatibility

The new implementation maintains backward compatibility:

- `signals()` RPC interface unchanged
- Returns `{result, forwardingExclusions}` as before
- `forwardingExclusions` array still populated for debugging
- All existing tests pass (334 specs, 0 failures)

## Configuration

The recursive signals implementation uses the same R/Kademlia configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `defaultTTL` | 20 | Maximum hops for recursive forwarding |
| `dedupCacheSize` | 1000 | Maximum entries in dedup cache |
| `dedupCacheTTL` | 10000 | Dedup cache entry TTL (ms) |
| `proximityRoutingEnabled` | true | Enable RTT-weighted selection |
| `proximityWeight` | 0.1 | RTT influence factor |

## Files Changed

1. **`dht/requestContext.js`** - Added `payload` property
2. **`dht/nodeRecursive.js`** - Added `recursiveSignals`, `forwardSignalsWithAlternatePaths`, `initiateRecursiveSignals`
3. **`nodes/nodeMessages.js`** - Removed old `recursiveSignals`, updated `signals()` to use new implementation
