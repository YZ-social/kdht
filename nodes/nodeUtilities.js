// Some scaffolding for development and debugging.
export class NodeUtilities {
  constructor(properties) {
    Object.assign(this, properties);
  }
  isRunning = true;
  static delay(ms, value) { // Promise to resolve (to nothing) after a given number of milliseconds
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms), value));
  }
  static randomInteger(max) { // Return a random number between 0 (inclusive) and max (exclusive).
    return Math.floor(Math.random() * max);
  }

  debug = false;
  info = true;
  get sname() { // The home contact sname, or just name if no contact
    return this.contact?.sname || this.name;
  }
  log(...rest) { if (this.debug) this.flog(new Date(), this.sname, ...rest); }
  ilog(...rest) { if (this.info || this.debug) this.flog(...rest); }
  flog(...rest) { console.log(new Date().toISOString(), this.sname, ...rest); }
  static assert(ok, ...rest) { // If !ok, log rests and exit.
    if (ok) return;
    console.error(...rest, new Error("Assert failure").stack); // Not throwing error, because we want to exit. But we are grabbing stack.
    globalThis.process?.exit(1);
  }

  static initialStatisticBuckets() {
    const stat = {count:0, elapsed:0};
    return {
      bucket: Object.assign({}, stat), // copy the model
      storage: Object.assign({}, stat),
      connection: Object.assign({}, stat),
      rpc: Object.assign({}, stat)
    };
  }
  static recordStatistic(accumulator, startTimeMS, name) {
    const stat = accumulator?.[name];
    if (!stat) return;
    stat.count++;
    stat.elapsed += Date.now() - startTimeMS;
  }
  static publishStatistics = false;
  statistics = NodeUtilities.initialStatisticBuckets();
  noteStatistic(startTimeMS, name) {
    if (!this.constructor.publishStatistics) return;
    this.constructor.recordStatistic(this.statistics, startTimeMS, name);
    this.constructor.noteStatistic(startTimeMS, name);
    if (name !== 'rpc') this.publish({eventName: 'network statistics',
				      subject: this.sname,
				      payload: this.getStatisticsJSON()});
  }
  getStatisticsJSON() {
    const {statistics} = this;
    statistics.connections = this.contacts.map(c => c.connection && c.sname).filter(n => n);
    return statistics;
  }

  // I expect this class/global version  to be phased out, in favor of the instance/publishing version, above.
  static _stats = {};
  static get statistics() { // Return {bucket, storage, rpc}, where each value is [elapsedInSeconds, count, averageInMSToNearestTenth].
    // If Nodes.contacts is populated, also report average number of buckets and contacts.
    const { _stats } = this;
    if (this.contacts?.length) {
      let buckets = 0, contacts = 0, stored = 0;
      for (const {node} of this.contacts) {
	stored += node.storage.size;
	node.forEachBucket(bucket => {
	  buckets++;
	  contacts += bucket.contacts.length;
	  return true;
	});
      }
      _stats.contacts = Math.round(contacts/this.contacts.length);
      _stats.stored = Math.round(stored/this.contacts.length);
      _stats.buckets = Math.round(buckets/this.contacts.length);
    }
    return _stats;
  }
  static resetStatistics() { // Reset statistics to zero.
    this._stats = this.initialStatisticBuckets();
  }
  static noteStatistic(startTimeMS, name) { // Given a startTimeMS, update statistics bucket for name.
    this.recordStatistic(this._stats, startTimeMS, name);
  }
  healthReport() { // Log key metrics for diagnosing overload.
    const resolvers = this.messageResolvers?.size || 0;
    const connections = this.nConnections;
    const open = this.connections.filter(c => c.isOpen).length;
    const forwards = this.pendingForwards || 0;
    const timers = this.timers?.size || 0;
    const loose = this.looseContacts?.length || 0;
    const contacts = this.contacts?.length || 0;
    const cooldowns = this.signalCooldowns?.size || 0;
    const dead = this.recentlyDead?.size || 0;
    const stored = this.storage?.size || 0;
    // Measure event loop lag: schedule a 0ms timer and see how long it actually takes.
    const mem = globalThis.process?.memoryUsage?.();
    const rss = mem ? Math.round(mem.rss / 1048576) : '?';
    const heap = mem ? Math.round(mem.heapUsed / 1048576) : '?';
    const ext = mem ? Math.round(mem.external / 1048576) : '?';
    const lagStart = Date.now();
    setTimeout(() => {
      const lag = Date.now() - lagStart;
      this.flog(`HEALTH lag:${lag}ms resolvers:${resolvers} open:${open} conns:${connections} contacts:${contacts} loose:${loose} fwds:${forwards} timers:${timers} cooldowns:${cooldowns} dead:${dead} stored:${stored} rss:${rss}MB heap:${heap}MB ext:${ext}MB`);
    }, 0);
  }
  report(logger = console.log) { // return logger( a string description of node )
    let report = `Node: ${this.contact?.report || this.name}, ${this.nConnections} connections`;
    function contactsString(contacts) { return contacts.map(contact => contact.report).join(', '); }
    if (this.storage.size) {
      report += `\n  storing ${this.storage.size}: ` +
	Array.from(this.storage.entries()).map(([k, v]) => `${k}n: ${v.toString()}`).join(', ');
    }
    if (this.looseContacts.length) {
      report += `\n  transports ${this.looseContacts.map(contact => contact.report).join(', ')}`;
    }
    for (let index = 0; index < this.constructor.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      report += `\n  ${index} (${bucket.contacts.length}): ` + (contactsString(bucket.contacts) || '-');
    }
    return logger ? logger(report) : report;
  }

  static reportAll() {
    this.contacts?.forEach(contact => contact.node.report());
  }
  getContactsData() {
    // Returns array of contact data for visualization.
    // Each entry: { differingBits, log2Distance, name, key, isConnected }
    // differingBits = bucketIndex + 1 = number of bits that differ in the address
    const contacts = [];
    for (let index = 0; index < this.constructor.keySize; index++) {
      const bucket = this.routingTable.get(index);
      if (!bucket) continue;
      for (const contact of bucket.contacts) {
        const distance = this.constructor.distance(this.key, contact.key);
        contacts.push({
          differingBits: index + 1,
          log2Distance: this.constructor.log2BigInt(distance),
          name: contact.sname,
          key: contact.key,
          isConnected: !!contact.connection
        });
      }
    }
    return contacts;
  }
  static log2BigInt(n) {
    // Compute log2 of a BigInt with decimal precision.
    if (n <= 0n) return 0;
    const bitStr = n.toString(2);
    const bitLength = bitStr.length;
    // Use up to 52 leading bits for fractional precision (JS number precision limit)
    const leadingBits = bitStr.slice(0, 52);
    const leadingValue = parseInt(leadingBits, 2);
    return (bitLength - leadingBits.length) + Math.log2(leadingValue);
  }
}

