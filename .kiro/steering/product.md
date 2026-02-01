# KDHT - Kademlia Distributed Hash Table

A pure JavaScript implementation of the Kademlia DHT protocol for peer-to-peer distributed storage.

## Purpose
- Experimental platform for testing DHT variations and optimizations
- Enables decentralized key-value storage across networked nodes
- Supports both simulation (in-process) and real WebRTC transports

## Core Concepts
- **Node**: An actor in the DHT with a 128-bit key (BigInt)
- **Contact**: Represents a connection from one Node to another
- **KBucket**: Routing table bucket holding up to k contacts organized by XOR distance
- **Helper**: Wrapper caching distance from a Contact to a target key

## Key Operations
- `join(contact)` - Join the DHT through a known node
- `storeValue(key, value)` - Store data replicated to k closest nodes
- `locateValue(key)` - Retrieve stored data from the network
- `locateNodes(key)` - Find k closest nodes to a key

## Design Goals
- Pure Kademlia implementation following the original paper
- Repeatable test suite for validating behavior across changes
- Support for simulated networks (no real networking) for fast testing
