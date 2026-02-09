# Requirements Document

## Introduction

This document specifies requirements for proper WebRTC resource cleanup in the KDHT project. The system currently experiences resource leaks (UDP sockets, file descriptors) when WebRTC connections timeout, fail during transitional states, or when remote peers disconnect unexpectedly. These leaks cause server instability after extended operation (observed: 500+ UDP sockets, 2000+ file descriptors after 9 hours).

## Glossary

- **WebContact**: The class that wraps WebRTC connections for DHT node communication
- **WebRTC**: The underlying peer-to-peer connection technology using RTCPeerConnection
- **Connection_State**: The state of an RTCPeerConnection (new, connecting, connected, disconnected, failed, closed)
- **Data_Channel**: A WebRTC data channel used for sending/receiving DHT messages
- **Resource_Cleanup**: The process of releasing UDP sockets, file descriptors, and memory associated with a connection
- **Transitional_State**: Connection states where cleanup is unsafe (connecting, disconnecting)
- **Stable_State**: Connection states where cleanup is safe (connected, failed, closed)
- **Connection_Tracker**: The existing diagnostic class for tracking connection events

## Requirements

### Requirement 1: Safe Connection State Cleanup

**User Story:** As a system operator, I want WebRTC connections to only be closed when in safe states, so that cleanup operations don't cause resource consumption crashes or main thread blocking.

#### Acceptance Criteria

1. WHEN disconnectTransport is called WHILE the connection is in a transitional state (connecting, disconnecting), THE WebContact SHALL wait for the connection to reach a stable state before closing
2. WHEN disconnectTransport is called WHILE the connection is in a stable state (connected, failed, closed), THE WebContact SHALL proceed with immediate cleanup
3. IF a connection remains in a transitional state beyond a maximum wait time, THEN THE WebContact SHALL force cleanup and log a warning
4. THE WebContact SHALL check RTCPeerConnection.connectionState before initiating close operations

### Requirement 2: Complete Resource Release on Cleanup

**User Story:** As a system operator, I want all WebRTC resources to be fully released when a connection is cleaned up, so that UDP sockets and file descriptors don't accumulate over time.

#### Acceptance Criteria

1. WHEN a WebRTC connection is cleaned up, THE WebContact SHALL stop all media tracks before closing the connection
2. WHEN a WebRTC connection is cleaned up, THE WebContact SHALL remove all event listeners from the RTCPeerConnection
3. WHEN a WebRTC connection is cleaned up, THE WebContact SHALL remove all event listeners from the Data_Channel
4. WHEN a WebRTC connection is cleaned up, THE WebContact SHALL nullify all references to WebRTC objects to allow garbage collection
5. WHEN a WebRTC connection is cleaned up, THE WebContact SHALL close resources in the correct order: tracks → event listeners → data channel → peer connection → nullify references

### Requirement 3: Timeout Connection Cleanup

**User Story:** As a system operator, I want connections that timeout during establishment to be properly cleaned up, so that failed connection attempts don't leak resources.

#### Acceptance Criteria

1. WHEN a connection attempt times out, THE WebContact SHALL perform complete resource cleanup
2. WHEN a connection attempt times out, THE WebContact SHALL log the timeout event to Connection_Tracker
3. WHEN a connection attempt times out, THE WebContact SHALL not leave any dangling event listeners
4. WHEN a connection attempt times out, THE WebContact SHALL ensure the RTCPeerConnection is fully closed

### Requirement 4: Unexpected Disconnect Cleanup

**User Story:** As a system operator, I want unexpected peer disconnections to trigger proper cleanup, so that abandoned connections don't leak resources.

#### Acceptance Criteria

1. WHEN a remote peer disconnects unexpectedly, THE WebContact SHALL detect the disconnection via connection state change
2. WHEN a remote peer disconnects unexpectedly, THE WebContact SHALL perform complete resource cleanup
3. WHEN a remote peer disconnects unexpectedly, THE WebContact SHALL log the event to Connection_Tracker with relevant details
4. WHEN a remote peer disconnects unexpectedly, THE WebContact SHALL remove the contact from the host's routing table

### Requirement 5: Resource Usage Monitoring

**User Story:** As a system operator, I want to monitor WebRTC resource usage, so that I can detect leaks early before they cause system instability.

#### Acceptance Criteria

1. THE Connection_Tracker SHALL track the count of active WebRTC connections
2. THE Connection_Tracker SHALL track cleanup operations (success and failure counts)
3. THE Connection_Tracker SHALL provide a method to get current resource statistics
4. WHEN cleanup fails, THE Connection_Tracker SHALL log detailed error information including connection state and error message

### Requirement 6: Graceful Cleanup on Node Shutdown

**User Story:** As a system operator, I want all WebRTC resources to be cleaned up when a node disconnects from the network, so that shutdown doesn't leave orphaned resources.

#### Acceptance Criteria

1. WHEN a node calls disconnect(), THE WebContact SHALL clean up all active connections
2. WHEN a node calls disconnect(), THE WebContact SHALL wait for all cleanup operations to complete before resolving
3. WHEN a node calls disconnect(), THE WebContact SHALL handle cleanup failures gracefully without throwing exceptions
