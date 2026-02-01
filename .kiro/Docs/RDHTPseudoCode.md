# RDHT Pseudocode: Recursive Kademlia with Source Routing, PR, and PNS

This pseudocode captures the full combined model: recursive Kademlia + source routing + Proximity Routing (PR) + optional PNS + maintenance.

---

## 1. Data Structures

```
NodeID            // k-bit identifier

Contact:
    id: NodeID
    address
    rtt            // optional, cached proximity metric
    lastSeen

RoutingTable:
    buckets[0..k-1]   // XOR-distance indexed k-buckets

RequestContext:
    requestID
    targetID
    path[]           // source route (ordered node IDs)
    seenSet          // deduplication set
    ttl
```

---

## 2. Recursive FIND_NODE with Source Routing + PR

```
procedure RECURSIVE_FIND_NODE(ctx, currentNode):

    if ctx.requestID in currentNode.seenRequests:
        SEND_DUPLICATE_REPLY(ctx, currentNode)
        return

    currentNode.seenRequests.add(ctx.requestID)
    ctx.path.append(currentNode.id)

    UPDATE_ROUTING_TABLE_FROM_PATH(ctx.path)

    if currentNode.id == ctx.targetID:
        SEND_SUCCESS(ctx, currentNode)
        return

    candidates = currentNode.routingTable.closestTo(ctx.targetID)

    // Proximity Routing (PR)
    nextHop = SELECT_PROXIMITY_AWARE(candidates)

    if nextHop == null or ctx.ttl == 0:
        SEND_FAILURE(ctx, currentNode)
        return

    ctx.ttl -= 1
    FORWARD(ctx, nextHop)
```

---

## 3. Proximity-Aware Next-Hop Selection (PR)

```
function SELECT_PROXIMITY_AWARE(candidates):
    best = null
    bestScore = ∞

    for c in candidates:
        score = XOR_DISTANCE(c.id, targetID)

        if c.rtt is known:
            score = score * PROXIMITY_WEIGHT(c.rtt)

        if score < bestScore:
            bestScore = score
            best = c

    return best
```

**Key property:**
> PR never violates XOR monotonicity—it only biases among valid candidates.

---

## 4. Optional Proximity Neighbor Selection (PNS)

```
procedure PNS_SELECT(bucket):
    equivalenceSet = bucket.entries   // same XOR prefix
    sampled = RANDOM_SAMPLE(equivalenceSet, PNS_SAMPLE_SIZE)

    for node in sampled:
        if node.rtt is unknown:
            node.rtt = PROBE(node)

    return SELECT_LOWEST_RTT(equivalenceSet)
```

**Constraints:**
- Rate-limited
- Only within XOR-equivalent peers
- Never replaces all diversity

---

## 5. Message Deduplication + Trace Routing

```
procedure SEND_DUPLICATE_REPLY(ctx, node):
    reply = {
        requestID: ctx.requestID,
        status: DUPLICATE,
        responder: node.id,
        path: ctx.path
    }
    SEND_BACK(reply, ctx.path)
```

**Requester behavior:**

```
on RECEIVE_REPLY(reply):
    if reply.requestID already completed:
        ignore
    else if reply.status == DUPLICATE:
        WAIT_FOR_PRIMARY_OR_TIMEOUT()
```

**Result:**
> No amplification, no loops, no silent drops.

---

## 6. Routing Table Learning (Recursive Side Effect)

```
procedure UPDATE_ROUTING_TABLE_FROM_PATH(path):
    for nodeID in path:
        if nodeID != self.id:
            routingTable.insertOrRefresh(nodeID)
```

> Recursive routing implicitly spreads topology knowledge faster than iterative lookups.

---

## 7. Periodic Maintenance (PR + PNS Safe)

```
procedure PERIODIC_MAINTENANCE():
    for bucket in routingTable.buckets:
        if bucket.isStale():
            target = RANDOM_ID_IN_BUCKET_RANGE(bucket)
            START_RECURSIVE_FIND_NODE(target)

        for node in bucket.entries:
            if not ALIVE(node):
                bucket.remove(node)

        if PNS_ENABLED:
            LIMITED_PNS_REEVALUATION(bucket)
```

**Design guarantees:**
- Preserves k-bucket diversity
- Bounded probing cost
- No convergence violations

---

## 8. Reliability vs Latency Configuration Knobs

```
CONFIG:
    ALPHA              // parallelism
    TTL                // recursion depth
    PNS_SAMPLE_SIZE
    PROXIMITY_WEIGHT
    DEDUP_CACHE_SIZE
    MAINTENANCE_PERIOD
```

---

## 9. Emergent Properties (What This Achieves)

| Property | Mechanism |
|----------|-----------|
| Fast convergence | Recursive forwarding |
| Loop-free | Source routing |
| Low latency | PR + PNS |
| DoS resistance | Deduplication |
| Churn resilience | Recursive refresh |
| Path observability | Trace routing |

---

## 10. One-Sentence Takeaway (Paper-Ready)

> Recursive Kademlia augmented with source routing and proximity awareness achieves faster convergence, lower latency, and stronger resilience by allowing intermediate nodes to learn routing state, suppress duplicate traffic, and bias forwarding decisions without violating XOR-distance correctness.
