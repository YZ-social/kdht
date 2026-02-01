# Recommended Design: Recursive Kademlia with Source Routing, PR, and PNS

## High-Level Recommendation

We recommend a recursive Kademlia-based DHT augmented with:

- **Source routing** (for reply control, tracing, and deduplication)
- **Proximity Routing (PR)** for low-overhead latency optimization
- **Proximity Neighbor Selection (PNS)** for optional, higher-performance deployments

This configuration preserves Kademlia's correctness and reachability guarantees while improving lookup latency, routing table convergence, and resilience under churn, provided that periodic maintenance is performed according to the lifecycle outlined below.

---

## Core Routing Model

### Recursive Routing (Primary Mode)

- Lookup requests are forwarded hop-by-hop by intermediate nodes
- Each hop must strictly reduce XOR distance to the target ID
- Intermediate nodes observe upstream and downstream peers, accelerating node discovery

**Benefits:**
- Faster routing table convergence
- Passive dissemination of node IDs
- Reduced reliance on explicit refresh traffic

### Source Routing (Supplemental)

Each recursive request carries:
- A bounded hop list or trace token
- A unique lookup/message ID

Replies may return via:
- The reverse path (preferred for tracing/deduplication)
- Or directly to the originator

**Benefits:**
- Enables loop detection and message deduplication
- Supports tracer routing and amplification mitigation
- Restores partial originator visibility without iterative routing

---

## Proximity Optimizations

### Proximity Routing (PR)

- At each hop, the next peer is chosen from XOR-valid candidates using proximity (e.g., RTT) as a secondary criterion
- Proximity metrics are gathered opportunistically during normal RPCs

**Key Properties:**
- No additional probing traffic
- No changes to bucket structure
- Safe under high churn

> **PR SHOULD be enabled by default.**

### Proximity Neighbor Selection (PNS) (Optional)

- Within each k-bucket, entries are ranked by proximity
- Limited RTT probes are used to compare XOR-equivalent candidates
- Buckets are reordered, never reshaped or merged

**Key Properties:**
- Best achievable lookup latency
- Modest probing overhead
- Requires careful rate limiting

> **PNS SHOULD be configurable and disabled by default in bandwidth-constrained environments.**

---

## Maintenance Lifecycle (Required)

### T0: Node Joins

```
→ Perform recursive self-lookup (lookup(ID_self))
→ Seed buckets with discovered neighbors
→ Collect initial proximity samples during forwarding
```

**Notes:**
- Recursive self-lookup ensures correct neighborhood seeding
- Bidirectional exposure accelerates convergence

### T1: Periodic Bucket Refresh

```
→ Select random ID per bucket range
→ Perform recursive FIND_NODE
→ Discover new nodes in prefix ranges
→ Update proximity metrics (PR/PNS)
```

**Notes:**
- Recursive refresh benefits all nodes on the path
- Refresh intervals should scale with observed churn

### T2: Liveness Checks

```
→ Periodically ping bucket entries
→ Evict unresponsive nodes
→ Promote replacement cache entries
```

**Notes:**
- Liveness MUST dominate proximity when deciding eviction
- Replacement caches should preserve prefix diversity

### T3: PNS Reevaluation (If Enabled)

```
→ Perform limited RTT probes on XOR-equivalent peers
→ Reorder entries within buckets
→ Do NOT reshuffle bucket boundaries
```

**Notes:**
- Probing must be rate-limited and randomized
- Reevaluation frequency should be lower than T1

---

## Safety Invariants (Must Hold)

At all times, the implementation **MUST** preserve:

- ✅ Strict XOR-distance progress per hop
- ✅ Prefix-based bucket partitioning
- ✅ Bucket diversity and replacement caches
- ✅ Liveness over proximity

The implementation **MUST NOT**:

- ❌ Replace logical neighbors with XOR-worse but closer peers
- ❌ Collapse buckets based on proximity
- ❌ Allow proximity to override routing correctness

---

## Recommended Defaults (Practical)

| Feature | Recommendation |
|---------|----------------|
| Routing mode | Recursive |
| Reply handling | Source routed |
| PR | Enabled |
| PNS | Optional / configurable |
| Bucket refresh | Periodic, recursive |
| RTT probing | Opportunistic + limited |
| Deduplication | Message ID + source path |

---

## One-Paragraph Summary (Drop-In Ready)

> A recursive Kademlia routing model augmented with source routing, Proximity Routing, and optional Proximity Neighbor Selection provides a robust balance between correctness, performance, and resilience under churn. Recursive forwarding accelerates node discovery by exposing intermediate peers to both upstream and downstream neighbors, while source routing enables loop detection, deduplication, and tracing. Proximity Routing opportunistically reduces latency without additional overhead, and Proximity Neighbor Selection further optimizes lookup performance through limited, rate-controlled probing among XOR-equivalent peers. Periodic maintenance—including recursive bucket refreshes, liveness checks, and constrained PNS reevaluation—ensures routing tables remain correct, diverse, and proximity-aware without violating Kademlia's convergence guarantees.
