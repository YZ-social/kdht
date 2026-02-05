const { BigInt } = globalThis; // For linters.

/**
 * RequestContext carries source routing metadata through recursive lookups.
 * 
 * This enables:
 * - Unique identification of lookups for deduplication
 * - Trace path for reverse routing of replies
 * - TTL enforcement to prevent unbounded recursion
 * - Loop detection via trace path inspection
 * - Tracking tried paths for alternate path selection on duplicate
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.5
 */
export class RequestContext {
  /**
   * @param {Object} params
   * @param {string} params.lookupId - Unique identifier for this lookup (UUID)
   * @param {BigInt} params.originId - Node key that initiated the lookup
   * @param {BigInt} params.targetId - Key being looked up
   * @param {number} params.ttl - Remaining hops allowed
   * @param {BigInt[]} [params.tracePath] - Array of node keys visited
   * @param {BigInt[]} [params.triedPaths] - Array of node keys that returned DUPLICATE (for alternate path selection)
   * @param {Object} [params.payload] - Optional payload data (e.g., signals for WebRTC)
   */
  constructor({ lookupId, originId, targetId, ttl, tracePath, triedPaths, payload }) {
    this.lookupId = lookupId;
    this.originId = originId;
    this.targetId = targetId;
    this.ttl = ttl;
    this.tracePath = tracePath || [];
    this.triedPaths = triedPaths || [];
    this.payload = payload || null;
  }

  /**
   * Create a new context for forwarding to the next hop.
   * Decrements TTL and appends the forwarding node's key to the trace path.
   * 
   * @param {BigInt} nodeId - The key of the node doing the forwarding
   * @returns {RequestContext} A new context for the forwarded request
   */
  forward(nodeId) {
    return new RequestContext({
      lookupId: this.lookupId,
      originId: this.originId,
      targetId: this.targetId,
      ttl: this.ttl - 1,
      tracePath: [...this.tracePath, nodeId],
      triedPaths: [...this.triedPaths],
      payload: this.payload,
    });
  }

  /**
   * Mark a node as tried (returned DUPLICATE) for alternate path selection.
   * 
   * @param {BigInt} nodeId - The node key that returned DUPLICATE
   * @returns {RequestContext} A new context with the node marked as tried
   * 
   * Requirement: 3.5
   */
  markTried(nodeId) {
    return new RequestContext({
      lookupId: this.lookupId,
      originId: this.originId,
      targetId: this.targetId,
      ttl: this.ttl,
      tracePath: [...this.tracePath],
      triedPaths: [...this.triedPaths, nodeId],
      payload: this.payload,
    });
  }

  /**
   * Check if a node has been tried (returned DUPLICATE).
   * 
   * @param {BigInt} nodeId - The node key to check
   * @returns {boolean} True if the node has been tried
   * 
   * Requirement: 3.5
   */
  hasTried(nodeId) {
    return this.triedPaths.some(id => id === nodeId);
  }

  /**
   * Check if a node has already been visited (loop detection).
   * 
   * @param {BigInt} nodeId - The node key to check
   * @returns {boolean} True if the node is in the trace path
   */
  hasVisited(nodeId) {
    return this.tracePath.some(id => id === nodeId);
  }

  /**
   * Serialize the context for wire transport.
   * Converts BigInt values to strings for JSON compatibility.
   * 
   * @returns {Object} Serialized context suitable for transmission
   */
  serialize() {
    return {
      lookupId: this.lookupId,
      originId: String(this.originId),
      targetId: String(this.targetId),
      ttl: this.ttl,
      tracePath: this.tracePath.map(String),
      triedPaths: this.triedPaths.map(String),
      payload: this.payload,
    };
  }

  /**
   * Deserialize a context from wire transport.
   * Converts string values back to BigInt.
   * 
   * @param {Object} data - Serialized context data
   * @returns {RequestContext} Deserialized context instance
   */
  static deserialize(data) {
    return new RequestContext({
      lookupId: data.lookupId,
      originId: BigInt(data.originId),
      targetId: BigInt(data.targetId),
      ttl: data.ttl,
      tracePath: data.tracePath.map(id => BigInt(id)),
      triedPaths: (data.triedPaths || []).map(id => BigInt(id)),
      payload: data.payload || null,
    });
  }
}
