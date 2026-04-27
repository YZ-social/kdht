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
  log(...rest) { if (this.debug) this.flog(...rest); }
  ilog(...rest) { if (this.info || this.debug) this.flog(...rest); }
  flog(...rest) { console.log(new Date().toISOString(), this.sname, ...rest); }
  static assert(ok, ...rest) { // If !ok, log rests and exit.
    if (ok) return;
    console.error(...rest, new Error("Assert failure").stack); // Not throwing error, because we want to exit. But we are grabbing stack.
    globalThis.process?.exit(1);
  }

  // Statistics
  static initialStatisticBuckets() { // Return an accumulator in which to track statistics.
    // Tracks {count, elapsedMS} for every webrtc connection, storage and bucket refresh, and rpc send.
    const stat = {count:0, elapsedMS:0};
    return {
      bucket: Object.assign({}, stat), // copy the model
      storage: Object.assign({}, stat),
      connection: Object.assign({}, stat),
      rpc: Object.assign({}, stat)
    };
  }
  statistics = NodeUtilities.initialStatisticBuckets();
  static publishStatistics = true;
  accumulate1Statistic(name, startTimeMS, accumulator = this.statistics) { // Add to count and elapsedMS in accumulator[name]. Answer count;
    const stat = accumulator?.[name];
    if (!stat) return;
    stat.elapsedMS += Date.now() - startTimeMS;
    ++stat.count;
  }
  static statisticsThrottleMS = 10e3; // Publish stats at most once per this interval.
  lastStatisticsPublish = 0;
  noteStatistic(name, startTimeMS) { // Add to the specified statistic[name], and maybe publish all totals.
    if (this.isStopped()) return;
    this.accumulate1Statistic(name, startTimeMS);
    if (!this.constructor.publishStatistics) return;
    if (name === 'rpc' || name === 'connection') return; // The act of publishing shouldn't increase the counts each time.
    const now = Date.now();
    if (now - this.lastStatisticsPublish < this.constructor.statisticsThrottleMS) return;
    this.lastStatisticsPublish = now;
    this.publishStatistics(name);
  }
  async publishStatistics(triggerName) { // Publish totals.
    // Publish through the portal through which we entered.
    const publish = this.constructor.publishStatistics;
    if (!publish) return Promise.resolve();
    if (typeof(publish) === 'string') // Publish through post to server
      return fetch(`${publish}/stats/${this.sname}`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
	body: JSON.stringify(this.getStatisticsJSON())
      });
    // Publish through DHT.
    const key = this.constructor.statisticsPubKey ||= await this.constructor.key('network statistics');
    return this.contact.publish({key, // contact.publish doesn't fire until we are attached.
				 subject: this.sname,
				 payload: this.getStatisticsJSON()});
  }
  getStatisticsJSON() { // Answer the stastics we publish, including a list of live connections snames.
    const {statistics} = this;
    statistics.connections = this.contacts.map(c => c.connection && c.sname).filter(n => n);
    const keys = {}; // keyStr → { s: hasSub, d: dataTypes, n: eventName, sub: [sname,...] }
    for (const [k, bag] of this.storage) {
      const ks = k.toString();
      const types = Object.keys(bag.types).filter(t =>
        Object.values(bag.types[t]).some(item => !item.isCancelled));
      if (!types.length) continue;
      const entry = {};
      if (types.some(t => t === 'sub' || t === 'event' || t === 'ext')) {
        entry.s = true;
        const subs = bag.types.sub;
        if (subs) {
          const names = Object.values(subs).filter(item => !item.isCancelled).map(item => item.subject);
          if (names.length) entry.sub = names;
        }
      }
      const dataTypes = types.filter(t => t === 'raw' || t === 'pub');
      if (dataTypes.length) entry.d = dataTypes;
      const name = this.keyNames?.get(ks);
      if (name) entry.n = name;
      keys[ks] = entry;
    }
    statistics.keys = keys;
    return statistics;
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

