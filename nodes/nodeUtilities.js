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
      webrtc: Object.assign({}, stat),
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
				      subject: this.name,
				      payload: this.getStatisticsJSON()});
  }
  getStatisticsJSON() {
    const {statistics} = this;
    statistics.connections = this.contacts.map(c => c.connection && c.name).filter(n => n);
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
}

