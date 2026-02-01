# Requirements Document

## Introduction

This specification defines the minimal changes required to align the existing KDHT codebase with the R/Kademlia design recommendations in RDHTSummary.md. The goal is surgical modification - preserving what works while adding only what's necessary for conformance.

## Glossary

- **Node**: An actor in the DHT with a 128-bit key (BigInt)
- **Contact**: Represents a connection from one Node to another
- **KBucket**: Routing table bucket holding up to k contacts organized by XOR distance
- **Helper**: Wrapper caching distance from a Contact to a target key
- **Recursive_Routing**: Lookup requests forwarded hop-by-hop by intermediate nodes
- **Source_Routing**: Each recursive request carries a bounded hop list or trace token
- **Proximity_Routing**: Next peer chosen from XOR-valid candidates using RTT as secondary criterion
- **PNS**: Proximity Neighbor Selection - ranking bucket entries by proximity
- **Deduplication_Cache**: Short-lived cache keyed by lookup_id to prevent duplicate processing
- **RTT**: Round-trip time, used as proximity metric

## Requirements

### Requirement 1: Iterative vs Recursive Routing Analysis

**User Story:** As a developer, I want to understand the current routing model, so that I can determine what changes are needed for R/Kademlia conformance.

#### Acceptance Criteria

1. THE Analysis SHALL document whether the current `iterate` method in nodeProbe.js implements iterative or recursive routing
2. THE Analysis SHALL identify that the current implementation uses iterative routing where the originator controls each hop
3. THE Analysis SHALL document that R/Kademlia requires recursive routing where intermediate nodes forward requests

### Requirement 2: Source Routing Support

**User Story:** As a developer, I want lookup requests to carry trace metadata, so that replies can return via reverse path and deduplication is possible.

#### Acceptance Criteria

1. WHEN a lookup request is initiated, THE System SHALL generate a unique lookup_id (128-bit random or hash-based)
2. WHEN a lookup request is forwarded, THE System SHALL append the current node's ID to a bounded trace path
3. WHEN a lookup reply is generated, THE System SHALL include the trace path for reverse routing
4. THE System SHALL enforce a maximum trace path length (TTL) to prevent unbounded recursion
5. WHEN serializing a lookup request, THE Serializer SHALL encode lookup_id, origin_id, target_id, ttl, and trace_path
6. WHEN deserializing a lookup request, THE Deserializer SHALL decode lookup_id, origin_id, target_id, ttl, and trace_path

### Requirement 3: Message Deduplication

**User Story:** As a developer, I want nodes to detect and handle duplicate lookup requests, so that recursive routing doesn't cause amplification or loops.

#### Acceptance Criteria

1. THE Node SHALL maintain a Deduplication_Cache with TTL-based eviction
2. WHEN a lookup request arrives with a lookup_id already in the cache, THE Node SHALL respond with a DUPLICATE status
3. WHEN a lookup request arrives with the node's own ID in the trace path, THE Node SHALL respond with a DUPLICATE status (loop detection)
4. WHEN responding to a duplicate, THE Node SHALL NOT silently drop the request but SHALL send an explicit reply
5. IF a DUPLICATE reply is received, THEN THE upstream node SHALL select an alternate XOR-valid next hop
6. THE Deduplication_Cache SHALL have configurable size and TTL parameters

### Requirement 4: Recursive Forwarding Logic

**User Story:** As a developer, I want intermediate nodes to forward lookup requests, so that the originator doesn't control each hop.

#### Acceptance Criteria

1. WHEN a node receives a recursive lookup request, THE Node SHALL forward it to the closest XOR-valid peer
2. WHEN forwarding, THE Node SHALL decrement the TTL and append itself to the trace path
3. WHEN TTL reaches zero, THE Node SHALL return its closest known nodes without further forwarding
4. WHEN the target is found or no closer nodes exist, THE Node SHALL return the result via the trace path
5. THE System SHALL ensure each hop strictly reduces XOR distance to the target ID

### Requirement 5: Proximity Routing (PR)

**User Story:** As a developer, I want next-hop selection to consider RTT as a secondary criterion, so that lookups have lower latency without violating XOR correctness.

#### Acceptance Criteria

1. THE Contact SHALL store an optional RTT metric gathered during normal RPCs
2. WHEN selecting the next hop from XOR-valid candidates, THE System SHALL prefer candidates with lower RTT
3. THE System SHALL gather RTT metrics opportunistically during normal RPCs without additional probing traffic
4. THE System SHALL NOT allow RTT preference to override XOR-distance correctness
5. WHERE Proximity_Routing is enabled, THE System SHALL use a configurable proximity weight factor
6. THE System SHALL enable Proximity_Routing by default

### Requirement 6: Proximity Neighbor Selection (PNS) - Optional

**User Story:** As a developer, I want bucket entries ranked by proximity, so that lookup latency is further optimized in stable networks.

#### Acceptance Criteria

1. WHERE PNS is enabled, THE KBucket SHALL rank entries by RTT within XOR-equivalent peers
2. WHERE PNS is enabled, THE System SHALL perform limited RTT probes to compare candidates
3. THE System SHALL rate-limit PNS probing to avoid excessive traffic
4. THE System SHALL NOT reshape or merge buckets based on proximity
5. THE System SHALL NOT replace logical neighbors with XOR-worse but closer peers
6. THE System SHALL disable PNS by default (configurable)

### Requirement 7: Maintenance Lifecycle - T0 Node Joins

**User Story:** As a developer, I want node joins to follow R/Kademlia patterns, so that routing tables converge correctly.

#### Acceptance Criteria

1. WHEN a node joins, THE Node SHALL perform a recursive self-lookup (lookup(ID_self))
2. WHEN joining, THE Node SHALL seed buckets with discovered neighbors
3. WHEN joining, THE Node SHALL collect initial proximity samples during forwarding
4. THE existing join() method SHALL be verified to already perform self-lookup via locateNodes(this.key)

### Requirement 8: Maintenance Lifecycle - T1 Periodic Bucket Refresh

**User Story:** As a developer, I want periodic bucket refresh to use recursive lookups, so that all nodes on the path benefit.

#### Acceptance Criteria

1. WHEN refreshing a bucket, THE KBucket SHALL perform a recursive FIND_NODE for a random ID in the bucket range
2. WHEN refreshing, THE System SHALL discover new nodes in prefix ranges
3. WHEN refreshing, THE System SHALL update proximity metrics for PR/PNS
4. THE existing refresh() method SHALL be verified to already use locateNodes with random target

### Requirement 9: Maintenance Lifecycle - T2 Liveness Checks

**User Story:** As a developer, I want liveness to dominate proximity in eviction decisions, so that routing correctness is preserved.

#### Acceptance Criteria

1. THE KBucket SHALL periodically verify liveness of bucket entries
2. WHEN a node is unresponsive, THE KBucket SHALL evict it
3. WHEN evicting, THE KBucket SHALL promote replacement cache entries
4. THE System SHALL ensure liveness dominates proximity when deciding eviction
5. THE existing addContact() method SHALL be verified to check connection liveness before eviction

### Requirement 10: Safety Invariants

**User Story:** As a developer, I want the implementation to preserve Kademlia's correctness guarantees, so that the DHT remains functional.

#### Acceptance Criteria

1. THE System SHALL preserve strict XOR-distance progress per hop
2. THE System SHALL preserve prefix-based bucket partitioning
3. THE System SHALL preserve bucket diversity
4. THE System SHALL NOT replace logical neighbors with XOR-worse but closer peers
5. THE System SHALL NOT collapse buckets based on proximity
6. THE System SHALL NOT allow proximity to override routing correctness

### Requirement 11: Configuration

**User Story:** As a developer, I want R/Kademlia features to be configurable, so that I can tune behavior for different environments.

#### Acceptance Criteria

1. THE Node SHALL expose a configuration option for enabling/disabling Proximity_Routing (default: enabled)
2. THE Node SHALL expose a configuration option for enabling/disabling PNS (default: disabled)
3. THE Node SHALL expose a configuration option for deduplication cache size
4. THE Node SHALL expose a configuration option for deduplication cache TTL
5. THE Node SHALL expose a configuration option for maximum trace path length (TTL)
6. THE Node SHALL expose a configuration option for proximity weight factor

### Requirement 12: Backward Compatibility

**User Story:** As a developer, I want existing tests to continue passing, so that the changes don't break current functionality.

#### Acceptance Criteria

1. WHEN R/Kademlia features are disabled, THE System SHALL behave identically to the current implementation
2. THE existing test suite SHALL pass without modification after changes
3. THE System SHALL support gradual rollout of recursive routing features
