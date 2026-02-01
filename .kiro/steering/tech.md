# Technology Stack

## Runtime
- Node.js with ES Modules (`"type": "module"`)
- Browser-compatible (WebRTC transport)

## Dependencies
- `@yz-social/webrtc` - WebRTC peer connections
- `uuid` - UUID generation for message tags and node names

## Dev Dependencies
- `jasmine` - Test framework
- `express` - Portal server
- `yargs` - CLI argument parsing

## Key Commands
```bash
# Run all tests (unit + WebRTC)
npm test

# Run unit tests only
npx jasmine

# Run WebRTC tests only
npm run testWebrtc

# Start portal server
npm start

# Run bot simulation
npm run bots
npm run thrashbots  # with thrashing
```

## Module Exports
```javascript
import { Node, Contact, KBucket, Helper } from '@yz-social/kdht';
import Router from '@yz-social/kdht/router';
import Portal from '@yz-social/kdht/portal';
```

## Code Conventions
- ES6 class syntax with inheritance chains (mixins via superclass chain)
- BigInt for 128-bit keys (use `n` suffix: `1n`, `0n`)
- Async/await for all network operations
- Static class properties for configuration constants
- `globalThis` destructuring for linter compatibility
