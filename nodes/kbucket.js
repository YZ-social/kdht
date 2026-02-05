const { BigInt } = globalThis; // For linters.

// Bucket in a RoutingTable: a list of up to k Contacts as enforced by addContact().
export class KBucket {  
  constructor(node, index) {
    this.node = node;
    this.index = index;

    // Cache the binary prefix used in randomTarget.
    const keySize = node.constructor.keySize;
    const nLeadingZeros = keySize - 1 - this.index;
    // The next bit after the leading zeros must be one to stay in this bucket.
    this.binaryPrefix = '0b' + '0'.repeat(nLeadingZeros) + '1';
    this.resetRefresh();
    
    // PNS rate limiting state
    this._lastPnsProbeTime = 0;
    this._pnsProbeCount = 0;
    this._pnsProbeWindowStart = 0;
  }

  // PNS configuration (can be overridden via Node class)
  static pnsProbeRateLimit = 10;      // Max probes per window
  static pnsProbeWindowMs = 60000;    // Rate limit window (1 minute)
  static pnsMinProbeIntervalMs = 100; // Minimum time between probes

  contacts = [];
  get length() { // How many do we have (not capacity, which is k.)
    return this.contacts.length;
  } 
  get isFull() {  // Are we at capacity?
    return this.length >= this.node.constructor.k;
  }
  get nConnections() { // How many of our contacts have their own transport connection?
    return this.contacts.reduce((accumulator, contact) => contact.connection ? accumulator + 1 : accumulator, 0);
  }
  get randomTarget() { // Return a key for which this.getBucketIndex will be the given bucketIndex.
    const nodeClass = this.node.constructor;
    const keySize = nodeClass.keySize;
    let binary = this.binaryPrefix;
    // Now fill the rest (if any) with random bits. -2 for the '0b' prefix.
    for (let i = binary.length - 2; i < keySize; i++) binary += Math.round(Math.random());
    const distance = BigInt(binary);
    // Quirk of xor distance that it works backwards like this.
    return this.node.distance(distance);
  }
  async refresh() { // Refresh specified bucket using LocateNodes for a random key in the specified bucket's range.
    if (this.node.isStopped() || !this.contacts.length) return false; // fixme skip isStopped?
    const targetKey = this.randomTarget;
    await this.node.locateNodes(targetKey); // Side-effect is to update this bucket.
    return true;
  }
  resetRefresh(now = false) { // We are organically performing a lookup in this bucket. Reset the timer.
    // clearInterval(this.refreshTimer);
    // this.refreshTimer = this.node.repeat(() => this.refresh(), 'bucket');
    this.node.schedule(this.index, 'bucket', () => this.refresh(), now ? 1 : undefined); // Not zero.
  }

  removeKey(key, deleteIfEmpty = true) { // Removes item specified by key (if present) from bucket and return 'present' if it was, else false.
    const { contacts } = this;
    let index = contacts.findIndex(item => item.key === key);
    if (index !== -1) {
      contacts.splice(index, 1);
      // Subtle: ensures that if contact is later added, it will resetRefresh.
      if (deleteIfEmpty && !contacts.length) this.node.routingTable.delete(this.index);
      return 'present';
    }
    return false;
  }

  addContact(contact) { // Returns 'present' or 'added' if it was added to end within capacity, else false.
    // Resets refresh timer.
    this.node.constructor.assert(contact.node.key !== this.node.key, 'attempt to add self contact to bucket');
    let added = this.removeKey(contact.key, false) || 'added';
    //this.node.log('addContact', contact.name, this.index, added, this.isFull ? 'full' : '');
    if (this.isFull) {
      if (added === 'present') this.node.looseContacts.push(contact); // So no findContact will fail during ping. Should we instead serialize findContact?
      const head = this.contacts[0];
      if (head.connection) { // still alive
	added = false;  // New contact will not be added.
	contact = head; // Add head back, below.
      }
      if (added === 'present') this.node.removeLooseContact(contact.key);
      // In either case (whether re-adding head to tail, or making room from a dead head), remove head now.
      // Subtle: Don't remove before waiting for the ping, as there can be overlap with other activity that could
      // think there's room and thus add it twice.
      this.removeKey(head.key);
    }
    this.contacts.push(contact);
    return added;
  }

  // ============================================================
  // PNS (Proximity Neighbor Selection) Methods
  // Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
  // ============================================================

  /**
   * Check if PNS is enabled for this bucket's node.
   * @returns {boolean} True if PNS is enabled
   */
  get pnsEnabled() {
    return this.node.constructor.pnsEnabled;
  }

  /**
   * Check if a PNS probe is allowed under rate limiting.
   * 
   * Rate limiting ensures we don't generate excessive probing traffic.
   * Requirement: 6.3
   * 
   * @returns {boolean} True if a probe is allowed
   */
  canProbe() {
    const now = Date.now();
    const config = this.constructor;
    
    // Check minimum interval between probes
    if (now - this._lastPnsProbeTime < config.pnsMinProbeIntervalMs) {
      return false;
    }
    
    // Reset window if expired
    if (now - this._pnsProbeWindowStart >= config.pnsProbeWindowMs) {
      this._pnsProbeWindowStart = now;
      this._pnsProbeCount = 0;
    }
    
    // Check rate limit within window
    return this._pnsProbeCount < config.pnsProbeRateLimit;
  }

  /**
   * Record that a PNS probe was performed.
   */
  recordProbe() {
    const now = Date.now();
    this._lastPnsProbeTime = now;
    
    // Reset window if expired
    if (now - this._pnsProbeWindowStart >= this.constructor.pnsProbeWindowMs) {
      this._pnsProbeWindowStart = now;
      this._pnsProbeCount = 0;
    }
    
    this._pnsProbeCount++;
  }

  /**
   * Get the number of probes performed in the current rate limit window.
   * @returns {number} Number of probes in current window
   */
  get probeCount() {
    const now = Date.now();
    // If window expired, count is effectively 0
    if (now - this._pnsProbeWindowStart >= this.constructor.pnsProbeWindowMs) {
      return 0;
    }
    return this._pnsProbeCount;
  }

  /**
   * Perform RTT probing on contacts that don't have RTT measurements.
   * 
   * This method sends ping RPCs to contacts without RTT data to gather
   * proximity information. It respects rate limiting.
   * 
   * Requirements: 6.2, 6.3
   * 
   * @param {number} maxProbes - Maximum number of probes to perform (default: 1)
   * @returns {Promise<number>} Number of probes actually performed
   */
  async probeForRTT(maxProbes = 1) {
    if (!this.pnsEnabled) return 0;
    
    let probesPerformed = 0;
    
    // Find contacts without RTT measurements
    const needsProbing = this.contacts.filter(c => c.rtt === null);
    
    for (const contact of needsProbing) {
      if (probesPerformed >= maxProbes) break;
      if (!this.canProbe()) break;
      
      // Perform a ping to measure RTT
      // The RTT is automatically recorded by sendRPC on success
      await contact.sendRPC('ping', this.node.key);
      this.recordProbe();
      probesPerformed++;
    }
    
    return probesPerformed;
  }

  /**
   * Reorder bucket contacts by proximity (RTT) while preserving bucket structure.
   * 
   * This method sorts contacts within the bucket by RTT (lowest first).
   * It only operates when PNS is enabled and does NOT:
   * - Change which contacts are in the bucket
   * - Merge or reshape buckets
   * - Replace XOR-valid contacts with XOR-invalid ones
   * 
   * Requirements: 6.1, 6.4, 6.5
   * 
   * @returns {boolean} True if reordering was performed
   */
  reorderByProximity() {
    // Only reorder if PNS is enabled (Requirement 6.6 - disabled by default)
    if (!this.pnsEnabled) return false;
    
    // Need at least 2 contacts to reorder
    if (this.contacts.length < 2) return false;
    
    // Store original keys to verify bucket structure is preserved
    const originalKeys = new Set(this.contacts.map(c => c.key));
    
    // Sort contacts by RTT (lowest first)
    // Contacts without RTT (null) are sorted to the end (treated as high RTT)
    this.contacts.sort((a, b) => {
      const rttA = a.rtt ?? Infinity;
      const rttB = b.rtt ?? Infinity;
      
      if (rttA < rttB) return -1;
      if (rttA > rttB) return 1;
      return 0;
    });
    
    // Verify bucket structure is preserved (Requirement 6.4)
    // All original contacts should still be present
    const newKeys = new Set(this.contacts.map(c => c.key));
    for (const key of originalKeys) {
      if (!newKeys.has(key)) {
        // This should never happen - restore original order
        console.error('PNS reorder violated bucket structure');
        return false;
      }
    }
    
    return true;
  }

  /**
   * Perform a full PNS update: probe for RTT if needed, then reorder.
   * 
   * This is a convenience method that combines probing and reordering.
   * It respects rate limiting for probes.
   * 
   * Requirements: 6.1, 6.2, 6.3
   * 
   * @returns {Promise<{probed: number, reordered: boolean}>} Results of the update
   */
  async updateProximityOrder() {
    if (!this.pnsEnabled) {
      return { probed: 0, reordered: false };
    }
    
    // Probe contacts without RTT data (rate-limited)
    const probed = await this.probeForRTT(1);
    
    // Reorder by proximity
    const reordered = this.reorderByProximity();
    
    return { probed, reordered };
  }
}
