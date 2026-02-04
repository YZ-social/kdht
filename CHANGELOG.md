# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

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
