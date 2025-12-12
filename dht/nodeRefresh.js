import { NodeKeys } from './nodeKeys.js';

// The mechanics of periodic refresh (of buckets or stored data).
export class NodeRefresh extends NodeKeys {
  static refreshTimeIntervalMS = 15e3; // Original paper for desktop filesharing was 60 minutes.
  constructor ({refreshTimeIntervalMS = NodeRefresh.refreshTimeIntervalMS, ...properties}) {
    super({refreshTimeIntervalMS, ...properties});
  }
  static stopRefresh() { // Stop all repeat timers in all instances the next time they come around.
    this.constructor.refreshTimeIntervalMS = 0;
  }
  stopRefresh() { // Stop repeat timeers in this instance.
    this.refreshTimeIntervalMS = 0;
  }
  isStopped(interval) {
    return !this.isRunning || 0 === this.refreshTimeIntervalMS || 0 === this.constructor.refreshTimeIntervalMS || 0 === interval;
  }
  fuzzyInterval(target = this.refreshTimeIntervalMS/2, margin = target/2) {
    // Answer a random integer uniformly distributed around target, +/- margin.
    // The default target slightly exceeds the Nyquist condition of sampling at a frequency at
    // least twice the signal being observed. In particular, allowing for some randomization,
    // as long as we're not completely overloaded, we should expect the target to hit at least
    // once for each thing it is trying to detect, and generally happen twice for each detectable event.
    const adjustment = Math.floor(Math.random() * margin);
    return Math.floor(target + margin/2 - adjustment);
  }
  workQueue = Promise.resolve();
  queueWork(thunk) { // Promise to resolve thunk() -- after all previous queued thunks have resolved.
    return this.workQueue = this.workQueue.then(thunk);
  }
  timers = new Map();
  schedule(timerKey, statisticsKey, thunk) {    
    // Schedule thunk() to occur at a fuzzyInterval from now, cancelling any
    // existing timer at the same key. This is used in such a way that:
    // 1. A side effect of calling thunk() is that it will be scheduled again, if appropriate.
    //    E.g., A bucket refresh calls iterate, which schedules, and storeValue schedules.
    // 2. The timerKeys are treated appropriately under Map.
    //    E.g., bucket index 1 === 1 and stored value key BigInt(1) === BigInt(1), but 1 !== BigInt(1)
    if (this.isStopped()) return;
    const start = Date.now();
    const timeout = this.fuzzyInterval();
    this.log('scheduling', statisticsKey, timerKey, 'for', timeout);
    clearInterval(this.timers.get(timerKey));
    this.timers.set(timerKey, setTimeout(async () => {
      const lag = Date.now() - start - timeout;
      this.timers.delete(timerKey);
      if (this.isStopped()) return;
      if (lag > 250) console.log(`** System is overloaded by ${lag.toLocaleString()} ms. **`);
      // Each actual thunk execution is serialized: Each Node executes its OWN various refreshes and probes
      // one at a time. This prevents a node from self-DoS'ing, but of course it does not coordinate across
      // nodes. If the system is bogged down for any reason, then the timeout spacing will get smaller
      // until finally the node is just running flat out.
      this.log('queue', statisticsKey, timerKey, timeout);
      await this.queueWork(thunk);
      this.log('completed work', statisticsKey, timerKey, timeout);      
    }, timeout));
  }
}
  
