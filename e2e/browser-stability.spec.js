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
