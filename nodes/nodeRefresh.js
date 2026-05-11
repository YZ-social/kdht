import { NodeKeys } from './nodeKeys.js';

// The mechanics of periodic refresh (of buckets or stored data).
export class NodeRefresh extends NodeKeys {
  static refreshTimeIntervalMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  get internalRefreshMS() {
    return this.refreshTimeIntervalMS * 2;
  }
  constructor ({refreshTimeIntervalMS = NodeRefresh.refreshTimeIntervalMS, ...properties}) {
    super({refreshTimeIntervalMS, ...properties});
  }
  static stopRefresh() { // Stop all repeat timers in all instances the next time they come around.
    this.refreshTimeIntervalMS = 0;
  }
  stopRefresh() { // Stop repeat timeers in this instance.
    this.refreshTimeIntervalMS = 0;
  }
  isStopped() {
    // [st]: TODO: it appears that no caller specifies an interval, so it could be removed
    // setting either the instance or static rTIMS to zero is used to bring this node or all nodes, respectively, to a graceful halt (either on a user-controlled local node or as part of a test script)
    return !this.isRunning || 0 === this.refreshTimeIntervalMS || 0 === this.constructor.refreshTimeIntervalMS;
  }
  // The refreshTimeIntervalMS is the number of nominal number milliseconds we expect to be able to handle for short session timems.
  // The actual period between bucket and data refreshes may be more or less than this, depending on how well we deal with churn.
  // That actual average time between refereshes is the default target value here. E.g., this.refreshTimeIntervalMS / 2, or 1.5 * this.refreshTimeIntervalMS, etc.
  fuzzyInterval(target = this.internalRefreshMS, margin = target/2) { // Like static fuzzyInterval with target defaulting to refreshTimeIntervalMS/2.
    return this.constructor.fuzzyInterval(target, margin);
  }
  static fuzzyInterval(target, margin = target/2) {
    // Answer a random integer uniformly distributed around target, +/- margin.
    // The default target slightly exceeds the Nyquist condition of sampling at a frequency at
    // least twice the signal being observed. In particular, allowing for some randomization,
    // as long as we're not completely overloaded, we should expect the target to hit at least
    // once for each thing it is trying to detect, and generally happen twice for each detectable event.
    const adjustment = this.randomInteger(margin);
    return Math.floor(target + margin/2 - adjustment);
  }
  timers = new Map();
  clearRefreshTimers() {
    this.timers.values().forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }
  refreshQueue = Promise.resolve();
  schedule(timerKey, statisticsKey, thunk, timeout = this.fuzzyInterval()) {
    // Schedule thunk() to occur at a fuzzyInterval from now, cancelling any
    // existing timer at the same key. This is used in such a way that:
    // 1. A side effect of calling thunk() is that it will be scheduled again, if appropriate.
    //    E.g., A bucket refresh calls iterate, which schedules, and storeValue schedules.
    // 2. The timerKeys are treated appropriately under Map.
    //    E.g., bucket index 1 === 1 and stored value key BigInt(1) === BigInt(1), but 1 !== BigInt(1)
    if (this.isStopped()) return;
    const start = Date.now();
    clearTimeout(this.timers.get(timerKey));
    this.timers.set(timerKey, setTimeout(async () => {
      const now = Date.now();
      const elapsed = now - start;
      const lag = elapsed - timeout;
      this.timers.delete(timerKey);
      if (this.isStopped()) return;
      this.log('refresh', statisticsKey, timerKey, 'last/lag ms:', elapsed.toLocaleString(), lag.toLocaleString());
      if (lag > 250) console.log(`** System is overloaded by ${lag.toLocaleString()} ms. **`);
      // Each bucket or storage item never schedules anything until that bucket or storage item's refresh is complete.
      // However, different items can overlap in execution, which doesn't work well under high CPU load.
      // Here we it comes time to actually execute, we just do one refresh a time, which further delays the next refresh
      // of any kind.
      await (this.refreshQueue = this.refreshQueue.then(() => thunk()));
      this.noteStatistic(statisticsKey, now);
    }, timeout));
  }
}

