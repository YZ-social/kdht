import * as fc from 'fast-check';
import { Helper } from '../../nodes/helper.js';
const { describe, it, expect, beforeAll } = globalThis; // For linters.

/**
 * Property-based tests for Helper proximity scoring
 * Feature: rdht-conformance
 */
describe('Helper Proximity', function () {
  // Arbitrary generators for property tests
  // Use smaller distances to avoid floating-point precision loss when converting BigInt to Number
  // Number.MAX_SAFE_INTEGER is 2^53 - 1, so we stay well below that for reliable comparisons
  const arbDistance = fc.bigInt(0n, 2n ** 52n - 1n);
  const arbRTT = fc.integer({ min: 1, max: 5000 });
  const arbProximityWeight = fc.double({ min: 0, max: 1, noNaN: true });

  /**
   * Create a mock contact with specified RTT
   */
  function mockContact(key, rtt = null) {
    return {
      key: key,
      rtt: rtt,
      rttUpdatedAt: rtt !== null ? Date.now() : null,
      name: `mock-${key.toString().slice(0, 8)}`
    };
  }

  describe('Property 9: Proximity-Aware Selection Preserves Correctness', function () {
    /**
     * **Validates: Requirements 5.2, 5.4**
     * 
     * For any next-hop selection with Proximity Routing enabled, if a candidate
     * with higher RTT but closer XOR distance exists alongside a candidate with
     * lower RTT but farther XOR distance, the system SHALL select a candidate
     * that makes XOR progress (never selecting an XOR-farther node regardless of RTT).
     */
    it('compareWithProximity never prefers XOR-farther node regardless of RTT', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbDistance,
          arbRTT,
          arbRTT,
          arbProximityWeight,
          (distA, distB, rttA, rttB, weight) => {
            // Ensure distances are different for meaningful test
            fc.pre(distA !== distB);

            const contactA = mockContact(1n, rttA);
            const contactB = mockContact(2n, rttB);

            const helperA = new Helper(contactA, distA);
            const helperB = new Helper(contactB, distB);

            const comparison = Helper.compareWithProximity(helperA, helperB, weight);

            // The comparison result should always respect XOR distance
            if (distA < distB) {
              // A is XOR-closer, so A should be preferred (comparison < 0)
              expect(comparison).toBeLessThan(0);
            } else {
              // B is XOR-closer, so B should be preferred (comparison > 0)
              expect(comparison).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('compareWithProximity uses RTT as tiebreaker when XOR distances are equal', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbRTT,
          arbRTT,
          arbProximityWeight,
          (distance, rttA, rttB, weight) => {
            // Ensure RTTs are different for meaningful test
            fc.pre(rttA !== rttB);

            const contactA = mockContact(1n, rttA);
            const contactB = mockContact(2n, rttB);

            // Same XOR distance
            const helperA = new Helper(contactA, distance);
            const helperB = new Helper(contactB, distance);

            const comparison = Helper.compareWithProximity(helperA, helperB, weight);

            // When XOR distances are equal, lower RTT should be preferred
            if (rttA < rttB) {
              expect(comparison).toBeLessThan(0);
            } else {
              expect(comparison).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('compareWithProximity returns 0 when both distance and RTT are equal', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbRTT,
          arbProximityWeight,
          (distance, rtt, weight) => {
            const contactA = mockContact(1n, rtt);
            const contactB = mockContact(2n, rtt);

            const helperA = new Helper(contactA, distance);
            const helperB = new Helper(contactB, distance);

            const comparison = Helper.compareWithProximity(helperA, helperB, weight);

            expect(comparison).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('sorting with compareWithProximity preserves XOR ordering', function () {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              distance: arbDistance,
              rtt: fc.option(arbRTT, { nil: null })
            }),
            { minLength: 2, maxLength: 20 }
          ),
          arbProximityWeight,
          (items, weight) => {
            // Create helpers from items
            const helpers = items.map((item, i) => {
              const contact = mockContact(BigInt(i), item.rtt);
              return new Helper(contact, item.distance);
            });

            // Sort with proximity-aware comparison
            const sorted = [...helpers].sort((a, b) => 
              Helper.compareWithProximity(a, b, weight)
            );

            // Verify XOR ordering is preserved
            for (let i = 1; i < sorted.length; i++) {
              // Each element should have distance >= previous element
              expect(sorted[i].distance).toBeGreaterThanOrEqual(sorted[i - 1].distance);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('proximityScore', function () {
    it('returns higher score for higher RTT at same distance', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbRTT,
          arbRTT,
          // Use a minimum weight > 0 to ensure RTT has an effect
          fc.double({ min: 0.01, max: 1, noNaN: true }),
          (distance, rttLow, rttHigh, weight) => {
            fc.pre(rttLow < rttHigh);
            fc.pre(distance > 0n); // Ensure non-zero distance for meaningful score

            const contactLow = mockContact(1n, rttLow);
            const contactHigh = mockContact(2n, rttHigh);

            const helperLow = new Helper(contactLow, distance);
            const helperHigh = new Helper(contactHigh, distance);

            const scoreLow = helperLow.proximityScore(weight);
            const scoreHigh = helperHigh.proximityScore(weight);

            // Higher RTT should result in higher (worse) score
            expect(scoreHigh).toBeGreaterThan(scoreLow);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns higher score for higher distance at same RTT', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbDistance,
          arbRTT,
          arbProximityWeight,
          (distLow, distHigh, rtt, weight) => {
            fc.pre(distLow < distHigh);

            const contactLow = mockContact(1n, rtt);
            const contactHigh = mockContact(2n, rtt);

            const helperLow = new Helper(contactLow, distLow);
            const helperHigh = new Helper(contactHigh, distHigh);

            const scoreLow = helperLow.proximityScore(weight);
            const scoreHigh = helperHigh.proximityScore(weight);

            // Higher distance should result in higher (worse) score
            expect(scoreHigh).toBeGreaterThan(scoreLow);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('uses default RTT of 1000ms when RTT is null', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbProximityWeight,
          (distance, weight) => {
            const contactNull = mockContact(1n, null);
            const contact1000 = mockContact(2n, 1000);

            const helperNull = new Helper(contactNull, distance);
            const helper1000 = new Helper(contact1000, distance);

            const scoreNull = helperNull.proximityScore(weight);
            const score1000 = helper1000.proximityScore(weight);

            // Scores should be equal since null defaults to 1000
            expect(scoreNull).toBe(score1000);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('score is proportional to distance when weight is 0', function () {
      fc.assert(
        fc.property(
          arbDistance,
          arbRTT,
          (distance, rtt) => {
            const contact = mockContact(1n, rtt);
            const helper = new Helper(contact, distance);

            const score = helper.proximityScore(0);

            // With weight 0, score should equal distance
            expect(score).toBe(Number(distance));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Unit tests', function () {
    describe('proximityScore', function () {
      it('calculates correct score with known values', function () {
        const contact = mockContact(1n, 100); // 100ms RTT
        const helper = new Helper(contact, 1000n);

        // Score = 1000 * (1 + 0.1 * 100 / 1000) = 1000 * 1.01 = 1010
        const score = helper.proximityScore(0.1);
        expect(score).toBe(1010);
      });

      it('uses default weight of 0.1', function () {
        const contact = mockContact(1n, 100);
        const helper = new Helper(contact, 1000n);

        const scoreDefault = helper.proximityScore();
        const scoreExplicit = helper.proximityScore(0.1);

        expect(scoreDefault).toBe(scoreExplicit);
      });
    });

    describe('compareWithProximity', function () {
      it('prefers closer XOR distance even with much higher RTT', function () {
        const contactClose = mockContact(1n, 5000); // Very high RTT
        const contactFar = mockContact(2n, 1);      // Very low RTT

        const helperClose = new Helper(contactClose, 100n);  // Close
        const helperFar = new Helper(contactFar, 1000n);     // Far

        const comparison = Helper.compareWithProximity(helperClose, helperFar, 0.1);

        // Close should be preferred despite high RTT
        expect(comparison).toBeLessThan(0);
      });

      it('uses RTT as tiebreaker for equal distances', function () {
        const contactFast = mockContact(1n, 10);
        const contactSlow = mockContact(2n, 500);

        const helperFast = new Helper(contactFast, 100n);
        const helperSlow = new Helper(contactSlow, 100n);

        const comparison = Helper.compareWithProximity(helperFast, helperSlow, 0.1);

        // Fast should be preferred
        expect(comparison).toBeLessThan(0);
      });

      it('handles null RTT by defaulting to 1000ms', function () {
        const contactNull = mockContact(1n, null);
        const contactKnown = mockContact(2n, 500);

        const helperNull = new Helper(contactNull, 100n);
        const helperKnown = new Helper(contactKnown, 100n);

        const comparison = Helper.compareWithProximity(helperNull, helperKnown, 0.1);

        // Known (500ms) should be preferred over null (defaults to 1000ms)
        expect(comparison).toBeGreaterThan(0);
      });
    });

    describe('compare (original)', function () {
      it('still works for backward compatibility', function () {
        const contactA = mockContact(1n, 100);
        const contactB = mockContact(2n, 10);

        const helperA = new Helper(contactA, 100n);
        const helperB = new Helper(contactB, 200n);

        // Original compare ignores RTT
        const comparison = Helper.compare(helperA, helperB);

        expect(comparison).toBeLessThan(0); // A is closer by XOR
      });
    });
  });
});
