# Implementation Plan: WebRTC Resource Cleanup

## Overview

This implementation adds proper WebRTC resource cleanup to prevent UDP socket and file descriptor leaks. The approach follows WebRTC best practices: check connection state before closing, stop tracks, remove listeners, close in correct order, and nullify references.

## Tasks

- [x] 1. Extend ConnectionTracker with resource monitoring
  - [x] 1.1 Add activeConnections counter and tracking methods
    - Add static properties: `activeConnections`, `cleanupSuccesses`, `cleanupFailures`
    - Add `trackConnectionCreated()` method to increment activeConnections
    - Add `trackConnectionClosed(success, reason)` method to decrement and track cleanup results
    - Add `getResourceStats()` method returning current counts
    - _Requirements: 5.1, 5.2, 5.3_
  
  - [x] 1.2 Write property test for tracker count accuracy
    - **Property 4: Tracker Count Accuracy**
    - **Validates: Requirements 3.2, 4.3, 5.1, 5.2**

- [x] 2. Add connection state utilities
  - [x] 2.1 Create ConnectionStates helper object in webrtc.js
    - Define TRANSITIONAL states array: ['new', 'connecting', 'disconnected']
    - Define STABLE states array: ['connected', 'failed', 'closed']
    - Add `isTransitional(state)` and `isStable(state)` methods
    - _Requirements: 1.1, 1.2, 1.4_

- [x] 3. Implement listener tracking in WebContact
  - [x] 3.1 Add listener tracking infrastructure
    - Add `_eventListeners` Map property to track registered listeners
    - Add `_cleanupInProgress` boolean to prevent concurrent cleanup
    - Add `registerListener(target, event, handler)` method that stores and adds listener
    - Add `removeAllListeners()` method that removes all tracked listeners
    - _Requirements: 2.2, 2.3_
  
  - [x] 3.2 Update createWebRTC to use listener tracking
    - Replace direct `addEventListener` calls with `registerListener`
    - Track data channel 'close' and 'message' listeners
    - Call `trackConnectionCreated()` when WebRTC is created
    - _Requirements: 2.2, 2.3, 5.1_

- [x] 4. Implement safe cleanup methods
  - [x] 4.1 Add waitForStableState method
    - Check current connectionState from webrtc.pc
    - If transitional, poll every 100ms until stable or timeout (5000ms default)
    - Log forced cleanup warning if timeout exceeded
    - Return object with `waited` and `forced` flags
    - _Requirements: 1.1, 1.3_
  
  - [x] 4.2 Add performCleanup method with correct order
    - Stop all media tracks via getSenders().forEach(s => s.track?.stop())
    - Call removeAllListeners() to remove tracked listeners
    - Close data channel if exists
    - Close peer connection via webrtc.close()
    - Nullify webrtc, connection, unsafeData references
    - Log cleanup result to ConnectionTracker
    - Handle errors gracefully, continue cleanup on failure
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.4_
  
  - [x] 4.3 Add safeCleanup entry point method
    - Check _cleanupInProgress flag, return early if true
    - Set _cleanupInProgress = true
    - Call waitForStableState()
    - Call performCleanup(reason)
    - Set _cleanupInProgress = false in finally block
    - _Requirements: 1.1, 1.2_
  
  - [x] 4.4 Write property test for state-aware cleanup behavior
    - **Property 1: State-Aware Cleanup Behavior**
    - **Validates: Requirements 1.1, 1.2**
  
  - [x] 4.5 Write property test for cleanup completeness
    - **Property 2: Cleanup Completeness**
    - **Validates: Requirements 2.2, 2.3, 2.4, 3.3, 3.4, 4.2**
  
  - [x] 4.6 Write property test for cleanup order correctness
    - **Property 3: Cleanup Order Correctness**
    - **Validates: Requirements 2.1, 2.5**

- [ ] 5. Update existing cleanup paths to use safeCleanup
  - [ ] 5.1 Update timeout handling in createWebRTC
    - Replace direct webrtc.close() with safeCleanup('timeout')
    - Ensure timeout path performs complete cleanup
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  
  - [ ] 5.2 Update onclose handler in createWebRTC
    - Call safeCleanup('disconnect') for unexpected closes
    - Log unexpected disconnect to ConnectionTracker
    - _Requirements: 4.1, 4.2, 4.3_
  
  - [ ] 5.3 Update disconnectTransport method
    - Replace direct webrtc.close() with safeCleanup('close')
    - Ensure proper cleanup order
    - _Requirements: 2.1, 2.5_
  
  - [ ] 5.4 Write property test for contact removal on unexpected disconnect
    - **Property 5: Contact Removal on Unexpected Disconnect**
    - **Validates: Requirements 4.4**

- [ ] 6. Update node shutdown to ensure complete cleanup
  - [ ] 6.1 Update disconnect method in Contact class
    - Collect all cleanup promises from connections
    - Use Promise.allSettled to wait for all cleanups
    - Handle cleanup failures gracefully without throwing
    - _Requirements: 6.1, 6.2, 6.3_
  
  - [ ] 6.2 Write property test for complete shutdown cleanup
    - **Property 6: Complete Shutdown Cleanup**
    - **Validates: Requirements 6.1, 6.2**

- [ ] 7. Checkpoint - Ensure all tests pass
  - Run `npx jasmine spec/dhtInternalsSpec.js spec/dhtKeySpec.js spec/rdht/*.js`
  - Verify no regressions in existing functionality
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All tasks including property tests are required
- Each task references specific requirements for traceability
- Property tests use fast-check library for property-based testing
- Existing ConnectionTracker class is extended, not replaced
- All changes are in contacts/webrtc.js and contacts/contact.js
