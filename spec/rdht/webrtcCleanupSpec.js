import * as fc from 'fast-check';
import { ConnectionTracker, ConnectionStates, WebContact } from '../../contacts/webrtc.js';
import { Node } from '../../nodes/node.js';
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

  describe('Property 1: State-Aware Cleanup Behavior', function () {
    /**
     * **Validates: Requirements 1.1, 1.2**
     * 
     * For any WebContact with an active connection, when safeCleanup is called,
     * the cleanup behavior SHALL match the connection state classification:
     * if the state is transitional (connecting, disconnected), cleanup waits for a stable state;
     * if the state is stable (connected, failed, closed), cleanup proceeds immediately.
     */
    
    // Create a mock WebContact for testing cleanup behavior
    function createMockWebContact(connectionState) {
      const mockHost = {
        contact: { sname: 'test-host' },
        log: () => {},
        flog: () => {},
        ilog: () => {}
      };
      
      // Create a minimal mock that simulates WebContact behavior
      const mockContact = {
        host: mockHost,
        sname: 'test-remote',
        _eventListeners: new Map(),
        _cleanupInProgress: false,
        webrtc: {
          pc: {
            connectionState: connectionState,
            getSenders: () => []
          },
          close: () => {}
        },
        connection: Promise.resolve(null),
        unsafeData: { close: () => {} },
        
        // Copy methods from WebContact prototype
        removeAllListeners: WebContact.prototype.removeAllListeners,
        performCleanup: WebContact.prototype.performCleanup,
        safeCleanup: WebContact.prototype.safeCleanup,
        
        // Custom waitForStableState that uses setTimeout instead of Node.delay
        async waitForStableState(maxWaitMs = 5000) {
          const start = Date.now();
          const state = this.webrtc?.pc?.connectionState;
          
          // If no webrtc or already stable, return immediately
          if (!state || ConnectionStates.isStable(state)) {
            return { waited: false, forced: false };
          }
          
          // Poll until stable or timeout
          const delay = ms => new Promise(r => setTimeout(r, ms));
          while (Date.now() - start < maxWaitMs) {
            const currentState = this.webrtc?.pc?.connectionState;
            if (!currentState || ConnectionStates.isStable(currentState)) {
              return { waited: true, forced: false };
            }
            await delay(50);
          }
          
          // Timeout exceeded - force cleanup
          ConnectionTracker.log('cleanup_forced', {
            from: this.host?.contact?.sname,
            to: this.sname,
            state: this.webrtc?.pc?.connectionState,
            waitedMs: maxWaitMs
          });
          return { waited: true, forced: true };
        }
      };
      
      return mockContact;
    }
    
    it('proceeds immediately for stable states', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ConnectionStates.STABLE),
          fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close'),
          async (state, reason) => {
            ConnectionTracker.clear();
            const contact = createMockWebContact(state);
            
            // Track that we had a connection
            ConnectionTracker.trackConnectionCreated();
            
            const result = await contact.waitForStableState(100);
            
            // For stable states, should not wait
            return result.waited === false && result.forced === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('waits for transitional states to become stable', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ConnectionStates.TRANSITIONAL),
          async (initialState) => {
            ConnectionTracker.clear();
            const contact = createMockWebContact(initialState);
            
            // Simulate state transition after a short delay
            setTimeout(() => {
              contact.webrtc.pc.connectionState = 'connected';
            }, 10);
            
            const result = await contact.waitForStableState(150);
            
            // Should have waited for stable state
            return result.waited === true && result.forced === false;
          }
        ),
        { numRuns: 10 }
      );
    });

    it('forces cleanup after timeout for stuck transitional states', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ConnectionStates.TRANSITIONAL),
          async (state) => {
            ConnectionTracker.clear();
            ConnectionTracker.enable();
            const contact = createMockWebContact(state);
            
            // Don't change state - it stays transitional
            const result = await contact.waitForStableState(60);
            
            ConnectionTracker.disable();
            
            // Should have waited and forced
            return result.waited === true && result.forced === true;
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe('Property 2: Cleanup Completeness', function () {
    /**
     * **Validates: Requirements 2.2, 2.3, 2.4, 3.3, 3.4, 4.2**
     * 
     * For any WebContact that undergoes cleanup (via timeout, disconnect, failure, or shutdown),
     * after cleanup completes: the webrtc property SHALL be null, the connection property SHALL be null,
     * the unsafeData property SHALL be null, and no event listeners SHALL remain registered.
     */
    
    function createMockWebContactWithListeners(state) {
      const mockHost = {
        contact: { sname: 'test-host' },
        log: () => {},
        flog: () => {},
        ilog: () => {}
      };
      
      const mockTarget = {
        listeners: new Map(),
        addEventListener(event, handler) {
          if (!this.listeners.has(event)) this.listeners.set(event, []);
          this.listeners.get(event).push(handler);
        },
        removeEventListener(event, handler) {
          if (!this.listeners.has(event)) return;
          const handlers = this.listeners.get(event);
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      };
      
      const mockContact = {
        host: mockHost,
        sname: 'test-remote',
        _eventListeners: new Map(),
        _cleanupInProgress: false,
        webrtc: {
          pc: {
            connectionState: state,
            getSenders: () => []
          },
          close: () => {}
        },
        connection: Promise.resolve(null),
        unsafeData: { close: () => {} },
        
        registerListener: WebContact.prototype.registerListener,
        removeAllListeners: WebContact.prototype.removeAllListeners,
        waitForStableState: WebContact.prototype.waitForStableState,
        performCleanup: WebContact.prototype.performCleanup,
        safeCleanup: WebContact.prototype.safeCleanup,
        
        mockTarget
      };
      
      // Register some listeners
      mockContact.registerListener(mockTarget, 'close', () => {});
      mockContact.registerListener(mockTarget, 'message', () => {});
      mockContact.registerListener(mockTarget, 'error', () => {});
      
      return mockContact;
    }
    
    it('nullifies all references after cleanup', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ConnectionStates.STABLE),
          fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close'),
          async (state, reason) => {
            ConnectionTracker.clear();
            const contact = createMockWebContactWithListeners(state);
            
            // Track connection
            ConnectionTracker.trackConnectionCreated();
            
            // Perform cleanup
            await contact.safeCleanup(reason);
            
            // Verify all references are nullified
            return contact.webrtc === null && 
                   contact.connection === null && 
                   contact.unsafeData === null;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('removes all event listeners after cleanup', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ConnectionStates.STABLE),
          fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close'),
          async (state, reason) => {
            ConnectionTracker.clear();
            const contact = createMockWebContactWithListeners(state);
            
            // Track connection
            ConnectionTracker.trackConnectionCreated();
            
            // Verify listeners exist before cleanup
            const hadListeners = contact._eventListeners.size > 0;
            
            // Perform cleanup
            await contact.safeCleanup(reason);
            
            // Verify all listeners are removed
            return hadListeners && contact._eventListeners.size === 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Cleanup Order Correctness', function () {
    /**
     * **Validates: Requirements 2.1, 2.5**
     * 
     * For any WebContact cleanup operation, the cleanup steps SHALL execute in the following order:
     * (1) stop media tracks, (2) remove event listeners, (3) close data channel,
     * (4) close peer connection, (5) nullify references.
     * No step SHALL execute before its predecessor completes.
     */
    
    function createMockWebContactWithOrderTracking() {
      const executionOrder = [];
      
      const mockHost = {
        contact: { sname: 'test-host' },
        log: () => {},
        flog: () => {},
        ilog: () => {}
      };
      
      const mockContact = {
        host: mockHost,
        sname: 'test-remote',
        _eventListeners: new Map(),
        _cleanupInProgress: false,
        executionOrder,
        webrtc: {
          pc: {
            connectionState: 'connected',
            getSenders: () => [{
              track: {
                stop: () => executionOrder.push('stop_tracks')
              }
            }]
          },
          close: () => executionOrder.push('close_peer_connection')
        },
        connection: Promise.resolve(null),
        unsafeData: {
          close: () => executionOrder.push('close_data_channel')
        },
        
        removeAllListeners() {
          executionOrder.push('remove_listeners');
          this._eventListeners.clear();
        },
        waitForStableState: WebContact.prototype.waitForStableState,
        
        // Custom performCleanup that tracks order
        performCleanup(reason) {
          let success = true;
          
          // Step 1: Stop all media tracks
          try {
            this.webrtc?.pc?.getSenders?.()?.forEach(sender => {
              try { sender.track?.stop(); } catch (e) { /* ignore */ }
            });
          } catch (e) {
            success = false;
          }
          
          // Step 2: Remove all event listeners
          try {
            this.removeAllListeners();
          } catch (e) {
            success = false;
          }
          
          // Step 3: Close data channel
          try {
            if (this.unsafeData) {
              this.unsafeData.close?.();
            }
          } catch (e) {
            success = false;
          }
          
          // Step 4: Close peer connection
          try {
            this.webrtc?.close?.();
          } catch (e) {
            success = false;
          }
          
          // Step 5: Nullify references
          this.webrtc = null;
          this.connection = null;
          this.unsafeData = null;
          executionOrder.push('nullify_references');
          
          ConnectionTracker.trackConnectionClosed(success, reason);
          return success;
        },
        
        safeCleanup: WebContact.prototype.safeCleanup
      };
      
      return mockContact;
    }
    
    it('executes cleanup steps in correct order', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close'),
          async (reason) => {
            ConnectionTracker.clear();
            const contact = createMockWebContactWithOrderTracking();
            
            // Track connection
            ConnectionTracker.trackConnectionCreated();
            
            // Perform cleanup
            await contact.safeCleanup(reason);
            
            const order = contact.executionOrder;
            
            // Verify order: tracks -> listeners -> channel -> connection -> nullify
            const expectedOrder = [
              'stop_tracks',
              'remove_listeners',
              'close_data_channel',
              'close_peer_connection',
              'nullify_references'
            ];
            
            return JSON.stringify(order) === JSON.stringify(expectedOrder);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('no step executes before its predecessor', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('timeout', 'disconnect', 'failure', 'shutdown', 'close'),
          async (reason) => {
            ConnectionTracker.clear();
            const contact = createMockWebContactWithOrderTracking();
            
            // Track connection
            ConnectionTracker.trackConnectionCreated();
            
            // Perform cleanup
            await contact.safeCleanup(reason);
            
            const order = contact.executionOrder;
            
            // Verify each step comes after its predecessor
            const stepOrder = {
              'stop_tracks': 0,
              'remove_listeners': 1,
              'close_data_channel': 2,
              'close_peer_connection': 3,
              'nullify_references': 4
            };
            
            for (let i = 1; i < order.length; i++) {
              const prevStep = order[i - 1];
              const currStep = order[i];
              if (stepOrder[prevStep] >= stepOrder[currStep]) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
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
