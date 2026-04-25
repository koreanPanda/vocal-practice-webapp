import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Mode = "practice" | "result" | "choose";

type PitchPoint = {
  time: number;
  midi: number;
  note: string;
  frequency: number;
  cents: number;
  targetMidi: number;
  targetNote: string;
  ok: boolean;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DO_MI_SOL_MI_DO = [0, 4, 7, 4, 0];
const NOTE_DURATION_MS = 1400;
const TOLERANCE_CENTS = 35;

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToMidiFloat(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToNote(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

function centsDifference(freq: number, targetFreq: number): number {
  return 1200 * Math.log2(freq / targetFreq);
}

function buildTargets(rootMidi: number): number[] {
  return DO_MI_SOL_MI_DO.map((offset) => rootMidi + offset);
}

/**
 * Very simple autocorrelation pitch detector.
 * MVP용입니다. 조용한 방 + 단일 음성 입력에서 가장 잘 동작합니다.
 */
function autoCorrelatePitch(buffer: Float32Array, sampleRate: number): number | null {
  let rms = 0;
  for (const value of buffer) rms += value * value;
  rms = Math.sqrt(rms / buffer.length);

  // 너무 작은 소리는 무시
  if (rms < 0.015) return null;

  const minFreq = 70;
  const maxFreq = 1000;
  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.floor(sampleRate / minFreq);

  let bestLag = -1;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - lag; i++) {
      correlation += buffer[i] * buffer[i + lag];
    }
    correlation /= buffer.length - lag;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorrelation < 0.01) return null;

  return sampleRate / bestLag;
}

function usePitchDetector(
  enabled: boolean,
  targetMidi: number,
  onPoint: (point: PitchPoint) => void
) {
  const audioRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(performance.now());

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function start() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;

      source.connect(analyser);

      audioRef.current = audioContext;
      analyserRef.current = analyser;
      streamRef.current = stream;
      startedAtRef.current = performance.now();

      const buffer = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (cancelled || !analyserRef.current || !audioRef.current) return;

        analyserRef.current.getFloatTimeDomainData(buffer);
        const freq = autoCorrelatePitch(buffer, audioRef.current.sampleRate);

        if (freq) {
          const midiFloat = freqToMidiFloat(freq);
          const targetFreq = midiToFreq(targetMidi);
          const cents = centsDifference(freq, targetFreq);
          const ok = Math.abs(cents) <= TOLERANCE_CENTS;

          onPoint({
            time: (performance.now() - startedAtRef.current) / 1000,
            midi: midiFloat,
            note: midiToNote(midiFloat),
            frequency: freq,
            cents,
            targetMidi,
            targetNote: midiToNote(targetMidi),
            ok,
          });
        }

        rafRef.current = requestAnimationFrame(tick);
      };

      tick();
    }

    start().catch((error) => {
      alert(`마이크를 시작할 수 없습니다: ${error.message}`);
    });

    return () => {
      cancelled = true;

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      audioRef.current?.close();

      rafRef.current = null;
      streamRef.current = null;
      audioRef.current = null;
      analyserRef.current = null;
    };
  }, [enabled, targetMidi, onPoint]);
}

function playReferenceSequence(targets: number[]) {
  const audio = new AudioContext();
  const startAt = audio.currentTime + 0.1;

  targets.forEach((midi, index) => {
    const freq = midiToFreq(midi);
    const t = startAt + index * 0.7;
    const duration = 0.5;

    const main = audio.createOscillator();
    const sub = audio.createOscillator();
    const gain = audio.createGain();

    // 피아노는 아니지만 기준음 확인용 synth tone
    main.type = "triangle";
    sub.type = "sine";

    main.frequency.setValueAtTime(freq, t);
    sub.frequency.setValueAtTime(freq * 2, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    main.connect(gain);
    sub.connect(gain);
    gain.connect(audio.destination);

    main.start(t);
    sub.start(t);
    main.stop(t + duration);
    sub.stop(t + duration);
  });

  setTimeout(() => {
    audio.close();
  }, targets.length * 700 + 1000);
}

function PitchScatter({
  points,
  targets,
  activeTargetMidi,
}: {
  points: PitchPoint[];
  targets: number[];
  activeTargetMidi: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const width = cssWidth * dpr;
    const height = cssHeight * dpr;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const minMidi = Math.min(...targets) - 3;
    const maxMidi = Math.max(...targets) + 3;
    const latestTime = points.length > 0 ? points[points.length - 1].time : 0;
    const minTime = Math.max(0, latestTime - 8);
    const maxTime = Math.max(8, latestTime + 0.8);

    const padLeft = 58 * dpr;
    const padRight = 18 * dpr;
    const padTop = 18 * dpr;
    const padBottom = 42 * dpr;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const x = (time: number) => padLeft + ((time - minTime) / (maxTime - minTime)) * plotW;
    const y = (midi: number) => padTop + (1 - (midi - minMidi) / (maxMidi - minMidi)) * plotH;

    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.lineWidth = 1 * dpr;

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Target tolerance band
    const centsToMidi = TOLERANCE_CENTS / 100;
    const bandTop = y(activeTargetMidi + centsToMidi);
    const bandBottom = y(activeTargetMidi - centsToMidi);
    ctx.fillStyle = "rgba(34, 197, 94, 0.12)";
    ctx.fillRect(padLeft, bandTop, plotW, bandBottom - bandTop);

    // Horizontal note grid
    for (let midi = Math.floor(minMidi); midi <= Math.ceil(maxMidi); midi++) {
      const yy = y(midi);
      const isTarget = targets.includes(midi);

      ctx.strokeStyle = isTarget ? "#9ca3af" : "#e5e7eb";
      ctx.beginPath();
      ctx.moveTo(padLeft, yy);
      ctx.lineTo(width - padRight, yy);
      ctx.stroke();

      ctx.fillStyle = isTarget ? "#111827" : "#6b7280";
      ctx.fillText(midiToNote(midi), 10 * dpr, yy + 4 * dpr);
    }

    // Axes
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop);
    ctx.lineTo(padLeft, height - padBottom);
    ctx.lineTo(width - padRight, height - padBottom);
    ctx.stroke();

    // Target line
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2 * dpr;
    const targetY = y(activeTargetMidi);
    ctx.beginPath();
    ctx.moveTo(padLeft, targetY);
    ctx.lineTo(width - padRight, targetY);
    ctx.stroke();

    ctx.fillStyle = "#2563eb";
    ctx.fillText(`Target ${midiToNote(activeTargetMidi)}`, padLeft + 8 * dpr, targetY - 8 * dpr);

    // Points
    for (const p of points.slice(-600)) {
      if (p.time < minTime || p.time > maxTime) continue;
      const px = x(p.time);
      const py = y(p.midi);

      ctx.fillStyle = p.ok ? "#16a34a" : "#dc2626";
      ctx.beginPath();
      ctx.arc(px, py, 3.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // X label
    ctx.fillStyle = "#6b7280";
    ctx.fillText("time", width - padRight - 32 * dpr, height - 14 * dpr);
  }, [points, targets, activeTargetMidi]);

  return <canvas className="pitch-canvas" ref={canvasRef} />;
}

function ResultSummary({ points }: { points: PitchPoint[] }) {
  const summary = useMemo(() => {
    const voiced = points;
    const ok = voiced.filter((p) => p.ok);
    const avgAbsCents =
      voiced.length > 0
        ? voiced.reduce((sum, p) => sum + Math.abs(p.cents), 0) / voiced.length
        : 0;

    return {
      total: voiced.length,
      ok: ok.length,
      accuracy: voiced.length > 0 ? (ok.length / voiced.length) * 100 : 0,
      avgAbsCents,
    };
  }, [points]);

  return (
    <div className="result-card">
      <h2>Result</h2>
      <div className="result-grid">
        <div>
          <span className="label">Accuracy</span>
          <strong>{summary.accuracy.toFixed(1)}%</strong>
        </div>
        <div>
          <span className="label">Average error</span>
          <strong>{summary.avgAbsCents.toFixed(1)} cents</strong>
        </div>
        <div>
          <span className="label">Detected points</span>
          <strong>{summary.total}</strong>
        </div>
        <div>
          <span className="label">Matched points</span>
          <strong>{summary.ok}</strong>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [rootMidi, setRootMidi] = useState(60); // C4
  const [mode, setMode] = useState<Mode>("practice");
  const [isRecording, setIsRecording] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [points, setPoints] = useState<PitchPoint[]>([]);

  const targets = useMemo(() => buildTargets(rootMidi), [rootMidi]);
  const activeTargetMidi = targets[activeIndex] ?? targets[0];

  const addPoint = useCallback((point: PitchPoint) => {
    setPoints((prev) => [...prev.slice(-1000), point]);
  }, []);

  usePitchDetector(isRecording, activeTargetMidi, addPoint);

  useEffect(() => {
    if (!isRecording) return;

    const timer = window.setInterval(() => {
      setActiveIndex((prev) => {
        const next = prev + 1;
        if (next >= targets.length) {
          window.clearInterval(timer);
          setIsRecording(false);
          setMode("result");
          return prev;
        }
        return next;
      });
    }, NOTE_DURATION_MS);

    return () => window.clearInterval(timer);
  }, [isRecording, targets.length]);

  const startPractice = () => {
    setPoints([]);
    setActiveIndex(0);
    setMode("practice");
    setIsRecording(true);
  };

  const stopPractice = () => {
    setIsRecording(false);
    setMode("result");
  };

  const transposeAndRestart = (semitone: number) => {
    setRootMidi((prev) => prev + semitone);
    setPoints([]);
    setActiveIndex(0);
    setMode("practice");
    setIsRecording(false);
  };

  const latest = points[points.length - 1];

  return (
    <main className="app">
      <section className="header">
        <div>
          <h1>Vocal Pitch Practice</h1>
          <p>도-미-솔-미-도 패턴을 듣고 따라 부르며 현재 음정을 실시간으로 확인합니다.</p>
        </div>
        <div className="root-note">
          <span>Root</span>
          <strong>{midiToNote(rootMidi)}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="target-row">
          {targets.map((midi, index) => (
            <div
              key={`${midi}-${index}`}
              className={`target-note ${index === activeIndex && isRecording ? "active" : ""}`}
            >
              <span>{index + 1}</span>
              <strong>{midiToNote(midi)}</strong>
            </div>
          ))}
        </div>

        <div className="status-grid">
          <div className="status-card">
            <span className="label">Current target</span>
            <strong>{midiToNote(activeTargetMidi)}</strong>
          </div>
          <div className="status-card">
            <span className="label">Detected note</span>
            <strong className={latest?.ok ? "green" : "red"}>{latest ? latest.note : "-"}</strong>
          </div>
          <div className="status-card">
            <span className="label">Cents error</span>
            <strong className={latest?.ok ? "green" : "red"}>
              {latest ? `${latest.cents.toFixed(1)} cents` : "-"}
            </strong>
          </div>
          <div className="status-card">
            <span className="label">Frequency</span>
            <strong>{latest ? `${latest.frequency.toFixed(1)} Hz` : "-"}</strong>
          </div>
        </div>

        <PitchScatter points={points} targets={targets} activeTargetMidi={activeTargetMidi} />

        <div className="buttons">
          <button onClick={() => playReferenceSequence(targets)}>기준음 재생</button>
          <button className="primary" onClick={startPractice} disabled={isRecording}>
            연습 시작
          </button>
          <button onClick={stopPractice} disabled={!isRecording}>
            종료하고 결과 보기
          </button>
        </div>

        <p className="hint">
          초록색 점은 ±{TOLERANCE_CENTS} cents 이내, 빨간색 점은 범위 밖입니다. 처음 실행할 때 브라우저에서
          마이크 권한을 허용해야 합니다.
        </p>
      </section>

      {mode === "result" && (
        <section className="panel">
          <ResultSummary points={points} />
          <div className="buttons">
            <button onClick={() => setMode("choose")}>다음 단계 선택</button>
            <button onClick={startPractice}>같은 음으로 다시 하기</button>
          </div>
        </section>
      )}

      {mode === "choose" && (
        <section className="panel">
          <h2>Next exercise</h2>
          <p>현재 root는 {midiToNote(rootMidi)}입니다. 다음 연습 음역을 선택하세요.</p>
          <div className="buttons">
            <button onClick={() => transposeAndRestart(1)}>반음 올리기</button>
            <button onClick={() => transposeAndRestart(-1)}>반음 내리기</button>
            <button onClick={() => transposeAndRestart(0)}>같은 음 유지</button>
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
