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
  fuzzyInterval(target = this.refreshTimeIntervalMS/2, margin = target/3) {
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
  repeat(thunk, statisticsKey, interval) {
    // Answer a timer that will execute thunk() in interval, and then  repeat.
    // If not specified, interval computes a new fuzzyInterval each time it repeats.
    // Does nothing if interval is zero.
    //this.log(statisticsKey, 'interval:', interval, 'instance:', this.refreshTimeIntervalMS, 'class:', this.constructor.refreshTimeIntervalMS);
    if (this.isStopped(interval)) return null;

    // We use repeated setTimer rather than setInterval because it is important in the
    // default case to use a different random interval each time, so that we don't have
    // everything firing at once repeatedly.
    const timeout = (interval === undefined) ?  this.fuzzyInterval() : interval;

    const scheduled = Date.now();
    return setTimeout(async () => {
      if (this.isStopped(interval)) return;
      const fired = Date.now();
      this.repeat(thunk, statisticsKey, interval); // Set it now, so as to not be further delayed by thunk.
      // Each actual thunk execution is serialized: Each Node executes its OWN various refreshes and probes
      // one at a time. This prevents a node from self-DoS'ing, but of course it does not coordinate across
      // nodes. If the system is bogged down for any reason, then the timeout spacing will get smaller
      // until finally the node is just running flat out.
      await this.queueWork(thunk);
      const status = this.constructor._stats?.[statisticsKey];
      if (status) {
	const elapsed = Date.now() - fired; // elapsed in thunk
	const lag = fired - scheduled - timeout;
	status.count++;
	status.elapsed += elapsed;
	status.lag += lag;
      }
    }, timeout);
  }

}
  
