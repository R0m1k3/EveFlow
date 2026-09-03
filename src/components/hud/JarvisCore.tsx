/**
 * JARVIS-style arc reactor core rendered on a 2D canvas.
 * Rotating tick rings, segmented arcs and an audio-reactive radial spectrum that reads the
 * real TTS output (or the microphone while listening).
 *
 * Performance notes: no canvas shadows (glow is a second wide low-alpha pass), colour strings
 * are cached, the spectrum buffer is reused, the theme accent is read once per theme change,
 * idle runs at 30 fps and the loop stops entirely while the window is hidden.
 */
import { useEffect, useRef } from 'react';
import { bridge } from '../../lib/bridge';
import { audioBus } from '../../services/voice/audioBus';
import type { HudState } from '../../state/chat';

interface Props {
  state: HudState;
  /** 0..1 override for the microphone level (VAD), used while listening. */
  inputLevel?: number;
  reduceMotion?: boolean;
  /** Bumped by the parent to trigger a short "ping" flash (send, tool start, speech start). */
  pulse?: number;
  className?: string;
}

type Rgb = [number, number, number];
interface Palette {
  main: Rgb;
  glow: Rgb;
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
const TICKS = 120;
const SEGMENTS = 6;

function readThemeAccent(): Rgb | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Rgb) : null;
}

export function JarvisCore({ state, inputLevel = 0, reduceMotion = false, pulse = 0, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const inputRef = useRef(inputLevel);
  const motionRef = useRef(reduceMotion);
  const pulseRef = useRef(0);
  stateRef.current = state;
  inputRef.current = inputLevel;
  motionRef.current = reduceMotion;

  useEffect(() => {
    if (pulse > 0) pulseRef.current = 1;
  }, [pulse]);

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
    const spectrumBuffer = new Float32Array(BARS);
    const color = { main: [52, 228, 255] as Rgb, glow: [52, 228, 255] as Rgb };
    let energy = 0;
    let spin = 0;
    let spin2 = 0;
    let spin3 = 0;
    let last = performance.now();
    let visible = document.visibilityState === 'visible';
    let frame = 0;
    let accent = readThemeAccent();

    const colorCache = new Map<number, string>();
    // Quantised rgba cache: colours are quantised to integers and alpha to 1/64 steps.
    const rgba = (c: Rgb, a: number): string => {
      const r = c[0] | 0;
      const g = c[1] | 0;
      const b = c[2] | 0;
      const q = Math.max(0, Math.min(64, Math.round(a * 64)));
      const key = (((r << 8) | g) << 8 | b) * 65 + q;
      let s = colorCache.get(key);
      if (!s) {
        s = `rgba(${r},${g},${b},${(q / 64).toFixed(3)})`;
        if (colorCache.size > 4000) colorCache.clear();
        colorCache.set(key, s);
      }
      return s;
    };

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

    const themeObserver = new MutationObserver(() => {
      accent = readThemeAccent();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const start = () => {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(draw);
      }
    };
    const onVisibility = () => {
      visible = document.visibilityState === 'visible';
      if (visible) start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // backgroundThrottling is off, so the Page Visibility API never fires: main tells us instead.
    const offWindow = bridge()?.window.onVisibility?.((shown) => {
      visible = shown;
      if (visible) start();
    });

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const draw = (now: number) => {
      if (!visible) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
      const st = stateRef.current;
      frame++;
      // Idle economy: 30 fps is plenty for the breathing animation.
      if (st === 'idle' && pulseRef.current < 0.01 && frame % 2 === 1) return;

      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const motion = motionRef.current ? 0.25 : 1;

      const target = PALETTES[st];
      const themeAccent = st === 'idle' || st === 'listening' || st === 'speaking' ? accent : null;
      const mainTarget = themeAccent ?? target.main;
      const glowTarget = themeAccent ?? target.glow;
      for (let i = 0; i < 3; i++) {
        color.main[i] = lerp(color.main[i], mainTarget[i], 0.08);
        color.glow[i] = lerp(color.glow[i], glowTarget[i], 0.08);
      }
      const speaking = st === 'speaking';
      const listening = st === 'listening';
      const spectrum = speaking
        ? audioBus.spectrum(BARS, 'output', spectrumBuffer)
        : listening
          ? audioBus.spectrum(BARS, 'input', spectrumBuffer)
          : null;
      const level = speaking ? audioBus.outputLevel() : listening ? Math.max(inputRef.current, audioBus.inputLevel()) : 0;
      pulseRef.current = Math.max(0, pulseRef.current - dt * 2.2);
      const ping = pulseRef.current;
      const targetEnergy = Math.max(ping, st === 'thinking' ? 0.45 : st === 'alert' || st === 'error' ? 0.6 : level);
      energy = lerp(energy, targetEnergy, speaking || listening || ping > 0 ? 0.35 : 0.08);
      for (let i = 0; i < BARS; i++) {
        let t = 0;
        if (spectrum) {
          const v = spectrum[i];
          t = v * Math.sqrt(v);
          if (listening) t = Math.max(t, inputRef.current * (0.5 + 0.5 * Math.sin(now / 90 + i)));
        } else if (st === 'thinking') {
          t = 0.15 + 0.12 * Math.sin(now / 260 + i * 0.35);
        } else if (st === 'idle') {
          t = 0.05 + 0.04 * Math.sin(now / 900 + i * 0.5);
        } else {
          t = 0.12 + 0.08 * Math.sin(now / 140 + i * 0.7);
        }
        t = Math.max(t, ping * 0.6);
        bars[i] = lerp(bars[i], t, t > bars[i] ? 0.5 : 0.12);
      }

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

      // ambient glow
      const halo = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.05);
      halo.addColorStop(0, rgba(glow, 0.18 + energy * 0.25));
      halo.addColorStop(0.5, rgba(glow, 0.05));
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      // outer tick ring: three batched paths (long / mid / short ticks)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin);
      ctx.lineWidth = 1;
      for (let group = 0; group < 3; group++) {
        ctx.beginPath();
        for (let i = 0; i < TICKS; i++) {
          const kind = i % 10 === 0 ? 0 : i % 5 === 0 ? 1 : 2;
          if (kind !== group) continue;
          const a = (i / TICKS) * Math.PI * 2;
          const r0 = R * (kind === 0 ? 0.93 : kind === 1 ? 0.955 : 0.97);
          ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
          ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        }
        ctx.strokeStyle = rgba(main, group === 0 ? 0.5 : group === 1 ? 0.33 : 0.17);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(main, 0.35);
      ctx.stroke();
      ctx.restore();

      // segmented arc ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin2);
      for (let i = 0; i < SEGMENTS; i++) {
        const startAngle = (i / SEGMENTS) * Math.PI * 2;
        const span = (Math.PI * 2) / SEGMENTS - 0.22;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.86, startAngle, startAngle + span);
        ctx.lineWidth = 6;
        ctx.strokeStyle = rgba(main, 0.16 + (i % 2 === 0 ? 0.18 : 0.05) + energy * 0.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.82, startAngle + 0.08, startAngle + span * 0.45);
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(main, 0.75);
        ctx.stroke();
      }
      ctx.restore();

      // dashed ring
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

      // audio spectrum bars: one wide low-alpha glow pass, then one crisp pass per intensity bucket
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineCap = 'round';
      const inner = R * 0.5;
      const maxLen = R * 0.16;
      ctx.lineWidth = 7;
      ctx.strokeStyle = rgba(glow, 0.1 + energy * 0.12);
      ctx.beginPath();
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const len = 2 + bars[i] * maxLen;
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * (inner + len), Math.sin(a) * (inner + len));
      }
      ctx.stroke();
      ctx.lineWidth = 2.4;
      for (let bucket = 0; bucket < 4; bucket++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < BARS; i++) {
          const b = Math.min(3, Math.floor(bars[i] * 4));
          if (b !== bucket) continue;
          any = true;
          const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
          const len = 2 + bars[i] * maxLen;
          ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
          ctx.lineTo(Math.cos(a) * (inner + len), Math.sin(a) * (inner + len));
        }
        if (!any) continue;
        ctx.strokeStyle = rgba(main, 0.35 + (bucket + 0.5) * 0.16);
        ctx.stroke();
      }
      ctx.restore();

      // reactor core
      const coreR = R * 0.36;
      const breath = 1 + Math.sin(now / 700) * 0.02 + energy * 0.08;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * breath);
      core.addColorStop(0, `rgba(255,255,255,${(0.75 + energy * 0.25).toFixed(3)})`);
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

      // thinking orbiters (radial gradient dots instead of shadow blur)
      if (st === 'thinking' || st === 'alert') {
        ctx.save();
        ctx.translate(cx, cy);
        for (let i = 0; i < 3; i++) {
          const a = spin3 * 2 + (i / 3) * Math.PI * 2;
          const r = R * 0.78;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          const dot = ctx.createRadialGradient(x, y, 0, x, y, 11);
          dot.addColorStop(0, rgba(main, 1));
          dot.addColorStop(0.35, rgba(glow, 0.6));
          dot.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = dot;
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // listening ring (input level)
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

    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      offWindow?.();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
