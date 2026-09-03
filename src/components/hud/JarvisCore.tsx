/**
 * JARVIS-style arc reactor core rendered on a 2D canvas.
 * Rotating tick rings, segmented arcs and an audio-reactive radial spectrum that reads the
 * real TTS output (or the microphone while listening).
 */
import { useEffect, useRef } from 'react';
import { audioBus } from '../../services/voice/audioBus';
import type { HudState } from '../../state/chat';

interface Props {
  state: HudState;
  /** 0..1 override for the microphone level (VAD), used while listening. */
  inputLevel?: number;
  reduceMotion?: boolean;
  className?: string;
}

interface Palette {
  main: [number, number, number];
  glow: [number, number, number];
}

const PALETTES: Record<HudState, Palette> = {
  idle: { main: [52, 228, 255], glow: [52, 228, 255] },
  listening: { main: [90, 240, 255], glow: [52, 228, 255] },
  thinking: { main: [255, 195, 90], glow: [255, 170, 60] },
  speaking: { main: [140, 245, 255], glow: [52, 228, 255] },
  alert: { main: [255, 171, 64], glow: [255, 120, 40] },
  error: { main: [255, 92, 108], glow: [255, 60, 80] },
  success: { main: [78, 240, 168], glow: [60, 220, 150] }
};

const BARS = 72;

function readThemeAccent(): [number, number, number] | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as [number, number, number]) : null;
}

export function JarvisCore({ state, inputLevel = 0, reduceMotion = false, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const inputRef = useRef(inputLevel);
  const motionRef = useRef(reduceMotion);
  stateRef.current = state;
  inputRef.current = inputLevel;
  motionRef.current = reduceMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    const bars = new Float32Array(BARS);
    const color = { main: [52, 228, 255] as [number, number, number], glow: [52, 228, 255] as [number, number, number] };
    let energy = 0;
    let spin = 0;
    let spin2 = 0;
    let spin3 = 0;
    let last = performance.now();
    let visible = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const onVisibility = () => {
      visible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', onVisibility);

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      const motion = motionRef.current ? 0.25 : 1;

      // ── target colours & energy
      const target = PALETTES[st];
      const themeAccent = st === 'idle' || st === 'listening' || st === 'speaking' ? readThemeAccent() : null;
      const mainTarget = themeAccent ?? target.main;
      for (let i = 0; i < 3; i++) {
        color.main[i] = lerp(color.main[i], mainTarget[i], 0.08);
        color.glow[i] = lerp(color.glow[i], (themeAccent ?? target.glow)[i], 0.08);
      }
      const speaking = st === 'speaking';
      const listening = st === 'listening';
      const spectrum = speaking ? audioBus.spectrum(BARS, 'output') : listening ? audioBus.spectrum(BARS, 'input') : null;
      const level = speaking ? audioBus.outputLevel() : listening ? Math.max(inputRef.current, audioBus.inputLevel()) : 0;
      const targetEnergy = st === 'thinking' ? 0.45 : st === 'alert' || st === 'error' ? 0.6 : level;
      energy = lerp(energy, targetEnergy, speaking || listening ? 0.35 : 0.08);
      for (let i = 0; i < BARS; i++) {
        let t = 0;
        if (spectrum) {
          const v = spectrum[i];
          t = Math.pow(v, 1.4);
          if (listening) t = Math.max(t, inputRef.current * (0.5 + 0.5 * Math.sin(now / 90 + i)));
        } else if (st === 'thinking') {
          t = 0.15 + 0.12 * Math.sin(now / 260 + i * 0.35);
        } else if (st === 'idle') {
          t = 0.05 + 0.04 * Math.sin(now / 900 + i * 0.5);
        } else {
          t = 0.12 + 0.08 * Math.sin(now / 140 + i * 0.7);
        }
        bars[i] = lerp(bars[i], t, t > bars[i] ? 0.5 : 0.12);
      }

      // ── rotation
      const speed = (st === 'thinking' ? 1.6 : st === 'alert' || st === 'error' ? 1.2 : speaking ? 0.7 : 0.35) * motion;
      spin += dt * 0.35 * speed;
      spin2 -= dt * 0.55 * speed;
      spin3 += dt * 0.9 * speed;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const R = Math.min(width, height) * 0.46;
      const main = color.main;
      const glow = color.glow;

      // ── ambient glow
      const halo = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.05);
      halo.addColorStop(0, rgba(glow, 0.18 + energy * 0.25));
      halo.addColorStop(0.5, rgba(glow, 0.05));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      // ── outer tick ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin);
      ctx.strokeStyle = rgba(main, 0.55);
      ctx.lineWidth = 1;
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const long = i % 10 === 0;
        const mid = i % 5 === 0;
        const r0 = R * (long ? 0.93 : mid ? 0.955 : 0.97);
        ctx.globalAlpha = long ? 0.9 : mid ? 0.6 : 0.3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(main, 0.35);
      ctx.stroke();
      ctx.restore();

      // ── segmented arc ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin2);
      ctx.lineCap = 'butt';
      const segments = 6;
      for (let i = 0; i < segments; i++) {
        const start = (i / segments) * Math.PI * 2;
        const span = (Math.PI * 2) / segments - 0.22;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.86, start, start + span);
        ctx.lineWidth = 6;
        ctx.strokeStyle = rgba(main, 0.16 + (i % 2 === 0 ? 0.18 : 0.05) + energy * 0.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.82, start + 0.08, start + span * 0.45);
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(main, 0.75);
        ctx.stroke();
      }
      ctx.restore();

      // ── dashed ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin3);
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(main, 0.45);
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // ── audio spectrum bars
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineCap = 'round';
      const inner = R * 0.5;
      const maxLen = R * 0.16;
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const len = 2 + bars[i] * maxLen;
        const x0 = Math.cos(a) * inner;
        const y0 = Math.sin(a) * inner;
        const x1 = Math.cos(a) * (inner + len);
        const y1 = Math.sin(a) * (inner + len);
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = rgba(main, 0.35 + bars[i] * 0.65);
        ctx.shadowBlur = 8 * bars[i];
        ctx.shadowColor = rgba(glow, 0.8);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();

      // ── reactor core
      const coreR = R * 0.36;
      const breath = 1 + Math.sin(now / 700) * 0.02 + energy * 0.08;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * breath);
      core.addColorStop(0, `rgba(255,255,255,${0.75 + energy * 0.25})`);
      core.addColorStop(0.25, rgba(main, 0.55 + energy * 0.3));
      core.addColorStop(0.7, rgba(glow, 0.12));
      core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * breath, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, coreR * (0.42 + i * 0.16) * breath, 0, Math.PI * 2);
        ctx.lineWidth = i === 0 ? 2 : 1;
        ctx.strokeStyle = rgba(main, 0.7 - i * 0.2);
        ctx.stroke();
      }
      // reactor triangle
      ctx.rotate(-spin2 * 0.5);
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        const r = coreR * 0.5;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = rgba(main, 0.55);
      ctx.stroke();
      ctx.restore();

      // ── thinking orbiters
      if (st === 'thinking' || st === 'alert') {
        ctx.save();
        ctx.translate(cx, cy);
        for (let i = 0; i < 3; i++) {
          const a = spin3 * 2 + (i / 3) * Math.PI * 2;
          const r = R * 0.78;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = rgba(main, 0.95);
          ctx.shadowBlur = 14;
          ctx.shadowColor = rgba(glow, 1);
          ctx.fill();
        }
        ctx.restore();
      }

      // ── listening ring (input level)
      if (listening) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.beginPath();
        ctx.arc(0, 0, R * (0.6 + level * 0.12), 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(main, 0.25 + level * 0.6);
        ctx.stroke();
        ctx.restore();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
