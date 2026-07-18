export function createAuthoritativeStreamSession({
  canvas,
  remoteVideo,
  remoteAudio,
  audio,
  getTurnConfig,
  getRole,
  isEnabled,
  isPeerConnected,
  getLocalButtons,
  getRunning,
  hasNes,
  setRunning,
  stopLoop,
  startLoop,
  showGame,
  setPlayerButtons,
  sendMessage,
  setStatus,
  log,
  updateHud,
  updateSound,
} = {}) {
  let peerConnection = null;
  let inputChannel = null;
  let localMedia = null;
  let remoteMedia = null;
  let remoteAudioMedia = null;
  let pendingIce = [];
  let inputSequence = 0;
  let lastRemoteInputSequence = 0;
  let inputHeartbeat = 0;
  let connectTimeout = 0;
  let guestWasRunning = false;
  let firstFrameReady = false;
  let readySent = false;
  let statsTimer = 0;
  let statsSummary = null;

  function getRtcConfig() {
    const turn = getTurnConfig?.();
    const privateTurn = turn?.urls?.length && turn.username && turn.credential
      ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }]
      : [];
    return {
      iceServers: [
        ...privateTurn,
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 4,
    };
  }

  function maybeMarkReady() {
    if (readySent || !firstFrameReady || peerConnection?.connectionState !== 'connected') return;
    readySent = true;
    const audioMuted = remoteAudio.muted || remoteAudio.paused;
    setStatus(audioMuted ? '权威画面已同步，点一下手柄开启声音' : '已进入 1P 权威画面，2P 手柄可操作');
    sendMessage({ type: 'stream-ready', muted: audioMuted });
    log('stream-first-frame', { muted: audioMuted, width: remoteVideo.videoWidth, height: remoteVideo.videoHeight });
  }

  function armFirstFrameCheck() {
    const markReady = () => {
      firstFrameReady = true;
      maybeMarkReady();
    };
    if (typeof remoteVideo.requestVideoFrameCallback === 'function') remoteVideo.requestVideoFrameCallback(markReady);
    else remoteVideo.addEventListener('loadeddata', markReady, { once: true });
  }

  function sendInput(buttons = getLocalButtons(), { quiet = false } = {}) {
    if (!isEnabled() || getRole() !== 'guest') return;
    const message = {
      type: 'stream-input',
      player: 2,
      buttons: Array.from(buttons || []),
      sequence: ++inputSequence,
      heartbeat: quiet,
    };
    const payload = JSON.stringify(message);
    if (inputChannel?.readyState === 'open') {
      inputChannel.send(payload);
      if (!quiet) log('stream-input-send', { via: 'datachannel', sequence: message.sequence, buttons: message.buttons });
    } else {
      sendMessage(message);
      if (!quiet) log('stream-input-send', { via: 'relay', sequence: message.sequence, buttons: message.buttons });
    }
  }

  function applyRemoteInput(message) {
    if (!isEnabled() || getRole() !== 'host') return;
    const sequence = Math.max(0, Math.floor(Number(message.sequence) || 0));
    if (sequence && sequence <= lastRemoteInputSequence) return;
    if (sequence) lastRemoteInputSequence = sequence;
    setPlayerButtons(2, new Set(message.buttons || []), { broadcast: false });
    if (!message.heartbeat) log('stream-input-received', { sequence, buttons: message.buttons || [] });
  }

  function configureInputChannel(channel) {
    inputChannel = channel;
    channel.onopen = () => {
      log('stream-input-open', { role: getRole() });
      if (getRole() === 'guest') {
        sendInput();
        clearInterval(inputHeartbeat);
        inputHeartbeat = window.setInterval(() => sendInput(getLocalButtons(), { quiet: true }), 100);
      }
    };
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data || ''));
        if (message.type === 'stream-input') applyRemoteInput(message);
      } catch (error) {
        log('stream-input-error', { message: error?.message || String(error) });
      }
    };
    channel.onclose = () => {
      log('stream-input-close', { role: getRole() });
      clearInterval(inputHeartbeat);
      inputHeartbeat = 0;
      if (getRole() === 'host') setPlayerButtons(2, new Set(), { broadcast: false });
    };
  }

  function showRemoteStream(stream) {
    remoteMedia = stream;
    guestWasRunning = guestWasRunning || getRunning();
    if (getRunning()) stopLoop();
    showGame();
    remoteVideo.srcObject = stream;
    remoteVideo.muted = true;
    remoteVideo.classList.remove('hidden');
    updateSound();
    armFirstFrameCheck();
    remoteVideo.play().catch(() => setStatus('正在等待 1P 权威画面，请点一下手柄继续'));
  }

  function attachRemoteAudio(track) {
    remoteAudioMedia = new MediaStream([track]);
    remoteAudio.srcObject = remoteAudioMedia;
    remoteAudio.muted = false;
    remoteAudio.play().then(updateSound).catch(() => {
      remoteAudio.muted = true;
      updateSound();
    });
  }

  function unlockAudio(event) {
    if (getRole() !== 'guest' || remoteVideo.classList.contains('hidden')) return;
    if (event?.target?.closest?.('#soundBtn')) return;
    remoteAudio.muted = false;
    updateSound();
    remoteAudio.play().then(() => setStatus('已进入 1P 权威画面，2P 手柄可操作')).catch(() => {});
  }

  async function collectStats() {
    if (!peerConnection || peerConnection.connectionState !== 'connected') return;
    try {
      const reports = await peerConnection.getStats();
      const byId = new Map();
      reports.forEach((report) => byId.set(report.id, report));
      const summary = { role: getRole() };
      reports.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          summary.fps = Math.round(Number(report.framesPerSecond) || 0);
          summary.decoded = Number(report.framesDecoded) || 0;
          summary.dropped = Number(report.framesDropped) || 0;
          summary.jitterMs = Math.round((Number(report.jitter) || 0) * 1000);
          const emitted = Number(report.jitterBufferEmittedCount) || 0;
          summary.playoutMs = emitted ? Math.round((Number(report.jitterBufferDelay) || 0) * 1000 / emitted) : 0;
        }
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          summary.fps = Math.round(Number(report.framesPerSecond) || 0);
          summary.sent = Number(report.framesSent) || 0;
          summary.quality = report.qualityLimitationReason || 'none';
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) {
          summary.rttMs = Math.round((Number(report.currentRoundTripTime) || 0) * 1000);
          summary.availableKbps = Math.round((Number(report.availableOutgoingBitrate) || Number(report.availableIncomingBitrate) || 0) / 1000);
          summary.localCandidate = byId.get(report.localCandidateId)?.candidateType || '';
          summary.remoteCandidate = byId.get(report.remoteCandidateId)?.candidateType || '';
        }
      });
      statsSummary = summary;
      updateHud();
    } catch (error) {
      log('stream-stats-error', { message: error?.message || String(error) });
    }
  }

  function createPeerConnection() {
    const connection = new RTCPeerConnection(getRtcConfig());
    peerConnection = connection;
    pendingIce = [];
    connection.onicecandidate = (event) => {
      if (event.candidate) sendMessage({ type: 'stream-ice', candidate: event.candidate.toJSON?.() || event.candidate });
    };
    connection.oniceconnectionstatechange = () => log('stream-ice-state', { state: connection.iceConnectionState });
    connection.onconnectionstatechange = () => {
      log('stream-peer-state', { state: connection.connectionState });
      if (connection.connectionState === 'connected') {
        clearTimeout(connectTimeout);
        connectTimeout = 0;
        maybeMarkReady();
        clearInterval(statsTimer);
        collectStats();
        statsTimer = window.setInterval(collectStats, 3000);
      } else if (['failed', 'disconnected'].includes(connection.connectionState)) {
        setStatus('权威串流连接中断，请重新加入房间');
      }
    };
    if (getRole() === 'guest') {
      connection.ondatachannel = (event) => configureInputChannel(event.channel);
      connection.ontrack = (event) => {
        try {
          if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
          if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
        } catch (error) { /* optional browser hints */ }
        if (event.track.kind === 'video') showRemoteStream(new MediaStream([event.track]));
        else if (event.track.kind === 'audio') attachRemoteAudio(event.track);
        log('stream-track-received', { kind: event.track.kind });
      };
    }
    return connection;
  }

  async function flushIce() {
    if (!peerConnection?.remoteDescription) return;
    const candidates = pendingIce.splice(0);
    for (const candidate of candidates) {
      try {
        await peerConnection.addIceCandidate(candidate);
      } catch (error) {
        log('stream-ice-add-error', { message: error?.message || String(error) });
      }
    }
  }

  async function startHost() {
    if (!isEnabled() || getRole() !== 'host' || !isPeerConnected()) return;
    if (!window.RTCPeerConnection || typeof canvas.captureStream !== 'function') {
      setStatus('当前 1P 浏览器不支持权威画面串流，请使用新版 Safari/Chrome');
      return;
    }
    teardown({ restoreLocalGame: false });
    audio.init();
    const connection = createPeerConnection();
    configureInputChannel(connection.createDataChannel('nes-input', { ordered: false, maxRetransmits: 0 }));
    localMedia = canvas.captureStream(60);
    const videoTrack = localMedia.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = 'motion';
      const sender = connection.addTrack(videoTrack, localMedia);
      const transceiver = connection.getTransceivers().find((candidate) => candidate.sender === sender);
      const codecs = window.RTCRtpSender?.getCapabilities?.('video')?.codecs || [];
      const h264 = codecs.filter((codec) => codec.mimeType?.toLowerCase() === 'video/h264');
      if (transceiver?.setCodecPreferences && h264.length) {
        transceiver.setCodecPreferences([...h264, ...codecs.filter((codec) => !h264.includes(codec))]);
      }
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = 800_000;
      parameters.encodings[0].maxFramerate = 60;
      parameters.degradationPreference = 'maintain-framerate';
      sender.setParameters(parameters)
        .then(() => log('stream-video-parameters', { maxBitrate: 800000, maxFramerate: 60, codec: h264.length ? 'H264-first' : 'browser-default' }))
        .catch((error) => log('stream-video-parameters-error', { message: error?.message || String(error) }));
    }
    for (const track of audio.getStreamDestination()?.stream?.getAudioTracks?.() || []) {
      localMedia.addTrack(track);
      connection.addTrack(track, localMedia);
    }
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    sendMessage({ type: 'stream-offer', description: connection.localDescription });
    setStatus('2P 已连接，正在建立 1P 权威画面...');
    log('stream-offer-send', { tracks: localMedia.getTracks().map((track) => track.kind) });
    clearTimeout(connectTimeout);
    connectTimeout = window.setTimeout(() => {
      if (peerConnection?.connectionState !== 'connected') {
        setStatus('权威串流未能直连；需要为路由器补充私人 TURN');
        log('stream-connect-timeout', { ice: peerConnection?.iceConnectionState || 'none' });
      }
    }, 10000);
  }

  async function acceptOffer(message) {
    if (!isEnabled() || getRole() !== 'guest') return;
    if (!window.RTCPeerConnection) {
      setStatus('当前 2P 浏览器不支持权威画面串流');
      return;
    }
    const earlyIce = pendingIce.slice();
    teardown({ restoreLocalGame: false });
    const connection = createPeerConnection();
    pendingIce = earlyIce;
    await connection.setRemoteDescription(message.description);
    await flushIce();
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    sendMessage({ type: 'stream-answer', description: connection.localDescription });
    setStatus('已连接房间，正在接收 1P 权威画面...');
    log('stream-answer-send');
  }

  async function acceptAnswer(message) {
    if (!isEnabled() || getRole() !== 'host' || !peerConnection) return;
    await peerConnection.setRemoteDescription(message.description);
    await flushIce();
    log('stream-answer-received');
  }

  function addIce(message) {
    if (!isEnabled() || !message.candidate) return;
    const candidate = new RTCIceCandidate(message.candidate);
    if (!peerConnection?.remoteDescription) pendingIce.push(candidate);
    else peerConnection.addIceCandidate(candidate).catch((error) => {
      log('stream-ice-add-error', { message: error?.message || String(error) });
    });
  }

  function teardown({ restoreLocalGame = true } = {}) {
    clearTimeout(connectTimeout);
    connectTimeout = 0;
    clearInterval(inputHeartbeat);
    inputHeartbeat = 0;
    clearInterval(statsTimer);
    statsTimer = 0;
    statsSummary = null;
    if (inputChannel) {
      inputChannel.onclose = null;
      inputChannel.close?.();
    }
    inputChannel = null;
    peerConnection?.close?.();
    peerConnection = null;
    localMedia?.getVideoTracks?.().forEach((track) => track.stop());
    localMedia = null;
    remoteMedia = null;
    remoteAudioMedia = null;
    pendingIce = [];
    inputSequence = 0;
    lastRemoteInputSequence = 0;
    firstFrameReady = false;
    readySent = false;
    remoteVideo.pause?.();
    remoteVideo.srcObject = null;
    remoteVideo.classList.add('hidden');
    remoteAudio.pause?.();
    remoteAudio.srcObject = null;
    remoteAudio.muted = true;
    if (restoreLocalGame && guestWasRunning && hasNes() && !getRunning()) {
      setRunning(true);
      startLoop();
    }
    guestWasRunning = false;
  }

  function getStatus() {
    return {
      peer: peerConnection?.connectionState || 'none',
      ice: peerConnection?.iceConnectionState || 'none',
      input: inputChannel?.readyState || 'none',
      stats: statsSummary,
    };
  }

  return {
    acceptAnswer,
    acceptOffer,
    addIce,
    applyRemoteInput,
    getStatus,
    sendInput,
    startHost,
    teardown,
    unlockAudio,
  };
}
