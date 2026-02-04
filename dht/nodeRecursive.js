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
   * 5. On DUPLICATE response, selecting alternate XOR-valid path
   * 
   * @param {Object} ctxData - Serialized RequestContext
   * @returns {Object} Result with status, nodes, and tracePath
   * 
   * Requirements: 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5
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

    // Try forwarding with alternate path selection on DUPLICATE (Requirement 3.5)
    return await this.forwardWithAlternatePaths(helpers, ctx, serializedNodes);
  }

  /**
   * Forward a recursive lookup, trying alternate paths on DUPLICATE responses.
   * 
   * @param {Helper[]} helpers - Available helpers sorted by XOR distance
   * @param {RequestContext} ctx - Current request context
   * @param {Object[]} serializedNodes - Pre-serialized nodes for response
   * @returns {Object} Result with status, nodes, and tracePath
   * 
   * Requirement: 3.5
   */
  async forwardWithAlternatePaths(helpers, ctx, serializedNodes) {
    let currentCtx = ctx;

    // Try candidates until we get a non-DUPLICATE response or run out of options
    while (true) {
      // Select next hop with proximity awareness, excluding tried paths (Requirements 3.5, 4.1, 4.5, 5.2)
      const nextHop = this.selectProximityAware(helpers, currentCtx);

      if (!nextHop) {
        return {
          status: 'NO_CLOSER',
          nodes: serializedNodes,
          tracePath: ctx.tracePath.map(String),
        };
      }

      // Forward recursively (Requirement 4.2)
      const forwardCtx = currentCtx.forward(this.key);
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await nextHop.contact.sendRPC(
          'recursiveFindNodes',
          forwardCtx.serialize()
        );

        // Handle forwarding failure
        if (!result) {
          // Mark this path as tried and continue to next candidate
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        // On DUPLICATE response, select alternate XOR-valid next hop (Requirement 3.5)
        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        // Non-DUPLICATE response - return it
        return result;
      } catch (error) {
        // Mark this path as tried and continue to next candidate
        currentCtx = currentCtx.markTried(nextHop.key);
        continue;
      }
    }
  }

  /**
   * Select the next hop for forwarding, considering proximity if enabled.
   * 
   * This method filters candidates to ensure XOR-distance progress and
   * optionally applies RTT-based proximity scoring. It also excludes
   * nodes that have been tried (returned DUPLICATE) for alternate path selection.
   * 
   * @param {Helper[]} candidates - Helpers sorted by XOR distance
   * @param {RequestContext} ctx - Current request context
   * @returns {Helper|null} The selected next hop, or null if none valid
   * 
   * Requirements: 3.5, 4.5, 5.2, 5.4
   */
  selectProximityAware(candidates, ctx) {
    const myDistance = this.distance(ctx.targetId);

    // Filter out visited nodes, self, tried nodes, and nodes that don't make XOR progress
    // Requirement 4.5: Must make strict XOR-distance progress
    // Requirement 3.5: Exclude nodes that returned DUPLICATE (tried paths)
    const valid = candidates.filter(h => 
      h.key !== this.key && 
      !ctx.hasVisited(h.key) &&
      !ctx.hasTried(h.key) &&
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
   * Handles DUPLICATE responses by selecting alternate paths.
   * 
   * @param {BigInt} targetKey - The key to look up
   * @returns {Object} Result with status and nodes
   * 
   * Requirement: 3.5
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

    // Add to dedup cache
    this.dedupCache.add(ctx.lookupId);

    let currentCtx = ctx;

    // Try candidates until we get a non-DUPLICATE response or run out of options
    while (true) {
      // Select first hop
      const firstHop = this.selectProximityAware(helpers, currentCtx);
      
      if (!firstHop) {
        // We might be the closest node or all paths exhausted
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
      const forwardCtx = currentCtx.forward(this.key);
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await firstHop.contact.sendRPC(
          'recursiveFindNodes',
          forwardCtx.serialize()
        );

        if (!result) {
          // Mark this path as tried and continue to next candidate
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        // On DUPLICATE response, select alternate XOR-valid next hop (Requirement 3.5)
        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        // Non-DUPLICATE response - return it
        return result;
      } catch (error) {
        // Mark this path as tried and continue to next candidate
        currentCtx = currentCtx.markTried(firstHop.key);
        continue;
      }
    }
  }
}
