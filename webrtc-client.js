/**
 * WebRTC Screen Receiver - Client Implementation
 * A WebRTC client for receiving screen sharing streams
 */

// Global variables
let ws = null;                // WebSocket connection
let peerConnection = null;    // RTCPeerConnection
let remoteStream = null;      // Remote media stream
let isConnected = false;      // Connection state
let statsInterval = null;     // Interval for collecting stats
let showStats = false;        // Toggle for stats display
let dataChannel = null;       // WebRTC DataChannel for input events
let micStream = null;         // Local mic stream

// ICE server configuration
const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};

// DOM Elements
const elements = {
    serverUrlInput: document.getElementById('serverUrlInput'),
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    connectionStatus: document.getElementById('connectionStatus'),
    remoteVideo: document.getElementById('remoteVideo'),
    videoStatus: document.getElementById('videoStatus'),
    statsPanel: document.getElementById('statsPanel'),
    statsToggleBtn: document.getElementById('statsToggleBtn'),
    statsOutput: document.getElementById('statsOutput'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    messageLog: document.getElementById('messageLog').querySelector('pre'),
    autoScrollCheck: document.getElementById('autoScrollCheck'),
    inputLog: document.getElementById('inputLog').querySelector('pre'),
    inputBinaryLog: document.getElementById('inputBinaryLog').querySelector('pre'),
};

// --- Input Event Binary Protocol Constants ---
const INPUT_EVENT_TYPE = {
    KEYBOARD: 0,
    MOUSE_MOVE: 1,
    MOUSE_BUTTON: 2,
    MOUSE_WHEEL: 3,
    GAMEPAD: 4 // for future
};
let inputSequenceNumber = 0;
const inputPageLoadTime = performance.now();
function getInputTimestampMs() {
    return Math.floor(performance.now() - inputPageLoadTime);
}

function encodeKeyboardEvent(e, keyState) {
    // keyState: 0=up, 1=down
    const buffer = new ArrayBuffer(16);
    const dv = new DataView(buffer);
    dv.setUint32(0, inputSequenceNumber++, true); // sequence_number
    dv.setUint32(4, getInputTimestampMs(), true); // timestamp_ms
    dv.setUint8(8, INPUT_EVENT_TYPE.KEYBOARD);    // type
    dv.setUint8(9, e.keyCode & 0xFF);            // keyboard.key_code (Windows VK code)
    dv.setUint8(10, keyState);                   // keyboard.key_state
    // rest is padding/unused
    return buffer;
}

function getScaledVideoCoordinates(e, videoElem) {
    // Get bounding rect and mouse position relative to element
    const rect = videoElem.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Get actual video resolution
    const vw = videoElem.videoWidth || rect.width;
    const vh = videoElem.videoHeight || rect.height;
    // Get displayed size
    const dw = rect.width;
    const dh = rect.height;
    // Scale coordinates to video resolution
    const sx = Math.round((x / dw) * vw);
    const sy = Math.round((y / dh) * vh);
    return { x: sx, y: sy };
}

function encodeMouseMoveEvent(e) {
    const v = elements.remoteVideo;
    const coords = getScaledVideoCoordinates(e, v);
    const buffer = new ArrayBuffer(16);
    const dv = new DataView(buffer);
    dv.setUint32(0, inputSequenceNumber++, true);
    dv.setUint32(4, getInputTimestampMs(), true);
    dv.setUint8(8, INPUT_EVENT_TYPE.MOUSE_MOVE);
    dv.setInt16(9, coords.x, true);
    dv.setInt16(11, coords.y, true);
    // button/button_state/wheel_delta = 0
    return buffer;
}

function encodeMouseButtonEvent(e, buttonState) {
    const v = elements.remoteVideo;
    const coords = getScaledVideoCoordinates(e, v);
    const buffer = new ArrayBuffer(16);
    const dv = new DataView(buffer);
    dv.setUint32(0, inputSequenceNumber++, true);
    dv.setUint32(4, getInputTimestampMs(), true);
    dv.setUint8(8, INPUT_EVENT_TYPE.MOUSE_BUTTON);
    dv.setInt16(9, coords.x, true);
    dv.setInt16(11, coords.y, true);
    dv.setUint8(13, e.button & 0xFF);      // mouse.button
    dv.setUint8(14, buttonState);          // mouse.button_state
    // wheel_delta = 0
    return buffer;
}

function encodeMouseWheelEvent(e) {
    const v = elements.remoteVideo;
    const coords = getScaledVideoCoordinates(e, v);
    const buffer = new ArrayBuffer(16);
    const dv = new DataView(buffer);
    dv.setUint32(0, inputSequenceNumber++, true);
    dv.setUint32(4, getInputTimestampMs(), true);
    dv.setUint8(8, INPUT_EVENT_TYPE.MOUSE_WHEEL);
    dv.setInt16(9, coords.x, true);
    dv.setInt16(11, coords.y, true);
    // button/button_state = 0
    dv.setInt16(15, Math.round(e.deltaY), true); // mouse.wheel_delta (at offset 15)
    return buffer;
}

function sendInputEvent(buffer) {
    logInputBinary(buffer); // Show binary data in UI
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(buffer);
    }
}

// Initialize the application
function init() {
    attachEventListeners();
    log('Game Streaming Viewer Initialized');
    // Set version in UI for cache-busting/debugging
    const version = 'v1.0.3';
    const versionElem = document.getElementById('version');
    if (versionElem) versionElem.textContent = version;
    elements.statsPanel.style.display = 'none';
    elements.fullscreenBtn = document.getElementById('fullscreenBtn');
    elements.micBtn = document.getElementById('micBtn');
    elements.fullscreenBtn.disabled = true;
    elements.micBtn.disabled = true;
    elements.fullscreenBtn.addEventListener('click', () => {
        if (elements.remoteVideo.requestFullscreen) {
            elements.remoteVideo.requestFullscreen();
        } else if (elements.remoteVideo.webkitRequestFullscreen) {
            elements.remoteVideo.webkitRequestFullscreen();
        } else if (elements.remoteVideo.msRequestFullscreen) {
            elements.remoteVideo.msRequestFullscreen();
        }
    });
    elements.micBtn.addEventListener('click', toggleMic);
}

// Attach event listeners to DOM elements
function attachEventListeners() {
    elements.connectBtn.addEventListener('click', connectToServer);
    elements.disconnectBtn.addEventListener('click', disconnectFromServer);
    elements.statsToggleBtn.addEventListener('click', toggleStatsPanel);
    elements.clearLogBtn.addEventListener('click', clearLog);
    // Only record input when over the video streamer component
    setupVideoInputListeners();
}

// Log input events to the input log panel
function logInput(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    const currentLog = elements.inputLog.textContent;
    elements.inputLog.textContent = currentLog + '\n' + logEntry;
    // Always scroll input log to bottom
    const logContainer = elements.inputLog.parentElement;
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Log input binary data to the input binary log panel
function logInputBinary(buffer) {
    const timestamp = new Date().toLocaleTimeString();
    const arr = new Uint8Array(buffer);
    const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const logEntry = `[${timestamp}] ${hex}`;
    const currentLog = elements.inputBinaryLog.textContent;
    elements.inputBinaryLog.textContent = currentLog + '\n' + logEntry;
    // Always scroll input binary log to bottom
    const logContainer = elements.inputBinaryLog.parentElement;
    logContainer.scrollTop = logContainer.scrollHeight;
}

function setupVideoInputListeners() {
    const video = elements.remoteVideo;
    let isActive = false;

    // Remove previous listeners if any (optional, for hot reload)
    video.replaceWith(video.cloneNode(true));
    elements.remoteVideo = document.getElementById('remoteVideo');
    const v = elements.remoteVideo;

    // Keyboard input (focus required)
    v.addEventListener('keydown', (e) => {
        if (!isActive || e.repeat) return;
        sendInputEvent(encodeKeyboardEvent(e, 1));
        logInput(`Keyboard DOWN: keyCode=${e.keyCode}`);
        e.preventDefault();
    });
    v.addEventListener('keyup', (e) => {
        if (!isActive) return;
        sendInputEvent(encodeKeyboardEvent(e, 0));
        logInput(`Keyboard UP: keyCode=${e.keyCode}`);
        e.preventDefault();
    });

    // Mouse move
    v.addEventListener('mousemove', (e) => {
        if (!isActive) return;
        sendInputEvent(encodeMouseMoveEvent(e));
    });
    // Mouse button
    v.addEventListener('mousedown', (e) => {
        if (!isActive) return;
        sendInputEvent(encodeMouseButtonEvent(e, 1));
        logInput(`Mouse DOWN: button=${e.button}`);
    });
    v.addEventListener('mouseup', (e) => {
        if (!isActive) return;
        sendInputEvent(encodeMouseButtonEvent(e, 0));
        logInput(`Mouse UP: button=${e.button}`);
    });
    // Mouse wheel
    v.addEventListener('wheel', (e) => {
        if (!isActive) return;
        sendInputEvent(encodeMouseWheelEvent(e));
        logInput(`Mouse WHEEL: deltaY=${e.deltaY}`);
        e.preventDefault();
    });

    // Focus/hover logic
    v.addEventListener('mouseenter', () => { isActive = true; v.focus(); });
    v.addEventListener('mouseleave', () => { isActive = false; });
    v.addEventListener('focus', () => { isActive = true; });
    v.addEventListener('blur', () => { isActive = false; });
    // Make video focusable
    v.setAttribute('tabindex', '0');
}

// Connect to WebSocket server
function connectToServer() {
    const serverUrl = elements.serverUrlInput.value.trim();
    if (!serverUrl) {
        log('Error: Server URL is required', 'error');
        return;
    }
    try {
        ws = new WebSocket(serverUrl);
        ws.onopen = () => {
            isConnected = true;
            updateConnectionStatus(true);
            log(`Connected to server: ${serverUrl}`, 'success');
            sendInitialMessage();
        };
        ws.onmessage = handleWebSocketMessage;
        ws.onclose = event => {
            isConnected = false;
            updateConnectionStatus(false);
            cleanupPeerConnection();
            log(`Disconnected from server. Code: ${event.code}, Reason: ${event.reason}`, 'warning');
        };
        ws.onerror = error => {
            log('WebSocket error: ' + error.message, 'error');
        };
    } catch (error) {
        log('Failed to connect: ' + error.message, 'error');
    }
}

// Send initial registration message
function sendInitialMessage() {
    sendToServer({ type: 'register', clientType: 'viewer' });
}

// Disconnect from WebSocket server
function disconnectFromServer() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
}

// Update the connection status in the UI
function updateConnectionStatus(connected) {
    elements.connectionStatus.textContent = connected ? 'Connected' : 'Disconnected';
    elements.connectionStatus.className = connected ? 'status-value connected' : 'status-value disconnected';
    elements.connectBtn.disabled = connected;
    elements.disconnectBtn.disabled = !connected;
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(event) {
    try {
        const message = JSON.parse(event.data);
        switch (message.type) {
            case 'registered':
                log('Registered as viewer', 'success');
                break;
            case 'offer':
                handleOffer(message);
                break;
            case 'answer':
                handleAnswer(message);
                break;
            case 'ice-candidate':
                handleIceCandidate(message);
                break;
            case 'error':
                log(`Server error: ${message.error || message.message}`, 'error');
                break;
            default:
                log(`Unknown message type: ${message.type}`, 'warning');
        }
    } catch (error) {
        log('Error parsing message: ' + error.message, 'error');
    }
}

// Send a message to the WebSocket server
function sendToServer(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('Cannot send message: Not connected to server', 'error');
        return false;
    }
    try {
        ws.send(JSON.stringify(message));
        return true;
    } catch (error) {
        log('Error sending message: ' + error.message, 'error');
        return false;
    }
}

// Handle an incoming WebRTC offer
function handleOffer(message) {
    log('Received WebRTC offer', 'info');
    cleanupPeerConnection();
    createPeerConnection();
    const rtcSessionDescription = new RTCSessionDescription({ type: 'offer', sdp: message.sdp });
    peerConnection.setRemoteDescription(rtcSessionDescription)
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => {
            sendToServer({ type: 'answer', sdp: peerConnection.localDescription.sdp });
        })
        .catch(error => {
            log('Error handling offer: ' + error.message, 'error');
        });
}

// Handle an incoming WebRTC answer
function handleAnswer(message) {
    if (!peerConnection) return;
    const rtcSessionDescription = new RTCSessionDescription({ type: 'answer', sdp: message.sdp });
    peerConnection.setRemoteDescription(rtcSessionDescription)
        .then(() => log('Set remote description from answer', 'success'))
        .catch(error => log('Error handling answer: ' + error.message, 'error'));
}

// Handle an incoming ICE candidate
function handleIceCandidate(message) {
    if (!peerConnection) return;
    if (message.candidate && message.sdpMid !== undefined && message.sdpMLineIndex !== undefined) {
        const candidate = new RTCIceCandidate({
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
            candidate: message.candidate
        });
        peerConnection.addIceCandidate(candidate)
            .then(() => log('Added remote ICE candidate', 'info'))
            .catch(error => log('Error adding ice candidate: ' + error.message, 'error'));
    }
}

// Create and initialize a WebRTC peer connection
function createPeerConnection() {
    try {
        peerConnection = new RTCPeerConnection(iceServers);
        // Use existing data channel with label 'input' if available
        dataChannel = null;
        peerConnection.ondatachannel = (event) => {
            if (event.channel && event.channel.label === 'input') {
                dataChannel = event.channel;
                dataChannel.onopen = () => {
                    log('DataChannel open', 'success');
                    logInput('DataChannel open');
                };
                dataChannel.onerror = e => {
                    log('DataChannel error: ' + e.message, 'error');
                    logInput('DataChannel error: ' + e.message);
                };
                dataChannel.onclose = () => {
                    log('DataChannel closed', 'warning');
                    logInput('DataChannel closed');
                };
            }
        };
        // If acting as the offerer, create the channel if not already present
        if (!dataChannel) {
            dataChannel = peerConnection.createDataChannel('input');
            dataChannel.onopen = () => log('DataChannel open', 'success');
            dataChannel.onerror = e => log('DataChannel error: ' + e.message, 'error');
            dataChannel.onclose = () => log('DataChannel closed', 'warning');
        }
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                sendToServer({
                    type: 'ice-candidate',
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    candidate: event.candidate.candidate
                });
            }
        };
        peerConnection.ontrack = event => {
            remoteStream = event.streams[0];
            elements.remoteVideo.srcObject = remoteStream;
            // Debug: Log all tracks in the remote stream
            console.log('Remote stream tracks:', remoteStream.getTracks());
            // Log audio tracks specifically
            const audioTracks = remoteStream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('No audio tracks found in remote stream!');
            } else {
                audioTracks.forEach((track, idx) => {
                    console.log(`Audio track ${idx}: enabled=${track.enabled}, id=${track.id}, kind=${track.kind}`);
                });
            }
            // Log video tracks as well
            const videoTracks = remoteStream.getVideoTracks();
            if (videoTracks.length === 0) {
                console.warn('No video tracks found in remote stream!');
            } else {
                videoTracks.forEach((track, idx) => {
                    console.log(`Video track ${idx}: enabled=${track.enabled}, id=${track.id}, kind=${track.kind}`);
                });
            }
            updateVideoControls(true);
            updateVideoStatus('');
            if (showStats) startStatsInterval();
        };
        peerConnection.oniceconnectionstatechange = () => {
            if (["disconnected", "failed", "closed"].includes(peerConnection.iceConnectionState)) {
                updateVideoStatus('Connection lost');
                updateVideoControls(false);
                stopStatsInterval();
            }
        };
        peerConnection.onsignalingstatechange = () => {
            log(`Signaling state: ${peerConnection.signalingState}`, 'info');
        };
        log('RTCPeerConnection created', 'success');
    } catch (error) {
        log('Failed to create peer connection: ' + error.message, 'error');
    }
}

// Clean up and close the peer connection
function cleanupPeerConnection() {
    stopStatsInterval();
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onsignalingstatechange = null;
        peerConnection.close();
        peerConnection = null;
        log('Peer connection closed', 'info');
    }
    if (elements.remoteVideo.srcObject) {
        const tracks = elements.remoteVideo.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        elements.remoteVideo.srcObject = null;
        remoteStream = null;
    }
    updateVideoControls(false);
    updateVideoStatus('No stream available');
}

// Update video controls based on stream availability
function updateVideoControls(hasStream) {
    if (elements.fullscreenBtn) {
        elements.fullscreenBtn.disabled = !hasStream;
    }
    if (elements.micBtn) {
        elements.micBtn.disabled = !hasStream;
    }
}

// Update the video status message
function updateVideoStatus(message) {
    elements.videoStatus.textContent = message;
    elements.videoStatus.style.display = message ? 'block' : 'none';
    // Hide the overlay if message is empty (stream is active)
    if (!message) {
        elements.videoStatus.style.display = 'none';
    }
}

// Toggle the statistics panel visibility
function toggleStatsPanel() {
    showStats = !showStats;
    elements.statsPanel.style.display = showStats ? 'block' : 'none';
    if (showStats && peerConnection) {
        startStatsInterval();
    } else {
        stopStatsInterval();
    }
}

// Start collecting and displaying WebRTC statistics
function startStatsInterval() {
    if (statsInterval) return;
    statsInterval = setInterval(getAndDisplayStats, 1000);
}

// Stop collecting WebRTC statistics
function stopStatsInterval() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
}

// Get and display WebRTC stats
function getAndDisplayStats() {
    if (!peerConnection || !remoteStream) {
        elements.statsOutput.textContent = 'No active connection';
        document.getElementById('statLatency').textContent = 'N/A';
        document.getElementById('statResolution').textContent = 'N/A';
        document.getElementById('statFps').textContent = 'N/A';
        return;
    }
    peerConnection.getStats().then(stats => {
        let latency = null, width = null, height = null, fps = null;
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                if (report.roundTripTime) latency = (report.roundTripTime * 1000).toFixed(1);
                if (report.frameWidth) width = report.frameWidth;
                if (report.frameHeight) height = report.frameHeight;
                if (report.framesPerSecond) fps = report.framesPerSecond;
            }
        });
        document.getElementById('statLatency').textContent = latency ? `${latency} ms` : 'N/A';
        document.getElementById('statResolution').textContent = (width && height) ? `${width}x${height}` : 'N/A';
        document.getElementById('statFps').textContent = fps ? fps : 'N/A';
        // For legacy output panel if present
        if (elements.statsOutput) {
            let statsOutput = '';
            statsOutput += `Latency: ${latency ? latency + ' ms' : 'N/A'}\n`;
            statsOutput += `Resolution: ${width && height ? width + 'x' + height : 'N/A'}\n`;
            statsOutput += `FPS: ${fps ? fps : 'N/A'}\n`;
            elements.statsOutput.textContent = statsOutput;
        }
    }).catch(error => {
        if (elements.statsOutput) elements.statsOutput.textContent = 'Error getting stats: ' + error.message;
        document.getElementById('statLatency').textContent = 'N/A';
        document.getElementById('statResolution').textContent = 'N/A';
        document.getElementById('statFps').textContent = 'N/A';
    });
}

// Log a message to the UI console
function log(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    const currentLog = elements.messageLog.textContent;
    elements.messageLog.textContent = currentLog + '\n' + logEntry;
    if (elements.autoScrollCheck.checked) {
        const logContainer = elements.messageLog.parentElement;
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    switch (level) {
        case 'error':
            console.error(message);
            break;
        case 'warning':
            console.warn(message);
            break;
        case 'success':
            console.info('%c' + message, 'color: green');
            break;
        default:
            console.log(message);
    }
}

// Clear the log display
function clearLog() {
    elements.messageLog.textContent = 'Log cleared';
}

// Toggle mic on/off
async function toggleMic() {
    if (micStream) {
        // Turn off mic
        micStream.getTracks().forEach(track => track.stop());
        if (peerConnection && peerConnection.getSenders) {
            peerConnection.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === 'audio') {
                    peerConnection.removeTrack(sender);
                }
            });
        }
        micStream = null;
        elements.micBtn.textContent = 'Mic';
        log('Microphone stopped', 'info');
        return;
    }
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (peerConnection) {
            micStream.getAudioTracks().forEach(track => {
                peerConnection.addTrack(track, micStream);
            });
        }
        elements.micBtn.textContent = 'Mic On';
        log('Microphone started', 'success');
    } catch (err) {
        log('Microphone error: ' + err.message, 'error');
    }
}

// To adjust FPS: Change the frame capture interval in the C++ server code (e.g., in CaptureLoop, change sleep_for(milliseconds(33)) for ~30 FPS)
// Example: std::this_thread::sleep_for(std::chrono::milliseconds(16)); // for ~60 FPS

// Initialize the application when DOM is fully loaded
document.addEventListener('DOMContentLoaded', init);

