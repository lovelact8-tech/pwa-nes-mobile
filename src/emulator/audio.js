export function createAudioController({
  onStatus,
  onChange,
  getSourceSampleRate,
} = {}) {
  let context = null;
  let scriptNode = null;
  let enabled = false;
  let readIndex = 0;
  let writeIndex = 0;
  let sampleCount = 0;
  let resampleAccumulator = 0;
  let leftBuffer = null;
  let rightBuffer = null;
  let streamDestination = null;

  const notifyChange = () => onChange?.({ context, enabled });

  function getSampleRate() {
    return context?.sampleRate || 44100;
  }

  function init() {
    if (context) {
      context.resume?.();
      enabled = true;
      notifyChange();
      return true;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      onStatus?.('当前浏览器不支持声音');
      return false;
    }

    try {
      context = new AudioContextClass();
      const capacity = Math.max(16384, Math.ceil(context.sampleRate * 0.5));
      leftBuffer = new Float32Array(capacity);
      rightBuffer = new Float32Array(capacity);
      readIndex = 0;
      writeIndex = 0;
      sampleCount = 0;

      scriptNode = context.createScriptProcessor(1024, 0, 2);
      scriptNode.onaudioprocess = (event) => {
        const outLeft = event.outputBuffer.getChannelData(0);
        const outRight = event.outputBuffer.getChannelData(1);
        for (let index = 0; index < outLeft.length; index++) {
          if (enabled && sampleCount > 0) {
            outLeft[index] = leftBuffer[readIndex];
            outRight[index] = rightBuffer[readIndex];
            readIndex = (readIndex + 1) % leftBuffer.length;
            sampleCount--;
          } else {
            outLeft[index] = 0;
            outRight[index] = 0;
          }
        }
      };
      scriptNode.connect(context.destination);
      if (typeof context.createMediaStreamDestination === 'function') {
        streamDestination = context.createMediaStreamDestination();
        scriptNode.connect(streamDestination);
      }
      context.resume?.();
      enabled = true;
      notifyChange();
      return true;
    } catch (error) {
      console.warn(error);
      onStatus?.('声音启动失败，可继续无声游玩');
      return false;
    }
  }

  function clear() {
    readIndex = 0;
    writeIndex = 0;
    sampleCount = 0;
    resampleAccumulator = 0;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    clear();
    context?.resume?.();
    notifyChange();
  }

  function toggle() {
    if (!context) return init();
    setEnabled(!enabled);
    return enabled;
  }

  function writeSample(left, right) {
    if (!context || !leftBuffer) return;
    const maxBufferedSamples = Math.ceil(context.sampleRate * 0.12);
    while (sampleCount > maxBufferedSamples) {
      readIndex = (readIndex + 1) % leftBuffer.length;
      sampleCount--;
    }
    if (sampleCount >= leftBuffer.length - 1) {
      readIndex = (readIndex + 1) % leftBuffer.length;
      sampleCount--;
    }
    leftBuffer[writeIndex] = left;
    rightBuffer[writeIndex] = right;
    writeIndex = (writeIndex + 1) % leftBuffer.length;
    sampleCount++;
  }

  function pushSample(left, right) {
    if (!context || !leftBuffer) return;
    const sourceRate = Math.max(8000, Number(getSourceSampleRate?.()) || context.sampleRate);
    resampleAccumulator += context.sampleRate / sourceRate;
    let written = 0;
    while (resampleAccumulator >= 1 && written < 4) {
      writeSample(left, right);
      resampleAccumulator -= 1;
      written++;
    }
  }

  return {
    clear,
    getContext: () => context,
    getSampleRate,
    getStreamDestination: () => streamDestination,
    init,
    isEnabled: () => enabled,
    pushSample,
    setEnabled,
    toggle,
  };
}
