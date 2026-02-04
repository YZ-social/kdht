/**
 * Node.js version check
 * 
 * This project requires Node.js 22 or higher due to:
 * - Map.entries() returning an iterator that works directly with array methods
 * - Other ES2024+ features
 */
const { describe, it, expect } = globalThis;

const MIN_NODE_VERSION = 22;

describe('Node.js version', function () {
  it(`requires Node.js ${MIN_NODE_VERSION} or higher`, function () {
    const version = process.versions.node;
    const majorVersion = parseInt(version.split('.')[0], 10);
    
    expect(majorVersion).toBeGreaterThanOrEqual(
      MIN_NODE_VERSION,
      `Node.js ${MIN_NODE_VERSION}+ is required. You are running Node.js ${version}. ` +
      `Please upgrade your Node.js installation.`
    );
  });
});
