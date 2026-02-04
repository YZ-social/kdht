import { v4 as uuidv4 } from 'uuid';
import { NodeMessages } from '../nodes/nodeMessages.js';
import { DedupCache } from './dedupCache.js';
import { RequestContext } from './requestContext.js';

/**
 * NodeRecursive adds recursive routing capability to the DHT.
 * 
 * This mixin is inserted between NodeMessages and NodeProbe in the inheritance chain.
 * It provides:
 * - Recursive FIND_NODE RPC handler
 * - Message deduplication via DedupCache
 * - Proximity-aware next-hop selection
 * - Trace path learning for routing table updates
 * 
 * Requirements: 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 5.2, 5.4
 */
export class NodeRecursive extends NodeMessages {
  // R/Kademlia configuration options (inherited from Node when in full chain)
  // These defaults match Node class for standalone testing
  static recursiveRoutingEnabled = false;
  static proximityRoutingEnabled = true;
  static pnsEnabled = false;
  static defaultTTL = 20;
  static dedupCacheSize = 1000;
  static dedupCacheTTL = 10000;
  static proximityWeight = 0.1;
  /**
   * Initialize the deduplication cache for this node.
   * Called lazily on first recursive routing operation.
   */
  _dedupCache = null;
  get dedupCache() {
    if (!this._dedupCache) {
      this._dedupCache = new DedupCache(
        this.constructor.dedupCacheSize,
        this.constructor.dedupCacheTTL
      );
    }
    return this._dedupCache;
  }

  /**
   * Create a new RequestContext for initiating a recursive lookup.
   * 
   * @param {BigInt} targetId - The key being looked up
   * @returns {RequestContext} A new context for the lookup
   */
  createLookupContext(targetId) {
    return new RequestContext({
      lookupId: uuidv4(),
      originId: this.key,
      targetId: targetId,
      ttl: this.constructor.defaultTTL,
      tracePath: [],
    });
  }

  /**
   * RPC handler for recursive FIND_NODE requests.
   * 
   * This method handles incoming recursive lookup requests by:
   * 1. Checking for duplicates (dedup cache or loop detection)
   * 2. Recording the lookup in the dedup cache
   * 3. Learning from the trace path
   * 4. Forwarding to the next hop or returning results
   * 
   * @param {Object} ctxData - Serialized RequestContext
   * @returns {Object} Result with status, nodes, and tracePath
   * 
   * Requirements: 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5
   */
  async recursiveFindNodes(ctxData) {
    // Deserialize context
    const ctx = RequestContext.deserialize(ctxData);

    // Deduplication check (Requirement 3.2)
    if (this.dedupCache.has(ctx.lookupId)) {
      return { 
        status: 'DUPLICATE', 
        tracePath: ctx.tracePath.map(String),
        reason: 'lookup_id_seen'
      };
    }

    // Loop detection (Requirement 3.3)
    if (ctx.hasVisited(this.key)) {
      return { 
        status: 'DUPLICATE', 
        tracePath: ctx.tracePath.map(String),
        reason: 'loop_detected'
      };
    }

    // Record in dedup cache (Requirement 3.1)
    this.dedupCache.add(ctx.lookupId);

    // Update routing table from trace path (Requirement 5.4 - learning)
    this.updateFromTracePath(ctx.tracePath);

    // Get closest helpers to target
    const helpers = this.findClosestHelpers(ctx.targetId);
    const serializedNodes = helpers.map(h => ({
      key: String(h.key),
      distance: String(h.distance),
      name: h.name
    }));

    // Check if we are the target
    if (this.key === ctx.targetId) {
      return {
        status: 'FOUND',
        nodes: serializedNodes,
        tracePath: ctx.tracePath.map(String),
      };
    }

    // Check TTL (Requirement 4.3)
    if (ctx.ttl <= 0) {
      return {
        status: 'TTL_EXPIRED',
        nodes: serializedNodes,
        tracePath: ctx.tracePath.map(String),
      };
    }

    // Select next hop with proximity awareness (Requirements 4.1, 4.5, 5.2)
    const nextHop = this.selectProximityAware(helpers, ctx);

    if (!nextHop) {
      return {
        status: 'NO_CLOSER',
        nodes: serializedNodes,
        tracePath: ctx.tracePath.map(String),
      };
    }

    // Forward recursively (Requirement 4.2)
    const forwardCtx = ctx.forward(this.key);
    this.dedupCache.markForwarded(ctx.lookupId);

    try {
      const result = await nextHop.contact.sendRPC(
        'recursiveFindNodes',
        forwardCtx.serialize()
      );

      // Handle forwarding failure
      if (!result) {
        return {
          status: 'FORWARD_FAILED',
          nodes: serializedNodes,
          tracePath: ctx.tracePath.map(String),
        };
      }

      return result;
    } catch (error) {
      return {
        status: 'FORWARD_FAILED',
        nodes: serializedNodes,
        tracePath: ctx.tracePath.map(String),
        error: error.message
      };
    }
  }

  /**
   * Select the next hop for forwarding, considering proximity if enabled.
   * 
   * This method filters candidates to ensure XOR-distance progress and
   * optionally applies RTT-based proximity scoring.
   * 
   * @param {Helper[]} candidates - Helpers sorted by XOR distance
   * @param {RequestContext} ctx - Current request context
   * @returns {Helper|null} The selected next hop, or null if none valid
   * 
   * Requirements: 4.5, 5.2, 5.4
   */
  selectProximityAware(candidates, ctx) {
    const myDistance = this.distance(ctx.targetId);

    // Filter out visited nodes, self, and nodes that don't make XOR progress
    // Requirement 4.5: Must make strict XOR-distance progress
    const valid = candidates.filter(h => 
      h.key !== this.key && 
      !ctx.hasVisited(h.key) &&
      h.distance < myDistance // Must make progress
    );

    if (valid.length === 0) return null;

    // If proximity routing is disabled, just use closest by XOR
    if (!this.constructor.proximityRoutingEnabled) {
      return valid[0]; // Already sorted by XOR distance
    }

    // Score by XOR distance with RTT bias (Requirement 5.2)
    const weight = this.constructor.proximityWeight;
    let best = null;
    let bestScore = Infinity;

    for (const h of valid) {
      // Default high RTT if unknown (encourages learning)
      const rtt = h.contact.rtt || 1000;
      // Score combines XOR distance with RTT penalty
      // Lower score is better
      const score = Number(h.distance) * (1 + weight * rtt / 1000);
      if (score < bestScore) {
        bestScore = score;
        best = h;
      }
    }

    return best;
  }

  /**
   * Learn from the trace path by updating routing table.
   * 
   * Nodes in the trace path are known to be alive, which accelerates
   * routing table convergence.
   * 
   * @param {BigInt[]} tracePath - Array of node keys from the trace
   * 
   * Requirement: 5.4 (opportunistic learning)
   */
  updateFromTracePath(tracePath) {
    for (const nodeId of tracePath) {
      if (nodeId !== this.key) {
        // Try to find an existing contact for this node
        const contact = this.findContactByKey(nodeId);
        if (contact) {
          // Node is known and alive - refresh in routing table
          this.addToRoutingTable(contact);
        }
      }
    }
  }

  /**
   * Initiate a recursive lookup for the given target key.
   * 
   * This is the entry point for recursive routing when enabled.
   * 
   * @param {BigInt} targetKey - The key to look up
   * @returns {Object} Result with status and nodes
   */
  async initiateRecursiveLookup(targetKey) {
    const ctx = this.createLookupContext(targetKey);
    
    // Start by finding our closest helpers
    const helpers = this.findClosestHelpers(targetKey);
    
    if (helpers.length === 0) {
      return {
        status: 'NO_NODES',
        nodes: [],
        tracePath: [],
      };
    }

    // Select first hop
    const firstHop = this.selectProximityAware(helpers, ctx);
    
    if (!firstHop) {
      // We might be the closest node
      return {
        status: 'NO_CLOSER',
        nodes: helpers.map(h => ({
          key: String(h.key),
          distance: String(h.distance),
          name: h.name
        })),
        tracePath: [],
      };
    }

    // Forward to first hop
    const forwardCtx = ctx.forward(this.key);
    this.dedupCache.add(ctx.lookupId);
    this.dedupCache.markForwarded(ctx.lookupId);

    try {
      const result = await firstHop.contact.sendRPC(
        'recursiveFindNodes',
        forwardCtx.serialize()
      );

      if (!result) {
        return {
          status: 'FORWARD_FAILED',
          nodes: helpers.map(h => ({
            key: String(h.key),
            distance: String(h.distance),
            name: h.name
          })),
          tracePath: [String(this.key)],
        };
      }

      return result;
    } catch (error) {
      return {
        status: 'FORWARD_FAILED',
        nodes: helpers.map(h => ({
          key: String(h.key),
          distance: String(h.distance),
          name: h.name
        })),
        tracePath: [String(this.key)],
        error: error.message
      };
    }
  }
}
