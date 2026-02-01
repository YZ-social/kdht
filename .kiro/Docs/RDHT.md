# R/Kademlia: Recursive and Topology-aware Overlay Routing

## 🧠 Notes: R/Kademlia

**Reference:** R/Kademlia: Recursive and Topology-aware Overlay Routing — Bernhard Heep (ATNAC 2010)

---

## 🎯 Purpose and Context

R/Kademlia is a **recursive variant** of the original Kademlia DHT that replaces iterative routing with recursive routing to improve performance and resilience under churn (node join/leave).

Designed to tackle two common limitations:
- High routing latency and overhead in iterative lookups
- NAT/PAT connectivity issues faced by many peers

---

## 🔁 Recursive Routing vs Iterative Routing

### Classic Kademlia (Iterative)
- Initiator sends `FIND_NODE` or `FIND_VALUE` RPCs to closest known peers one step at a time
- Requires multiple round trips to complete a lookup

### R/Kademlia (Recursive)
- Each intermediate node forwards the lookup to the next closer peer on behalf of the originator, forming a **forwarding chain**
- Acknowledgements are hop-by-hop, which removes some dependency on originator round trips

### Benefits of Recursive Routing
| Benefit | Description |
|---------|-------------|
| **Lower latency** | Fewer round trips deep into the network |
| **Lower bandwidth** | Less redundant querying |
| **Better churn tolerance** | Intermediate nodes carry requests forward even if originator sees delays or timeouts |
| **NAT/PAT friendly** | Reduces reliance on unknown/unreachable nodes outside local routing tables |

---

## 🧩 Two Signaling (Routing) Modes in R/Kademlia

R/Kademlia introduces two distinct modes for returning routing information to the originator — crucial since naive recursion hides information from the original requester.

### 1. Direct Mode

**What it does:**
- Every node on the recursive routing path gathers closest known nodes to the destination key and sends them **directly back to the originator**

**How it works:**
1. A request (e.g., `FIND_NODE`) is forwarded recursively hop-by-hop from the originator toward the target
2. Each node on that path sends back a list of close neighbors (according to XOR distance) directly to the originator via separate messages

**Pros:**
- The originator receives essentially the same set of responses it would in iterative mode
- Lower bandwidth usage compared to source-routing mode

**Cons:**
- Return messages may come from nodes that are not direct peers of the originator
- Can cause connection problems in NAT/PAT scenarios where direct connectivity is constrained

### 2. Source-Routing Mode

**What it does:**
- The final node on the routing path builds a reply containing the closest neighbors and sends it **backward along the same path** (source route), collecting additional routing info at each hop

**How it works:**
1. The lookup is forwarded recursively to the target
2. The final responding node embeds its closest known nodes in a return message
3. At each hop on the return path, that node merges its closest node info into the reply before forwarding it back to the originator

**Pros:**
- All nodes on the path learn more peers (because each contributes to the collected neighbor set)
- Nodes on the routing path only communicate with already known peers, which can increase reliability

**Cons:**
- Higher bandwidth consumption due to larger aggregated responses
- In high churn scenarios, if intermediate nodes on the return path fail, the originator may not receive a complete response

---

## 📈 Empirical Observations

According to simulation results presented in the original research:
- **Direct mode** tends to use less bandwidth under moderate churn rates
- **Source-routing mode** can achieve lower latency under high churn, at the cost of extra messaging

This shows that each signaling mode trades off overhead against speed and information richness.

---

## 🧠 Additional Enhancements

Aside from recursive routing, R/Kademlia integrates these overlay enhancements:

| Enhancement | Description |
|-------------|-------------|
| **Topology-aware routing (Proximity Routing)** | Uses a combined metric (proximity + XOR prefix) for forwarding decisions for better real network performance |
| **Proximity Neighbor Selection (PNS)** | Fills k-buckets with physically closer nodes (using RTT/latency measurements), aiming to reduce latency |

---

## 🧾 Summary

**What R/Kademlia contributes to DHTs:**
- Moves Kademlia from iterative to recursive routing, improving performance under churn and reducing lookup overhead
- Introduces **two signaling modes** (Direct vs Source-routing) to return routing info appropriately after recursive lookups
- Provides empirical evidence that recursive and topology-aware strategies outperform original iterative Kademlia in many metrics (latency, bandwidth)
- Demonstrates that signaling mode choice can tune performance based on network dynamics

---

# 🏗️ Hierarchical DHT (Funahashi et al.)

## Big Picture

The paper does not change the core DHT algorithm (Kademlia/Chord-like routing). Instead, it organizes nodes into a **hierarchy of clusters** so that different lookup strategies (recursive vs iterative) can be applied where they work best.

> Think of it as: **DHT of DHTs**

---

## 🔹 Two Levels: High-level and Low-level Clusters

### 1. Low-level Clusters (Base Layer)

**Definition:**
A low-level cluster is a group of nodes that:
- Are close in the overlay ID space (key range–based grouping)
- Often share similar network locality (latency proximity)
- Each low-level cluster runs a **normal DHT internally**

**Characteristics:**
- Smaller number of nodes
- Higher churn (nodes come and go)
- Cheaper to maintain routing tables
- Lookups inside a cluster are fast

> Think of this as: "Local neighborhoods inside the DHT"

### 2. High-level Clusters (Backbone)

**Definition:**
- Each low-level cluster elects one or more **representative nodes**
- These representatives participate in a **higher-level DHT**
- The high-level DHT routes **between clusters**, not individual nodes

**Characteristics:**
- Much smaller population
- Nodes are selected for:
  - High availability
  - Low churn
  - Often better bandwidth/uptime
- Routing tables are more stable

> This layer acts as: "The backbone of the DHT"

---

## 🔑 How Clusters Are Defined

The paper assumes a hierarchical ID space partitioning:
- Global key space is divided into regions
- Each region corresponds to a low-level cluster
- One or more nodes in each cluster are promoted to the high-level overlay

**Promotion is based on node reliability metrics:**
- Session length
- Failure rate
- Observed uptime

⚠️ **Important:** The paper does not mandate a single election algorithm — it assumes an existing reliability scoring mechanism.

---

## 🔁 Lookup Flow in the Hierarchical DHT

### Case 1: Key is in the same low-level cluster
- Lookup stays entirely inside the cluster
- Uses **recursive lookup** (fast, low latency)

### Case 2: Key is in a different cluster
1. Query escalates to the high-level DHT
2. High-level routes to the target cluster
3. Lookup descends into that cluster
4. Final resolution happens locally

**This is why hierarchical DHTs scale well:**
- Most traffic stays local
- Global routing is handled by stable nodes

---

## 🔄 Recursive vs Iterative in This Hierarchy

**Key observation from the paper:**
- Recursive lookup is fast but fragile under churn
- Iterative lookup is slower but more robust

**Strategy used:**

| Layer | Preferred Lookup Mode | Reason |
|-------|----------------------|--------|
| Low-level clusters | Recursive | Low latency, short paths |
| High-level clusters | Iterative | Better failure control |

They also propose **adaptive switching:**
- If a low-level cluster becomes unstable → switch to iterative
- If stability improves → switch back to recursive

---

## 🧠 Why This Matters

This paper shows that:
- Recursive vs iterative is **not a global choice**
- It should depend on **node stability** and **where you are in the routing hierarchy**

This idea directly influenced later work on:
- Adaptive DHT routing
- IPFS's conservative iterative design
- Reputation-based routing (ReDS)

---

## 🧾 Summary Paragraph

> Funahashi et al. employ a hierarchical DHT architecture in which nodes are grouped into low-level clusters that manage local key ranges and a high-level overlay composed of representative, stable nodes. Low-level clusters are smaller and subject to higher churn, while the high-level overlay prioritizes stability and long-lived peers. This structure enables the system to selectively apply recursive lookups in stable regions for low latency and iterative lookups in volatile regions for robustness, demonstrating that lookup strategy choice should be topology- and reliability-aware rather than globally fixed.

---

# 📡 Tracer Routing Nodes in Recursive DHTs

## Motivation

Recursive DHT routing improves latency and efficiency but reduces end-to-end visibility for the originator. This lack of visibility complicates:
- Debugging lookup failures
- Detecting misrouting or suppression
- Identifying message amplification or looping

**Tracer routing nodes** are introduced to partially restore visibility without reverting to full iterative control.

---

## 🧭 What Is Tracer Routing?

Tracer routing augments recursive DHT lookups with **lightweight path observability**.

Rather than controlling each hop (iterative) or being completely blind (pure recursive), the originator:
- Receives **trace metadata** about the lookup path
- Without participating in every forwarding decision

> This is analogous to `traceroute` in IP networks, but adapted to overlay routing.

---

## 🧱 Role of Tracer Nodes

A tracer node is a regular DHT participant that additionally:
- Annotates recursive messages with trace information
- Optionally performs deduplication and rate control
- Acts as a checkpoint in recursive routing paths

Tracer functionality can be:
- Enabled on all nodes
- Or restricted to designated nodes (e.g., high-stability or backbone nodes)

---

## 🔗 How Tracer Routing Works

### Forward Path
1. Originator sends a recursive lookup request
2. Each hop:
   - Forwards the request toward the target
   - Optionally appends a compact trace entry:
     - Node ID (or hash)
     - Hop count or TTL
     - Message ID hash
     - Timestamp or RTT estimate

### Return Path
Trace metadata is returned:
- Via source routing (reverse path)
- Or directly to the originator (direct mode)

This produces a partial or complete overlay path trace.

---

## 🧠 What Gets Traced (Minimal by Design)

To avoid amplification or privacy leakage, tracer routing typically records:
- **Hashed node identifiers** (not raw IPs)
- **Bounded hop counts**
- **Bloom-filter-style path summaries**
- **Message IDs** for deduplication correlation

No full routing tables or neighbor lists are exposed.

---

## 🛡️ Security & Amplification Mitigation Benefits

### 1. Loop Detection
Tracer metadata allows detection of:
- Recursive loops
- Repeated forwarding to the same logical region

Nodes can drop or short-circuit messages that reappear with the same trace signature.

### 2. Message Deduplication
Tracer routing enables:
- Per-lookup message IDs
- Hop-local deduplication caches

If a node sees `(lookup_id, target_key)` already forwarded → message is dropped or downgraded.

This directly mitigates amplification via recursive fan-out.

### 3. Amplification Attribution
By examining trace summaries, the originator (or monitoring nodes) can:
- Identify nodes or regions generating excessive duplicates
- Detect anomalous branching behavior
- Feed data into reputation or throttling systems

This complements systems like ReDS without requiring full trust.

### 4. Rate Limiting with Context
Tracer nodes can enforce:
- Rate limits **per lookup path**, not just per sender
- Adaptive throttling when trace depth or duplication exceeds norms

This is especially important in recursive routing, where naive rate limiting can break legitimate lookups.

---

## 🔄 Relationship to Recursive vs Iterative Routing

| Aspect | Iterative | Recursive | Recursive + Tracer |
|--------|-----------|-----------|-------------------|
| Originator control | High | Low | Medium |
| Latency | Higher | Lower | Near-recursive |
| Path visibility | Full | Minimal | Partial |
| Amplification risk | Lower | Higher | Reduced |
| Deduplication | Originator-side | Hard | Path-aware |

Tracer routing effectively reclaims the safety properties of iterative routing while preserving the efficiency of recursion.

---

## 🧩 Placement in a Hierarchical DHT

Tracer routing is particularly effective when applied to:
- **High-level clusters** (stable backbone nodes)
- Recursive inter-cluster routing
- NAT-constrained environments

Low-level clusters may disable tracing for performance, while high-level overlays enforce it for safety.

---

## 🧠 Design Tradeoffs

| Pros | Cons |
|------|------|
| Improved observability | Slight message overhead |
| Loop and amplification resistance | Trace spoofing risk (mitigated via hashing/signatures) |
| Compatible with recursive routing | Requires protocol support |

---

## 🧾 Summary Paragraph

> Tracer routing nodes augment recursive DHT routing with lightweight path observability, enabling loop detection, message deduplication, and amplification mitigation without reverting to fully iterative lookup control. By embedding bounded trace metadata into recursive messages, tracer routing restores partial end-to-end visibility and enables path-aware rate limiting and abuse detection. This approach preserves the latency advantages of recursive routing while addressing key security and robustness concerns.

---

# Proximity Neighbor Selection (PNS) and Routing Correctness

## Key Insight

**Proximity Neighbor Selection does not weaken Kademlia's reachability guarantees** because proximity is applied only as a secondary criterion among nodes that already satisfy the XOR-distance progress condition.

- Routing tables remain partitioned by logical distance
- Each hop strictly reduces XOR distance to the target ID
- If the closest logical nodes are physically distant, PNS cannot substitute nearer but XOR-worse peers
- The lookup proceeds using higher-latency hops while maintaining correctness

> **Thus, PNS improves latency opportunistically without compromising convergence to any valid node ID.**

### Mental Model (Useful Intuition)
- **XOR distance** = compass direction
- **Proximity** = road quality

> You may prefer highways, but if the destination is east, you still have to go east.

---

## Node Discovery in Kademlia

Awareness of new nodes within a Kademlia neighborhood is ensured through:

1. **Join-time self-lookups** - When a node joins, it performs a lookup for its own ID, causing nodes responsible for nearby XOR ranges to learn about it
2. **Bucket insertion rules** - Nodes update their routing tables when they encounter new peers
3. **Periodic prefix refreshes** - Force continued exploration of each prefix range

**Recursive routing further accelerates this process** by increasing passive exposure to new nodes during forwarded lookups.

> Together, these mechanisms guarantee eventual dissemination of neighborhood membership despite churn.

---

## Why Recursive Routing Accelerates Discovery

Recursive routing accelerates node discovery compared to iterative routing because:
- Intermediate nodes forward requests on behalf of the originator
- This exposes them to both upstream and downstream peers
- Each recursive hop creates **bidirectional visibility** between nodes that would never interact under iterative routing

**Result:** Recursive routing passively disseminates node IDs along lookup paths without additional control traffic, leading to faster neighborhood awareness and more rapid routing table convergence.

---

# Periodic Maintenance in Recursive Kademlia

## 0️⃣ Baseline: What "Periodic Updates" Mean in Kademlia

Classic Kademlia has three background maintenance loops:
1. **Bucket refresh** (discover new nodes)
2. **Liveness checks** (evict dead nodes)
3. **Replacement cache management**

> Recursive routing changes who sees traffic, but does not remove these loops — it **amplifies their effectiveness**.

---

## 1️⃣ Periodic Updates in Recursive Kademlia (Baseline)

### 🔄 Bucket Refresh (Still Required)

Each node periodically:
1. Chooses a random ID in each bucket's XOR range
2. Performs a `FIND_NODE(random_id)`

In recursive mode:
- That lookup is forwarded hop-by-hop
- Every intermediate node:
  - Observes new peers
  - Updates its buckets passively

➡️ **One refresh lookup now benefits many nodes, not just the originator.**

### ❤️ Liveness Maintenance

Nodes periodically:
- Ping bucket entries
- Evict unresponsive nodes
- Promote replacement-cache entries

Recursive routing helps here because:
- Nodes are naturally exercised by forwarded traffic
- Liveness info is updated opportunistically
- Less "artificial" ping traffic is needed

---

## 2️⃣ Adding PR (Proximity Routing): No New Update Loop

**Key point:** PR does not introduce new periodic messages. PR affects **selection**, not **discovery**.

### How PR Stays Up to Date

Proximity metrics (RTT, delay) are:
- Measured opportunistically during normal RPCs
- Cached with timestamps

Stale proximity data is:
- Replaced naturally as traffic flows
- Discarded on node eviction

**Periodic behavior with PR:**
- Bucket refresh → recursive lookup → proximity samples updated
- No active probing is required

➡️ **PR is low overhead and naturally self-refreshing.**

---

## 3️⃣ Adding PNS (Proximity Neighbor Selection): Extra Maintenance

**PNS does require additional periodic work.**

### Why?
Because proximity must be **measured**, not inferred.

### 🔁 PNS Update Loop (Inside Each Bucket)

For each k-bucket, maintain:
- k active entries
- A replacement cache (often size ≥ k)

Periodically:
1. Probe some candidates (ping / RTT)
2. Compare proximity among XOR-equivalent peers
3. Retain the best k by:
   - XOR correctness (mandatory)
   - Proximity (secondary)

> This is **local optimization**, not global reshaping.

### 📍 When PNS Probing Happens

Probing is triggered by:
- New node arrival
- Bucket refresh results
- Replacement cache growth
- Periodic "bucket reevaluation" timers

**Critically:**
- Probing is rate-limited
- Often randomized
- Never done for all buckets at once

---

## 4️⃣ Recursive Routing Makes PNS Cheaper

This is subtle but important.

In recursive mode:
- Many RTT samples are gathered **for free**
- Because forwarding nodes:
  - Already communicate with candidates
  - Measure latency as a side effect

So PNS:
- Requires fewer explicit probes
- Can piggyback proximity measurement on forwarding

> **This is why recursive + PNS scales better than iterative + PNS.**

---

## 5️⃣ Putting It All Together (Timeline View)

```
T0: Node joins
    → Recursive self-lookup
    → Buckets seeded
    → Initial proximity samples collected

T1: Periodic bucket refresh
    → Recursive lookup
    → New nodes discovered
    → Proximity metrics updated (PR/PNS)

T2: Liveness checks
    → Dead nodes evicted
    → Replacement cache promoted

T3: PNS reevaluation (if enabled)
    → Limited RTT probes
    → Bucket entries reordered (not reshaped)

Repeat…
```

---

## 6️⃣ Safety Invariants (Very Important)

Periodic updates must **never** violate these:

### ✅ Always Preserved
- XOR prefix coverage
- Monotonic distance progress
- Bucket diversity

### 🚫 Never Allowed
- Dropping logical neighbors due to poor proximity
- Replacing entire buckets with nearby peers
- Cross-prefix substitutions

> **PR/PNS operate inside correctness constraints.**

---

## 7️⃣ Trade-Off Summary

| Feature | Extra Traffic | Benefit | Risk |
|---------|--------------|---------|------|
| Recursive routing | None | Faster discovery | Trust in intermediates |
| PR | None | Lower latency | Stale RTT (minor) |
| PNS | Low (probes) | Best latency | Probe overhead |
| Iterative + PNS | Higher | Moderate | Worse scaling |
