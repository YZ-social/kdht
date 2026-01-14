import { Helper } from  './helper.js';
import { NodeMessages } from './nodeMessages.js';

// Probe the network
export class NodeProbe extends NodeMessages {
  // There are only three kinds of rpc results: 'pong', [...helper], {value: something}
  static isValueResult(rpcResult) {
    return rpcResult && rpcResult !== 'pong' && 'value' in rpcResult;
  }
  static isContactsResult(rpcResult) {
    return Array.isArray(rpcResult);
  }
  async step(targetKey, finder, helper, keysSeen, trace) {
    // Get up to k previously unseen Helpers from helper, adding results to keysSeen.
    const contact = helper.contact;
    // this.log('step with', contact.sname);
    let results = await contact.sendRPC(finder, targetKey);
    if (!results) { // disconnected
      if (trace) this.log(helper.name, '=> disconnected');
      this.log('removing unconnected contact', contact.sname);
      await this.removeContact(contact);
      return null; // signal that there is *no* response from this contact - to distinguish from a response that confirms that the contact is alive, even if there are (after filtering) no new contacts to try.
    }
    await this.addToRoutingTable(contact); // Live node, so update bucket.
    // this.log('step added contact', contact.sname);
    if (this.constructor.isContactsResult(results)) { // Keep only those that we have not seen, and note the new ones we have.
      const rawResults = results;
      results = results.filter(helper => !keysSeen.has(helper.key) && keysSeen.add(helper.key)); // add() returns the Set, which is truthy
      // Results are (helpers around) contacts, with distance from the target. Set them up for this host, with contact as sponsor.
      results = results.map(h => new Helper(this.ensureContact(h.contact, contact), h.distance));
      if (trace) {
        const filterMsg = results.length === rawResults.length ? "" : ` after removing ${rawResults.map(h => h.name).filter(name => !results.some(r => r.name === name)).join(', ')}`;
        this.log(`${helper.name} => ${results.length ? results.map(h => h.name) : '<empty>'}${filterMsg}`);
      }
    } else if (trace && false) this.log(`${helper.name} => ${results}`);

    return results;
  }

  static alpha = 3; // How many lookup requests are kept in flight concurrently.
  static queryTimeoutMs = 2000; // Give up on a query after this many ms.
  async iterate(targetKey, finder, k = this.constructor.k, trace = false, timing = false, includeSelf = false) {
    // Promise a best-first list of k Helpers from the network, by repeatedly trying to improve our closest known by applying finder.
    // But if any finder operation answers isValueResult, answer that instead.
    // Note: When a value is found, returns { value, responder } where responder is the Helper that provided the value.
    // This allows callers to identify which node responded. Use isValueResult() to check, and result.value to get the value.
    //
    // Per Kademlia paper: keeps alpha requests in flight while making progress.
    // If alpha consecutive responses fail to find new nodes, escalates to k parallel queries.
    // Terminates when among the k closest nodes we've seen, none have outstanding queries
    // (they've all either responded or timed out).
    //
    // includeSelf: If true, the local node is eligible to be included in the results (currently used only for storeValue).

    if (trace) this.log(`iterate: key=${targetKey}, finder=${finder}, k=${k}`);

    if (targetKey !== this.key) {
      const bucketIndex = this.getBucketIndex(targetKey);
      const bucket = this.routingTable.get(bucketIndex);
      // Subtle: if we don't have one now, but will after, refreshes will be rescheduled by KBucket constructor.
      bucket?.resetRefresh();
    }

    const alpha = this.constructor.alpha;
    const queryTimeoutMs = this.constructor.queryTimeoutMs;
    const isValueResult = this.constructor.isValueResult;
    const iterateStartTime = timing ? Date.now() : 0;
    let requestCount = 0;

    // This is an iterative procedure, starting from the nodes among our own contacts that are
    // closest to the specified target.  The result of findClosestHelpers might turn out to include
    // this node itself, but of course there is no point in sending ourselves a query to request
    // what findClosestHelpers has already delivered, so the node is filtered out before starting
    // the iteration.  In the case of a caller that would be happy for this node to appear in the
    // results (if it is indeed one of the closest), the caller should specify includeSelf=true;
    // this is checked at the end of the method before handing the results back.
    let allNodesSeen = this.findClosestHelpers(targetKey, 2*k).filter(h => h.key !== this.key);
    const keysSeen = new Set(allNodesSeen.map(h => h.key));    // Every key we've seen at all (for filtering in step()).
    keysSeen.add(this.key); // Prevent self from being added via other nodes' responses.

    const queryTimes = new Map(); // helper.key -> timestamp when query was sent
    const respondedKeys = new Set(); // keys of nodes that have responded
    const timedOutKeys = new Set(); // keys of nodes we've given up on
    const disconnectedKeys = new Set(); // keys of nodes that were found to be disconnected
    const queryResponders = []; // helpers that have responded (for building result)
    let responsesWithoutNewNodes = 0; // count of successive empty responses
    let maxInFlight = alpha; // Normal: alpha parallel queries. Escalates to k when a "round" of alpha queries all fail to find new nodes.
    let iterationFinished = false;

    let resolveIteration;
    const iterationPromise = new Promise((resolve) => resolveIteration = (...args) => { iterationFinished = true; resolve(...args) }); // to be resolved with a value result, or undefined

    // Check for timed-out queries based on current time
    const checkTimeouts = () => {
      const now = Date.now();
      for (const [key, sendTime] of queryTimes) {
        if (now - sendTime > queryTimeoutMs) {
          queryTimes.delete(key);
          timedOutKeys.add(key);
          if (trace) this.log('query timed out:', key.toString().slice(0, 8));
        }
      }
    };

    // Check if termination condition is met:
    // Among the k closest nodes we've seen, none have outstanding queries.
    const isComplete = () => {
      const kClosest = allNodesSeen.slice(0, k);
      for (const h of kClosest) {
        // If this node has an outstanding query (not responded, not timed out, not disconnected), not complete
        if (!respondedKeys.has(h.key) && !timedOutKeys.has(h.key) && !disconnectedKeys.has(h.key)) {
          return false;
        }
      }
      return kClosest.length === Math.min(k, allNodesSeen.length);
    };

    // Get the next closest node that needs to be queried
    const getNextToQuery = () => {
      for (const h of allNodesSeen) {
        if (!respondedKeys.has(h.key) && !queryTimes.has(h.key) && !timedOutKeys.has(h.key) && !disconnectedKeys.has(h.key)) {
          return h;
        }
      }
      return null;
    };

    // Handler for when a request completes
    const handleCompletion = (helper, result) => {
      if (iterationFinished) return; // too late

      if (!this.isRunning) {
        resolveIteration();
        return;
      }

      queryTimes.delete(helper.key);

      if (timing && false) {
        const elapsed = Date.now() - iterateStartTime;
        console.log(`  Response: ${elapsed}ms - ${helper.name} (${queryTimes.size} in flight)`);
      }

      // Handle disconnected node (null result from step())
      if (result === null) {
        disconnectedKeys.add(helper.key);
      } else {
        respondedKeys.add(helper.key);
        queryResponders.push(helper);

        // Check for value result (immediate termination, after attempting to add one more storage node)
        if (isValueResult(result)) {
          // Store at closest node that didn't have it (if any). This can cause more than k copies in the network.
          const sortedResponders = [...queryResponders].sort(Helper.compare);
          for (const h of sortedResponders) {
            if (h.key !== helper.key) { // Skip the one that returned the value
              h.contact.store(targetKey, result.value);
              break;
            }
          }

          // Include responder info in the result for diagnostics
          resolveIteration({ value: result.value, responder: helper });
          return;
        }

        // Result is array of Helpers (may be empty if node had no new contacts)
        // Merge new helpers into allNodesSeen and track progress
        if (result.length > 0) {
          allNodesSeen.push(...result);
          allNodesSeen.sort(Helper.compare); // Keep sorted by distance (best-first).
          responsesWithoutNewNodes = 0; // reset counter
          maxInFlight = alpha; // Back to normal parallelism when making progress
        } else {
          responsesWithoutNewNodes++;
          if (responsesWithoutNewNodes >= alpha && maxInFlight < k) {
            // A "round" of alpha queries all failed to find new nodes.
            // Per Kademlia paper: escalate to k parallel queries to cast a wider net.
            maxInFlight = k;
            if (trace) this.log('escalating to', k, 'parallel queries after', alpha, 'empty responses');
          }
        }
      }

      // Check for timeouts and termination
      checkTimeouts();

      if (isComplete()) {
        if (trace) this.log('terminated: k closest nodes all resolved');
        resolveIteration();
        return;
      }

      // Or terminate when network is exhausted (fewer than k nodes available)
      if (queryTimes.size === 0 && !getNextToQuery()) {
        if (trace) this.log('terminated: network exhausted');
        resolveIteration();
        return;
      }

      // Launch requests to maintain maxInFlight in flight
      while (queryTimes.size < maxInFlight && launchNext()) {
        // launchNext returns false when no more candidates
      }
    };

    // Launch a request to the next candidate
    const launchNext = () => {
      const helper = getNextToQuery();
      if (!helper) return false;

      queryTimes.set(helper.key, Date.now());

      if (timing) {
        requestCount++;
        // const elapsed = Date.now() - iterateStartTime;
        // console.log(`  Launch ${requestCount}: ${elapsed}ms - ${helper.name} (${queryTimes.size} in flight)`);
      }

      this.step(targetKey, finder, helper, keysSeen, trace)
        .then(result => handleCompletion(helper, result))
        .catch(err => {
          // Handle errors - treat as disconnected
          handleCompletion(helper, null);
        });

      return true;
    };

    // Handle edge case: no nodes to query (isolated node)
    if (allNodesSeen.length === 0) {
      const contactCount = this.contacts.length;
      this.log(`iterate(${finder}): no nodes to query - isolated node with ${contactCount} contacts in routing table`);
      return [];
    }

    // Launch initial alpha requests
    for (let i = 0; i < alpha; i++) {
      if (!launchNext()) break;
    }

    // Wait for iteration to complete (converged or exhausted, or found a value)
    const valueResult = await iterationPromise; // undefined if no value result was received

    if (timing) {
      const totalElapsed = Date.now() - iterateStartTime;
      console.log(`  Total iterate time: ${totalElapsed}ms (${queryResponders.length} nodes queried)`);
    }

    if (valueResult) {
      if (trace) this.log(`value result: ${valueResult} after responses from ${queryResponders.length} nodes`);
      return valueResult;
    }

    // Build result: k closest nodes that have actually responded
    let closestResponsive = queryResponders
      .sort(Helper.compare)
      .slice(0, k);

    // If includeSelf is true, add self to the results if it belongs among the k closest.
    // This is used for storeValue where we're a valid storage location.
    if (includeSelf) {
      const selfDistance = this.constructor.distance(this.key, targetKey);
      const selfHelper = new Helper(this.contact, selfDistance);
      // Add self to the list and re-sort/slice to get the true k closest
      closestResponsive = [...closestResponsive, selfHelper]
        .sort(Helper.compare)
        .slice(0, k);
    }

    if (trace) this.log('probe result', closestResponsive.map(helper => `${helper.name}@${String(helper.distance).slice(0,2)}[${String(helper.distance).length}]`).join(', '));

    return closestResponsive;
  }
}
