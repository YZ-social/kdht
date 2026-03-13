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

**Current mechanisms:** `findClosestHelpers()` draws only from `this.contacts` (routing-table contacts). Since only proven-alive contacts enter the routing table (B1), this structural invariant already prevents unverified contacts from being propagated to peers.

### B3. Bucket eviction: prefer open contacts
When a bucket is full, evict the least-recently-seen contact only if its data channel is not open. If the head contact is still open, keep it and reject the newcomer (moving the head to the tail as "most recently seen").

**Current mechanisms:** `KBucket.addContact()` checks `head.isOpen` — i.e., whether the WebRTC data channel is truly open (`unsafeData?.readyState === 'open'`), not merely whether a connection promise exists.

### B4. Bucket and storage refresh discover new contacts
Periodic refresh of each bucket should probe a random key in the bucket's range, discovering any new contacts and letting stale ones fall out naturally through failed RPCs.

**Current mechanisms:** `KBucket.refresh()` calls `locateNodes(randomTarget)`, scheduled on a fuzzy interval. `resetRefresh()` restarts the timer whenever an `iterate()` operation targets a key in the bucket's range, since the iterate itself will discover and update contacts. Additionally, storing data (including pub/sub) schedules a refresh of that data, which invokes the same probe mechanism.

**H: Maybe we don't need the bucket refresh of an occupied bucket that also has data stored in that range, since stored data will dominate in a live/used system. However, this must be done carefully because currently the storage refresh timer is reset when someone else beats us to it and stores in us, and yet we would still want to do the probe (without the re-store).**

---

## C. Loose Contacts (Transport without Routing)

### C1. Contacts awaiting routing
A contact with an open transport that hasn't yet been placed in the routing table should be tracked so it can be found by `findContact`/`findContactByKey` and doesn't get lost.

**Current mechanisms:** `looseContacts` array. `noteContactForTransport()` adds contacts; `addToRoutingTable()` removes from looseContacts on successful routing-table insertion.

### C2. Transport capacity limit
The total number of open WebRTC connections must be capped to a platform-specific limit. When at capacity, drop the least valuable existing connection before opening a new one.

**Current mechanisms:** `noteContactForTransport()` checks `nConnections >= maxTransports`. Drop priority: (1) loose contacts first, (2) then from the bucket with the most connections. Avoids dropping sponsors of the incoming contact.

### C3. Dropped transports don't imply death
Dropping a transport connection due to capacity limits (`close`) is different from the far node leaving the network (`bye`). A closed transport means "we can't talk directly right now" but the node may still be reachable through the network.

**Current mechanisms:** `close()` removes from looseContacts and disconnects transport but doesn't call `removeContact` or mark as dead. `bye()` does a full `removeContact(immediate)` plus accelerated bucket refresh.

**H: My intention is that if someone drops a connection to us for being at the maxTransports limit, they should politely send 'close' and we should remove it without marking it dead. But did I implement that correctly?**

---

## D. Suppressing Reconnection to Dead Contacts

### D1. Don't immediately re-add a contact that just failed

After a contact has been determined to be unreachable, we should not create a new Contact for it (from peer mentions, probe responses, etc.) for some cooldown period. Peers may not yet know the contact is dead.

**Current mechanism:**

`removeContact(contact, false)` does two things:
1. Sets `contact.node.isRunning = false`
2. Schedules `delete this.contactDictionary[contact.name]` after `refreshTimeIntervalMS/2` (7.5s)

During the 7.5s window, any code path calling `existingContact()` gets back the non-running contact. `fromNode()` (called by `clone()`) uses `host.existingContact(node.name)` with `contact ||= new this()` — so it reuses the existing non-running Contact rather than creating a fresh one.

**Bug:** The intended suppression mechanism was that `sendRPC` would not try to send to a non-running node, preventing connection attempts during the cooldown. However, `sendRPC` (contact.js) only checks the *sender's* `isRunning`, not the *target's*. Neither `sendRPC` nor `connect()` check the target contact's `isRunning`. So a non-running target contact will still proceed through `connect()` → `createConnection()`, eventually timing out after 30s. The 7.5s window prevents creation of a new Contact object (the non-running one is reused) but does **not** prevent connection attempts. In simulations, `SimulatedContact.transmitRPC` does check `this.isRunning` (the target's), so the mechanism works there — but not in WebRTC mode.

**H (confirming the bug, from D2): "My intent was that there is a current mechanism: that the failed probe marks it as not running; the contactDictionary keeps it around for a while; and that sendRPC won't try to send to a non-running node. Maybe I didn't actually do that?"**

**H: On the dead-exclusion interval: The refresh interval is supposed to be the time at which we observe a change in the network, so mischaracterisations should be re-assessed at that time. The dead-exclusion timeout should not be longer than a refresh. Meanwhile, the dead-exclusion period should be longer than a recursive signaling timeout (though it currently may not be).**

**Proposed (stability-fixes):** `recentlyDead` (name → expiration, 120s cooldown), checked in `connect()`, `deserializeResponse()`, and `nodePubSub.js`. This is a much longer and more aggressive suppression. The need it was addressing is real — see J1 for the pub/sub cascade problem that motivated it.

**Q: Fixing the `sendRPC` bug (adding a target `isRunning` check) would restore the intended suppression mechanism. Combined with consistent use of non-immediate removal (see E3, E5), would the 7.5s contactDictionary window then be sufficient? Or is a longer cooldown still needed?**

### D2. Don't keep trying expensive signaling to unreachable targets
Recursive signal forwarding is expensive per attempt. After a failed attempt, suppress further recursive signaling to the same target for a cooldown period.

**Current mechanisms:** The intended mechanism was `isRunning=false` + contactDictionary retention (D1), but this is broken for WebRTC (see D1 bug above). Per-node recursive forwarding work is bounded by `maxTries` (alpha^3 = 27 hops), but when many nodes simultaneously attempt recursive signaling to the same dead target, the aggregate network load scales with the number of attempting nodes.

**Proposed (stability-fixes):** `signalCooldowns` (name → expiration, 60s).

**H: Does D1's mechanism (once the bug is fixed) handle this? If not, what exactly are the circumstances where it doesn't?**

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
When a probe step gets a null response from `sendRPC`, the code calls `removeContact(contact)` with `immediate=true` — removing all traces.

A null response means the contact had (or was given) a connection, but the RPC produced no result: either the send failed, the connection closed, or the RPC timed out. This is currently treated as definitive evidence that the contact is gone.

**However**, a null response is not necessarily definitive — the contact could be temporarily unreachable (network blip, overloaded node, transient WebRTC issue) rather than permanently gone. Using immediate removal means the contact is instantly forgotten, with no cooldown to prevent re-discovery through the next probe response — leading to a potentially wasteful cycle of create → fail → remove → re-discover.

**H: This should use non-immediate removal (`removeContact(contact, false)`). See E3.**

### E5. Polite disconnect (`bye`)
When a contact explicitly says `bye`, it is disconnecting from the network. Currently this calls `removeContact(this)` (immediate) plus `disconnectTransport` and accelerated bucket refresh.

Because the removal is immediate (no cooldown), the very next probe response could re-introduce the contact. That contact would then fail to respond and be removed again — wasted work.

**H: I think you're right. Maybe no `removeContact` should be immediate.**

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

**Current mechanisms:** During the contactDictionary retention window (~7.5s after soft removal), `existingContact()` returns the non-running contact, which is reused rather than creating a fresh one. However, due to the D1 bug (sendRPC doesn't check target's `isRunning`), this does **not** actually prevent connection attempts — only Contact object creation.

**H: If we did non-immediate removal in all the necessary places (E3, E5, ...), would we still have this problem? If we do, we should understand WHY — i.e., under what circumstances, exactly.**

**Proposed (stability-fixes):** a `recentlyDead` check in `connect()`.

### G2. Connection timeout
If a WebRTC connection isn't established within a timeout, clean up the attempt: null out the connection, remove the contact.

**Current mechanisms:** `createConnection()` sets up a `timerPromise` that fires after `timeoutMS` (default 30s), calls `onclose()` and `removeContact(this)` (immediate).

**H: I can easily imagine that there is an existing bug here. There are several ways a connection can fail and several different timeouts. Do they all clean up properly?**

### G3. Bootstrap uses HTTP; subsequent connections use signaling
The first connection (to a portal node, with no existing connections) uses HTTP POST through the portal server. All subsequent connections use WebRTC signaling relayed through the network (via sponsors or recursive forwarding).

**Current mechanisms:** `createConnection()` checks `bootstrapHost && !host.connections.find(c => c.isOpen)` to choose between `fetchSignals` (HTTP) and `messageSignals` (network relay). The `isOpen` check (rather than simply `!host.connections.length`) ensures that a pending-but-not-yet-open connection doesn't prevent HTTP bootstrap fallback.

**H: The development of `host.connections.find(c => c.isOpen)` was pretty "organic", and there are similar checks (e.g., `nConnections`) that need to be rationalised to be consistent about when to use `isOpen` vs `connection`.**

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

**Current mechanisms:** `recursiveSignals()` with `forwardingTimeout` and `maxTries` limits. `signals()` handler checks direct connection first, then forwards recursively. Forwarding only goes through contacts with `isOpen` (truly open data channels).

**Bug:** The forwarding timeout is currently non-functional. In the `signals()` handler (`nodeMessages.js`), `Contact.forwardingTimeoutMS` is passed as the expiration — but this static property does not exist on `Contact`, so it is `undefined`. Separately, the `forwardingTimeout` getter (`contact.js`) calls `this.rpcTimeout(...)` which returns a *Promise* (from `Node.delay`), then subtracts `this.maxPingMS` (which, being a static, is not found on the instance), producing `NaN`. Both paths result in `Date.now() > expiration` always being `false`, meaning recursive signal chains never time out — only `maxTries` (alpha^3 = 27) limits them.

**H: Oof. Good catch.**

**Proposed (stability-fixes):** `static forwardingTimeoutMS = 14 * this.maxPingMS` (= 4620ms) to fix this.

### H3. Limit recursive forwarding concurrency
Don't allow unbounded concurrent recursive signal-forwarding through a single node.

**Current mechanisms:** Per-node work is bounded by `maxTries` (alpha^3 = 27 hops). There is no explicit concurrency limit on how many concurrent forwarding operations a single node handles.

**H: `recursiveSignals` abandons the search if `forwardingExclusions.length > maxTries`. Isn't that working? Does forwarding concurrency limiting add anything beyond that?**

The argument for limiting: while each individual forwarding chain is bounded, if many nodes simultaneously request forwarding through the same popular node, the aggregate load on that node could crowd out its normal RPC processing. However, once the H2 timeout bug is fixed, each chain also has a time bound, which may make explicit concurrency limiting unnecessary.

**Proposed (stability-fixes):** `pendingForwards` / `maxPendingForwards` (= alpha = 3) to gate forwarding concurrency.

### H4. Give up on unreachable signaling targets
If recursive signaling fails, soft-remove the contact.

**Current mechanisms:** `checkSignals(null)` calls `removeContact(this, false)`.

**H: See D1. Do we need two mechanisms (signalCooldowns + removeContact)?**

**Proposed (stability-fixes):** additionally set a `signalCooldowns` entry to suppress further expensive recursive attempts for 60s (see D2).

---

## I. RPC Handling

### I1. Incoming RPC = proof of life
Any incoming RPC from a contact proves it's alive. Update the routing table.

**Current mechanisms:** `receiveRPC()` calls `addToRoutingTable(sender)`.

### I2. Failed RPC during probe = contact removal
A null response from `sendRPC` during a probe step means the contact is unreachable. Remove it. (See E4 for discussion of whether this should be immediate or soft removal.)

**Current mechanisms:** `step()` calls `removeContact(contact)` (immediate) on null response.

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

The code has no such check; every storage merge triggers `ensureRemoteContact` + `sendRPC('event', ...)` for each subscriber, regardless of whether it is reachable.

**Current mechanisms:** None. **Proposed (stability-fixes):** `isRecentlyDead` checks in `SubStorageItem.merge1()` and `PubStorageItem.merge1()`. The need is real: without throttling, a departed subscriber triggers repeated connection attempts from every node that holds its subscription (potentially all k storage nodes, on every merge). The subscription itself expires after 1 hour.

**H: I think there are two questions: (1) Is it right to add an `isRunning` guard here? Sounds reasonable. (2) Is the timing provided by the recently-dead and/or non-immediate removal correct? I think the answer is "whatever the answer is to D1".**

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
The most critical finding: Howard's intended suppression mechanism — `isRunning=false` preventing RPCs to dead contacts — is not implemented for WebRTC. `sendRPC` only checks the *sender's* `isRunning`. Fixing this would restore the intended D1 mechanism and may reduce or eliminate the need for additional mechanisms like `recentlyDead`.

### Cooldown duration and mechanism (D1)
Howard's guidance: the dead-exclusion timeout should be between a recursive-signaling timeout and the refresh interval. The current 7.5s contactDictionary retention is in roughly the right range but its effectiveness depends on the `sendRPC` bug being fixed first. Once fixed, consistent use of non-immediate removal (E3, E4, E5) combined with serialised connections and `isOpen` checks may be sufficient.

### Consistent use of non-immediate removal (E3, E4, E5)
Howard suggests that switching all `removeContact` calls to non-immediate may be all that is needed, in conjunction with `isOpen` and serialised connections. This requires auditing all `removeContact` call sites.

### Forwarding timeout (H2)
The forwarding timeout mechanism is broken and needs to be fixed. Once fixed, the need for explicit forwarding concurrency limiting (H3) may be reduced.

### Connection failure cleanup (G2)
There are several ways a connection can fail and several different timeouts. A systematic audit is needed to verify they all clean up properly.

### `isOpen` vs `connection` consistency (G3)
Various parts of the code use `connection` (truthy check on promise) vs `isOpen` (data channel actually open) inconsistently. `nConnections`, `connections` getter, `removeLast`, and the `signals()` direct-connection check all use `connection`, while KBucket eviction, sponsor checking, bootstrap fallback, and recursive forwarding use `isOpen`. These should be rationalised.

### Late-response handling (I4)
Needs a solution that handles the case where resolver cleanup causes late responses to be misinterpreted as incoming requests.
