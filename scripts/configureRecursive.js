#!/usr/bin/env node
/**
 * Configure KDHT for R/Kademlia recursive routing mode.
 * 
 * This script sets all necessary configuration options to run the DHT
 * in full recursive mode with proximity-aware routing.
 * 
 * Usage:
 *   import { configureRecursive, configureIterative } from './scripts/configureRecursive.js';
 *   configureRecursive();  // Enable recursive mode
 *   configureIterative();  // Restore iterative mode (default)
 */

import { Node } from '../index.js';

/**
 * Configure Node for full R/Kademlia recursive routing mode.
 * 
 * This enables:
 * - Recursive routing (intermediate nodes forward requests)
 * - Proximity routing (RTT-weighted next-hop selection)
 * - Optionally PNS (Proximity Neighbor Selection)
 * 
 * @param {Object} options - Configuration options
 * @param {boolean} [options.pnsEnabled=false] - Enable PNS bucket reordering
 * @param {number} [options.defaultTTL=20] - Maximum hops for recursive lookups
 * @param {number} [options.dedupCacheSize=1000] - Deduplication cache size
 * @param {number} [options.dedupCacheTTL=10000] - Deduplication cache TTL (ms)
 * @param {number} [options.proximityWeight=0.1] - RTT influence factor (0-1)
 */
export function configureRecursive(options = {}) {
  const {
    pnsEnabled = false,
    defaultTTL = 20,
    dedupCacheSize = 1000,
    dedupCacheTTL = 10000,
    proximityWeight = 0.1,
  } = options;

  // Enable recursive routing
  Node.recursiveRoutingEnabled = true;
  
  // Enable proximity-aware next-hop selection
  Node.proximityRoutingEnabled = true;
  
  // Optional: Enable Proximity Neighbor Selection
  Node.pnsEnabled = pnsEnabled;
  
  // Configure TTL and deduplication
  Node.defaultTTL = defaultTTL;
  Node.dedupCacheSize = dedupCacheSize;
  Node.dedupCacheTTL = dedupCacheTTL;
  Node.proximityWeight = proximityWeight;

  console.log('R/Kademlia recursive routing enabled:', {
    recursiveRoutingEnabled: Node.recursiveRoutingEnabled,
    proximityRoutingEnabled: Node.proximityRoutingEnabled,
    pnsEnabled: Node.pnsEnabled,
    defaultTTL: Node.defaultTTL,
    dedupCacheSize: Node.dedupCacheSize,
    dedupCacheTTL: Node.dedupCacheTTL,
    proximityWeight: Node.proximityWeight,
  });
}

/**
 * Configure Node for standard iterative routing mode (default).
 * 
 * This restores the original Kademlia behavior where the originator
 * controls each hop of the lookup.
 */
export function configureIterative() {
  Node.recursiveRoutingEnabled = false;
  Node.proximityRoutingEnabled = true;  // Still useful for next-hop selection
  Node.pnsEnabled = false;
  Node.defaultTTL = 20;
  Node.dedupCacheSize = 1000;
  Node.dedupCacheTTL = 10000;
  Node.proximityWeight = 0.1;

  console.log('Standard iterative routing enabled');
}

/**
 * Get current R/Kademlia configuration.
 */
export function getConfiguration() {
  return {
    recursiveRoutingEnabled: Node.recursiveRoutingEnabled,
    proximityRoutingEnabled: Node.proximityRoutingEnabled,
    pnsEnabled: Node.pnsEnabled,
    defaultTTL: Node.defaultTTL,
    dedupCacheSize: Node.dedupCacheSize,
    dedupCacheTTL: Node.dedupCacheTTL,
    proximityWeight: Node.proximityWeight,
  };
}

// If run directly from Node.js, configure recursive mode
// This check is skipped in browser environments where process is undefined
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('configureRecursive.js')) {
  const args = process.argv.slice(2);
  const pnsEnabled = args.includes('--pns');
  configureRecursive({ pnsEnabled });
}
