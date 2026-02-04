# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

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
