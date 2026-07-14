export type NormalizedMidiEvent = {
  type: "on" | "off" | "pedal";
  note?: number;
  velocity?: number;
  value?: number;
  on?: boolean;
  channel: number;
  time: number;
  portId: string;
};

const PK_HEADER = [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00];
const PK_INIT = [...PK_HEADER, 0x0f, 0x01, 0xf7];
const PARTYKEYS_MATCH = /partykey/i;

function normalizeTimestamp(value: number) {
  let time = Number(value);
  const now = performance.now();
  if (!Number.isFinite(time)) return now;
  if (time > 1e11 && Number.isFinite(performance.timeOrigin)) time -= performance.timeOrigin;
  return Math.abs(time - now) > 60_000 ? now : time;
}

export function parseMidiPacket(
  data: ArrayLike<number>,
  rawTime: number,
  portId: string,
  emit: (event: NormalizedMidiEvent) => void,
) {
  const bytes = Array.from(data || [], (value) => Number(value) & 0xff).filter((value) => value < 0xf8);
  const time = normalizeTimestamp(rawTime);
  let index = 0;
  let runningStatus = 0;

  while (index < bytes.length) {
    let status = bytes[index];
    if (status & 0x80) {
      index += 1;
      if (status >= 0xf0) {
        runningStatus = 0;
        if (status === 0xf0) {
          while (index < bytes.length && bytes[index] !== 0xf7) index += 1;
          if (index < bytes.length) index += 1;
        } else {
          index += status === 0xf2 ? 2 : status === 0xf1 || status === 0xf3 ? 1 : 0;
        }
        continue;
      }
      runningStatus = status;
    } else if (!runningStatus) {
      index += 1;
      continue;
    } else {
      status = runningStatus;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    const length = command === 0xc0 || command === 0xd0 ? 1 : 2;
    if (index + length > bytes.length) break;
    const data1 = bytes[index++];
    const data2 = length === 2 ? bytes[index++] : 0;

    if (command === 0x90 && data2 > 0) {
      emit({ type: "on", note: data1, velocity: data2, channel, time, portId });
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      emit({ type: "off", note: data1, velocity: 0, channel, time, portId });
    } else if (command === 0xb0 && data1 === 64) {
      emit({ type: "pedal", value: data2, on: data2 >= 64, channel, time, portId });
    }
  }
}

function encodeChannel(value: number) {
  const clean = Math.max(0, Math.min(255, Math.round(value)));
  return [Math.floor(clean / 128), clean % 128];
}

type RgbGroup = { rgb: [number, number, number]; keys: number[] };

export function buildRgbFrames(groups: RgbGroup[], maxBytes = 256) {
  const encoded = groups.map(({ rgb, keys }) => {
    const cleanKeys = [...new Set(keys)]
      .filter((key) => Number.isInteger(key) && key >= 0 && key <= 35);
    if (!cleanKeys.length) return null;
    return [
      ...encodeChannel(rgb[0]),
      ...encodeChannel(rgb[1]),
      ...encodeChannel(rgb[2]),
      cleanKeys.length,
      ...cleanKeys,
    ];
  }).filter(Boolean) as number[][];

  const frames: number[][] = [];
  let body: number[] = [];
  let count = 0;
  const flush = () => {
    if (!count) return;
    frames.push([...PK_HEADER, 0x15, count, ...body, 0xf7]);
    body = [];
    count = 0;
  };
  for (const group of encoded) {
    if (10 + body.length + group.length > maxBytes) flush();
    if (10 + group.length > maxBytes) throw new Error("PartyKeys SysEx frame exceeds 256 bytes");
    body.push(...group);
    count += 1;
  }
  flush();
  return frames;
}

function allOffFrame() {
  return [
    ...PK_HEADER, 0x15, 0x01,
    0, 0, 0, 0, 0, 0, 36,
    ...Array.from({ length: 36 }, (_, index) => index),
    0xf7,
  ];
}

type MidiInputLike = {
  id: string;
  name?: string | null;
  state?: string | null;
  onmidimessage: ((event: { data: ArrayLike<number>; timeStamp?: number; receivedTime?: number }) => void) | null;
};

type MidiOutputLike = {
  id: string;
  name?: string | null;
  state?: string | null;
  send: (data: number[], timestamp?: number) => void;
  clear?: () => void;
};

type MidiAccessLike = {
  inputs: { values: () => IterableIterator<MidiInputLike> };
  outputs: { values: () => IterableIterator<MidiOutputLike> };
  onstatechange: (() => void) | null;
};

export class PartyKeysMidi {
  private access: MidiAccessLike | null = null;
  private inputs: MidiInputLike[] = [];
  private outputs: MidiOutputLike[] = [];
  private sent = new Map<string, Set<number>>();
  private handler: (event: NormalizedMidiEvent) => void = () => {};
  private statusHandler: (status: { inputs: number; partyKeys: number; outputs: number }) => void = () => {};
  private sysexEnabled = false;
  mode: 36 | 72 = 36;

  async connect(
    handler: (event: NormalizedMidiEvent) => void,
    statusHandler: (status: { inputs: number; partyKeys: number; outputs: number }) => void,
  ) {
    this.handler = handler;
    this.statusHandler = statusHandler;
    if (!("requestMIDIAccess" in navigator)) throw new Error("当前浏览器不支持 Web MIDI，请使用 Chrome、Edge 或 MIDI Browser。");
    const request = (navigator as Navigator & {
      requestMIDIAccess: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
    }).requestMIDIAccess.bind(navigator);
    try {
      this.access = await request({ sysex: true }) as unknown as MidiAccessLike;
      this.sysexEnabled = true;
    } catch {
      this.access = await request() as unknown as MidiAccessLike;
      this.sysexEnabled = false;
    }
    this.access!.onstatechange = () => this.bind();
    this.bind();
  }

  setMode(mode: 36 | 72) {
    this.mode = mode;
    this.restore([]);
  }

  private bind() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].filter((port) => port.state !== "disconnected");
    this.outputs = [...this.access.outputs.values()]
      .filter((port) => this.sysexEnabled && port.state !== "disconnected" && PARTYKEYS_MATCH.test(port.name || ""))
      .slice(0, this.mode === 72 ? 2 : 1);

    for (const input of this.inputs) {
      input.onmidimessage = (event) => {
        parseMidiPacket(
          event.data,
          event.timeStamp ?? event.receivedTime ?? performance.now(),
          input.id,
          (parsed) => {
            if (parsed.note != null) parsed.note = this.normalizeNote(input, parsed.note);
            this.handler(parsed);
          },
        );
      };
    }
    for (const output of this.outputs) {
      try {
        output.send(PK_INIT);
        output.send(allOffFrame());
      } catch {
        continue;
      }
      this.sent.set(output.id, new Set());
    }
    this.statusHandler({
      inputs: this.inputs.length,
      partyKeys: this.inputs.filter((port) => PARTYKEYS_MATCH.test(port.name || "")).length,
      outputs: this.outputs.length,
    });
  }

  private normalizeNote(input: MidiInputLike, rawNote: number) {
    if (this.mode === 36 || !PARTYKEYS_MATCH.test(input.name || "")) return rawNote;
    const partyInputs = this.inputs.filter((port) => PARTYKEYS_MATCH.test(port.name || ""));
    const slot = partyInputs.findIndex((port) => port.id === input.id);
    if (slot === 0) return rawNote - 12;
    if (slot === 1) return rawNote + 24;
    return rawNote;
  }

  restore(normalizedNotes: number[], previewNotes: number[] = []) {
    const devices = this.outputs.length;
    for (let slot = 0; slot < devices; slot += 1) {
      const output = this.outputs[slot];
      const mapToKey = (note: number) => {
        if (this.mode === 36) return note >= 48 && note <= 83 ? note - 48 : null;
        if (slot === 0) return note >= 36 && note <= 71 ? note - 36 : null;
        return note >= 72 && note <= 107 ? note - 72 : null;
      };
      const current = normalizedNotes.map(mapToKey).filter((key): key is number => key != null);
      const preview = previewNotes.map(mapToKey).filter((key): key is number => key != null && !current.includes(key));
      const previous = this.sent.get(output.id) || new Set<number>();
      const next = new Set([...current, ...preview]);
      const off = [...previous].filter((key) => !next.has(key));
      const groups: RgbGroup[] = [];
      if (off.length) groups.push({ rgb: [0, 0, 0], keys: off });
      if (preview.length) groups.push({ rgb: [52, 65, 90], keys: preview });
      if (current.length) groups.push({ rgb: [255, 107, 74], keys: current });
      for (const frame of buildRgbFrames(groups)) {
        try { output.send(frame); } catch {}
      }
      this.sent.set(output.id, next);
    }
  }

  allOff() {
    for (const output of this.outputs) {
      output.clear?.();
      try { output.send(allOffFrame()); } catch {}
      this.sent.set(output.id, new Set());
    }
  }
}

const SAMPLE_PITCHES = [48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84];
const SAMPLE_LAYERS = [
  { suffix: 4, maxVelocity: 45 },
  { suffix: 8, maxVelocity: 78 },
  { suffix: 12, maxVelocity: 106 },
  { suffix: 16, maxVelocity: 127 },
];

function sampleName(midi: number) {
  const names = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

type Voice = { node: AudioScheduledSourceNode; gain: GainNode; source: string };

export class FourLayerPiano {
  context: AudioContext | null = null;
  private buffers: AudioBuffer[][] | null = null;
  private loading: Promise<void> | null = null;
  private ready = false;
  private keysBus: GainNode | null = null;
  private master: GainNode | null = null;
  private active = new Map<string, Voice>();
  private deferred = new Set<string>();
  private sustain = false;

  ensureAudio() {
    if (!this.context) this.createGraph();
    if (this.context?.state === "suspended") void this.context.resume();
    if (!this.loading) this.loading = this.loadSamples();
    return this.context!;
  }

  private createGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0.8;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 3;
    compressor.knee.value = 8;
    this.keysBus = context.createGain();
    this.keysBus.connect(this.master);
    this.master.connect(compressor);
    compressor.connect(context.destination);
  }

  private async loadSamples() {
    const context = this.context!;
    try {
      const decoded = await Promise.all(SAMPLE_LAYERS.flatMap((layer, layerIndex) =>
        SAMPLE_PITCHES.map(async (pitch, pitchIndex) => {
          const response = await fetch(`/samples/${sampleName(pitch)}v${layer.suffix}.mp3`);
          if (!response.ok) throw new Error("sample unavailable");
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          return { layerIndex, pitchIndex, buffer };
        }),
      ));
      this.buffers = SAMPLE_LAYERS.map(() => new Array<AudioBuffer>(SAMPLE_PITCHES.length));
      decoded.forEach(({ layerIndex, pitchIndex, buffer }) => {
        this.buffers![layerIndex][pitchIndex] = buffer;
      });
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  noteOn(note: number, velocity = 96, source = "user", when?: number) {
    const context = this.ensureAudio();
    const key = `${source}:${note}`;
    this.releaseKey(key, 0.04, true);
    const start = Math.max(context.currentTime, when ?? context.currentTime);
    const gain = context.createGain();
    let node: AudioScheduledSourceNode;
    if (this.ready && this.buffers) {
      const layerIndex = Math.max(0, SAMPLE_LAYERS.findIndex((layer) => velocity <= layer.maxVelocity));
      let pitchIndex = 0;
      SAMPLE_PITCHES.forEach((pitch, index) => {
        if (Math.abs(note - pitch) < Math.abs(note - SAMPLE_PITCHES[pitchIndex])) pitchIndex = index;
      });
      const sourceNode = context.createBufferSource();
      sourceNode.buffer = this.buffers[layerIndex][pitchIndex];
      sourceNode.playbackRate.value = 2 ** ((note - SAMPLE_PITCHES[pitchIndex]) / 12);
      gain.gain.value = 0.32 + 0.55 * (velocity / 127);
      node = sourceNode;
    } else {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440 * (2 ** ((note - 69) / 12));
      const level = Math.max(0.02, velocity / 127 * 0.28);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(Math.max(level * 0.25, 0.001), start + 1.2);
      node = oscillator;
    }
    node.connect(gain);
    gain.connect(this.keysBus!);
    node.start(start);
    this.active.set(key, { node, gain, source });
  }

  noteOff(note: number, source = "user") {
    const key = `${source}:${note}`;
    if (this.sustain && source === "user") {
      this.deferred.add(key);
      return;
    }
    this.releaseKey(key, 0.28, true);
  }

  setPedal(on: boolean) {
    this.sustain = on;
    if (!on) {
      [...this.deferred].forEach((key) => this.releaseKey(key, 0.34, true));
      this.deferred.clear();
    }
  }

  private releaseKey(key: string, release = 0.28, force = false) {
    const voice = this.active.get(key);
    if (!voice || !this.context) return;
    if (this.sustain && !force && voice.source === "user") return;
    this.active.delete(key);
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0005), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
    try { voice.node.stop(now + release + 0.05); } catch {}
  }

  releaseAll() {
    [...this.active.keys()].forEach((key) => this.releaseKey(key, 0.08, true));
    this.deferred.clear();
    this.sustain = false;
  }
}

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}
