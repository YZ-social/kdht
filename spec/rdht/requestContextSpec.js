import * as fc from 'fast-check';
import { RequestContext } from '../../dht/requestContext.js';
const { describe, it, expect, BigInt } = globalThis; // For linters.

/**
 * Property-based tests for RequestContext
 * Feature: rdht-conformance
 */
describe('RequestContext', function () {
  // Arbitrary generators for property tests
  const arbNodeKey = fc.bigInt(0n, 2n ** 128n - 1n);
  const arbLookupId = fc.uuid();
  const arbTTL = fc.integer({ min: 0, max: 50 });
  const arbTracePath = fc.array(arbNodeKey, { maxLength: 20 });

  const arbRequestContext = fc.record({
    lookupId: arbLookupId,
    originId: arbNodeKey,
    targetId: arbNodeKey,
    ttl: arbTTL,
    tracePath: arbTracePath,
  });

  describe('Property 1: RequestContext Round-Trip Serialization', function () {
    /**
     * **Validates: Requirements 2.5, 2.6**
     * 
     * For any valid RequestContext object, serializing it and then deserializing
     * the result SHALL produce an equivalent RequestContext with identical
     * lookupId, originId, targetId, ttl, and tracePath values.
     */
    it('serialize then deserialize produces equivalent context', function () {
      fc.assert(
        fc.property(arbRequestContext, (contextData) => {
          const original = new RequestContext(contextData);
          const serialized = original.serialize();
          const deserialized = RequestContext.deserialize(serialized);

          // Verify all fields match
          expect(deserialized.lookupId).toBe(original.lookupId);
          expect(deserialized.originId).toBe(original.originId);
          expect(deserialized.targetId).toBe(original.targetId);
          expect(deserialized.ttl).toBe(original.ttl);
          expect(deserialized.tracePath.length).toBe(original.tracePath.length);
          
          for (let i = 0; i < original.tracePath.length; i++) {
            expect(deserialized.tracePath[i]).toBe(original.tracePath[i]);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Unit tests', function () {
    describe('constructor', function () {
      it('creates context with all fields', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n, 2n, 3n],
        });

        expect(ctx.lookupId).toBe('test-uuid');
        expect(ctx.originId).toBe(123n);
        expect(ctx.targetId).toBe(456n);
        expect(ctx.ttl).toBe(20);
        expect(ctx.tracePath).toEqual([1n, 2n, 3n]);
      });

      it('defaults tracePath to empty array', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
        });

        expect(ctx.tracePath).toEqual([]);
      });
    });

    describe('forward', function () {
      it('decrements TTL by 1', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [],
        });

        const forwarded = ctx.forward(789n);
        expect(forwarded.ttl).toBe(19);
      });

      it('appends node to trace path', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n, 2n],
        });

        const forwarded = ctx.forward(789n);
        expect(forwarded.tracePath).toEqual([1n, 2n, 789n]);
      });

      it('preserves other fields', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n],
        });

        const forwarded = ctx.forward(789n);
        expect(forwarded.lookupId).toBe('test-uuid');
        expect(forwarded.originId).toBe(123n);
        expect(forwarded.targetId).toBe(456n);
      });

      it('does not mutate original context', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n],
        });

        ctx.forward(789n);
        expect(ctx.ttl).toBe(20);
        expect(ctx.tracePath).toEqual([1n]);
      });
    });

    describe('hasVisited', function () {
      it('returns true if node is in trace path', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n, 2n, 3n],
        });

        expect(ctx.hasVisited(2n)).toBe(true);
      });

      it('returns false if node is not in trace path', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n, 2n, 3n],
        });

        expect(ctx.hasVisited(4n)).toBe(false);
      });

      it('returns false for empty trace path', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [],
        });

        expect(ctx.hasVisited(1n)).toBe(false);
      });
    });

    describe('serialize', function () {
      it('converts BigInt to strings', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [1n, 2n],
        });

        const serialized = ctx.serialize();
        expect(serialized.originId).toBe('123');
        expect(serialized.targetId).toBe('456');
        expect(serialized.tracePath).toEqual(['1', '2']);
      });

      it('preserves non-BigInt fields', function () {
        const ctx = new RequestContext({
          lookupId: 'test-uuid',
          originId: 123n,
          targetId: 456n,
          ttl: 20,
          tracePath: [],
        });

        const serialized = ctx.serialize();
        expect(serialized.lookupId).toBe('test-uuid');
        expect(serialized.ttl).toBe(20);
      });
    });

    describe('deserialize', function () {
      it('converts strings back to BigInt', function () {
        const data = {
          lookupId: 'test-uuid',
          originId: '123',
          targetId: '456',
          ttl: 20,
          tracePath: ['1', '2'],
        };

        const ctx = RequestContext.deserialize(data);
        expect(ctx.originId).toBe(123n);
        expect(ctx.targetId).toBe(456n);
        expect(ctx.tracePath).toEqual([1n, 2n]);
      });
    });
  });
});
