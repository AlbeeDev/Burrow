/**
 * Voice proxy: bridges a browser mic stream to Deepgram's realtime STT, keeping the API key on the
 * server. The browser opens a WebSocket to `/voice`, streams raw 16 kHz mono PCM (linear16) as
 * binary frames, and gets back JSON `{ transcript }` messages for each finalized phrase, which the
 * client feeds into the voice-command parser. Nothing here runs unless BURROW_DEEPGRAM_KEY is set,
 * so the whole feature is opt-in (like the usage provider): no key, no voice backend, no cost.
 */

import WebSocket from "ws";

/** The Deepgram key, or null when voice isn't configured. Read once at import. */
export const deepgramKey = process.env.BURROW_DEEPGRAM_KEY?.trim() || null;

// Realtime endpoint: Nova-3, linear16 PCM at 16 kHz, with smart formatting + final-only results.
const DG_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
  "&smart_format=true&punctuate=true&interim_results=false" +
  // Keyterm prompting (Nova-3): bias recognition toward the wake word + command verbs so they're
  // picked up reliably even with an accent. Doesn't affect normal dictation.
  "&keyterm=command&keyterm=start&keyterm=stop&keyterm=send&keyterm=clear" +
  "&keyterm=up&keyterm=down&keyterm=escape&keyterm=interrupt";

/**
 * Wire one browser voice socket to a fresh Deepgram socket. Audio flows browser -> Deepgram; final
 * transcripts flow Deepgram -> browser. Either side closing tears the other down, so a dropped tab
 * never leaves a Deepgram stream (and its billing) running.
 */
export function handleVoice(browser: WebSocket): void {
  if (!deepgramKey) {
    try { browser.close(1011, "voice not configured"); } catch { /* ignore */ }
    return;
  }
  const dg = new WebSocket(DG_URL, { headers: { Authorization: `Token ${deepgramKey}` } });

  // The client gates audio to speech only, so Deepgram sees silence as "no data". KeepAlive stops it
  // closing the idle connection (~10s timeout) without sending billable audio.
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  dg.on("open", () => {
    try { browser.send(JSON.stringify({ type: "ready" })); } catch { /* ignore */ }
    keepAlive = setInterval(() => {
      try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" })); } catch { /* ignore */ }
    }, 5000);
  });
  // Deepgram can emit the same finalized phrase more than once; drop an exact repeat of the last one
  // (within a few seconds) so a phrase isn't typed twice.
  let lastSent = "";
  let lastAt = 0;
  dg.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg?.channel?.alternatives?.[0];
      if (msg?.is_final && alt?.transcript) {
        const t = String(alt.transcript);
        const now = Date.now();
        if (t === lastSent && now - lastAt < 5000) { lastAt = now; return; }
        lastSent = t;
        lastAt = now;
        browser.send(JSON.stringify({ transcript: t }));
      }
    } catch { /* non-JSON keepalive, ignore */ }
  });
  dg.on("close", () => { if (keepAlive) clearInterval(keepAlive); try { browser.close(); } catch { /* ignore */ } });
  dg.on("error", () => { if (keepAlive) clearInterval(keepAlive); try { browser.close(); } catch { /* ignore */ } });

  browser.on("message", (data, isBinary) => {
    if (isBinary && dg.readyState === WebSocket.OPEN) dg.send(data);
  });
  browser.on("close", () => {
    try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
    try { dg.close(); } catch { /* ignore */ }
  });
}
