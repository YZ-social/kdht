# Contact Handling Desiderata

## Purpose

This document lists the desired behaviours around DHT contact management, combining goals served by all existing mechanisms. The aim is to provide a unified reference that can guide a rationalisation of the code — reducing overlapping mechanisms and ensuring every goal is clearly and simply met.

"Current mechanisms" reflect the code on `main` (including the `serial-connections` merge). Mechanisms from the stability-fixes branch that are not on `main` are marked as "Proposed (stability-fixes)."

Questions for Howard are marked with **Q:**. Howard's responses are marked with **H:**.

---

## A. Node Identity

### A1. Session identity
A node has a unique key each session, and retains that key throughout the session. A session runs from just before bootstrapping the first connection, through (deliberate or observed) disconnection of the last remote contact. A rejoining node (e.g., page reload, bot restart) gets a new key and is a completely new node from the network's perspective — there is no "reconnect" case.

**H: `node.html` behaves this way on reconnect, but not yet on reconnect from tab visibility changes. This has likely caused problems in group testing.**

**ST: TODO**

### A2. Self-exclusion from routing table
A node must never add itself to its own routing table or send RPCs to itself through the network.

**Current mechanisms:** `addToRoutingTable()` has `if (contact.key === this.key) return null;`. `iterate()` filters self out of its query candidates (`allNodesSeen = ... .filter(h => h.key !== this.key)`) and adds `this.key` to `keysSeen` to prevent re-introduction via other nodes' responses.

---

## B. Routing Table Admission

### B1. Proof of life required for routing table
A contact should only be in the routing table if we have direct evidence that the far node is alive — i.e., we have received a successful RPC response from it, or it has sent us an RPC.

**Current mechanisms:** `addToRoutingTable()` is called only from `receiveRPC()` (incoming message) and `step()` (successful probe response), so the call-site gating already ensures proof of life.

### B2. Don't propagate unverified contacts to peers
When responding to a probe (`findNodes` / `findValue`), a node should avoid including contacts it only knows about through hearsay — i.e., contacts mentioned by a third party but never directly verified. Propagating unverified contacts can cause cascades of futile connection attempts across the network.

**Current mechanisms:** `findClosestHelpers()` draws only from `this.contacts` (routing-table contacts). Since only proven-alive contacts enter the routing table (B1), this structural invariant already prevents unverified contacts from being propagated to peers.  Note that a bucket contact is not necessarily connected to this node right now (i.e., is in "Idle" state) - but its presence in the bucket is enough to merit propagation.

### B3. Bucket eviction: prefer open contacts
When a bucket is full, evict the least-recently-seen contact only if its data channel is not open. If the head contact is still open, keep it and reject the newcomer (moving the head to the tail as "most recently seen").

**Current mechanisms:** `KBucket.addContact()` checks `head.isOpen` — i.e., whether the WebRTC data channel is truly open (`unsafeData?.readyState === 'open'`), not merely whether a connection promise exists.

### B4. Bucket and storage refresh discover new contacts
Periodic refresh of each bucket should probe a random key in the bucket's range, discovering any new contacts and letting stale ones fall out naturally through failed RPCs.

**Current mechanisms:** `KBucket.refresh()` calls `locateNodes(randomTarget)`, scheduled on a fuzzy interval. `resetRefresh()` restarts the timer whenever an `iterate()` operation targets a key in the bucket's range, since the iterate itself will discover and update contacts. Additionally, storing data (including pub/sub) schedules a refresh of that data, which invokes the same probe mechanism.

**H: Maybe we don't need the bucket refresh of an occupied bucket that also has data stored in that range, since stored data will dominate in a live/used system. However, this must be done carefully because currently the storage refresh timer is reset when someone else beats us to it and stores in us, and yet we would still want to do the probe (without the re-store).**

**ST: postpone any change for now**

---

## C. Loose Contacts (Transport without Routing)

### C1. Contacts awaiting routing
A contact with an open (or currently opening) transport that hasn't yet been placed in the routing table should be tracked so it can be found by `findContact`/`findContactByKey` and doesn't get lost.

**Current mechanisms:** `looseContacts` array. `noteContactForTransport()` adds contacts; `addToRoutingTable()` removes from looseContacts on successful routing-table insertion.

### C2. Transport capacity limit
The total number of open WebRTC connections must be capped to a platform-specific limit. When at capacity, drop the least valuable existing connection before opening a new one.

**Current mechanisms:** `noteContactForTransport()` checks `nConnections >= maxTransports`. Drop priority: (1) loose contacts first, (2) then from the bucket with the most connections. Avoids dropping sponsors of the incoming contact.

### C3. Politely closed transports
A far node dropping its transport connection due to capacity limits (`close`) is different from the node leaving the network (`bye`). A closed transport means "we can't talk directly right now" but the node may still be reachable through the network.

**Current mechanisms:** `close()` removes from looseContacts and disconnects transport but doesn't call `removeContact` or mark as dead. In contrast, `bye()` does a full `removeContact(immediate)` plus accelerated bucket refresh.

**H: My intention is that if someone drops a connection to us for being at the maxTransports limit, they should politely send 'close' and we should remove it without marking it dead. But did I implement that correctly?**

**ST: Appears correct. In a bucket, 'close' is handled as a transition from Routed to Idle; in loose, by removal from the loose connection (in state terms, moving from Open to Known).**

---

## D. Suppressing Reconnection to Dead Contacts

### D1. Don't immediately re-add a contact that just failed

After a contact has been determined to be unreachable, we should not create a new Contact for it (from peer mentions, probe responses, etc.) for some cooldown period. Peers may be mentioning the contact simply because news of its death hasn't reached them yet.

**Current mechanism:**

`removeContact(contact, false)` does two things:
1. Sets `contact.node.isRunning = false`
2. Schedules `delete this.contactDictionary[contact.name]` after `refreshTimeIntervalMS/2` (7.5s)

`isRunning=false` means we believe the node is dead. During the 7.5s window, any code path calling `existingContact()` gets back this dead-tagged contact and can thus act on its supposed dead status. In particular, `ensureRemoteContact()` — which is how WebRTC probe responses create contacts — checks `existingContact(name)` first and will find the non-running contact, preventing creation of a fresh one. The non-running contact is then blocked from sending RPCs by the `isRunning` check in `sendRPC`.

**Earlier bug:** The intended suppression mechanism was that `sendRPC` would not try to send to a non-running node, preventing connection attempts during the cooldown. However, `sendRPC` (contact.js) was only checking the *sender's* `isRunning`, not the *target's*. So a non-running target contact *would* still proceed through `connect()` → `createConnection()`, eventually timing out after 30s. That has now been fixed.

**H: On the dead-exclusion interval: The refresh interval is supposed to be the time at which we observe a change in the network, so mischaracterisations should be re-assessed at that time. The dead-exclusion timeout should not be longer than a refresh. Meanwhile, the dead-exclusion period should be longer than a recursive signaling timeout (though it currently may not be).**

**ST: With the H2 fix now applied, the recursive signaling timeout is well-defined at ~2.5s (`maxPingMS * recursiveHopsLimit / 2` = `330 * 15 / 2`). The current dead-exclusion interval of 7.5s (`refreshTimeIntervalMS / 2`) satisfies both bounds: it is shorter than the refresh interval (15s) and longer than the signaling timeout (2.5s).**

**Proposed (stability-fixes):** `recentlyDead` (name → expiration, 120s cooldown), checked in `connect()`, `deserializeResponse()`, and `nodePubSub.js`. This is a much longer and more aggressive suppression.

**ST: The `recentlyDead` mechanism is not needed as a separate data structure.** All paths that create contacts and then communicate with them go through `sendRPC`, which now checks the target's `isRunning` (D1 bug fix). During the 7.5s contactDictionary window, the non-running contact is reused and blocked. After 7.5s, a fresh contact may be created if a peer still mentions the dead node, but each such retry is bounded (~2.5s with the H2 fix) and self-limiting as refresh cycles clean stale references from peers' routing tables.

The one case where 7.5s is genuinely insufficient is pub/sub (J1): subscription records persist for up to an hour, so dead subscribers keep being re-encountered on every merge event long after the refresh cycle has cleaned them from routing tables. This is now addressed with a targeted `isRunning` guard in the pub/sub merge code (see J1).

### D2. Don't keep trying expensive signaling to unreachable targets
Recursive signal forwarding is expensive per attempt. After a failed attempt, suppress further recursive signaling to the same target for a cooldown period.

**Current mechanisms:** D1's mechanism now handles this. After a failed signaling attempt, `checkSignals(null)` calls `removeContact(this, false)`, which marks the contact `isRunning=false` and retains it in the contactDictionary for 7.5s. During that window, `sendRPC`'s `isRunning` check (now fixed) blocks any further attempt to reach the contact, including via signaling. Per-node recursive forwarding work is additionally bounded by `maxTries` (alpha^3 = 27 hops) and, with the H2 fix, by a ~2.5s time limit.

The only gap is that after the 7.5s contactDictionary window expires, a peer that hasn't yet learned of the contact's death could re-introduce it in a probe response, triggering one more signaling attempt. However, this is self-limiting: each such attempt costs at most ~2.5s, can occur at most once per 7.5s window, and the 15s refresh cycle is actively cleaning the dead contact out of peers' routing tables.

The multi-node concern — many nodes simultaneously attempting signaling to the same dead target — is not addressable by a per-node cooldown in any case. It is addressed by the natural propagation of routing-table updates through the refresh cycle.

**H: Does D1's mechanism (once the bug is fixed) handle this? If not, what exactly are the circumstances where it doesn't?**

**ST: Yes — with the `sendRPC` bug fixed (D1) and the forwarding timeout fixed (H2), D1's mechanism covers D2. The proposed `signalCooldowns` from stability-fixes is not needed. Pub/sub (J1), where stale subscription records can keep a dead contact's name circulating for up to an hour, now has its own `isRunning` guard.**

---

## E. Contact Lifecycle Transitions

### E1. New contact from peer mention
When a probe response includes a contact we haven't seen before, we should create a Contact for it (to enable later communication) and set up its sponsor.

**Current mechanisms:** `ensureContact()` in `step()` creates the contact with `sponsor` set.

### E2. Proof-of-life promotion
When we receive a direct RPC from (or get a successful RPC response from) a contact, that constitutes proof of life. The contact should be eligible for routing-table placement.

**Current mechanisms:** `addToRoutingTable()` is called from `receiveRPC()` and `step()` (on successful response).

### E3. Soft removal (delayed)
When a contact becomes unreachable but wasn't explicitly disconnected (no `bye`), we should:
- Remove it from the routing table/looseContacts
- Suppress reconnection attempts for a cooldown period
- Eventually clean up all traces

**Current mechanisms:** `removeContact(contact, false)`:
- Sets `contact.node.isRunning = false`
- Removes from routing table / looseContacts
- Schedules `contactDictionary` deletion after `refreshTimeIntervalMS/2`

See D1 for discussion of the cooldown mechanism, including the bug where `sendRPC` doesn't check the target's `isRunning`.

**H: I don't think I've been consistent about when to use `removeContact(contact, false)`. For example, the `!results` case at the top of `node.step()` should use a false second argument. And E5 (bye) should too. It may be that consistent use of non-immediate removal — in conjunction with the other changes in main, such as serialised connections and the use of `isOpen` — is all that is needed.**

### E4. Hard removal (probe failure)
When a probe step gets a null response from `sendRPC`, the code ~~calls `removeContact(contact)` with `immediate=true` — removing all traces~~ now calls `removeContact(contact, false)` (non-immediate), giving the 7.5s cooldown window.

A null response means the contact had (or was given) a connection, but the RPC produced no result: either the send failed, the connection closed, or the RPC timed out. ~~This is currently treated as definitive evidence that the contact is gone.~~ Non-immediate removal retains the contact in contactDictionary as non-running, preventing re-discovery for 7.5s.

**Evidence (2026-03-19 log analysis):** Immediate removal in probe failures was a primary contributor to a cascading network collapse. When browser nodes departed, probe failures immediately deleted contacts, making them eligible for re-discovery in the very next probe response. This fed a signal relay storm (2,573 failed forwarding attempts in ~10 seconds) that saturated server event loops, causing servers to time out on each other and mutually remove each other.

**H: This should use non-immediate removal (`removeContact(contact, false)`). See E3.**

**Fix applied:** `nodeProbe.js` `step()` now passes `false`.

### E5. Polite disconnect (`bye`)
When a contact explicitly says `bye`, it is disconnecting from the network. This calls `removeContact(this, false)` (non-immediate) plus `disconnectTransport` and accelerated bucket refresh.

**H: I think you're right. Maybe no `removeContact` should be immediate.**

**Status:** All `removeContact` call sites now use non-immediate removal. See also E4, G2.

### E6. No "re-welcome" case for new sessions
Because a rejoining node gets a new key (see A), there is no need to balance cooldown duration against re-welcome speed. The old node's routing-table entries expire naturally through failed RPCs and bucket refresh. The new node bootstraps fresh through the portal as a completely new identity.

The remaining reconnection scenarios are within a single session:
- **Network glitch:** Connection drops but the node is still alive. The `onclose` handler fires, triggering soft removal (E7). If the node re-establishes communication (e.g., through a different sponsor), it proves itself alive through RPCs and re-enters the routing table normally.
- **maxTransports eviction:** One side drops the transport and sends `close`. The contact stays in the routing table (C3) and can be reconnected through sponsors or signaling.

### E7. Connection-close removal
When a WebRTC connection is closed (the `onclose` handler fires):
- If the host is still running, this means the connection dropped unexpectedly, so soft-remove the contact.
- If the host has been stopped (shutting down via `disconnect()`), skip `removeContact` — the host is tearing everything down and `isRunning` will be set to false momentarily.

**Current mechanisms:** `onclose` in `createConnection()` checks `this.webrtc && !this.host.isStopped()` before calling `removeContact(this, false)`.

---

## F. Sponsorship

### F1. Track who introduced us
For each contact, remember which other contacts introduced us to it (sponsors). This is needed for signaling — to reach a contact through the network, we first try asking its sponsors (who are likely to have a direct connection).

**Current mechanisms:** `_sponsors` map (key → contact) on each Contact. Set in `ensureContact()` and `ensureRemoteContact()`.

### F2. Don't drop sponsors during transport eviction
When at transport capacity and deciding what to drop, prefer dropping non-sponsors over sponsors of the contact we're trying to connect.

**Current mechanisms:** `noteContactForTransport()` passes `!contact.hasSponsor(element.key)` predicate to `removeLast`.

### F3. Handle stale sponsor references
When a contact C is removed, other contacts that list C as a sponsor retain a stale reference in their `_sponsors`. Rather than cleaning up these reverse references (which would require scanning all contacts — O(N) per removal), the code checks `isOpen` on sponsors before using them.

**Current mechanisms:** `messageSignals()` checks `sponsor.isOpen` before attempting to send through a sponsor, which filters out sponsors whose connections have been closed.

**H: I don't remove from everyone's sponsors, as I don't have an efficient mechanism for doing so. Instead, I check sponsors for liveness (isOpen) before making use of them. We need to make sure this is done consistently everywhere sponsors are used.**

**Proposed (stability-fixes):** `contact._sponsors?.clear()` in `removeContact()` — this clears the removed contact's own sponsor list, which is a separate (smaller) concern from the reverse-reference problem.

### F4. Avoid wasteful connection attempts through stale sponsors (nice to have)
Even though `messageSignals()` checks `isOpen`, there may be other paths where sponsors are used without an `isOpen` check. A systematic audit would ensure consistency.

---

## G. Connection Establishment

### G1. Don't connect to known-dead contacts
Before attempting a WebRTC connection, check whether the target is known to be dead. Don't waste time and resources on a connection that will fail.

**Current mechanisms:** During the contactDictionary retention window (~7.5s after soft removal), `existingContact()` returns the non-running contact, which is reused rather than creating a fresh one. With the D1 `sendRPC` bug now fixed, `sendRPC` checks the target's `isRunning` and returns null before reaching `connect()`, so connection attempts to dead contacts are prevented during the window.

**H: If we did non-immediate removal in all the necessary places (E3, E5, ...), would we still have this problem? If we do, we should understand WHY — i.e., under what circumstances, exactly.**

**ST: With the `sendRPC` bug fixed and consistent non-immediate removal, `connect()` is never reached for a known-dead contact — `sendRPC` blocks it first. The proposed `recentlyDead` check in `connect()` from stability-fixes is not needed. See D1 for full analysis.**

### G2. Connection timeout
If a WebRTC connection isn't established within a timeout, clean up the attempt: null out the connection, remove the contact.

**Current mechanisms:** `createConnection()` sets up a `timerPromise` that fires after `timeoutMS` (default 30s), calls `onclose()` and `removeContact(this, false)` (non-immediate, as of 2026-03-19 fix).

**H: I can easily imagine that there is an existing bug here. There are several ways a connection can fail and several different timeouts. Do they all clean up properly?**

**Fix applied (2026-03-19):** Changed from immediate to non-immediate removal, consistent with E4 and E5.

### G3. Bootstrap uses HTTP; subsequent connections use signaling
The first connection (to a portal node, with no existing connections) uses HTTP POST through the portal server. All subsequent connections use WebRTC signaling relayed through the network (via sponsors or recursive forwarding).

**Current mechanisms:** `createConnection()` checks `bootstrapHost && !host.connections.find(c => c.isOpen)` to choose between `fetchSignals` (HTTP) and `messageSignals` (network relay). The `isOpen` check (rather than simply `!host.connections.length`) ensures that a pending-but-not-yet-open connection doesn't prevent HTTP bootstrap fallback.

**H: The development of `host.connections.find(c => c.isOpen)` was pretty "organic", and there are similar checks (e.g., `nConnections`) that need to be rationalised to be consistent about when to use `isOpen` vs `connection`.**

**Earlier bug:** `fetchSignals` retried indefinitely on non-200 responses with no backoff or retry limit. A portal that was slow to register a worker would trigger a tight retry loop from the bootstrapping node.

**Fix:** Added exponential backoff (1s, 2s, 4s, … capped at 30s) and a retry limit (`maxFetchRetries = 8`). After exhausting retries, calls `checkSignals(null)` to trigger soft removal (H4).

### G4. Serialise connection establishment (optional)
Connection attempts from a single node can optionally be serialised to avoid race conditions, duplicate connections, and resource waste from simultaneous WebRTC setup.

**Current mechanisms:** `connectionQueue` on the home contact — a promise chain through which all outgoing `connect()` calls are serialised. Each `connect()` appends its `createConnection()` call to the queue. This is currently always active (no switch to disable it), but is intended to be optional since serialisation is slower than unconstrained connection establishment.

**Bug:** Incoming connection requests (via `WebContact.signals()`) call `createConnection()` directly, bypassing the `connectionQueue`. This means incoming connections are not serialised.

**H: I had originally intended for the connectionQueue to be part of the `createConnection` implementation so that it would handle both incoming and outgoing, but switched it to the caller so that the simulator would exercise the same code, and forgot to go back and add it to the caller in `WebContact.signals()`. I'll look into doing so.**

Note: Connection serialisation does not limit concurrent signal *forwarding* through a node (forwarding uses existing connections, not new ones).

---

## H. Signaling Path

### H1. Try sponsors first
To reach a contact for signaling, first try its known sponsors (direct, cheap, likely to work).

**Current mechanisms:** `messageSignals()` iterates `_sponsors` and tries `sendRPC('signals', ...)` through each sponsor that has `isOpen` (i.e., a truly open data channel). Tries twice with a 100ms delay.

**H: I do not know why it sometimes works when tried the second time after a delay. Surely that's a clue about something.**

### H2. Fall back to recursive forwarding
If sponsors don't work, forward signals recursively through the network, bounded by time and hop count.

**Current mechanisms:** `recursiveSignals()` with expiration-time and `maxTries` limits. `signals()` handler checks direct connection first, then forwards recursively. Forwarding only goes through contacts with `isOpen` (truly open data channels).

**Earlier bug (now fixed):** The forwarding timeout was non-functional. In the `signals()` handler (`nodeMessages.js`), `Contact.forwardingTimeoutMS` was passed as the expiration — but this static property did not exist on `Contact`, so it was `undefined`. Separately, the `forwardingTimeout` getter (`contact.js`) called `this.rpcTimeout(...)` which returns a *Promise* (from `Node.delay`), then subtracted `this.maxPingMS` (which, being a static, was not found on the instance), producing `NaN`. Both paths resulted in `Date.now() > expiration` always being `false`, meaning recursive signal chains never timed out — only `maxTries` (alpha^3 = 27) limited them.

**Fix:** The `forwardingTimeout` getter has been removed. `messageSignals()` now computes the expiration directly as `Date.now() + maxPingMS * recursiveHopsLimit / 2` (= 2475ms with current settings), and passes it through `recursiveSignals` and the `signals` RPC so that each forwarding node shares the same absolute deadline. The `signals()` handler in `nodeMessages.js` now receives `forwardingExpiration` as a parameter rather than referencing a nonexistent static. Additionally, `rpcTimeout()` was fixed to reference `Contact.maxPingMS` (the static) rather than `this.constructor.maxPingMS` or `this.maxPingMS`.

### H3. Limit recursive forwarding concurrency
Don't allow unbounded concurrent recursive signal-forwarding through a single node.

**Current mechanisms:** Per-node work is bounded by `maxTries` (alpha^3 = 27 hops) and by the H2 time bound (~2.5s). ~~There is no explicit concurrency limit on how many concurrent forwarding operations a single node handles.~~ A `pendingForwards` counter (capped at `alpha = 3`) now gates entry to recursive forwarding in the `signals()` handler. When a node is already handling `alpha` concurrent forwarding operations, additional requests receive a definitive `{forwardingExclusions}` response rather than entering `recursiveSignals`.

**H: `recursiveSignals` abandons the search if `forwardingExclusions.length > maxTries`. Isn't that working? Does forwarding concurrency limiting add anything beyond that?**

**Evidence (2026-03-19 log analysis):** Yes, it adds something essential. While each individual chain is bounded, aggregate load from many simultaneous chains overwhelmed server event loops. In the observed failure, ~15 server nodes simultaneously attempted recursive forwarding to the same dead browser node. The aggregate signal traffic (2,573 failed attempts in ~10s) prevented servers from responding to each other's normal RPCs (`findNodes`), causing cascading mutual timeouts and network collapse. The per-chain bounds (maxTries, H2 timeout) were individually working, but the unbounded *concurrency* of chains through popular forwarding nodes was the problem.

**Fix applied (2026-03-19):** `pendingForwards` counter on `NodeMessages`, checked in `signals()` before entering recursive forwarding. Cap is `alpha` (= 3), matching the per-node branching factor. Uses `try/finally` to ensure the counter is decremented on all code paths.

### H4. Give up on unreachable signaling targets
If recursive signaling fails, soft-remove the contact.

**Current mechanisms:** `checkSignals(null)` calls `removeContact(this, false)`.

**H: See D1. Do we need two mechanisms (signalCooldowns + removeContact)?**

**ST: No — `removeContact(this, false)` in `checkSignals(null)` is sufficient, now that `sendRPC` checks the target's `isRunning`. See D2 analysis.**

---

## I. RPC Handling

### I1. Incoming RPC = proof of life
Any incoming RPC from a contact proves it's alive. Update the routing table.

**Current mechanisms:** `receiveRPC()` calls `addToRoutingTable(sender)`.

### I2. Failed RPC during probe = contact removal
A null response from `sendRPC` during a probe step means the contact is unreachable. Remove it. (See E4 for discussion of whether this should be immediate or soft removal.)

**Current mechanisms:** `step()` calls `removeContact(contact, false)` (non-immediate) on null response. See E4.

### I3. RPC timeout
Each RPC has a timeout based on expected hop count. If no response arrives in time, resolve to null.

**Current mechanisms:** `rpcTimeout()` returns a delay promise. `transmitRPC()` races the response promise against the timeout and the closed promise.

### I4. Discard late responses
If a response arrives after the RPC timed out, it should not cause harmful side effects.

**Current mechanisms:** `transmitRPC()` does not clean up the `messageResolver` on timeout, so a late response finds and calls the stale resolver. This is harmless to the original caller (the resolved promise is no longer awaited), but leaves stale entries in `messageResolvers` until they are eventually resolved — a minor memory leak for long-lived nodes with many timed-out RPCs.

**H: I think it may be even more complicated. If the resolver is removed by the timeout winning the race, then it isn't available at `contact.receiveRPC`, and so the incoming message will be treated as a new RPC request to be handled, rather than a response. At minimum it would need a guard to see if the requested method name exists in the host.**

**Proposed (stability-fixes):** explicit cleanup in `transmitRPC()` (delete the `messageResolver` when timeout or close wins the race) plus a guard in `receiveRPC()` to drop late responses that arrive after cleanup.

**Q: Given Howard's observation, the right approach may be: (a) clean up the resolver on timeout, AND (b) add a guard in `receiveRPC` that checks whether the "method" is actually a known method before dispatching — since a late response's data would fail this check. What form should this guard take?**

---

## J. Pub/Sub

### J1. Don't deliver to dead subscribers
When processing a subscription or publication, check whether the subscriber is recently dead before attempting delivery. This prevents cascades of futile connection attempts when many nodes hold stale subscription records for a departed subscriber.

**Current mechanisms:** `isRunning` guards in both `SubStorageItem.merge1()` and `PubStorageItem.merge1()`, checked on the contact returned by `ensureRemoteContact` before any `sendRPC` call. This leverages D1's existing contactDictionary retention: during the 7.5s window after soft removal, the non-running contact is found and delivery is skipped without attempting connection or signaling.

Subscription records persist for up to an hour (line 59 of `nodePubSub.js`), far outliving the 7.5s contactDictionary window and the ~15s refresh cycle. After the contactDictionary window expires, a merge event will create a fresh contact (via `ensureRemoteContact`) with `isRunning` defaulting to true, passing the guard. The resulting `sendRPC` failure will trigger `removeContact(contact, false)`, re-establishing the suppression for another 7.5s. This limits the cascade to at most one failed attempt per 7.5s window per node, each bounded at ~2.5s by the H2 fix. The subscription itself will eventually expire (1 hour), ending the cycle.

**H: I think there are two questions: (1) Is it right to add an `isRunning` guard here? Sounds reasonable. (2) Is the timing provided by the recently-dead and/or non-immediate removal correct? I think the answer is "whatever the answer is to D1".**

**ST: Done. The `isRunning` guard leverages D1's existing mechanism rather than introducing a parallel `recentlyDead` data structure.**

---

## K. Disconnect (Graceful Shutdown)

### K1. Replicate stored data before leaving
Before disconnecting, copy all stored values to other nodes to maintain the k-replication invariant.

**Current mechanisms:** `disconnect()` calls `replicateStorage()`, which calls `storeValue()` for each stored key.

### K2. Notify connected contacts
Send `bye` to all connected contacts so they can clean up immediately rather than waiting for timeouts.

**Current mechanisms:** `disconnect()` sends `bye` to each connection, then calls `disconnectTransport()`.

### K3. Stop all periodic activity
On disconnect, stop bucket refreshes and storage refreshes to avoid wasted work.

**Current mechanisms:** `disconnect()` calls `stopRefresh()` (sets `refreshTimeIntervalMS = 0`) and then `isRunning = false`.

---

## Overlaps and Open Questions

### The `sendRPC` / `isRunning` bug (D1)
Now fixed. `sendRPC` checks the target's `isRunning`, restoring Howard's intended suppression mechanism. This eliminates the need for `recentlyDead` (D1) and `signalCooldowns` (D2) as separate mechanisms. The pub/sub gap (J1), where stale subscription records outlive the contactDictionary window, is now addressed with a targeted `isRunning` guard in the merge code.

### Cooldown duration and mechanism (D1)
Howard's guidance: the dead-exclusion timeout should be between a recursive-signaling timeout and the refresh interval. With the H2 fix, the signaling timeout is now ~2.5s and the refresh interval is 15s, so the current 7.5s contactDictionary retention sits comfortably between them. Consistent use of non-immediate removal (E3, E4, E5) combined with serialised connections and `isOpen` checks should be sufficient.

### Consistent use of non-immediate removal (E3, E4, E5)
Howard suggests that switching all `removeContact` calls to non-immediate may be all that is needed, in conjunction with `isOpen` and serialised connections. ~~This requires auditing all `removeContact` call sites.~~

**Done (2026-03-19).** All `removeContact` call sites now use non-immediate removal:
- `nodeProbe.js` `step()` (E4): changed from immediate
- `contact.js` `fetchBootstrap()`: changed from immediate
- `webrtc.js` `createConnection()` timeout (G2): changed from immediate
- `contact.js` `bye()` (E5): already non-immediate
- `webrtc.js` `onclose` (E7): already non-immediate
- `contact.js` `checkSignals()` (H4): already non-immediate

### Forwarding timeout (H2)
The forwarding timeout mechanism has been fixed. Recursive signal chains now time out after ~2.5s. ~~This reduces (and may eliminate) the need for explicit forwarding concurrency limiting (H3).~~

**2026-03-19 log analysis showed that H2 alone is not sufficient.** While each chain is individually bounded, the aggregate load from many simultaneous chains through the same nodes can overwhelm event loops. H3 concurrency limiting has now been implemented alongside H2.

### Connection failure cleanup (G2)
There are several ways a connection can fail and several different timeouts. A systematic audit is needed to verify they all clean up properly.

### `isOpen` vs `connection` consistency (G3)
Various parts of the code use `connection` (truthy check on promise) vs `isOpen` (data channel actually open) inconsistently. `nConnections`, `connections` getter, `removeLast`, and the `signals()` direct-connection check all use `connection`, while KBucket eviction, sponsor checking, bootstrap fallback, and recursive forwarding use `isOpen`. These should be rationalised.

### Late-response handling (I4)
Needs a solution that handles the case where resolver cleanup causes late responses to be misinterpreted as incoming requests.

### Dead subscribers and refresh timescale (J1)
The J1 `isRunning` guard blocks delivery to dead subscribers during the contactDictionary retention window (`refreshTimeIntervalMS / 2`). After the window expires, the next storage refresh cycle creates a fresh contact and triggers one wasted signaling attempt (~2.5s) before re-establishing suppression. At production refresh intervals (possibly something like 15 minutes?), the retention window would itself run to many minutes — long enough to cover many storage refresh cycles, giving the guard real teeth. At the current development timescale of 15s, the retention window is only 7.5s while storage refresh fires every ~30s, meaning each storage node wastes one signaling attempt per refresh cycle for up to an hour (the subscription expiry). This overhead scales with the number of storage nodes (k) and the number of dead subscribers with active subscriptions.
