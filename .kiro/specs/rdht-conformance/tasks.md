# Implementation Plan: R/Kademlia Conformance

## Overview

This plan implements minimal, surgical changes to align KDHT with R/Kademlia recommendations. The approach is additive - new capabilities alongside existing code, with configuration-driven feature flags for backward compatibility.

## Tasks

- [x] 1. Create RequestContext for source routing metadata
  - [x] 1.1 Create dht/requestContext.js with RequestContext class
    - Implement constructor with lookupId, originId, targetId, ttl, tracePath
    - Implement forward() method to create forwarded context
    - Implement hasVisited() for loop detection
    - Implement serialize() and static deserialize() methods
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  
  - [x] 1.2 Write property test for RequestContext round-trip serialization
    - **Property 1: RequestContext Round-Trip Serialization**
    - **Validates: Requirements 2.5, 2.6**

- [x] 2. Create DedupCache for message deduplication
  - [x] 2.1 Create dht/dedupCache.js with DedupCache class
    - Implement constructor with maxSize and ttlMs parameters
    - Implement has() method with TTL checking
    - Implement add() method with size limit enforcement
    - Implement markForwarded() method
    - Implement evictStale() method
    - _Requirements: 3.1, 3.6_
  
  - [x] 2.2 Write property test for DedupCache TTL eviction
    - **Property 4: Deduplication Cache TTL Eviction**
    - **Validates: Requirements 3.1**

- [x] 3. Checkpoint - Verify foundation components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add RTT tracking to Contact class
  - [x] 4.1 Extend Contact with RTT measurement
    - Add rtt and rttUpdatedAt properties to Contact class
    - Add updateRTT() method
    - Modify sendRPC() to measure and record RTT on successful calls
    - _Requirements: 5.1, 5.3_
  
  - [x] 4.2 Write property test for RTT measurement during RPC
    - **Property 8: RTT Measurement During RPC**
    - **Validates: Requirements 5.1, 5.3**

- [x] 5. Add R/Kademlia configuration options to Node
  - [x] 5.1 Add static configuration properties to Node class
    - Add recursiveRoutingEnabled (default: false)
    - Add proximityRoutingEnabled (default: true)
    - Add pnsEnabled (default: false)
    - Add defaultTTL (default: 20)
    - Add dedupCacheSize (default: 1000)
    - Add dedupCacheTTL (default: 10000)
    - Add proximityWeight (default: 0.1)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  
  - [x] 5.2 Write unit tests for configuration defaults
    - Verify proximityRoutingEnabled defaults to true
    - Verify pnsEnabled defaults to false
    - Verify recursiveRoutingEnabled defaults to false
    - _Requirements: 5.6, 6.6, 11.1, 11.2_

- [x] 6. Checkpoint - Verify configuration and RTT tracking
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Create NodeRecursive mixin for recursive routing
  - [x] 7.1 Create dht/nodeRecursive.js with recursive routing logic
    - Create NodeRecursive class extending NodeMessages
    - Initialize dedupCache in constructor
    - Implement recursiveFindNodes() RPC handler
    - Implement selectProximityAware() for next-hop selection
    - Implement updateFromTracePath() for routing table learning
    - _Requirements: 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.2, 5.4_
  
  - [x] 7.2 Write property test for duplicate detection
    - **Property 5: Duplicate Detection**
    - **Validates: Requirements 3.2, 3.3, 3.4**
  
  - [x] 7.3 Write property test for XOR-distance progress
    - **Property 7: XOR-Distance Progress**
    - **Validates: Requirements 4.5, 10.1**
  
  - [x] 7.4 Write property test for trace path growth
    - **Property 2: Trace Path Growth on Forward**
    - **Validates: Requirements 2.2, 4.2**
  
  - [x] 7.5 Write property test for TTL enforcement
    - **Property 3: TTL Enforcement**
    - **Validates: Requirements 2.4, 4.3**

- [x] 8. Integrate NodeRecursive into inheritance chain
  - [x] 8.1 Update nodeProbe.js to extend NodeRecursive
    - Change NodeProbe to extend NodeRecursive instead of NodeMessages
    - Ensure existing iterate() method unchanged
    - _Requirements: 12.1, 12.2_
  
  - [x] 8.2 Update index.js exports if needed
    - Export RequestContext and DedupCache if useful for consumers
    - _Requirements: 12.3_

- [x] 9. Checkpoint - Verify recursive routing integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add proximity-aware selection to Helper
  - [x] 10.1 Extend Helper with proximity scoring
    - Add proximityScore() method considering RTT and XOR distance
    - Add static compareWithProximity() for sorting with PR
    - _Requirements: 5.2, 5.4_
  
  - [x] 10.2 Write property test for proximity-aware selection correctness
    - **Property 9: Proximity-Aware Selection Preserves Correctness**
    - **Validates: Requirements 5.2, 5.4**

- [ ] 11. Implement alternate path selection on duplicate
  - [ ] 11.1 Add alternate path handling to recursive routing
    - Track tried paths in forwarding context
    - On DUPLICATE response, select next XOR-valid candidate
    - _Requirements: 3.5_
  
  - [ ] 11.2 Write property test for alternate path selection
    - **Property 6: Alternate Path Selection on Duplicate**
    - **Validates: Requirements 3.5**

- [ ] 12. Checkpoint - Verify proximity routing
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Verify existing maintenance lifecycle compliance
  - [ ] 13.1 Add verification tests for join self-lookup
    - Verify join() calls locateNodes(this.key)
    - Verify buckets are seeded after join
    - _Requirements: 7.1, 7.2, 7.4_
  
  - [ ] 13.2 Add verification tests for bucket refresh
    - Verify refresh() uses random key in bucket range
    - Verify locateNodes is called during refresh
    - _Requirements: 8.1, 8.4_
  
  - [ ] 13.3 Add verification tests for liveness-based eviction
    - Verify addContact() checks connection before eviction
    - Verify live nodes are not evicted for dead nodes
    - _Requirements: 9.4, 9.5_
  
  - [ ] 13.4 Write property test for liveness-based eviction
    - **Property 16: Liveness-Based Eviction**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

- [ ] 14. Add safety invariant tests
  - [ ] 14.1 Write property test for bucket structure preservation
    - **Property 12: Bucket Structure Preservation**
    - **Validates: Requirements 6.4, 10.2, 10.3**
  
  - [ ] 14.2 Write property test for no XOR-worse replacement
    - **Property 13: No XOR-Worse Replacement**
    - **Validates: Requirements 6.5, 10.4**

- [ ] 15. Checkpoint - Verify safety invariants
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Add optional PNS support
  - [ ] 16.1 Extend KBucket with PNS reordering
    - Add reorderByProximity() method (only when pnsEnabled)
    - Implement rate-limited RTT probing
    - Ensure bucket structure is preserved
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  
  - [ ] 16.2 Write property test for PNS bucket ordering
    - **Property 10: PNS Bucket Ordering**
    - **Validates: Requirements 6.1**
  
  - [ ] 16.3 Write property test for PNS rate limiting
    - **Property 11: PNS Rate Limiting**
    - **Validates: Requirements 6.3**

- [ ] 17. Add backward compatibility tests
  - [ ] 17.1 Create backward compatibility test suite
    - Run existing dhtAcceptanceSpec with features disabled
    - Verify identical behavior to pre-modification
    - _Requirements: 12.1, 12.2_
  
  - [ ] 17.2 Write property test for backward compatibility
    - **Property 17: Backward Compatibility**
    - **Validates: Requirements 12.1**

- [ ] 18. Final checkpoint - Full test suite
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npm test` to verify complete test suite passes

- [ ] 19. Update documentation
  - [ ] 19.1 Update CHANGELOG.md with R/Kademlia conformance changes
    - Document what was changed
    - Document why it was changed
    - Document configuration options
    - _Requirements: 11.1-11.6, 12.3_

## Notes

- All tasks including property tests are required for comprehensive coverage
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The inheritance chain modification (Task 8) is the integration point
- PNS (Task 16) is fully optional feature but tests are required when implementing
