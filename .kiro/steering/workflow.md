# Development Workflow Rules

## Current Branch
- Working branch: `recursive`
- This branch implements R/Kademlia conformance features

## Transport Constraints
- Transports use WebRTC or Node IPC only
- No other transport mechanisms should be introduced

## Work Process
1. Work on only one item at a time
2. Complete the current task fully before starting the next

## Testing Requirements
- All changes must have accompanying tests
- Tests must pass before committing
- Run `npm test` to verify all tests pass

## Commit Discipline
- Commit all code before moving on to the next task
- Each commit should represent a complete, working change

## Code Reuse
- Always look for existing code to use first before writing new code
- Check the codebase for similar patterns or utilities
- Prefer extending existing classes over creating new ones

## Change Log
After making changes, document in `CHANGELOG.md`:
- What was changed
- Why it was changed
- Any lessons learned that might help other developers solving similar problems
