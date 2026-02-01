# RDHT Source Mapping: Research References

This document maps each major section of the recursive Kademlia-with-PR/PNS design to relevant published research that supports or introduces the core ideas.

---

## 📌 1️⃣ Base DHT: Kademlia Routing & Recursive vs. Iterative

### Maymounkov & Mazières — *Kademlia: A Peer-to-Peer Information System Based on the XOR Metric*
- Foundational specification of Kademlia and XOR metric routing behavior
- Provides correctness, resilience, and iterative routing baseline
- [NYU Computer Science](https://cs.nyu.edu)

### Freedman et al. — *Non-Transitive Connectivity and DHTs*
- Discusses differences between recursive and iterative routing in Kademlia-like systems
- Highlights advantages of recursive forwarding (lower latency)
- [USENIX](https://usenix.org)

### DHash++ / NSDI and similar systems
- Practical evaluation showing recursive lookups reduce latency compared to iterative forwarding under many conditions
- [USENIX](https://usenix.org)

### Mapping to your design
- ✔ The recursive routing logic in your pseudocode uses the same next-hop reduction invariant as Kademlia but with forwarding rather than originator "step control"
- ✔ Iterative lookup control and fallback behavior are based on classic comparisons between iterative and recursive DHT lookups

---

## 📌 2️⃣ Recursive Kademlia + Source Routing + Topology Awareness

### Bernhard Heep — *R/Kademlia: Recursive and Topology-Aware Overlay Routing*
- Primary source for recursive Kademlia with both Proximity Routing (PR) and Proximity Neighbor Selection (PNS)
- [KIT Telematik](https://telematics.tm.kit.edu)

**Key contributions:**
- Introduces recursive routing modes (direct vs. source routing)
- Demonstrates how source routing is used to aggregate responses and avoid unreachable contacts due to NATs
- Explicitly describes how PR and PNS are applied to improve lookup latencies in recursive mode

### Mapping to your design
- ✔ Your recursive `RECURSIVE_FIND_NODE` pseudocode corresponds directly to R/Kademlia's lookup process with source routing
- ✔ The PR selection function is grounded in the prefix-plus-proximity metric from R/Kademlia (XOR + RTT)
- ✔ Source routing trace behavior and hop-by-hop acknowledgement semantics directly map to the two signaling modes shown in the R/Kademlia slides

---

## 📌 3️⃣ Proximity Routing (PR) & Proximity Metrics

### Heep's R/Kademlia work
- Defines PR concretely: next hop is selected based on lowest underlay cost (e.g., RTT) among XOR-valid candidates
- [KIT Telematik](https://telematics.tm.kit.edu)

### Baset et al. — *"A Common Protocol for Implementing Various DHT Algorithms"* (draft)
- Discusses Proximity Neighbor Selection (PNS) in relation to DHT routing tables (based on latency/underlay info)
- [doczz.net](https://doczz.net)

### Kaune et al. — *Embracing the Peer Next Door: Proximity in Kademlia*
- Analyzes PNS and PRS (proximity route and neighbor selection) in general DHT context
- Gives theoretical insight into underlay-aware neighbor choice
- [KOM Darmstadt](https://www.kom.tu-darmstadt.de)

### Mapping to your design
- ✔ The PR selection code (evaluate candidates by proximity when XOR distance is equal) aligns with both R/Kademlia and Kaune et al.'s description of PR/PRS
- ✔ The PNS reevaluation and RTT probing semantics align with DHash++ and R/Kademlia's bucket optimization findings

---

## 📌 4️⃣ Node Discovery & Maintenance

### Maymounkov & Mazières' original Kademlia
- Describes how nodes learn about new peers opportunistically through lookup messages
- This feeds your "update routing table from path" semantics
- [NYU Computer Science](https://cs.nyu.edu)

### Heep's R/Kademlia slides/paper
- Explicitly evaluates maintenance and neighbor learning
- Shows that recursive routing visits more intermediate nodes than iterative lookups do, improving discovery
- [KIT Telematik](https://telematics.tm.kit.edu)

### Mitigating Eclipse Attacks context
- Recursive routing's maintenance traits can help or hurt depending on churn
- Should be paired with explicit maintenance (liveness checks)
- Details appear in structured overlay security analyses
- [SSG Lancaster University](https://www.lancaster.ac.uk)

### Mapping to your design
- ✔ Your `UPDATE_ROUTING_TABLE_FROM_PATH` algorithm is effectively justified by the inherent learning that recursive routing provides as documented in both the original Kademlia paper and R/Kademlia evaluations

---

## 📌 5️⃣ Source Routing & Path Vectors

### *"Kademlia-directed ID-based Routing Architecture (KIRA)"* — IETF Draft
- Details source routing in structured overlay routing
- Describes how a source route object carries node IDs through a recursive path to avoid loops or unreachable next hops
- [IETF](https://ietf.org)

### Mapping to your design
- ✔ This draft is a direct architectural analog to your trace/route vector in recursive DHTs with source routing
- ✔ It defines how source routing objects are encoded, advanced, and extended, exactly as your pseudocode with a `path[]` list does

---

## 📌 6️⃣ Proximity Neighbor Selection (PNS) in Practice

### DHash++ / NSDI Report
- Contains discussion of PNS as a general technique for lowering lookup latency in Kademlia-type systems
- [USENIX](https://usenix.org)

### Kaune et al. (as above)
- Formalizes the notion of PNS and PRS under underlay metrics
- [KOM Darmstadt](https://www.kom.tu-darmstadt.de)

### Mapping to your design
- ✔ Your periodic PNS reevaluation and rate-controlled RTT probes align with both R/Kademlia's extension and these general proximity selection analyses

---

## 🧠 Summary Table (Paper ↔ Design)

| Design Element | Supporting Paper / Draft |
|----------------|-------------------------|
| Base Kademlia routing | Maymounkov & Mazières (Kademlia) |
| Recursive vs. iterative | Freedman et al. / NSDI recursive analysis |
| Recursive + source routing | R/Kademlia (Heep) |
| Source routing objects | IETF KIRA Draft |
| Proximity Routing (PR) | R/Kademlia, Kaune et al. |
| Proximity Neighbor Selection (PNS) | Baset DHT draft, Kaune et al., NSDI |
| Maintenance & discovery | R/Kademlia evaluation, original Kademlia |

---

## 📌 Why These References Matter

| Reference | Contribution |
|-----------|--------------|
| **R/Kademlia** | Primary implementation-oriented paper for combining recursion, PR, and PNS with source routing |
| **Original Kademlia** | Provides the semantic guarantees your design preserves |
| **KIRA IETF Draft** | Formalizes source routing objects usable in recursive DHT signaling |
| **Proximity selection analyses** (Kaune et al., Baset draft, NSDI/Accordion logic) | Justify the proximity optimizations |
