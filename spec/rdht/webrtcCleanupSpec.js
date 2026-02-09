import * as fc from 'fast-check';
import { ConnectionTracker, ConnectionStates } from '../../contacts/webrtc.js';
const { describe, it, expect, beforeEach } = globalThis; // For linters.

/**
 * Property-based tests for WebRTC Resource Cleanup
 * Feature: webrtc-resource-cleanup
 */
describe('WebRTC Resource Cleanup', function () {
  beforeEach(function () {
    // Reset tracker state before each test
    ConnectionTracker.clear();
  });

  describe('Property 4: Tracker Count Accuracy', function () {
    /**
     * **Validates: Requirements 3.2, 4.3, 5.1, 5.2**
     * 
     * For any sequence of connection create and cleanup operations,
     * the ConnectionTracker's activeConnections count SHALL equal the
     * actual number of non-null WebRTC connections, and 
     * cleanupSuccesses + cleanupFailures SHALL equal the total number
     * of cleanup operations performed.
     */
    it('activeConnections count matches actual connection count after create/cleanup operations', function () {
      // Arbitrary for operation type: true = create, false = cleanup
      const arbOperation = fc.boolean();
      // Arbitrary for cleanup success
      const arbSuccess = fc.boolean();
      // Arbitrary for cleanup reason
      const arbReason = fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close');
      
      fc.assert(
        fc.property(
          fc.array(fc.tuple(arbOperation, arbSuccess, arbReason), { minLength: 1, maxLength: 100 }),
          (operations) => {
            // Reset tracker state at start of each property test iteration
            ConnectionTracker.clear();
            
            // Track expected state
            let expectedActive = 0;
            let expectedSuccesses = 0;
            let expectedFailures = 0;
            let totalCleanups = 0;
            
            for (const [isCreate, success, reason] of operations) {
              if (isCreate) {
                // Create operation
                ConnectionTracker.trackConnectionCreated();
                expectedActive++;
              } else {
                // Cleanup operation - only if there are active connections
                if (expectedActive > 0) {
                  ConnectionTracker.trackConnectionClosed(success, reason);
                  expectedActive--;
                  totalCleanups++;
                  if (success) {
                    expectedSuccesses++;
                  } else {
                    expectedFailures++;
                  }
                }
              }
            }
            
            const stats = ConnectionTracker.getResourceStats();
            
            // Verify activeConnections matches expected
            expect(stats.activeConnections).toBe(expectedActive);
            
            // Verify cleanup counts match
            expect(stats.cleanupSuccesses).toBe(expectedSuccesses);
            expect(stats.cleanupFailures).toBe(expectedFailures);
            expect(stats.totalCleanups).toBe(totalCleanups);
            expect(stats.cleanupSuccesses + stats.cleanupFailures).toBe(totalCleanups);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('activeConnections never goes negative', function () {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
          (cleanupAttempts) => {
            // Reset tracker state at start of each property test iteration
            ConnectionTracker.clear();
            
            // Try to close more connections than we created
            ConnectionTracker.trackConnectionCreated();
            ConnectionTracker.trackConnectionCreated();
            
            // Attempt many cleanups (more than created)
            for (const success of cleanupAttempts) {
              ConnectionTracker.trackConnectionClosed(success, 'test');
            }
            
            const stats = ConnectionTracker.getResourceStats();
            
            // activeConnections should never be negative
            expect(stats.activeConnections).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Unit tests for ConnectionTracker resource monitoring', function () {
    describe('trackConnectionCreated', function () {
      it('increments activeConnections', function () {
        expect(ConnectionTracker.activeConnections).toBe(0);
        ConnectionTracker.trackConnectionCreated();
        expect(ConnectionTracker.activeConnections).toBe(1);
        ConnectionTracker.trackConnectionCreated();
        expect(ConnectionTracker.activeConnections).toBe(2);
      });
    });

    describe('trackConnectionClosed', function () {
      it('decrements activeConnections on success', function () {
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionCreated();
        expect(ConnectionTracker.activeConnections).toBe(2);
        
        ConnectionTracker.trackConnectionClosed(true, 'close');
        expect(ConnectionTracker.activeConnections).toBe(1);
        expect(ConnectionTracker.cleanupSuccesses).toBe(1);
        expect(ConnectionTracker.cleanupFailures).toBe(0);
      });

      it('decrements activeConnections on failure', function () {
        ConnectionTracker.trackConnectionCreated();
        expect(ConnectionTracker.activeConnections).toBe(1);
        
        ConnectionTracker.trackConnectionClosed(false, 'error');
        expect(ConnectionTracker.activeConnections).toBe(0);
        expect(ConnectionTracker.cleanupSuccesses).toBe(0);
        expect(ConnectionTracker.cleanupFailures).toBe(1);
      });

      it('does not go below zero', function () {
        expect(ConnectionTracker.activeConnections).toBe(0);
        ConnectionTracker.trackConnectionClosed(true, 'close');
        expect(ConnectionTracker.activeConnections).toBe(0);
      });
    });

    describe('getResourceStats', function () {
      it('returns correct statistics', function () {
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionClosed(true, 'close');
        ConnectionTracker.trackConnectionClosed(false, 'error');
        
        const stats = ConnectionTracker.getResourceStats();
        
        expect(stats.activeConnections).toBe(1);
        expect(stats.cleanupSuccesses).toBe(1);
        expect(stats.cleanupFailures).toBe(1);
        expect(stats.totalCleanups).toBe(2);
      });
    });

    describe('clear', function () {
      it('resets all counters', function () {
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionCreated();
        ConnectionTracker.trackConnectionClosed(true, 'close');
        
        ConnectionTracker.clear();
        
        const stats = ConnectionTracker.getResourceStats();
        expect(stats.activeConnections).toBe(0);
        expect(stats.cleanupSuccesses).toBe(0);
        expect(stats.cleanupFailures).toBe(0);
        expect(stats.totalCleanups).toBe(0);
      });
    });
  });

  describe('Unit tests for ConnectionStates helper', function () {
    describe('TRANSITIONAL states', function () {
      it('contains new, connecting, and disconnected', function () {
        expect(ConnectionStates.TRANSITIONAL).toContain('new');
        expect(ConnectionStates.TRANSITIONAL).toContain('connecting');
        expect(ConnectionStates.TRANSITIONAL).toContain('disconnected');
        expect(ConnectionStates.TRANSITIONAL.length).toBe(3);
      });
    });

    describe('STABLE states', function () {
      it('contains connected, failed, and closed', function () {
        expect(ConnectionStates.STABLE).toContain('connected');
        expect(ConnectionStates.STABLE).toContain('failed');
        expect(ConnectionStates.STABLE).toContain('closed');
        expect(ConnectionStates.STABLE.length).toBe(3);
      });
    });

    describe('isTransitional', function () {
      it('returns true for transitional states', function () {
        expect(ConnectionStates.isTransitional('new')).toBe(true);
        expect(ConnectionStates.isTransitional('connecting')).toBe(true);
        expect(ConnectionStates.isTransitional('disconnected')).toBe(true);
      });

      it('returns false for stable states', function () {
        expect(ConnectionStates.isTransitional('connected')).toBe(false);
        expect(ConnectionStates.isTransitional('failed')).toBe(false);
        expect(ConnectionStates.isTransitional('closed')).toBe(false);
      });

      it('returns false for unknown states', function () {
        expect(ConnectionStates.isTransitional('unknown')).toBe(false);
        expect(ConnectionStates.isTransitional(null)).toBe(false);
        expect(ConnectionStates.isTransitional(undefined)).toBe(false);
      });
    });

    describe('isStable', function () {
      it('returns true for stable states', function () {
        expect(ConnectionStates.isStable('connected')).toBe(true);
        expect(ConnectionStates.isStable('failed')).toBe(true);
        expect(ConnectionStates.isStable('closed')).toBe(true);
      });

      it('returns false for transitional states', function () {
        expect(ConnectionStates.isStable('new')).toBe(false);
        expect(ConnectionStates.isStable('connecting')).toBe(false);
        expect(ConnectionStates.isStable('disconnected')).toBe(false);
      });

      it('returns false for unknown states', function () {
        expect(ConnectionStates.isStable('unknown')).toBe(false);
        expect(ConnectionStates.isStable(null)).toBe(false);
        expect(ConnectionStates.isStable(undefined)).toBe(false);
      });
    });

    describe('state classification completeness', function () {
      it('all WebRTC connection states are classified', function () {
        // All valid RTCPeerConnection.connectionState values
        const allStates = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
        
        for (const state of allStates) {
          const isTransitional = ConnectionStates.isTransitional(state);
          const isStable = ConnectionStates.isStable(state);
          
          // Each state should be exactly one of transitional or stable
          expect(isTransitional || isStable).toBe(true);
          expect(isTransitional && isStable).toBe(false);
        }
      });
    });
  });
});
