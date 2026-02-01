# Design Document: R/Kademlia Conformance

## Overview

This design specifies minimal, surgical changes to align the existing KDHT codebase with R/Kademlia recommendations. The approach preserves the working iterative routing while adding optional recursive routing capabilities, source routing metadata, message deduplication, and proximity optimizations.

### Design Philosophy

1. **Additive Changes**: New capabilities are added alongside existing code, not replacing it
2. **Configuration-Driven**: All new features are configurable with sensible defaults
3. **Backward Compatible**: Existing tests pass without modification
4. **Minimal Footprint**: Only change what's necessary for conformance

### Gap Analysis Summary

| R/Kademlia Requirement | Current Status | Change Needed |
|------------------------|----------------|---------------|
| Recursive Routing | ❌ Iterative only | Add recursive mode |
| Source Routing | ❌ Not present | Add trace metadata |
| Message Deduplication | ❌ Not present | Add dedup cache |
| Proximity Routing (PR) | ❌ Not present | Add RTT tracking |
| PNS | ❌ Not present | Add optional ranking |
| T0: Join self-lookup | ✅ Already done | Verify only |
| T1: Bucket refresh | ✅ Already done | Verify only |
| T2: Liveness checks | ✅ Already done | Verify only |
| XOR-distance progress | ✅ Already done | Verify only |

## Architecture

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Node                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NodeProbe.iterate() - ITERATIVE routing                 ││
│  │   - Originator sends queries to closest known nodes     ││
│  │   - Originator receives responses directly              ││
│  │   - Originator controls each hop                        ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NodeMessages - RPC handlers                             ││
│  │   - ping, store, findNodes, findValue, signals          ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ KBucket - Routing table buckets                         ││
│  │   - k contacts per bucket                               ││
│  │   - Liveness-based eviction                             ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture (with R/Kademlia additions)

```
┌─────────────────────────────────────────────────────────────┐
│                         Node                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NodeProbe.iterate() - ITERATIVE routing (unchanged)     ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NEW: NodeRecursive - RECURSIVE routing                  ││
│  │   - recursiveFindNodes(targetKey, ctx)                  ││
│  │   - Intermediate nodes forward requests                 ││
│  │   - Source routing via trace path                       ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NodeMessages - RPC handlers (extended)                  ││
│  │   - NEW: recursiveFindNodes, recursiveFindValue         ││
│  │   - Deduplication check on entry                        ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ NEW: DedupCache - Message deduplication                 ││
│  │   - lookup_id → {firstSeen, forwarded}                  ││
│  │   - TTL-based eviction                                  ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Contact (extended)                                      ││
│  │   - NEW: rtt property for proximity                     ││
│  │   - RTT measured during normal RPCs                     ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Helper (extended)                                       ││
│  │   - NEW: proximityScore() for PR selection              ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. RequestContext (New Data Structure)

Carries source routing metadata through recursive lookups.

```javascript
// dht/requestContext.js (NEW FILE)
class RequestContext {
  constructor({
    lookupId,      // Unique identifier for this lookup
    originId,      // Node ID that initiated the lookup
    targetId,      // Key being looked up
    ttl,           // Remaining hops allowed
    tracePath,     // Array of node IDs visited
  }) {
    this.lookupId = lookupId;
    this.originId = originId;
    this.targetId = targetId;
    this.ttl = ttl;
    this.tracePath = tracePath || [];
  }
  
  // Create a new context for forwarding
  forward(nodeId) {
    return new RequestContext({
      lookupId: this.lookupId,
      originId: this.originId,
      targetId: this.targetId,
      ttl: this.ttl - 1,
      tracePath: [...this.tracePath, nodeId],
    });
  }
  
  // Check if node is in trace path (loop detection)
  hasVisited(nodeId) {
    return this.tracePath.includes(nodeId);
  }
  
  // Serialize for wire transport
  serialize() {
    return {
      lookupId: this.lookupId,
      originId: String(this.originId),
      targetId: String(this.targetId),
      ttl: this.ttl,
      tracePath: this.tracePath.map(String),
    };
  }
  
  // Deserialize from wire transport
  static deserialize(data) {
    return new RequestContext({
      lookupId: data.lookupId,
      originId: BigInt(data.originId),
      targetId: BigInt(data.targetId),
      ttl: data.ttl,
      tracePath: data.tracePath.map(BigInt),
    });
  }
}
```

### 2. DedupCache (New Component)

Prevents duplicate processing of recursive lookups.

```javascript
// dht/dedupCache.js (NEW FILE)
class DedupCache {
  constructor(maxSize = 1000, ttlMs = 10000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // lookupId → {firstSeen, forwarded}
  }
  
  // Check if lookup was already seen
  has(lookupId) {
    const entry = this.cache.get(lookupId);
    if (!entry) return false;
    if (Date.now() - entry.firstSeen > this.ttlMs) {
      this.cache.delete(lookupId);
      return false;
    }
    return true;
  }
  
  // Record a lookup as seen
  add(lookupId) {
    this.evictStale();
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(lookupId, {
      firstSeen: Date.now(),
      forwarded: false,
    });
  }
  
  // Mark lookup as forwarded
  markForwarded(lookupId) {
    const entry = this.cache.get(lookupId);
    if (entry) entry.forwarded = true;
  }
  
  // Remove stale entries
  evictStale() {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.firstSeen > this.ttlMs) {
        this.cache.delete(id);
      }
    }
  }
}
```

### 3. NodeRecursive (New Mixin in Inheritance Chain)

Adds recursive routing capability.

```javascript
// dht/nodeRecursive.js (NEW FILE)
// Insert between NodeMessages and NodeProbe in inheritance chain

class NodeRecursive extends NodeMessages {
  // Configuration
  static recursiveRoutingEnabled = false; // Default: use iterative
  static proximityRoutingEnabled = true;  // Default: enabled when recursive
  static pnsEnabled = false;              // Default: disabled
  static defaultTTL = 20;                 // Max hops
  static dedupCacheSize = 1000;
  static dedupCacheTTL = 10000;           // 10 seconds
  static proximityWeight = 0.1;           // RTT influence factor
  
  dedupCache = new DedupCache(
    this.constructor.dedupCacheSize,
    this.constructor.dedupCacheTTL
  );
  
  // RPC handler for recursive FIND_NODE
  async recursiveFindNodes(ctx) {
    // Deserialize context
    ctx = RequestContext.deserialize(ctx);
    
    // Deduplication check
    if (this.dedupCache.has(ctx.lookupId)) {
      return { status: 'DUPLICATE', tracePath: ctx.tracePath };
    }
    
    // Loop detection
    if (ctx.hasVisited(this.key)) {
      return { status: 'DUPLICATE', tracePath: ctx.tracePath };
    }
    
    // Record in dedup cache
    this.dedupCache.add(ctx.lookupId);
    
    // Update routing table from trace path
    this.updateFromTracePath(ctx.tracePath);
    
    // Check if we are the target
    if (this.key === ctx.targetId) {
      return {
        status: 'FOUND',
        nodes: this.findClosestHelpers(ctx.targetId),
        tracePath: ctx.tracePath,
      };
    }
    
    // Check TTL
    if (ctx.ttl <= 0) {
      return {
        status: 'TTL_EXPIRED',
        nodes: this.findClosestHelpers(ctx.targetId),
        tracePath: ctx.tracePath,
      };
    }
    
    // Select next hop with proximity awareness
    const candidates = this.findClosestHelpers(ctx.targetId);
    const nextHop = this.selectProximityAware(candidates, ctx);
    
    if (!nextHop) {
      return {
        status: 'NO_CLOSER',
        nodes: candidates,
        tracePath: ctx.tracePath,
      };
    }
    
    // Forward recursively
    const forwardCtx = ctx.forward(this.key);
    this.dedupCache.markForwarded(ctx.lookupId);
    
    const result = await nextHop.contact.sendRPC(
      'recursiveFindNodes',
      forwardCtx.serialize()
    );
    
    // Handle forwarding failure
    if (!result) {
      return {
        status: 'FORWARD_FAILED',
        nodes: candidates,
        tracePath: ctx.tracePath,
      };
    }
    
    return result;
  }
  
  // Select next hop considering proximity
  selectProximityAware(candidates, ctx) {
    // Filter out visited nodes and self
    const valid = candidates.filter(h => 
      h.key !== this.key && 
      !ctx.hasVisited(h.key) &&
      h.distance < this.distance(ctx.targetId) // Must make progress
    );
    
    if (valid.length === 0) return null;
    
    if (!this.constructor.proximityRoutingEnabled) {
      return valid[0]; // Just use closest by XOR
    }
    
    // Score by XOR distance with RTT bias
    const weight = this.constructor.proximityWeight;
    let best = null;
    let bestScore = Infinity;
    
    for (const h of valid) {
      const rtt = h.contact.rtt || 1000; // Default high RTT if unknown
      const score = Number(h.distance) * (1 + weight * rtt / 1000);
      if (score < bestScore) {
        bestScore = score;
        best = h;
      }
    }
    
    return best;
  }
  
  // Learn from trace path
  updateFromTracePath(tracePath) {
    // Nodes in trace path are known to be alive
    // This accelerates routing table convergence
    for (const nodeId of tracePath) {
      if (nodeId !== this.key) {
        const contact = this.findContactByKey(nodeId);
        if (contact) {
          this.addToRoutingTable(contact);
        }
      }
    }
  }
}
```

### 4. Contact Extensions

Add RTT tracking to Contact class.

```javascript
// Additions to transports/contact.js

class Contact {
  // ... existing code ...
  
  // NEW: RTT tracking
  rtt = null;           // Last measured RTT in ms
  rttUpdatedAt = null;  // Timestamp of last RTT measurement
  
  // NEW: Update RTT after successful RPC
  updateRTT(rttMs) {
    this.rtt = rttMs;
    this.rttUpdatedAt = Date.now();
  }
  
  // Modify sendRPC to measure RTT
  async sendRPC(method, ...rest) {
    // ... existing setup code ...
    
    const start = Date.now();
    return this.transmitRPC(...message)
      .then(result => {
        if (result !== null) {
          // Successful RPC - update RTT
          this.updateRTT(Date.now() - start);
        }
        if (!sender.isRunning) return null;
        return result;
      })
      .finally(() => Node.noteStatistic(start, 'rpc'));
  }
}
```

### 5. Configuration Interface

Expose R/Kademlia configuration options.

```javascript
// Additions to Node class

class Node extends NodeProbe {
  // R/Kademlia configuration (class-level defaults)
  static recursiveRoutingEnabled = false;
  static proximityRoutingEnabled = true;
  static pnsEnabled = false;
  static defaultTTL = 20;
  static dedupCacheSize = 1000;
  static dedupCacheTTL = 10000;
  static proximityWeight = 0.1;
  
  // Instance-level configuration via constructor
  constructor({
    recursiveRoutingEnabled = Node.recursiveRoutingEnabled,
    proximityRoutingEnabled = Node.proximityRoutingEnabled,
    pnsEnabled = Node.pnsEnabled,
    ...rest
  }) {
    super(rest);
    this.recursiveRoutingEnabled = recursiveRoutingEnabled;
    this.proximityRoutingEnabled = proximityRoutingEnabled;
    this.pnsEnabled = pnsEnabled;
  }
}
```

## Data Models

### RequestContext

| Field | Type | Description |
|-------|------|-------------|
| lookupId | string | UUID v4 unique identifier |
| originId | BigInt | Node key that initiated lookup |
| targetId | BigInt | Key being looked up |
| ttl | number | Remaining hops allowed |
| tracePath | BigInt[] | Ordered list of visited node keys |

### DedupCacheEntry

| Field | Type | Description |
|-------|------|-------------|
| firstSeen | number | Timestamp when lookup was first seen |
| forwarded | boolean | Whether lookup was forwarded |

### RecursiveResult

| Field | Type | Description |
|-------|------|-------------|
| status | string | 'FOUND', 'DUPLICATE', 'TTL_EXPIRED', 'NO_CLOSER', 'FORWARD_FAILED' |
| nodes | Helper[] | Closest known nodes (when applicable) |
| tracePath | BigInt[] | Path taken by the request |
| value | any | Value found (for recursiveFindValue) |

### Contact RTT Extension

| Field | Type | Description |
|-------|------|-------------|
| rtt | number | Last measured RTT in milliseconds |
| rttUpdatedAt | number | Timestamp of last RTT measurement |



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: RequestContext Round-Trip Serialization

*For any* valid RequestContext object, serializing it and then deserializing the result SHALL produce an equivalent RequestContext with identical lookupId, originId, targetId, ttl, and tracePath values.

**Validates: Requirements 2.5, 2.6**

### Property 2: Trace Path Growth on Forward

*For any* recursive lookup forwarding operation, the trace path in the forwarded context SHALL contain exactly one more entry than the original, and that entry SHALL be the forwarding node's key.

**Validates: Requirements 2.2, 4.2**

### Property 3: TTL Enforcement

*For any* recursive lookup request with TTL equal to zero, the receiving node SHALL NOT forward the request and SHALL return its closest known nodes.

**Validates: Requirements 2.4, 4.3**

### Property 4: Deduplication Cache TTL Eviction

*For any* entry added to the DedupCache, after the configured TTL has elapsed, the cache SHALL report that the entry does not exist (has() returns false).

**Validates: Requirements 3.1**

### Property 5: Duplicate Detection

*For any* recursive lookup request where either (a) the lookup_id is already in the dedup cache, or (b) the receiving node's key is in the trace path, the node SHALL respond with DUPLICATE status and SHALL NOT silently drop the request.

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 6: Alternate Path Selection on Duplicate

*For any* DUPLICATE response received during recursive routing, the upstream node SHALL attempt to forward to an alternate XOR-valid next hop that was not previously tried.

**Validates: Requirements 3.5**

### Property 7: XOR-Distance Progress

*For any* recursive forwarding decision, the selected next hop's XOR distance to the target SHALL be strictly less than the current node's XOR distance to the target.

**Validates: Requirements 4.5, 10.1**

### Property 8: RTT Measurement During RPC

*For any* successful RPC call (non-null result), the Contact's rtt property SHALL be updated with the measured round-trip time, and no separate probing traffic SHALL be generated for this measurement.

**Validates: Requirements 5.1, 5.3**

### Property 9: Proximity-Aware Selection Preserves Correctness

*For any* next-hop selection with Proximity Routing enabled, if a candidate with higher RTT but closer XOR distance exists alongside a candidate with lower RTT but farther XOR distance, the system SHALL select a candidate that makes XOR progress (never selecting an XOR-farther node regardless of RTT).

**Validates: Requirements 5.2, 5.4**

### Property 10: PNS Bucket Ordering

*For any* KBucket with PNS enabled containing multiple contacts, the contacts SHALL be ordered by RTT (lowest first) within the constraint that all contacts remain XOR-valid for that bucket's prefix range.

**Validates: Requirements 6.1**

### Property 11: PNS Rate Limiting

*For any* time window, the number of RTT probes performed for PNS reevaluation SHALL NOT exceed the configured rate limit.

**Validates: Requirements 6.3**

### Property 12: Bucket Structure Preservation

*For any* operation (including PNS reordering), the bucket index assignment based on XOR prefix SHALL remain unchanged, buckets SHALL NOT be merged or reshaped, and each bucket SHALL only contain contacts whose keys fall within the correct XOR prefix range.

**Validates: Requirements 6.4, 10.2, 10.3**

### Property 13: No XOR-Worse Replacement

*For any* bucket modification operation, a contact that is XOR-closer to the bucket's range SHALL NOT be replaced by a contact that is XOR-farther, regardless of proximity metrics.

**Validates: Requirements 6.5, 10.4**

### Property 14: Join Self-Lookup and Seeding

*For any* node join operation, the node SHALL perform a lookup for its own key, and after completion, the routing table SHALL contain contacts discovered during that lookup.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 15: Refresh Behavior

*For any* bucket refresh operation, the system SHALL perform a lookup for a random key within the bucket's XOR range, and contacts discovered during the lookup SHALL be candidates for addition to the routing table.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 16: Liveness-Based Eviction

*For any* bucket at capacity when a new contact arrives, if the head contact is unresponsive (no connection), it SHALL be evicted; if the head contact is responsive, the new contact SHALL NOT replace it regardless of proximity.

**Validates: Requirements 9.1, 9.2, 9.3, 9.4**

### Property 17: Backward Compatibility

*For any* configuration where recursive routing features are disabled, the system's behavior for locateNodes, locateValue, storeValue, and join operations SHALL be identical to the pre-modification implementation.

**Validates: Requirements 12.1**

## Error Handling

### Deduplication Errors

| Condition | Response |
|-----------|----------|
| Duplicate lookup_id detected | Return `{status: 'DUPLICATE', tracePath}` |
| Loop detected (self in trace) | Return `{status: 'DUPLICATE', tracePath}` |
| Dedup cache full | Evict oldest entry, then add new |

### Forwarding Errors

| Condition | Response |
|-----------|----------|
| TTL exhausted | Return `{status: 'TTL_EXPIRED', nodes, tracePath}` |
| No XOR-closer peer available | Return `{status: 'NO_CLOSER', nodes, tracePath}` |
| Forward RPC fails | Return `{status: 'FORWARD_FAILED', nodes, tracePath}` |
| All alternate paths exhausted | Return best known nodes |

### RTT Measurement Errors

| Condition | Response |
|-----------|----------|
| RPC timeout | Do not update RTT (keep previous value) |
| RPC returns null | Do not update RTT |
| First RPC to contact | Set RTT to measured value |

### Configuration Errors

| Condition | Response |
|-----------|----------|
| Invalid TTL (< 1) | Use default TTL |
| Invalid cache size (< 1) | Use default cache size |
| Invalid proximity weight (< 0) | Use 0 (disable proximity bias) |

## Testing Strategy

### Dual Testing Approach

This feature requires both unit tests and property-based tests:

- **Unit tests**: Verify specific examples, edge cases, configuration defaults, and integration with existing code
- **Property tests**: Verify universal properties across randomly generated inputs

### Property-Based Testing Configuration

- **Library**: fast-check (JavaScript property-based testing library)
- **Minimum iterations**: 100 per property test
- **Tag format**: `Feature: rdht-conformance, Property N: <property_text>`

### Test Categories

#### 1. RequestContext Tests
- Unit: Serialization of specific contexts
- Property: Round-trip serialization (Property 1)

#### 2. DedupCache Tests
- Unit: Basic add/has/evict operations
- Property: TTL eviction (Property 4)
- Property: Size limit enforcement

#### 3. Recursive Routing Tests
- Unit: Single-hop forwarding
- Property: Trace path growth (Property 2)
- Property: TTL enforcement (Property 3)
- Property: XOR progress (Property 7)

#### 4. Duplicate Handling Tests
- Unit: Specific duplicate scenarios
- Property: Duplicate detection (Property 5)
- Property: Alternate path selection (Property 6)

#### 5. Proximity Routing Tests
- Unit: RTT measurement timing
- Property: RTT measurement (Property 8)
- Property: Selection correctness (Property 9)

#### 6. PNS Tests (when enabled)
- Unit: Bucket reordering
- Property: Ordering (Property 10)
- Property: Rate limiting (Property 11)

#### 7. Safety Invariant Tests
- Property: Bucket structure (Property 12)
- Property: No XOR-worse replacement (Property 13)

#### 8. Existing Behavior Tests
- Unit: Verify join self-lookup (Property 14)
- Unit: Verify refresh behavior (Property 15)
- Unit: Verify liveness eviction (Property 16)
- Property: Backward compatibility (Property 17)

### Test File Organization

```
spec/
├── rdht/
│   ├── requestContextSpec.js    # RequestContext unit + property tests
│   ├── dedupCacheSpec.js        # DedupCache unit + property tests
│   ├── recursiveRoutingSpec.js  # Recursive routing property tests
│   ├── proximityRoutingSpec.js  # PR unit + property tests
│   ├── pnsSpec.js               # PNS unit + property tests
│   └── backwardCompatSpec.js    # Backward compatibility tests
```

### Generators for Property Tests

```javascript
// Example generators for fast-check
const arbNodeKey = fc.bigInt(0n, 2n ** 128n - 1n);
const arbLookupId = fc.uuid();
const arbTTL = fc.integer({ min: 0, max: 50 });
const arbTracePath = fc.array(arbNodeKey, { maxLength: 20 });
const arbRTT = fc.integer({ min: 1, max: 5000 });

const arbRequestContext = fc.record({
  lookupId: arbLookupId,
  originId: arbNodeKey,
  targetId: arbNodeKey,
  ttl: arbTTL,
  tracePath: arbTracePath,
});
```
