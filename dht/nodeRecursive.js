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
      name: h.contact.sname  // Use sname to preserve server signifier (S prefix)
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
            name: h.contact.sname  // Use sname to preserve server signifier (S prefix)
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

  // ============================================================
  // Recursive Locate - Node/Value lookup using R/Kademlia routing
  // ============================================================

  /**
   * Recursively locate nodes closest to a target key.
   * 
   * This is the R/Kademlia replacement for iterative locateNodes.
   * Uses recursive routing where intermediate nodes forward requests.
   * 
   * Unlike iterative routing where each RPC naturally creates connections,
   * recursive routing does the lookup server-side. We must proactively
   * connect to discovered nodes to populate our routing table.
   * 
   * @param {BigInt} targetKey - The key to look up
   * @param {number} k - Number of closest nodes to return
   * @param {boolean} includeSelf - Whether to include self in results
   * @returns {Helper[]} Array of k closest Helpers
   */
  async recursiveLocateNodes(targetKey, k = this.constructor.k, includeSelf = false) {
    const result = await this.initiateRecursiveLookup(targetKey);
    
    // Convert result nodes back to Helpers
    // IMPORTANT: We must create contacts for discovered nodes, not just find existing ones.
    // This is how the routing table gets populated during recursive lookups.
    let helpers = [];
    const contactsToConnect = [];
    
    if (result.nodes && result.nodes.length > 0) {
      const { Helper } = await import('../nodes/helper.js');
      for (const nodeData of result.nodes) {
        // First try to find existing contact
        let contact = this.findContactByKey(BigInt(nodeData.key));
        
        // If not found, create a new contact using ensureRemoteContact
        // The name field contains the sname which can be used to create the contact
        if (!contact && nodeData.name && this.contact.ensureRemoteContact) {
          try {
            contact = await this.contact.ensureRemoteContact(nodeData.name);
            // Add to routing table so we can connect to it later
            if (contact) {
              this.addToRoutingTable(contact);
            }
          } catch (e) {
            // Failed to create contact, skip this node
            this.log('Failed to create contact for', nodeData.name, e);
          }
        }
        
        if (contact) {
          helpers.push(new Helper(contact, BigInt(nodeData.distance)));
          // Queue for connection if not already connected and not self
          if (contact.key !== this.key && !contact.connection) {
            contactsToConnect.push(contact);
          }
        }
      }
    }
    
    // If we didn't get enough from recursive lookup, supplement with local knowledge
    if (helpers.length < k) {
      const localHelpers = this.findClosestHelpers(targetKey, k * 2);
      for (const h of localHelpers) {
        if (!helpers.some(existing => existing.key === h.key)) {
          helpers.push(h);
        }
      }
    }
    
    // Sort by distance and take k closest
    const { Helper } = await import('../nodes/helper.js');
    helpers.sort(Helper.compare);
    
    // Include self if requested
    if (includeSelf) {
      const selfDistance = this.constructor.distance(this.key, targetKey);
      const selfHelper = new Helper(this.contact, selfDistance);
      helpers.push(selfHelper);
      helpers.sort(Helper.compare);
    }
    
    const finalHelpers = helpers.slice(0, k);
    
    // Proactively connect to discovered nodes (up to k)
    // This is essential for recursive routing - unlike iterative routing where
    // each RPC naturally creates connections, we must explicitly connect.
    // Do this in parallel but don't wait for all to complete.
    if (contactsToConnect.length > 0) {
      const connectPromises = contactsToConnect.slice(0, k).map(async contact => {
        try {
          await contact.connect();
          this.addToRoutingTable(contact);
        } catch (e) {
          // Connection failed, that's ok - we'll try again later
          this.log('Failed to connect to discovered node', contact.sname, e);
        }
      });
      // Don't await all - let connections happen in background
      // But wait for at least a few to establish
      await Promise.race([
        Promise.all(connectPromises),
        new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
      ]);
    }
    
    return finalHelpers;
  }

  /**
   * RPC handler for recursive FIND_VALUE requests.
   * 
   * Like recursiveFindNodes but returns value if found locally.
   * 
   * @param {Object} ctxData - Serialized RequestContext
   * @returns {Object} Result with status, value/nodes, and tracePath
   */
  async recursiveFindValue(ctxData) {
    // Deserialize context
    const ctx = RequestContext.deserialize(ctxData);

    // Deduplication check
    if (this.dedupCache.has(ctx.lookupId)) {
      return { 
        status: 'DUPLICATE', 
        tracePath: ctx.tracePath.map(String),
        reason: 'lookup_id_seen'
      };
    }

    // Loop detection
    if (ctx.hasVisited(this.key)) {
      return { 
        status: 'DUPLICATE', 
        tracePath: ctx.tracePath.map(String),
        reason: 'loop_detected'
      };
    }

    // Record in dedup cache
    this.dedupCache.add(ctx.lookupId);

    // Update routing table from trace path
    this.updateFromTracePath(ctx.tracePath);

    // Check if we have the value locally
    const value = this.retrieveLocally(ctx.targetId);
    if (value !== undefined) {
      return {
        status: 'FOUND_VALUE',
        value: value,
        tracePath: ctx.tracePath.map(String),
      };
    }

    // Get closest helpers to target
    const helpers = this.findClosestHelpers(ctx.targetId);
    const serializedNodes = helpers.map(h => ({
      key: String(h.key),
      distance: String(h.distance),
      name: h.contact.sname  // Use sname to preserve server signifier (S prefix)
    }));

    // Check TTL
    if (ctx.ttl <= 0) {
      return {
        status: 'TTL_EXPIRED',
        nodes: serializedNodes,
        tracePath: ctx.tracePath.map(String),
      };
    }

    // Forward recursively with alternate path selection
    return await this.forwardFindValueWithAlternatePaths(helpers, ctx, serializedNodes);
  }

  /**
   * Forward a recursive find value, trying alternate paths on DUPLICATE responses.
   */
  async forwardFindValueWithAlternatePaths(helpers, ctx, serializedNodes) {
    let currentCtx = ctx;

    while (true) {
      const nextHop = this.selectProximityAware(helpers, currentCtx);

      if (!nextHop) {
        return {
          status: 'NO_CLOSER',
          nodes: serializedNodes,
          tracePath: ctx.tracePath.map(String),
        };
      }

      const forwardCtx = currentCtx.forward(this.key);
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await nextHop.contact.sendRPC(
          'recursiveFindValue',
          forwardCtx.serialize()
        );

        if (!result) {
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        return result;
      } catch (error) {
        currentCtx = currentCtx.markTried(nextHop.key);
        continue;
      }
    }
  }

  /**
   * Recursively locate a value by key.
   * 
   * This is the R/Kademlia replacement for iterative locateValue.
   * Uses recursive routing where intermediate nodes forward requests.
   * 
   * @param {BigInt} targetKey - The key to look up
   * @returns {any} The value if found, undefined otherwise
   */
  async recursiveLocateValue(targetKey) {
    const ctx = this.createLookupContext(targetKey);
    
    // Start by finding our closest helpers
    const helpers = this.findClosestHelpers(targetKey);
    
    if (helpers.length === 0) {
      return undefined;
    }

    // Add to dedup cache
    this.dedupCache.add(ctx.lookupId);

    let currentCtx = ctx;

    while (true) {
      const firstHop = this.selectProximityAware(helpers, currentCtx);
      
      if (!firstHop) {
        return undefined;
      }

      const forwardCtx = currentCtx.forward(this.key);
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await firstHop.contact.sendRPC(
          'recursiveFindValue',
          forwardCtx.serialize()
        );

        if (!result) {
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        if (result.status === 'FOUND_VALUE') {
          return result.value;
        }

        // No value found in this path
        return undefined;
      } catch (error) {
        currentCtx = currentCtx.markTried(firstHop.key);
        continue;
      }
    }
  }

  // ============================================================
  // Recursive Signals - WebRTC signaling using R/Kademlia routing
  // ============================================================

  /**
   * RPC handler for recursive signals forwarding.
   * 
   * This replaces the old recursiveSignals in NodeMessages with proper
   * R/Kademlia routing: deduplication, TTL, trace path, and proximity-aware
   * next-hop selection.
   * 
   * @param {Object} ctxData - Serialized RequestContext with signals payload
   * @returns {Object} Result with status, result (signals), and forwardingExclusions
   */
  async recursiveSignals(ctxData) {
    // Deserialize context
    const ctx = RequestContext.deserialize(ctxData);
    const { signals, targetNameForDebugging } = ctx.payload || {};

    // Build forwardingExclusions from trace path for backward compatibility
    const forwardingExclusions = ctx.tracePath.map(id => {
      const contact = this.findContactByKey(id);
      return contact?.name || String(id);
    });

    // Deduplication check
    if (this.dedupCache.has(ctx.lookupId)) {
      return { 
        status: 'DUPLICATE', 
        result: null,
        forwardingExclusions,
        reason: 'lookup_id_seen'
      };
    }

    // Loop detection
    if (ctx.hasVisited(this.key)) {
      return { 
        status: 'DUPLICATE', 
        result: null,
        forwardingExclusions,
        reason: 'loop_detected'
      };
    }

    // Record in dedup cache
    this.dedupCache.add(ctx.lookupId);

    // Update routing table from trace path
    this.updateFromTracePath(ctx.tracePath);

    // Add ourselves to forwardingExclusions
    forwardingExclusions.push(this.name);

    // Check if we are the target - pass signals to our home contact
    if (this.key === ctx.targetId) {
      const result = await this.contact.signals(...signals);
      return {
        status: 'FOUND',
        result,
        forwardingExclusions,
      };
    }

    // Check if we have a direct connection to the target
    const directContact = this.findContactByKey(ctx.targetId);
    if (directContact && directContact.connection) {
      const response = await directContact.sendRPC('signals', ctx.targetId, signals, forwardingExclusions, targetNameForDebugging);
      if (response) {
        return {
          status: 'FOUND',
          result: response.result,
          forwardingExclusions: response.forwardingExclusions || forwardingExclusions,
        };
      }
      // Direct connection failed, fall through to recursive forwarding
    }

    // Check TTL
    if (ctx.ttl <= 0) {
      this.log('TTL expired for recursive signals to', targetNameForDebugging);
      return {
        status: 'TTL_EXPIRED',
        result: null,
        forwardingExclusions,
      };
    }

    // Forward recursively with alternate path selection
    return await this.forwardSignalsWithAlternatePaths(ctx, signals, forwardingExclusions, targetNameForDebugging);
  }

  /**
   * Forward signals recursively, trying alternate paths on failure.
   * 
   * @param {RequestContext} ctx - Current request context
   * @param {Array} signals - The WebRTC signals payload
   * @param {Array} forwardingExclusions - Names of nodes already tried
   * @param {string} targetNameForDebugging - Target name for logging
   * @returns {Object} Result with status, result, and forwardingExclusions
   */
  async forwardSignalsWithAlternatePaths(ctx, signals, forwardingExclusions, targetNameForDebugging) {
    const helpers = this.findClosestHelpers(ctx.targetId);
    let currentCtx = ctx;

    // Try candidates until we get a successful response or run out of options
    while (true) {
      const nextHop = this.selectProximityAware(helpers, currentCtx);

      if (!nextHop) {
        this.log('No closer node for recursive signals to', targetNameForDebugging);
        return {
          status: 'NO_CLOSER',
          result: null,
          forwardingExclusions,
        };
      }

      // Skip if no connection
      if (!nextHop.contact.connection) {
        currentCtx = currentCtx.markTried(nextHop.key);
        continue;
      }

      // Skip if already in forwardingExclusions (for backward compat with old signals)
      if (forwardingExclusions.includes(nextHop.contact.name)) {
        currentCtx = currentCtx.markTried(nextHop.key);
        continue;
      }

      // Forward recursively
      const forwardCtx = currentCtx.forward(this.key);
      // Include signals payload in the forwarded context
      forwardCtx.payload = { signals, targetNameForDebugging };
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await nextHop.contact.sendRPC(
          'recursiveSignals',
          forwardCtx.serialize()
        );

        // Handle forwarding failure
        if (!result) {
          forwardingExclusions.push(nextHop.contact.name);
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        // On DUPLICATE response, try alternate path
        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(nextHop.key);
          continue;
        }

        // Success or terminal failure - return it
        return result;
      } catch (error) {
        forwardingExclusions.push(nextHop.contact.name);
        currentCtx = currentCtx.markTried(nextHop.key);
        continue;
      }
    }
  }

  /**
   * Initiate recursive signals forwarding to a target key.
   * 
   * This is the entry point that replaces the old recursiveSignals call
   * in NodeMessages.signals(). It uses R/Kademlia routing with proper
   * deduplication, TTL, and proximity-aware forwarding.
   * 
   * @param {BigInt} key - Target node key
   * @param {Array} signals - WebRTC signals payload [senderSname, ...signals]
   * @param {Array} forwardingExclusions - Names already tried (for backward compat)
   * @param {number} expiration - Timeout timestamp (ignored, we use TTL instead)
   * @param {string} targetNameForDebugging - Target name for logging
   * @returns {Object} Result with {result, forwardingExclusions} or null
   */
  async initiateRecursiveSignals(key, signals, forwardingExclusions = [], expiration, targetNameForDebugging) {
    const ctx = this.createLookupContext(key);
    // Store signals in payload
    ctx.payload = { signals, targetNameForDebugging };

    // Add ourselves to dedup cache
    this.dedupCache.add(ctx.lookupId);

    // Initialize forwardingExclusions with ourselves
    forwardingExclusions.push(this.name);

    const helpers = this.findClosestHelpers(key);
    
    if (helpers.length === 0) {
      return {
        result: null,
        forwardingExclusions,
      };
    }

    let currentCtx = ctx;

    // Try candidates until we get a successful response or run out of options
    while (true) {
      const firstHop = this.selectProximityAware(helpers, currentCtx);
      
      if (!firstHop) {
        this.log('Unable to forward recursive signals to', targetNameForDebugging, 
          'among', helpers.filter(h => h.contact.connection).length, 'available contacts.');
        return {
          result: null,
          forwardingExclusions,
        };
      }

      // Skip if no connection
      if (!firstHop.contact.connection) {
        currentCtx = currentCtx.markTried(firstHop.key);
        continue;
      }

      // Skip if already tried
      if (forwardingExclusions.includes(firstHop.contact.name)) {
        currentCtx = currentCtx.markTried(firstHop.key);
        continue;
      }

      // Forward to first hop
      const forwardCtx = currentCtx.forward(this.key);
      forwardCtx.payload = { signals, targetNameForDebugging };
      this.dedupCache.markForwarded(ctx.lookupId);

      try {
        const result = await firstHop.contact.sendRPC(
          'recursiveSignals',
          forwardCtx.serialize()
        );

        if (!result) {
          forwardingExclusions.push(firstHop.contact.name);
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        // On DUPLICATE, try alternate path
        if (result.status === 'DUPLICATE') {
          currentCtx = currentCtx.markTried(firstHop.key);
          continue;
        }

        // Return the result in the expected format
        return {
          result: result.result,
          forwardingExclusions: result.forwardingExclusions || forwardingExclusions,
        };
      } catch (error) {
        forwardingExclusions.push(firstHop.contact.name);
        currentCtx = currentCtx.markTried(firstHop.key);
        continue;
      }
    }
  }
}
