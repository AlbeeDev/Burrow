/**
 * Streams mic audio to the gateway's `/voice` proxy (Deepgram) and yields finalized transcripts.
 *
 * Captures 16 kHz mono, converts to linear16 PCM, and sends it as binary WS frames; the server adds
 * the API key and relays to Deepgram, so the key never reaches the browser. Transcripts come back as
 * `{ transcript }` JSON and are handed to `onText` (which the caller routes into the command parser).
 */

export type VoiceStream = { stop: () => void };

export async function startVoiceStream(opts: {
  onText: (text: string) => void;
  onStatus?: (s: string) => void;
}): Promise<VoiceStream> {
  opts.onStatus?.("connecting…");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ac = new AudioContext({ sampleRate: 16000 });
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const wsUrl = (location.protocol === "https:" ? "wss://": "ws://") + location.host + "/voice";
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      // "ready" isn't surfaced: the component shows the standby/dictating label once connected.
      if (msg.transcript) opts.onText(String(msg.transcript));
    } catch { /* ignore */ }
  };
  ws.onerror = () => opts.onStatus?.("voice error");

  src.connect(proc);
  proc.connect(ac.destination);
  // Voice-activity gate: only stream audio while you're actually speaking, so Deepgram bills ~only
  // for spoken time, not idle standby. A hangover keeps streaming briefly after speech so trailing
  // words aren't clipped. (The server sends keep-alives to hold the connection open during silence.)
  const FRAME_MS = (4096 / 16000) * 1000; // ~256ms per block
  const THRESHOLD = 0.01;
  const HANGOVER_MS = 1000;
  let speaking = false;
  let silenceMs = 0;
  proc.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < f32.length; i++) { const v = f32[i] ?? 0; sum += v * v; }
    const rms = Math.sqrt(sum / f32.length);
    if (rms > THRESHOLD) { speaking = true; silenceMs = 0; }
    else if (speaking) { silenceMs += FRAME_MS; if (silenceMs > HANGOVER_MS) speaking = false; }
    if (!speaking) return; // silence: send nothing (not billed); server keep-alive holds the socket
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
      i16[i] = s < 0 ? s * 0x8000: s * 0x7fff;
    }
    ws.send(i16.buffer);
  };

  return {
    stop: () => {
      try { proc.disconnect(); src.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { ac.close(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}
