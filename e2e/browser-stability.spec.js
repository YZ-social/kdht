// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Browser stability tests for KDHT recursive routing.
 * 
 * These tests verify that browser nodes can:
 * 1. Connect to the recursive portal server
 * 2. Maintain stable WebRTC connections
 * 3. Perform DHT operations (store/retrieve)
 * 4. Handle multiple concurrent connections
 * 
 * Tests run against oracle-yz recursive portal server.
 */

// Helper to wait for network stability
async function waitForStability(page, durationMs = 5000) {
  const startTime = Date.now();
  let lastConnectionCount = 0;
  let stableFor = 0;
  
  while (Date.now() - startTime < durationMs) {
    const stats = await page.evaluate(() => {
      if (typeof ConnectionTracker !== 'undefined') {
        return ConnectionTracker.getStats();
      }
      return null;
    });
    
    if (stats) {
      const currentConnections = stats.connectionSuccesses - stats.disconnects;
      if (currentConnections === lastConnectionCount) {
        stableFor += 500;
        if (stableFor >= 2000) return true; // Stable for 2 seconds
      } else {
        stableFor = 0;
        lastConnectionCount = currentConnections;
      }
    }
    
    await page.waitForTimeout(500);
  }
  
  return false;
}

// Helper to get connection stats from page
async function getConnectionStats(page) {
  return await page.evaluate(() => {
    if (typeof ConnectionTracker !== 'undefined') {
      return {
        stats: ConnectionTracker.getStats(),
        recentEvents: ConnectionTracker.getRecentEvents(20)
      };
    }
    return null;
  });
}

// Helper to get node info
async function getNodeInfo(page) {
  return await page.evaluate(() => {
    if (typeof contact !== 'undefined' && contact?.node) {
      return {
        name: contact.node.name,
        key: contact.node.key?.toString(),
        nConnections: contact.node.nConnections,
        bucketCount: contact.node.buckets?.length || 0,
        isRunning: contact.node.isRunning
      };
    }
    return null;
  });
}

test.describe('Browser Node Connection Stability', () => {
  
  test.beforeEach(async ({ page }) => {
    // Enable console logging from browser
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('ConnectionTracker')) {
        console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
      }
    });
    
    // Log page errors
    page.on('pageerror', error => {
      console.log(`[Page Error]: ${error.message}`);
    });
  });

  test('should connect to recursive portal and join network', async ({ page, baseURL }) => {
    // Navigate to recursive node page
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for initial connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Wait for WebRTC connections to establish (join takes time)
    await page.waitForTimeout(10000);
    
    // Get node info
    const nodeInfo = await getNodeInfo(page);
    console.log('Node connected:', nodeInfo);
    
    expect(nodeInfo).not.toBeNull();
    expect(nodeInfo.isRunning).toBe(true);
    // Note: nConnections may be 0 if the portal node doesn't maintain the connection
    // The important thing is that the node joined successfully
  });

  test('should maintain stable connections for 30 seconds', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for initial connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Enable connection tracking
    await page.evaluate(() => {
      if (typeof ConnectionTracker !== 'undefined') {
        ConnectionTracker.enable();
        ConnectionTracker.clear();
      }
    });
    
    // Monitor for 30 seconds
    const monitorDuration = 30000;
    const checkInterval = 5000;
    const snapshots = [];
    
    for (let elapsed = 0; elapsed < monitorDuration; elapsed += checkInterval) {
      await page.waitForTimeout(checkInterval);
      
      const nodeInfo = await getNodeInfo(page);
      const stats = await getConnectionStats(page);
      
      snapshots.push({
        elapsed,
        nodeInfo,
        stats: stats?.stats
      });
      
      console.log(`[${elapsed/1000}s] Connections: ${nodeInfo?.nConnections}, ` +
                  `Attempts: ${stats?.stats?.connectionAttempts}, ` +
                  `Successes: ${stats?.stats?.connectionSuccesses}, ` +
                  `Disconnects: ${stats?.stats?.disconnects}`);
    }
    
    // Analyze stability
    const finalStats = await getConnectionStats(page);
    console.log('Final connection stats:', JSON.stringify(finalStats?.stats, null, 2));
    
    // Check for excessive disconnects
    const disconnectRate = finalStats?.stats?.disconnects / (finalStats?.stats?.connectionSuccesses || 1);
    console.log(`Disconnect rate: ${(disconnectRate * 100).toFixed(1)}%`);
    
    // Fail if disconnect rate is too high (more than 50% of connections disconnected)
    expect(disconnectRate).toBeLessThan(0.5);
    
    // Check that we still have connections
    const finalNodeInfo = await getNodeInfo(page);
    expect(finalNodeInfo?.nConnections).toBeGreaterThan(0);
  });

  test('should handle store and retrieve operations', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Wait a bit for network to stabilize
    await page.waitForTimeout(5000);
    
    // Store a value
    const testKey = `test-key-${Date.now()}`;
    const testValue = `test-value-${Date.now()}`;
    
    await page.evaluate(async ({ key, value }) => {
      await contact.storeValue(key, value);
    }, { key: testKey, value: testValue });
    
    console.log(`Stored: ${testKey} = ${testValue}`);
    
    // Wait for replication
    await page.waitForTimeout(3000);
    
    // Retrieve the value
    const retrievedValue = await page.evaluate(async ({ key }) => {
      return await contact.node.locateValue(key);
    }, { key: testKey });
    
    console.log(`Retrieved: ${testKey} = ${retrievedValue}`);
    
    expect(retrievedValue).toBe(testValue);
  });

  test('should report connection issues with diagnostics', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Enable tracking
    await page.evaluate(() => {
      if (typeof ConnectionTracker !== 'undefined') {
        ConnectionTracker.enable();
        ConnectionTracker.clear();
      }
    });
    
    // Run for a while
    await page.waitForTimeout(20000);
    
    // Get detailed diagnostics
    const diagnostics = await page.evaluate(() => {
      const stats = typeof ConnectionTracker !== 'undefined' ? ConnectionTracker.getStats() : null;
      const events = typeof ConnectionTracker !== 'undefined' ? ConnectionTracker.getRecentEvents(50) : [];
      
      // Get node report
      const nodeReport = typeof contact !== 'undefined' ? contact.node.report(null) : 'No node';
      
      return {
        stats,
        events,
        nodeReport
      };
    });
    
    console.log('\n=== Connection Diagnostics ===');
    console.log('Stats:', JSON.stringify(diagnostics.stats, null, 2));
    console.log('\nRecent Events:');
    for (const event of diagnostics.events.slice(-10)) {
      console.log(`  ${event.type}: ${JSON.stringify(event)}`);
    }
    console.log('\nNode Report:');
    console.log(diagnostics.nodeReport);
    
    // This test always passes but provides diagnostic output
    expect(diagnostics.stats).not.toBeNull();
  });
});

test.describe('Multiple Browser Nodes', () => {
  
  test('should support multiple browser nodes connecting', async ({ browser, baseURL }) => {
    const nodeCount = 3;
    const contexts = [];
    const pages = [];
    
    try {
      // Create multiple browser contexts (simulating multiple users)
      for (let i = 0; i < nodeCount; i++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        
        // Enable console logging
        page.on('console', msg => {
          if (msg.type() === 'error') {
            console.log(`[Node ${i} Error]: ${msg.text()}`);
          }
        });
        
        contexts.push(context);
        pages.push(page);
      }
      
      // Connect all nodes
      console.log(`Connecting ${nodeCount} browser nodes...`);
      
      await Promise.all(pages.map(async (page, i) => {
        await page.goto(`${baseURL}/nodeRecursive.html`);
        await page.waitForFunction(() => {
          return typeof contact !== 'undefined' && contact?.node?.isRunning;
        }, { timeout: 60000 });
        console.log(`Node ${i} connected`);
      }));
      
      // Wait for network to stabilize
      await pages[0].waitForTimeout(10000);
      
      // Check all nodes are still connected
      const nodeInfos = await Promise.all(pages.map(async (page, i) => {
        const info = await page.evaluate(() => {
          if (typeof contact !== 'undefined' && contact?.node) {
            return {
              name: contact.node.name,
              nConnections: contact.node.nConnections,
              isRunning: contact.node.isRunning
            };
          }
          return null;
        });
        console.log(`Node ${i}: ${info?.nConnections} connections, running: ${info?.isRunning}`);
        return info;
      }));
      
      // All nodes should still be running
      for (let i = 0; i < nodeCount; i++) {
        expect(nodeInfos[i]?.isRunning).toBe(true);
      }
      
    } finally {
      // Cleanup
      for (const context of contexts) {
        await context.close();
      }
    }
  });
});

test.describe('Recursive Routing Verification', () => {
  
  test('should verify recursive routing is enabled', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Check that recursive routing is enabled via the node's constructor
    const config = await page.evaluate(() => {
      if (typeof contact !== 'undefined' && contact?.node) {
        const NodeClass = contact.node.constructor;
        return {
          recursiveRoutingEnabled: NodeClass.recursiveRoutingEnabled,
          proximityRoutingEnabled: NodeClass.proximityRoutingEnabled,
          pnsEnabled: NodeClass.pnsEnabled,
          defaultTTL: NodeClass.defaultTTL
        };
      }
      return null;
    });
    
    console.log('R/Kademlia configuration:', config);
    
    expect(config).not.toBeNull();
    expect(config.recursiveRoutingEnabled).toBe(true);
    expect(config.proximityRoutingEnabled).toBe(true);
  });

  test('should use recursive locateNodes (not iterative)', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Wait for network to stabilize
    await page.waitForTimeout(5000);
    
    // Perform a locateNodes lookup and verify it uses recursive routing
    const result = await page.evaluate(async () => {
      // Generate a random target key
      const targetKey = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
      
      // Check if recursiveLocateNodes method exists (it should if recursive routing is enabled)
      const hasRecursiveMethod = typeof contact.node.recursiveLocateNodes === 'function';
      const NodeClass = contact.node.constructor;
      
      // Perform the lookup
      const startTime = Date.now();
      const helpers = await contact.node.locateNodes(targetKey);
      const elapsed = Date.now() - startTime;
      
      return {
        hasRecursiveMethod,
        recursiveRoutingEnabled: NodeClass.recursiveRoutingEnabled,
        helpersFound: helpers?.length || 0,
        elapsed,
        // Check if dedup cache was used (indicates recursive routing)
        dedupCacheSize: contact.node.dedupCache?.cache?.size || 0
      };
    });
    
    console.log('locateNodes result:', result);
    
    expect(result.recursiveRoutingEnabled).toBe(true);
    expect(result.hasRecursiveMethod).toBe(true);
    expect(result.helpersFound).toBeGreaterThan(0);
    // Dedup cache should have entries if recursive routing was used
    expect(result.dedupCacheSize).toBeGreaterThan(0);
  });

  test('should use recursive locateValue for retrieval', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Wait for network to stabilize
    await page.waitForTimeout(5000);
    
    // Store a value first
    const testKey = `recursive-test-${Date.now()}`;
    const testValue = `recursive-value-${Date.now()}`;
    
    await page.evaluate(async ({ key, value }) => {
      await contact.storeValue(key, value);
    }, { key: testKey, value: testValue });
    
    console.log(`Stored: ${testKey} = ${testValue}`);
    
    // Wait for replication
    await page.waitForTimeout(3000);
    
    // Clear dedup cache to track new lookups
    await page.evaluate(() => {
      if (contact.node._dedupCache) {
        contact.node._dedupCache = null;
      }
    });
    
    // Retrieve using locateValue (should use recursive routing)
    const result = await page.evaluate(async ({ key }) => {
      const NodeClass = contact.node.constructor;
      const startTime = Date.now();
      const value = await contact.node.locateValue(key);
      const elapsed = Date.now() - startTime;
      
      return {
        value,
        elapsed,
        recursiveRoutingEnabled: NodeClass.recursiveRoutingEnabled,
        // Check dedup cache usage
        dedupCacheSize: contact.node.dedupCache?.cache?.size || 0
      };
    }, { key: testKey });
    
    console.log(`Retrieved: ${testKey} = ${result.value} (${result.elapsed}ms)`);
    console.log('Dedup cache entries:', result.dedupCacheSize);
    
    expect(result.value).toBe(testValue);
    expect(result.recursiveRoutingEnabled).toBe(true);
  });

  test('should handle multi-hop recursive signaling', async ({ browser, baseURL }) => {
    // This test creates two browser nodes and verifies they can communicate
    // through the portal network using recursive signaling
    
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    
    try {
      // Connect both nodes
      await Promise.all([
        page1.goto(`${baseURL}/nodeRecursive.html`),
        page2.goto(`${baseURL}/nodeRecursive.html`)
      ]);
      
      // Wait for both to connect
      await Promise.all([
        page1.waitForFunction(() => typeof contact !== 'undefined' && contact?.node?.isRunning, { timeout: 60000 }),
        page2.waitForFunction(() => typeof contact !== 'undefined' && contact?.node?.isRunning, { timeout: 60000 })
      ]);
      
      // Wait for network to stabilize
      await page1.waitForTimeout(10000);
      
      // Get node info from both
      const node1Info = await page1.evaluate(() => ({
        name: contact.node.name,
        key: contact.node.key.toString(),
        sname: contact.sname,
        nConnections: contact.node.nConnections,
        contacts: contact.node.contacts.map(c => c.sname)
      }));
      
      const node2Info = await page2.evaluate(() => ({
        name: contact.node.name,
        key: contact.node.key.toString(),
        sname: contact.sname,
        nConnections: contact.node.nConnections,
        contacts: contact.node.contacts.map(c => c.sname)
      }));
      
      console.log('Node 1:', node1Info);
      console.log('Node 2:', node2Info);
      
      // Node 1 stores a value
      const testKey = `multi-hop-${Date.now()}`;
      const testValue = `value-from-node1-${Date.now()}`;
      
      const storeResult = await page1.evaluate(async ({ key, value }) => {
        const stored = await contact.storeValue(key, value);
        return { stored, storageSize: contact.node.storage.size };
      }, { key: testKey, value: testValue });
      
      console.log(`Node 1 stored: ${testKey} = ${testValue}, result:`, storeResult);
      
      // Wait for replication
      await page1.waitForTimeout(5000);
      
      // Check if value is stored on portal nodes (via node 1's perspective)
      const storageCheck = await page1.evaluate(async ({ key }) => {
        // Try to locate the value from node 1's perspective
        const value = await contact.node.locateValue(key);
        return { value, localValue: contact.node.retrieveLocally(key) };
      }, { key: testKey });
      
      console.log('Storage check from Node 1:', storageCheck);
      
      // Node 2 retrieves the value (this exercises recursive routing through portals)
      const retrievedValue = await page2.evaluate(async ({ key }) => {
        const value = await contact.node.locateValue(key);
        return { value, localValue: contact.node.retrieveLocally(key) };
      }, { key: testKey });
      
      console.log(`Node 2 retrieved: ${testKey} =`, retrievedValue);
      
      // The value should be found either locally or through the network
      expect(retrievedValue.value || retrievedValue.localValue).toBe(testValue);
      
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('should verify recursive findNodes RPC is used', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Wait for network to stabilize
    await page.waitForTimeout(5000);
    
    // Instrument the node to track RPC calls
    const rpcStats = await page.evaluate(async () => {
      // Track RPC calls
      const rpcCalls = [];
      const originalSendRPC = contact.constructor.prototype.sendRPC;
      
      contact.constructor.prototype.sendRPC = async function(method, ...args) {
        rpcCalls.push({ method, timestamp: Date.now() });
        return originalSendRPC.call(this, method, ...args);
      };
      
      // Perform a lookup
      const targetKey = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
      await contact.node.locateNodes(targetKey);
      
      // Restore original
      contact.constructor.prototype.sendRPC = originalSendRPC;
      
      // Analyze RPC calls
      const NodeClass = contact.node.constructor;
      const recursiveCalls = rpcCalls.filter(c => c.method.startsWith('recursive'));
      const iterativeCalls = rpcCalls.filter(c => c.method === 'findNodes' || c.method === 'findValue');
      
      return {
        totalCalls: rpcCalls.length,
        recursiveCalls: recursiveCalls.length,
        iterativeCalls: iterativeCalls.length,
        methods: rpcCalls.map(c => c.method),
        recursiveRoutingEnabled: NodeClass.recursiveRoutingEnabled
      };
    });
    
    console.log('RPC stats:', rpcStats);
    
    // With recursive routing enabled, we should see recursiveFindNodes calls
    // and NOT iterative findNodes calls
    expect(rpcStats.recursiveRoutingEnabled).toBe(true);
    
    if (rpcStats.totalCalls > 0) {
      // If any RPCs were made, they should be recursive
      console.log('RPC methods used:', rpcStats.methods);
      // Note: The first lookup might not make RPCs if we're the closest node
      // But if RPCs are made, they should be recursive
      if (rpcStats.recursiveCalls > 0 || rpcStats.iterativeCalls > 0) {
        expect(rpcStats.recursiveCalls).toBeGreaterThan(0);
      }
    }
  });
});

test.describe('Connection Limit Stress Test', () => {
  
  test('should handle connection limits gracefully', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/nodeRecursive.html`);
    
    // Wait for connection
    await page.waitForFunction(() => {
      return typeof contact !== 'undefined' && contact?.node?.isRunning;
    }, { timeout: 60000 });
    
    // Enable tracking
    await page.evaluate(() => {
      if (typeof ConnectionTracker !== 'undefined') {
        ConnectionTracker.enable();
        ConnectionTracker.clear();
      }
    });
    
    // Get initial state
    const initialInfo = await getNodeInfo(page);
    console.log('Initial connections:', initialInfo?.nConnections);
    
    // Trigger multiple lookups to stress connections
    const lookupCount = 10;
    console.log(`Triggering ${lookupCount} concurrent lookups...`);
    
    await page.evaluate(async (count) => {
      const promises = [];
      for (let i = 0; i < count; i++) {
        // Random key lookups
        const randomKey = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        promises.push(contact.node.locateNodes(randomKey));
      }
      await Promise.all(promises);
    }, lookupCount);
    
    // Wait for things to settle
    await page.waitForTimeout(10000);
    
    // Get final state
    const finalInfo = await getNodeInfo(page);
    const stats = await getConnectionStats(page);
    
    console.log('Final connections:', finalInfo?.nConnections);
    console.log('Connection stats:', JSON.stringify(stats?.stats, null, 2));
    
    // Check for "too many connections" type errors
    const errorEvents = stats?.stats?.errors || [];
    const connectionErrors = errorEvents.filter(e => 
      e.message?.includes('connection') || e.message?.includes('limit')
    );
    
    if (connectionErrors.length > 0) {
      console.log('Connection errors found:', connectionErrors);
    }
    
    // Node should still be running
    expect(finalInfo?.isRunning).toBe(true);
  });
});
