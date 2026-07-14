"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_SONG, SongArrangement, fitRange, midiName, parseMusicXml } from "../lib/music";
import { FourLayerPiano, NormalizedMidiEvent, PartyKeysMidi } from "../lib/partykeys";

type PracticeStep = {
  label: string;
  sublabel: string;
  notes: number[];
  duration: number;
  lyric?: string;
};

const LEVELS = [
  { number: "01", name: "先听一遍", kicker: "完整示范", detail: "听懂旋律、和声与呼吸" },
  { number: "02", name: "和弦跟唱", kicker: "卡拉 OK", detail: "弹对和弦，歌词自动前进" },
  { number: "03", name: "伴奏织体", kicker: "左手配合", detail: "根音、五音、和弦与琶音" },
  { number: "04", name: "完整演奏", kicker: "双手合奏", detail: "左手和弦＋右手旋律" },
];

const BLACK_PITCHES = new Set([1, 3, 6, 8, 10]);

function activeChord(song: SongArrangement, beat: number) {
  return [...song.chords].reverse().find((chord) => chord.beat <= beat) || song.chords[0];
}

function makeSteps(song: SongArrangement, level: number, shift: number): PracticeStep[] {
  const move = (notes: number[]) => notes.map((note) => note + shift);
  if (level === 1) {
    return song.chords.slice(0, 8).map((chord) => ({
      label: chord.symbol,
      sublabel: "示范段落",
      notes: move(chord.notes),
      duration: chord.duration,
      lyric: chord.lyric,
    }));
  }
  if (level === 2) {
    return song.chords.slice(0, 16).map((chord, index) => ({
      label: chord.symbol,
      sublabel: `第 ${index + 1} 小节 · ${Math.round(chord.duration)} 拍`,
      notes: move(chord.notes),
      duration: chord.duration,
      lyric: chord.lyric || song.lyrics[index] || `第 ${index + 1} 句 · 等待歌词`,
    }));
  }
  if (level === 3) {
    return song.chords.slice(0, 8).flatMap((chord) => {
      const notes = move(chord.notes);
      const root = notes[0] > 59 ? notes[0] - 12 : notes[0];
      const fifth = root + 7;
      const upper = notes.map((note) => note < 60 ? note + 12 : note);
      return [
        { label: chord.symbol, sublabel: "左手 · 根音", notes: [root], duration: 1, lyric: chord.lyric },
        { label: chord.symbol, sublabel: "右手 · 和弦", notes: upper, duration: 1, lyric: chord.lyric },
        { label: chord.symbol, sublabel: "左手 · 五音", notes: [fifth], duration: 1, lyric: chord.lyric },
        { label: chord.symbol, sublabel: "右手 · 和弦", notes: upper, duration: 1, lyric: chord.lyric },
      ];
    });
  }
  return song.melody.slice(0, 32).map((melody) => {
    const chord = activeChord(song, melody.beat);
    const bass = chord.notes[0] > 55 ? chord.notes[0] - 12 : chord.notes[0];
    return {
      label: chord.symbol,
      sublabel: "左手低音 ＋ 右手旋律",
      notes: move([bass, ...melody.notes]),
      duration: melody.duration,
      lyric: melody.lyric,
    };
  });
}

function pitchClassSet(notes: Iterable<number>) {
  return new Set([...notes].map((note) => ((note % 12) + 12) % 12));
}

function stepMatches(expected: number[], played: Set<number>, level: number) {
  if (!expected.length) return false;
  if (level === 2 || expected.length > 2) {
    const expectedClasses = pitchClassSet(expected);
    const playedClasses = pitchClassSet(played);
    return [...expectedClasses].every((pitch) => playedClasses.has(pitch));
  }
  return expected.every((note) => played.has(note));
}

export default function Home() {
  const [song, setSong] = useState<SongArrangement>(DEMO_SONG);
  const [level, setLevel] = useState(2);
  const [mode, setMode] = useState<36 | 72>(36);
  const [stepIndex, setStepIndex] = useState(0);
  const [held, setHeld] = useState<Set<number>>(new Set());
  const [feedback, setFeedback] = useState("准备好后，弹出亮起的音");
  const [playing, setPlaying] = useState(false);
  const [smartChord, setSmartChord] = useState(true);
  const [importMessage, setImportMessage] = useState("");
  const [midiStatus, setMidiStatus] = useState({ inputs: 0, partyKeys: 0, outputs: 0 });
  const [midiError, setMidiError] = useState("");
  const [showRangeNotice, setShowRangeNotice] = useState(false);
  const pianoRef = useRef<FourLayerPiano | null>(null);
  const midiRef = useRef<PartyKeysMidi | null>(null);
  const playedRef = useRef<Set<number>>(new Set());
  const timersRef = useRef<number[]>([]);
  const midiHandlerRef = useRef<(event: NormalizedMidiEvent) => void>(() => {});

  if (!pianoRef.current && typeof window !== "undefined") pianoRef.current = new FourLayerPiano();
  if (!midiRef.current && typeof window !== "undefined") midiRef.current = new PartyKeysMidi();

  const rangeFit = useMemo(() => fitRange(song.range, mode), [song.range, mode]);
  const shift = rangeFit.shift;
  const steps = useMemo(() => makeSteps(song, level, shift), [song, level, shift]);
  const currentStep = steps[Math.min(stepIndex, Math.max(steps.length - 1, 0))];
  const nextStep = steps[Math.min(stepIndex + 1, Math.max(steps.length - 1, 0))];
  const keyboardStart = mode === 36 ? 48 : 36;
  const keyboardNotes = useMemo(
    () => Array.from({ length: mode }, (_, index) => keyboardStart + index),
    [mode, keyboardStart],
  );
  const progress = steps.length ? Math.round((stepIndex / steps.length) * 100) : 0;

  useEffect(() => {
    midiRef.current?.setMode(mode);
    setStepIndex(0);
    setHeld(new Set());
    playedRef.current.clear();
    setShowRangeNotice(song.range[0] < rangeFit.target[0] || song.range[1] > rangeFit.target[1]);
  }, [mode, song.range, rangeFit.target]);

  useEffect(() => {
    if (!currentStep) return;
    midiRef.current?.restore(currentStep.notes, nextStep?.notes || []);
  }, [currentStep, nextStep]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    pianoRef.current?.releaseAll();
    midiRef.current?.allOff();
  }, []);

  function stopPlayback() {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    pianoRef.current?.releaseAll();
    setPlaying(false);
  }

  function registerNote(note: number) {
    if (!currentStep || playing) return;
    playedRef.current.add(note);
    setHeld(new Set(playedRef.current));
    if (!stepMatches(currentStep.notes, playedRef.current, level)) {
      setFeedback("继续，把亮起的音补齐");
      return;
    }
    setFeedback("弹对了 · 下一组");
    playedRef.current.clear();
    const nextIndex = stepIndex + 1;
    if (nextIndex >= steps.length) {
      setStepIndex(steps.length);
      midiRef.current?.allOff();
      setFeedback(`第 ${level} 关完成！`);
      return;
    }
    window.setTimeout(() => {
      setStepIndex(nextIndex);
      setHeld(new Set());
    }, 180);
  }

  function releaseNote(note: number) {
    playedRef.current.delete(note);
    setHeld(new Set(playedRef.current));
  }

  function handleMidi(event: NormalizedMidiEvent) {
    if (event.type === "on" && event.note != null) {
      pianoRef.current?.noteOn(event.note, event.velocity || 96, "user");
      registerNote(event.note);
    }
    if (event.type === "off" && event.note != null) {
      pianoRef.current?.noteOff(event.note, "user");
      releaseNote(event.note);
    }
    if (event.type === "pedal") pianoRef.current?.setPedal(Boolean(event.on));
  }

  midiHandlerRef.current = handleMidi;

  async function connectMidi() {
    setMidiError("");
    pianoRef.current?.ensureAudio();
    try {
      await midiRef.current?.connect((event) => midiHandlerRef.current(event), setMidiStatus);
      if (midiStatus.inputs === 0) setFeedback("MIDI 已就绪，等待设备连接");
    } catch (error) {
      setMidiError(error instanceof Error ? error.message : "MIDI 连接失败");
    }
  }

  function pressVirtual(note: number) {
    pianoRef.current?.ensureAudio();
    pianoRef.current?.noteOn(note, 96, "screen");
    registerNote(note);
  }

  function releaseVirtual(note: number) {
    pianoRef.current?.noteOff(note, "screen");
    releaseNote(note);
  }

  function pressChord(notes: number[]) {
    pianoRef.current?.ensureAudio();
    notes.forEach((note) => pianoRef.current?.noteOn(note, 90, "screen"));
    notes.forEach(registerNote);
    const timer = window.setTimeout(() => notes.forEach((note) => pianoRef.current?.noteOff(note, "screen")), 420);
    timersRef.current.push(timer);
  }

  function playDemo() {
    if (playing) {
      stopPlayback();
      return;
    }
    stopPlayback();
    const piano = pianoRef.current;
    if (!piano || !steps.length) return;
    const context = piano.ensureAudio();
    const secondsPerBeat = 60 / song.bpm;
    const startAt = context.currentTime + 0.28;
    let cursor = 0;
    setPlaying(true);
    setStepIndex(0);

    const demoSteps = level === 1 ? steps : steps.slice(0, 16);
    demoSteps.forEach((step, index) => {
      const lightTimer = window.setTimeout(() => midiRef.current?.restore(step.notes, demoSteps[index + 1]?.notes || []), cursor * 1000);
      const screenTimer = window.setTimeout(() => setStepIndex(index), cursor * 1000 + 200);
      timersRef.current.push(lightTimer, screenTimer);
      step.notes.forEach((note) => {
        const source = `demo-${index}`;
        piano.noteOn(note, level === 1 ? 72 : 88, source, startAt + cursor);
        const offTimer = window.setTimeout(
          () => piano.noteOff(note, source),
          (cursor + Math.min(step.duration * secondsPerBeat, 1.8)) * 1000 + 280,
        );
        timersRef.current.push(offTimer);
      });
      cursor += Math.max(0.45, step.duration * secondsPerBeat);
    });
    if (level === 1) {
      song.melody.slice(0, 64).forEach((event, index) => {
        const source = `melody-${index}`;
        const eventStart = event.beat * secondsPerBeat;
        event.notes.forEach((rawNote) => {
          const note = rawNote + shift;
          piano.noteOn(note, 94, source, startAt + eventStart);
          const offTimer = window.setTimeout(
            () => piano.noteOff(note, source),
            (eventStart + Math.max(0.16, event.duration * secondsPerBeat * 0.88)) * 1000 + 280,
          );
          timersRef.current.push(offTimer);
        });
      });
    }
    const endTimer = window.setTimeout(() => {
      setPlaying(false);
      setStepIndex(0);
      midiRef.current?.restore(steps[0]?.notes || [], steps[1]?.notes || []);
    }, cursor * 1000 + 500);
    timersRef.current.push(endTimer);
  }

  function chooseLevel(nextLevel: number) {
    stopPlayback();
    setLevel(nextLevel);
    setStepIndex(0);
    playedRef.current.clear();
    setFeedback(nextLevel === 1 ? "先听完整示范，记住和声走向" : "准备好后，弹出亮起的音");
    if (song.range[0] < rangeFit.target[0] || song.range[1] > rangeFit.target[1]) setShowRangeNotice(true);
  }

  async function importMusicXml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = parseMusicXml(await file.text());
      setSong(parsed);
      setLevel(1);
      setStepIndex(0);
      const nextFit = fitRange(parsed.range, mode);
      setImportMessage(
        `已导入《${parsed.title}》：${parsed.melody.length} 个旋律事件、${parsed.chords.length} 个和弦，音域 ${midiName(parsed.range[0])}–${midiName(parsed.range[1])}${nextFit.shift ? `，将自动移调 ${nextFit.shift > 0 ? "+" : ""}${nextFit.shift} 半音` : ""}。`,
      );
      setShowRangeNotice(parsed.range[0] < nextFit.target[0] || parsed.range[1] > nextFit.target[1]);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "MusicXML 导入失败");
    }
  }

  const activeNotes = new Set(currentStep?.notes || []);
  const previewNotes = new Set(nextStep?.notes || []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><strong>音乐密码</strong><small>PARTYKEYS SONG LAB</small></div>
        </div>
        <div className="top-actions">
          <label className="upload-button">
            <input type="file" accept=".xml,.musicxml,application/xml,text/xml" onChange={importMusicXml} />
            <span aria-hidden="true">↑</span> 导入 MusicXML
          </label>
          <button className={`midi-button ${midiStatus.inputs ? "connected" : ""}`} onClick={connectMidi}>
            <span className="status-dot" />
            {midiStatus.partyKeys ? `${midiStatus.partyKeys} 台琴已连接` : midiStatus.inputs ? "MIDI 已连接" : "连接实体琴"}
          </button>
        </div>
      </header>

      <section className="song-heading">
        <div>
          <p className="eyebrow">ONE SONG · FOUR LEVELS</p>
          <h1>{song.title}</h1>
          <p className="song-meta">{song.artist} <span /> {song.key} <span /> {song.bpm} BPM <span /> {song.beatsPerBar}/{song.beatUnit}</p>
        </div>
        <div className="song-source"><span>曲谱状态</span><strong>{song.sourceLabel}</strong></div>
      </section>

      {(importMessage || midiError) && (
        <div className={`notice-strip ${midiError ? "error" : ""}`}>
          <span>{midiError ? "!" : "✓"}</span>
          <p>{midiError || importMessage}</p>
          <button aria-label="关闭提示" onClick={() => { setImportMessage(""); setMidiError(""); }}>×</button>
        </div>
      )}

      <nav className="level-rail" aria-label="四个练习关卡">
        {LEVELS.map((item, index) => {
          const value = index + 1;
          return (
            <button key={item.number} className={`level-card ${level === value ? "active" : ""} ${level > value ? "done" : ""}`} onClick={() => chooseLevel(value)}>
              <span className="level-number">{level > value ? "✓" : item.number}</span>
              <span className="level-copy"><small>{item.kicker}</small><strong>{item.name}</strong><em>{item.detail}</em></span>
              <span className="level-arrow">→</span>
            </button>
          );
        })}
      </nav>

      {showRangeNotice && (
        <section className="range-notice">
          <div className="range-icon">↕</div>
          <div>
            <strong>本关开始前：发现超出当前键盘的音</strong>
            <p>
              曲谱音域 {midiName(song.range[0])}–{midiName(song.range[1])}，{mode} 键模式为 {midiName(rangeFit.target[0])}–{midiName(rangeFit.target[1])}。
              {rangeFit.fits ? ` 系统将整曲移调 ${rangeFit.shift > 0 ? "+" : ""}${rangeFit.shift} 半音。` : " 单纯移调仍无法完整容纳，演奏时会做八度折叠。"}
            </p>
          </div>
          <button onClick={() => setShowRangeNotice(false)}>知道了</button>
        </section>
      )}

      <section className="practice-stage">
        <div className="stage-main">
          <div className="stage-toolbar">
            <div className="stage-title">
              <span>{LEVELS[level - 1].number}</span>
              <div><small>{LEVELS[level - 1].kicker}</small><h2>{LEVELS[level - 1].name}</h2></div>
            </div>
            <div className="stage-controls">
              {level === 2 && (
                <button className={`soft-toggle ${smartChord ? "on" : ""}`} onClick={() => setSmartChord(!smartChord)}>
                  智能和弦 <span>{smartChord ? "开" : "关"}</span>
                </button>
              )}
              <button className="play-button" onClick={playDemo}><span>{playing ? "■" : "▶"}</span>{playing ? "停止" : level === 1 ? "播放示范" : "听这一段"}</button>
            </div>
          </div>

          <div className="karaoke-window">
            <div className="timing-line"><span style={{ width: `${Math.max(4, progress)}%` }} /></div>
            <div className="measure-labels"><span>当前</span><span>接下来</span></div>
            <div className="chord-row">
              {steps.slice(Math.max(0, stepIndex - 1), Math.max(0, stepIndex - 1) + 4).map((step, visibleIndex) => {
                const absoluteIndex = Math.max(0, stepIndex - 1) + visibleIndex;
                return (
                  <div key={`${absoluteIndex}-${step.label}`} className={`chord-cell ${absoluteIndex === stepIndex ? "current" : ""} ${absoluteIndex < stepIndex ? "passed" : ""}`}>
                    <small>{String(absoluteIndex + 1).padStart(2, "0")}</small>
                    <strong>{step.label}</strong>
                    <span>{step.sublabel}</span>
                    <i>{absoluteIndex < stepIndex ? "✓" : absoluteIndex === stepIndex ? "NOW" : "+1"}</i>
                  </div>
                );
              })}
            </div>
            <div className="lyric-lines">
              <p className="lyric-current">{currentStep?.lyric || (song.lyrics.length ? song.lyrics.slice(stepIndex, stepIndex + 8).join("") : "歌词将在导入带歌词的 MusicXML 后逐字跟随")}</p>
              <p className="lyric-next">{nextStep?.lyric || "下一句"}</p>
            </div>
          </div>

          <div className="coach-row">
            <div className="now-card">
              <span className="pulse-ring" />
              <div><small>现在弹</small><strong>{currentStep?.label || "完成"}</strong></div>
              <div className="note-pills">
                {(currentStep?.notes || []).map((note) => <span key={note}>{midiName(note)}</span>)}
              </div>
            </div>
            <div className={`feedback-card ${feedback.includes("对了") || feedback.includes("完成") ? "success" : ""}`}>
              <span>{feedback.includes("对了") || feedback.includes("完成") ? "✓" : "♪"}</span>
              <div><small>实时反馈</small><strong>{feedback}</strong></div>
            </div>
          </div>

          {smartChord && level === 2 && (
            <div className="smart-chords">
              <span>屏幕一键和弦</span>
              {["C", "Am", "F", "G"].map((symbol) => {
                const chord = song.chords.find((item) => item.symbol.replace(/♯|♭/g, "") === symbol)?.notes
                  || DEMO_SONG.chords.find((item) => item.symbol === symbol)!.notes;
                return <button key={symbol} onClick={() => pressChord(chord.map((note) => note + shift))}>{symbol}</button>;
              })}
            </div>
          )}
        </div>

        <aside className="song-panel">
          <div className="album-art">
            <div className="wind-lines"><i /><i /><i /><i /></div>
            <span>像</span><span>风</span><span>一</span><span>样</span>
          </div>
          <div className="song-panel-copy">
            <small>本次只练这一首</small>
            <strong>{song.title}</strong>
            <p>{song.source === "demo" ? "当前使用 C 调教学骨架，正式旋律等待 MusicXML。" : "已按导入曲谱生成旋律、和弦、伴奏织体与双手关卡。"}</p>
          </div>
          <div className="stat-grid">
            <div><small>音域</small><strong>{midiName(song.range[0])}–{midiName(song.range[1])}</strong></div>
            <div><small>和弦</small><strong>{song.chords.length}</strong></div>
            <div><small>歌词</small><strong>{song.lyrics.length ? "已包含" : "待导入"}</strong></div>
            <div><small>移调</small><strong>{shift ? `${shift > 0 ? "+" : ""}${shift}` : "原位"}</strong></div>
          </div>
          {song.warnings.length > 0 && <p className="panel-warning">{song.warnings[0]}</p>}
          <img src="/partykeys-keyboard.png" alt="音乐密码 36 键键盘" />
        </aside>
      </section>

      <section className="keyboard-dock">
        <div className="keyboard-head">
          <div><span className="live-dot" /> <strong>演奏区</strong><small>实体琴与屏幕键盘使用同一套判定</small></div>
          <div className="mode-switch" role="group" aria-label="键盘范围">
            <button className={mode === 36 ? "active" : ""} onClick={() => setMode(36)}>单琴 · 36 键</button>
            <button className={mode === 72 ? "active" : ""} onClick={() => setMode(72)}>双琴 · 72 键</button>
          </div>
        </div>
        <div className={`piano keyboard-${mode}`}>
          {keyboardNotes.map((note, index) => {
            const black = BLACK_PITCHES.has(note % 12);
            const active = activeNotes.has(note);
            const preview = !active && previewNotes.has(note);
            const isSplit = mode === 72 && index === 36;
            return (
              <button
                key={note}
                className={`piano-key ${black ? "black" : "white"} ${active ? "target" : ""} ${preview ? "preview" : ""} ${held.has(note) ? "pressed" : ""} ${isSplit ? "split" : ""}`}
                aria-label={`${midiName(note)}${active ? "，当前目标" : ""}`}
                onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { event.currentTarget.setPointerCapture(event.pointerId); pressVirtual(note); }}
                onPointerUp={() => releaseVirtual(note)}
                onPointerCancel={() => releaseVirtual(note)}
              >
                {!black && <span>{note % 12 === 0 ? midiName(note) : ""}</span>}
                {active && <i />}
              </button>
            );
          })}
        </div>
        <div className="keyboard-foot">
          <span>{mode === 36 ? "C3–B5 · PartyKeys 36" : "C2–B7 · 两台 PartyKeys 左低音 / 右高音"}</span>
          <span className="legend"><i className="target" /> 当前音 <i className="preview" /> 下一组</span>
          <span>{midiStatus.outputs ? `灯光输出 ${midiStatus.outputs}/${mode === 72 ? 2 : 1}` : "连接实体琴后同步亮灯"}</span>
        </div>
      </section>

      <footer>
        <span>音乐密码 · 一首歌，四步弹会</span>
        <span>Piano samples: Salamander Grand Piano V3 · Alexander Holm · CC BY 3.0</span>
      </footer>
    </main>
  );
}
