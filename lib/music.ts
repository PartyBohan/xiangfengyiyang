export type ChordEvent = {
  beat: number;
  duration: number;
  symbol: string;
  notes: number[];
  lyric?: string;
};

export type MelodyEvent = {
  beat: number;
  duration: number;
  notes: number[];
  lyric?: string;
};

export type SongArrangement = {
  title: string;
  artist: string;
  key: string;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  source: "demo" | "musicxml";
  sourceLabel: string;
  range: [number, number];
  chords: ChordEvent[];
  melody: MelodyEvent[];
  lyrics: string[];
  warnings: string[];
};

const PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const FIFTH_KEYS: Record<number, string> = {
  "-7": "C♭",
  "-6": "G♭",
  "-5": "D♭",
  "-4": "A♭",
  "-3": "E♭",
  "-2": "B♭",
  "-1": "F",
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F♯",
  7: "C♯",
};

export const CHORD_TONES: Record<string, number[]> = {
  C: [60, 64, 67],
  Am: [57, 60, 64],
  F: [53, 57, 60],
  G: [55, 59, 62],
};

const demoSymbols = [
  "C", "C", "Am", "Am", "F", "F", "G", "G",
  "C", "Am", "F", "G", "C", "Am", "F", "G",
];

const demoMelody = [
  64, 67, 69, 67, 64, 60, 64, 67,
  69, 69, 67, 64, 62, 64, 60, 60,
];

export const DEMO_SONG: SongArrangement = {
  title: "像风一样",
  artist: "薛之谦 · 教学占位编配",
  key: "C（由原调 D 下移全音）",
  bpm: 59,
  beatsPerBar: 4,
  beatUnit: 4,
  source: "demo",
  sourceLabel: "网络资料核对 · 等待 MusicXML 修正",
  range: [48, 72],
  chords: demoSymbols.map((symbol, index) => ({
    beat: index * 4,
    duration: 4,
    symbol,
    notes: CHORD_TONES[symbol],
    lyric: `第 ${index + 1} 句 · 导入歌词后自动同步`,
  })),
  melody: demoMelody.map((note, index) => ({
    beat: index * 4,
    duration: 1,
    notes: [note],
  })),
  lyrics: [],
  warnings: [
    "当前旋律与节奏为教学占位编配，不代表原曲正式曲谱。",
    "导入 MusicXML 后会重新生成四关并检查音域。",
  ],
};

function directText(node: Element | null, selector: string) {
  return node?.querySelector(selector)?.textContent?.trim() || "";
}

function midiFromPitch(note: Element) {
  const step = directText(note, "pitch > step");
  const octave = Number(directText(note, "pitch > octave"));
  const alter = Number(directText(note, "pitch > alter") || 0);
  if (!(step in PITCH_CLASS) || !Number.isFinite(octave)) return null;
  return (octave + 1) * 12 + PITCH_CLASS[step] + alter;
}

function chordNotes(symbol: string, rootMidi = 60) {
  const lower = symbol.toLowerCase();
  const intervals = lower.includes("dim")
    ? [0, 3, 6]
    : lower.includes("aug")
      ? [0, 4, 8]
      : lower.includes("m") && !lower.includes("maj")
        ? [0, 3, 7]
        : [0, 4, 7];
  if (lower.includes("7")) intervals.push(lower.includes("maj7") ? 11 : 10);
  return intervals.map((interval) => rootMidi + interval);
}

function parseHarmony(harmony: Element, beat: number) {
  const step = directText(harmony, "root > root-step") || "C";
  const alter = Number(directText(harmony, "root > root-alter") || 0);
  const kindNode = harmony.querySelector("kind");
  const kindText = kindNode?.getAttribute("text")?.trim();
  const kind = kindNode?.textContent?.trim() || "major";
  const accidental = alter === 1 ? "♯" : alter === -1 ? "♭" : "";
  const suffix = kindText || (
    kind.includes("minor") ? "m" :
      kind.includes("dominant") ? "7" :
        kind.includes("diminished") ? "dim" :
          kind.includes("augmented") ? "aug" : ""
  );
  const symbol = `${step}${accidental}${suffix}`;
  const rootClass = (PITCH_CLASS[step] + alter + 12) % 12;
  const rootMidi = 48 + rootClass;
  return { beat, symbol, notes: chordNotes(symbol, rootMidi) };
}

export function parseMusicXml(xmlText: string): SongArrangement {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError || !xml.querySelector("score-partwise, score-timewise")) {
    throw new Error("这不是有效的 MusicXML 文件。");
  }

  const title = directText(xml.documentElement, "work > work-title")
    || directText(xml.documentElement, "movement-title")
    || "未命名曲目";
  const artist = Array.from(xml.querySelectorAll("identification creator"))
    .map((node) => node.textContent?.trim())
    .filter(Boolean)
    .join(" · ") || "MusicXML 导入";

  const bpm = Math.round(Number(
    xml.querySelector("sound[tempo]")?.getAttribute("tempo")
    || directText(xml.documentElement, "metronome > per-minute")
    || 72,
  ));
  const beatsPerBar = Number(directText(xml.documentElement, "time > beats") || 4);
  const beatUnit = Number(directText(xml.documentElement, "time > beat-type") || 4);
  const fifths = Number(directText(xml.documentElement, "key > fifths") || 0);

  const partCandidates = Array.from(xml.querySelectorAll("part"));
  const part = partCandidates.sort((a, b) =>
    b.querySelectorAll("note pitch").length - a.querySelectorAll("note pitch").length,
  )[0];
  if (!part) throw new Error("MusicXML 中没有可读取的声部。");

  let divisions = 1;
  let absoluteBeat = 0;
  const melody: MelodyEvent[] = [];
  const harmonies: Array<{ beat: number; symbol: string; notes: number[] }> = [];
  const lyrics: string[] = [];
  const allNotes: number[] = [];

  for (const measure of Array.from(part.querySelectorAll(":scope > measure"))) {
    const nextDivisions = Number(directText(measure, "attributes > divisions"));
    if (nextDivisions > 0) divisions = nextDivisions;
    let cursor = 0;
    let previousStart = 0;

    for (const child of Array.from(measure.children)) {
      if (child.tagName === "harmony") {
        harmonies.push(parseHarmony(child, absoluteBeat + cursor));
        continue;
      }
      if (child.tagName === "backup") {
        cursor -= Number(directText(child, "duration") || 0) / divisions;
        continue;
      }
      if (child.tagName === "forward") {
        cursor += Number(directText(child, "duration") || 0) / divisions;
        continue;
      }
      if (child.tagName !== "note") continue;

      const duration = Math.max(Number(directText(child, ":scope > duration") || divisions) / divisions, 0.125);
      const isChordTone = Boolean(child.querySelector(":scope > chord"));
      const start = isChordTone ? previousStart : cursor;
      const lyric = directText(child, "lyric > text");
      const midi = midiFromPitch(child);

      if (lyric) lyrics.push(lyric);
      if (midi != null) {
        allNotes.push(midi);
        const existing = melody.find((event) => Math.abs(event.beat - (absoluteBeat + start)) < 0.0001);
        if (existing && isChordTone) {
          existing.notes.push(midi);
        } else {
          melody.push({ beat: absoluteBeat + start, duration, notes: [midi], lyric: lyric || undefined });
        }
      }

      previousStart = start;
      if (!isChordTone) cursor += duration;
    }
    absoluteBeat += Math.max(cursor, beatsPerBar);
  }

  const warnings: string[] = [];
  let chords: ChordEvent[];
  if (harmonies.length) {
    chords = harmonies.map((harmony, index) => ({
      ...harmony,
      duration: Math.max((harmonies[index + 1]?.beat ?? absoluteBeat) - harmony.beat, 1),
    }));
  } else {
    warnings.push("文件中没有和弦标记，暂用 C–Am–F–G 作为伴奏骨架，可在后续编辑中修正。");
    const bars = Math.max(4, Math.ceil(absoluteBeat / beatsPerBar));
    chords = Array.from({ length: bars }, (_, index) => {
      const symbol = ["C", "Am", "F", "G"][index % 4];
      return { beat: index * beatsPerBar, duration: beatsPerBar, symbol, notes: CHORD_TONES[symbol] };
    });
  }

  if (!lyrics.length) warnings.push("文件中没有歌词，将以小节编号显示；可重新上传带歌词的 MusicXML。");
  if (!melody.length) throw new Error("MusicXML 中没有可演奏的音符。");

  return {
    title,
    artist,
    key: FIFTH_KEYS[fifths] || `五度圈 ${fifths}`,
    bpm: Math.min(240, Math.max(30, bpm || 72)),
    beatsPerBar: beatsPerBar || 4,
    beatUnit: beatUnit || 4,
    source: "musicxml",
    sourceLabel: "已由 MusicXML 生成四关",
    range: [Math.min(...allNotes), Math.max(...allNotes)],
    chords,
    melody,
    lyrics,
    warnings,
  };
}

export function midiName(note: number) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

export function fitRange(range: [number, number], mode: 36 | 72) {
  const target: [number, number] = mode === 36 ? [48, 83] : [36, 107];
  let shift = 0;
  while (range[0] + shift < target[0]) shift += 12;
  while (range[1] + shift > target[1]) shift -= 12;
  const fits = range[0] + shift >= target[0] && range[1] + shift <= target[1];
  return { target, shift, fits };
}
