# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

#### Fix Recursive Routing Network Discovery and Signaling

- **What**: Fixed two bugs preventing proper network discovery in recursive routing mode
- **Why**: Browser nodes were only maintaining 1 connection despite 15 portal nodes being available. Investigation revealed:
  1. `recursiveLocateNodes` was only using `findContactByKey` which only finds existing contacts - it never created contacts for discovered nodes
  2. `contact.messageSignals()` was calling `this.host.recursiveSignals()` which doesn't exist - should be `initiateRecursiveSignals()`
- **Changes**:
  - `dht/nodeRecursive.js`: `recursiveLocateNodes` now creates contacts for discovered nodes using `ensureRemoteContact` and adds them to the routing table
  - `contacts/contact.js`: Fixed `messageSignals` to call `initiateRecursiveSignals` instead of non-existent `recursiveSignals` method
- **Testing**: Browser nodes now attempt to connect to discovered nodes (visible in ConnectionTracker logs). Connection timeouts to non-server nodes are expected - those are ephemeral browser nodes from previous tests that are no longer running.
- **Lessons Learned**:
  - In recursive routing, discovered nodes are returned as serialized data (key, distance, name) - the receiving node must create contacts from this data
  - The `name` field in serialized nodes contains the sname which can be used with `ensureRemoteContact` to create contacts
  - Method naming matters - `recursiveSignals` is the RPC handler, `initiateRecursiveSignals` is the entry point

---

#### Multi-Portal Worker Support and WebRTC Serialization Fixes

- **What**: Fixed two bugs preventing multiple portal workers from running together
- **Why**: Running multiple portal workers distributes load and improves network stability. Two bugs were preventing this:
  1. Race condition in worker bootstrap - workers could try to connect before the first worker registered
  2. WebRTC serialization error - recursive RPC methods pass context objects, not BigInt keys
- **Changes**:
  - `scripts/node.js`: Added retry logic to `fetchBootstrap` (5 retries with 2s delay), check `bootstrapName` is truthy before calling `ensureRemoteContact`
  - `contacts/webrtc.js`: Updated `serializeRequest` and `deserializeRequest` to handle recursive methods (`recursiveFindNodes`, `recursiveFindValue`, `recursiveSignals`) that pass context objects instead of BigInt keys
- **Testing**: All 11 Chromium Playwright tests pass with 3 portal workers running, including:
  - Connection stability tests (30-second stability, 100% success rate)
  - Store/retrieve operations
  - Multiple browser nodes connecting simultaneously
  - Recursive routing verification (confirms `recursiveFindNodes` RPC is used)
  - Multi-hop store/retrieve between browser nodes through portal network
- **Lessons Learned**:
  - Worker startup timing is critical - later workers must wait for earlier workers to register
  - Different RPC methods have different parameter formats - recursive methods use context objects, not keys
  - The `toString()` method on objects returns `[object Object]`, which cannot be converted to BigInt

---

#### R/Kademlia Conformance - Summary

This release adds optional R/Kademlia conformance features to KDHT, enabling recursive routing, proximity-aware peer selection, and message deduplication while maintaining full backward compatibility with existing iterative routing.

**What Changed:**
- Added `RequestContext` class for source routing metadata (lookup ID, trace path, TTL)
- Added `DedupCache` class for message deduplication with TTL-based eviction
- Added `NodeRecursive` mixin providing recursive FIND_NODE RPC handler
- Extended `Contact` class with RTT measurement during normal RPCs
- Extended `Helper` class with proximity scoring for next-hop selection
- Extended `KBucket` class with optional PNS (Proximity Neighbor Selection) reordering
- Added comprehensive property-based tests validating 17 correctness properties

**Why Changed:**
R/Kademlia is an extension to the Kademlia DHT protocol that improves lookup latency through:
1. Recursive routing - intermediate nodes forward requests, reducing round trips
2. Proximity routing - RTT-aware next-hop selection among XOR-valid candidates
3. Source routing - trace paths enable reverse routing and loop detection
4. Message deduplication - prevents amplification in recursive forwarding

These changes align KDHT with academic R/Kademlia recommendations while preserving the existing iterative routing as the default behavior.

**Configuration Options (Requirement 11):**

All options are static properties on the `Node` class:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `recursiveRoutingEnabled` | boolean | `false` | Enable recursive routing mode (iterative when false) |
| `proximityRoutingEnabled` | boolean | `true` | Enable RTT-based next-hop selection |
| `pnsEnabled` | boolean | `false` | Enable Proximity Neighbor Selection bucket reordering |
| `defaultTTL` | number | `20` | Maximum hops for recursive lookups |
| `dedupCacheSize` | number | `1000` | Maximum entries in deduplication cache |
| `dedupCacheTTL` | number | `10000` | Deduplication cache entry TTL in milliseconds |
| `proximityWeight` | number | `0.1` | RTT influence factor for proximity scoring |

PNS-specific options (when `pnsEnabled = true`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pnsProbeRateLimit` | number | `10` | Maximum RTT probes per rate limit window |
| `pnsProbeWindowMs` | number | `60000` | Rate limit window duration in milliseconds |
| `pnsMinProbeIntervalMs` | number | `100` | Minimum time between consecutive probes |

**Usage Example:**
```javascript
import { Node } from '@yz-social/kdht';

// Enable recursive routing with proximity awareness
Node.recursiveRoutingEnabled = true;
Node.proximityRoutingEnabled = true;

// Optionally enable PNS for stable networks
Node.pnsEnabled = true;

// Tune parameters as needed
Node.defaultTTL = 15;
Node.proximityWeight = 0.2;
```

**Backward Compatibility (Requirement 12):**
- All features are disabled by default except `proximityRoutingEnabled`
- With `recursiveRoutingEnabled = false`, behavior is identical to pre-modification
- All 255+ existing tests pass without modification
- New exports (`RequestContext`, `DedupCache`) are additive

**New Exports:**
```javascript
import { Node, Contact, KBucket, Helper, RequestContext, DedupCache } from '@yz-social/kdht';

// Configuration helpers (also available in browser)
import { configureRecursive, configureIterative, getConfiguration } from '@yz-social/kdht';
```

---

#### Browser Node Recursive Mode Support

- **What**: Added support for browser nodes to run in R/Kademlia recursive mode
- **Why**: Browser nodes connecting to a recursive portal server should also use recursive routing for optimal performance. Without explicit configuration, browser nodes would default to iterative mode.
- **Changes**:
  - Exported `configureRecursive`, `configureIterative`, `getConfiguration` from main `index.js`
  - Updated `scripts/configureRecursive.js` to be browser-compatible (guards against `process` being undefined)
  - Created `nodeRecursive.html` - browser node page that automatically enables recursive mode
- **Usage**:
  - Use `nodeRecursive.html` instead of `node.html` for recursive mode browser nodes
  - Or manually call `configureRecursive()` before creating nodes in custom browser code
- **Lessons Learned**:
  - Static class properties like `Node.recursiveRoutingEnabled` are set per JavaScript environment
  - Server and browser run in separate environments, so configuration must be applied in both
  - Browser nodes should match the server's routing mode for optimal performance

---

#### R/Kademlia Conformance - Task 17: Backward Compatibility Tests

- **What**: Added comprehensive backward compatibility test suite verifying that with R/Kademlia features disabled, the system behaves identically to the pre-modification implementation
- **Why**: R/Kademlia conformance changes must not break existing functionality. These tests ensure:
  - `locateNodes`, `locateValue`, `storeValue`, and `join` operations work correctly with features disabled
  - Existing test suite continues to pass without modification
  - XOR distance calculations, bucket placement, and routing table operations are unchanged
- **Changes**:
  - Created `spec/rdht/backwardCompatibilitySpec.js` with:
    - Task 17.1: Backward compatibility test suite
      - Tests for `locateNodes` behavior (iterative routing, k closest nodes, discovery)
      - Tests for `locateValue` behavior (store/retrieve, undefined for missing keys, local lookup)
      - Tests for `storeValue` behavior (k replication, multi-node storage)
      - Tests for `join` behavior (self-lookup, bucket seeding)
      - Tests for existing internal operations (bucket placement, XOR distance, Helper comparison)
    - Task 17.2: Property 17 - Backward Compatibility (validates Requirement 12.1)
      - Property test: `locateNodes` returns sorted Helpers by XOR distance
      - Property test: stored values can be retrieved from any node
      - Property test: `iterate` uses iterative routing pattern
      - Property test: `addToRoutingTable` places contacts in correct buckets
      - Property tests: XOR distance is symmetric, zero to self, satisfies triangle inequality
- **Configuration**: Tests run with all R/Kademlia features disabled (`recursiveRoutingEnabled = false`, `proximityRoutingEnabled = false`, `pnsEnabled = false`)
- **Lessons Learned**:
  - Jasmine uses `toBeDefined()` instead of Jest's `toHaveProperty()` for property existence checks
  - Network setup overhead requires reduced property test iterations (10 runs vs 100)
  - XOR metric satisfies a weaker form of triangle inequality: `d(a,c) <= d(a,b) + d(b,c)`

#### R/Kademlia Conformance - Task 16: Optional PNS Support

- **What**: Added optional Proximity Neighbor Selection (PNS) support to KBucket
- **Why**: R/Kademlia's PNS feature allows bucket entries to be ranked by RTT (proximity) within XOR-equivalent peers, optimizing lookup latency in stable networks. This is an optional feature disabled by default.
- **Changes**:
  - Extended `KBucket` class with PNS methods:
    - `reorderByProximity()` - sorts contacts by RTT (lowest first) while preserving bucket structure
    - `probeForRTT(maxProbes)` - performs rate-limited RTT probing on contacts without measurements
    - `updateProximityOrder()` - convenience method combining probing and reordering
    - `canProbe()` / `recordProbe()` - rate limiting helpers
    - `probeCount` getter - tracks probes in current window
    - `pnsEnabled` getter - reflects node configuration
  - Added PNS rate limiting configuration:
    - `pnsProbeRateLimit` (default: 10) - max probes per window
    - `pnsProbeWindowMs` (default: 60000) - rate limit window (1 minute)
    - `pnsMinProbeIntervalMs` (default: 100) - minimum time between probes
- **Configuration**: PNS is disabled by default (`Node.pnsEnabled = false`). Enable via `Node.pnsEnabled = true`.
- **Safety Guarantees** (Requirements 6.4, 6.5):
  - Bucket structure is preserved - no contacts are added or removed during reordering
  - Buckets are not merged or reshaped
  - XOR-valid contacts are never replaced with XOR-invalid ones
- **Lessons Learned**:
  - PNS reordering only affects the order of contacts within a bucket, not which contacts are present
  - Contacts with null RTT are sorted to the end (treated as high RTT) to encourage probing
  - Rate limiting prevents excessive probing traffic that could degrade network performance

#### Tests

- Created `spec/rdht/pnsSpec.js` with:
  - Property 10: PNS Bucket Ordering (validates Requirement 6.1)
    - Contacts sorted by RTT (lowest first)
    - All original contacts preserved (bucket structure)
    - Null RTT contacts placed at end
    - No reordering when PNS disabled
  - Property 11: PNS Rate Limiting (validates Requirement 6.3)
    - Rate limit respected within window
    - Rate limit resets after window expires
    - Probe count tracking
    - Minimum probe interval enforcement
  - Unit tests for reorderByProximity, probeForRTT, updateProximityOrder, pnsEnabled getter

#### R/Kademlia Conformance - Task 14: Safety Invariant Tests

- **What**: Added property-based tests verifying Kademlia's safety invariants are preserved
- **Why**: R/Kademlia requires that bucket structure and XOR-distance correctness are never violated, even with proximity optimizations. These tests ensure:
  - Bucket index assignment is deterministic based on XOR prefix (Requirement 10.2)
  - Contacts are always placed in the correct bucket for their XOR prefix range (Requirements 6.4, 10.3)
  - Buckets are never merged or reshaped during operations (Requirements 6.4, 10.2)
  - XOR-closer contacts are never replaced by XOR-farther contacts (Requirements 6.5, 10.4)
  - Proximity metrics (RTT) cannot override XOR correctness (Requirement 10.4)
- **Changes**:
  - Created `spec/rdht/safetyInvariantsSpec.js` with property tests
  - Property 12: Bucket Structure Preservation (4 property tests)
  - Property 13: No XOR-Worse Replacement (3 property tests)
- **Lessons Learned**:
  - The `getBucketIndex()` function is deterministic - same key always maps to same bucket
  - `KBucket.randomTarget` generates keys that correctly map back to the bucket's index
  - When bucket is full with live contacts, new contacts are rejected regardless of RTT
  - Dead contacts (no connection) can be evicted, but replacements must be valid for the bucket

#### Tests

- Created `spec/rdht/safetyInvariantsSpec.js` with:
  - Property 12: Bucket Structure Preservation (validates Requirements 6.4, 10.2, 10.3)
    - Bucket index assignment is deterministic based on XOR prefix
    - Contacts in bucket have keys within correct XOR prefix range
    - Buckets are not merged or reshaped during operations
    - XOR prefix determines bucket uniquely
  - Property 13: No XOR-Worse Replacement (validates Requirements 6.5, 10.4)
    - XOR-closer contacts are never replaced by XOR-farther contacts
    - Proximity metrics do not override XOR correctness
    - Dead contacts can be replaced but only by valid bucket members

#### R/Kademlia Conformance - Task 13: Maintenance Lifecycle Compliance Verification

- **What**: Added verification tests confirming existing KDHT implementation conforms to R/Kademlia maintenance lifecycle requirements
- **Why**: R/Kademlia specifies maintenance lifecycle behaviors (T0: Join, T1: Refresh, T2: Liveness). These tests verify the existing implementation already meets these requirements without modification.
- **Changes**:
  - Created `spec/rdht/maintenanceLifecycleSpec.js` with verification tests
  - Task 13.1: Verified `join()` calls `locateNodes(this.key)` for self-lookup and seeds buckets with discovered neighbors (Requirements 7.1, 7.2, 7.4)
  - Task 13.2: Verified `KBucket.randomTarget` generates keys in correct bucket range and `refresh()` calls `locateNodes` with random target (Requirements 8.1, 8.4)
  - Task 13.3: Verified `addContact()` checks `head.connection` for liveness before eviction (Requirements 9.4, 9.5)
  - Task 13.4: Added Property 16 (Liveness-Based Eviction) - validates that unresponsive heads are evicted while responsive heads are preserved (Requirements 9.1, 9.2, 9.3, 9.4)
- **Lessons Learned**:
  - The existing KDHT implementation already follows R/Kademlia maintenance patterns
  - Liveness check uses `head.connection` truthiness - truthy means alive, falsy means dead
  - When bucket is full and head is alive, new contact is rejected and head is moved to tail (LRU behavior)
  - Property tests need unique keys per iteration - bucket indices 0-9 have small key spaces that can cause collisions

#### Tests

- Created `spec/rdht/maintenanceLifecycleSpec.js` with:
  - T0 Node Join Self-Lookup tests (3 tests)
  - T1 Periodic Bucket Refresh tests (4 tests)
  - T2 Liveness-Based Eviction tests (4 unit tests)
  - Property 16: Liveness-Based Eviction (2 property tests, validates Requirements 9.1-9.4)

#### R/Kademlia Conformance - Task 11: Alternate Path Selection on Duplicate

- **What**: Added alternate path handling to recursive routing - when a DUPLICATE response is received, the system now selects the next XOR-valid candidate that hasn't been tried
- **Why**: R/Kademlia requires that on DUPLICATE response, the upstream node SHALL select an alternate XOR-valid next hop (Requirement 3.5). This prevents routing failures when the first-choice path has already seen the lookup.
- **Changes**:
  - Extended `RequestContext` with `triedPaths` array to track nodes that returned DUPLICATE
  - Added `markTried(nodeId)` method to create a new context with a node marked as tried
  - Added `hasTried(nodeId)` method to check if a node has been tried
  - Updated `serialize()` and `deserialize()` to include `triedPaths`
  - Updated `forward()` to preserve `triedPaths`
  - Modified `selectProximityAware()` to exclude nodes in `triedPaths`
  - Added `forwardWithAlternatePaths()` method that loops through candidates on DUPLICATE responses
  - Updated `recursiveFindNodes()` to use the new alternate path handling
  - Updated `initiateRecursiveLookup()` to handle DUPLICATE responses with alternate paths
- **Lessons Learned**:
  - The `triedPaths` array is separate from `tracePath` - tracePath tracks the actual route taken, while triedPaths tracks failed attempts
  - The while loop in `forwardWithAlternatePaths()` continues until either a non-DUPLICATE response is received or all candidates are exhausted
  - Immutable context updates (via `markTried()`) prevent accidental state corruption

#### Tests

- Added to `spec/rdht/nodeRecursiveSpec.js`:
  - Property 6: Alternate Path Selection on Duplicate (validates Requirement 3.5)
  - Tests for `selectProximityAware` excluding tried nodes
  - Tests for `markTried()` creating new context without modifying original
  - Tests for `hasTried()` returning correct values
  - Tests for `triedPaths` serialization round-trip
  - Tests for `forward()` preserving `triedPaths`

#### R/Kademlia Conformance - Task 8: NodeRecursive Integration into Inheritance Chain

- **What**: Integrated `NodeRecursive` into the Node inheritance chain and exported new R/Kademlia components
- **Why**: To make recursive routing capabilities available to all Node instances while maintaining backward compatibility
- **Changes**:
  - Updated `nodes/nodeProbe.js` to extend `NodeRecursive` instead of `NodeMessages`
  - New inheritance chain: `NodeMessages` → `NodeRecursive` → `NodeProbe` → `Node`
  - Updated `index.js` to export `RequestContext` and `DedupCache` for consumers
- **Backward Compatibility**: All 255 existing tests pass without modification. The recursive routing features are disabled by default (`recursiveRoutingEnabled = false`), so existing behavior is unchanged.
- **Lessons Learned**:
  - The mixin pattern allows seamless insertion of new functionality into the inheritance chain
  - Exporting foundation classes enables consumers to build custom recursive routing logic if needed

#### R/Kademlia Conformance - Task 7: NodeRecursive Mixin for Recursive Routing

- **What**: Created `dht/nodeRecursive.js` with `NodeRecursive` class that adds recursive routing capability to the DHT
- **Why**: R/Kademlia requires recursive routing where intermediate nodes forward requests. This mixin provides:
  - Recursive FIND_NODE RPC handler (`recursiveFindNodes`)
  - Message deduplication via DedupCache integration
  - Proximity-aware next-hop selection (`selectProximityAware`)
  - Trace path learning for routing table updates (`updateFromTracePath`)
  - Loop detection and TTL enforcement
- **Changes**:
  - Created `NodeRecursive` class extending `NodeMessages`
  - Lazy initialization of `dedupCache` using configured size and TTL
  - `createLookupContext()` for initiating recursive lookups
  - `recursiveFindNodes()` RPC handler with duplicate detection, loop detection, TTL enforcement
  - `selectProximityAware()` filters candidates for XOR-distance progress and applies RTT-based scoring
  - `updateFromTracePath()` learns from trace path to accelerate routing table convergence
- **Configuration**: Uses existing Node configuration properties (dedupCacheSize, dedupCacheTTL, defaultTTL, proximityRoutingEnabled, proximityWeight)
- **Lessons Learned**:
  - The mixin pattern allows adding recursive routing without modifying existing iterative routing
  - XOR-distance progress must be strictly enforced (< not <=) to guarantee termination
  - Proximity scoring combines XOR distance with RTT penalty: `score = distance * (1 + weight * rtt / 1000)`
  - Testing NodeRecursive before inheritance chain integration requires creating test subclasses

#### Tests

- Created `spec/rdht/nodeRecursiveSpec.js` with:
  - Property 5: Duplicate Detection (validates Requirements 3.2, 3.3, 3.4)
  - Property 7: XOR-Distance Progress (validates Requirements 4.5, 10.1)
  - Property 2: Trace Path Growth on Forward (validates Requirements 2.2, 4.2)
  - Property 3: TTL Enforcement (validates Requirements 2.4, 4.3)
  - Unit tests for dedupCache initialization, createLookupContext, selectProximityAware, updateFromTracePath, recursiveFindNodes

#### R/Kademlia Conformance - Task 4: RTT Tracking for Proximity Routing

- **What**: Extended `Contact` class with RTT (Round-Trip Time) measurement capabilities
- **Why**: R/Kademlia's Proximity Routing (PR) uses RTT as a secondary criterion for next-hop selection. This enables:
  - Lower latency lookups by preferring faster peers among XOR-valid candidates
  - Opportunistic RTT measurement during normal RPCs without additional probing traffic
- **Changes**:
  - Added `rtt` property (last measured RTT in milliseconds)
  - Added `rttUpdatedAt` property (timestamp of last measurement)
  - Added `updateRTT(rttMs)` method
  - Modified `sendRPC()` to automatically measure and record RTT on successful calls
- **Configuration**: None required - RTT tracking is automatic
- **Lessons Learned**:
  - RTT is only updated on successful RPCs (non-null result) to avoid recording timeouts as valid measurements
  - The measurement is taken from the start of `transmitRPC()` to when the result is received, capturing actual network latency

#### Tests

- Created `spec/rdht/contactRttSpec.js` with:
  - Property test for RTT measurement during RPC (validates Requirements 5.1, 5.3)
  - Unit tests for updateRTT(), RTT property initialization, and multi-call RTT updates

#### R/Kademlia Conformance - Task 1: RequestContext for Source Routing

- **What**: Created `dht/requestContext.js` with `RequestContext` class for carrying source routing metadata through recursive lookups
- **Why**: R/Kademlia requires recursive routing where intermediate nodes forward requests. The RequestContext enables:
  - Unique lookup identification via `lookupId` for message deduplication
  - Trace path tracking for reverse routing of replies
  - TTL enforcement to prevent unbounded recursion
  - Loop detection via `hasVisited()` method
- **Configuration**: None required - this is a foundational data structure
- **Lessons Learned**:
  - BigInt values must be serialized as strings for JSON wire transport
  - The `forward()` method creates immutable copies to prevent accidental mutation
  - Property-based testing with fast-check validates serialization round-trips across the full 128-bit key space

#### Dependencies

- Added `fast-check` as dev dependency for property-based testing

#### Tests

- Created `spec/rdht/requestContextSpec.js` with:
  - Property test for round-trip serialization (validates Requirements 2.5, 2.6)
  - Unit tests for constructor, forward(), hasVisited(), serialize(), and deserialize()
