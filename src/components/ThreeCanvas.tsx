import React, { Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { AvatarModelLoader } from './AvatarModelLoader';
import { EveEmotion, EveAvatar } from '../services/emotionService';

export interface ToolEvent {
  id: string;
  label: string;
  detail?: string;
  status: 'idle' | 'running' | 'done' | 'error';
  ts: number;
}

interface ThreeCanvasProps {
  emotion: EveEmotion;
  isSpeaking: boolean;
  avatarId?: EveAvatar;
  isFloatingMode?: boolean;
}

interface HologramProjectionProps {
  emotion: EveEmotion;
  isSpeaking: boolean;
  avatarId?: EveAvatar;
}

interface ParticleInstance {
  x: number;
  y: number;
  z: number;
  speed: number;
  scale: number;
  phase: number;
}

/**
 * 3D Holographic rising particles representing active data streams.
 * Flowing upwards in an expanding spiral fashion, strictly confined within the restricted projection space (below the avatar).
 * Restrained dynamically to the avatar's real-time bottom baseline to prevent overlapping with the avatar's body.
 */
const HologramParticles: React.FC<{ color: THREE.Color; avatarId?: EveAvatar }> = ({ color, avatarId = 'eve' }) => {
  const count = 54; // restrained density so the projector stays clean and readable
  const particlesRef = useRef<THREE.Group>(null);
  
  // Persist random initial coordinates within the cone volume, speed modifiers, and scaling factors
  const particleData = React.useMemo<ParticleInstance[]>(() => {
    const data: ParticleInstance[] = [];
    for (let i = 0; i < count; i++) {
      const y = -0.8 + Math.random() * 0.6;
      const ratio = (y + 0.8) / 0.6;
      const radiusAtY = 0.17 + 0.17 * ratio;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * radiusAtY;
      data.push({
        x: Math.cos(angle) * radius,
        y: y,
        z: Math.sin(angle) * radius,
        speed: 0.002 + Math.random() * 0.004, // Elegant floating speed below EVE
        scale: 0.16 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2
      });
    }
    return data;
  }, []);

  useFrame((state) => {
    if (!particlesRef.current) return;
    const children = particlesRef.current.children;
    const t = state.clock.getElapsedTime();

    // Compute dynamic avatar bottom in real-time
    const isEve = avatarId === 'eve';
    const avatarY = isEve
      ? Math.sin(t * 1.5) * 0.06 + 0.27
      : Math.sin(t * 1.4) * 0.05 + 0.27;
    const yBottomLocal = (avatarY + 0.1) - 0.59;

    for (let i = 0; i < children.length; i++) {
      const child = children[i] as THREE.Mesh;
      const data = particleData[i];
      
      // Rise animation
      data.y += data.speed;
      
      // Spiral micro-rotation effect
      const currentRadius = Math.sqrt(data.x * data.x + data.z * data.z);
      const angle = Math.atan2(data.z, data.x) + 0.014;
      data.x = Math.cos(angle) * currentRadius;
      data.z = Math.sin(angle) * currentRadius;
      
      // Radial constraints: inverted cone is narrower at the bottom (0.17 radius) than top (0.34 radius)
      const ratio = (data.y + 0.8) / 0.6;
      const radiusAtY = 0.17 + 0.17 * ratio;
      
      // Reset position if exceeding top or radial boundaries
      if (data.y > yBottomLocal || currentRadius > radiusAtY) {
        data.y = -0.8;
        const newAngle = Math.random() * Math.PI * 2;
        const newRadius = Math.random() * 0.11; // Start close to the lens focal point
        data.x = Math.cos(newAngle) * newRadius;
        data.z = Math.sin(newAngle) * newRadius;
      }
      
      child.position.set(data.x, data.y, data.z);

      // Sinuous individual flickering
      if (child.material) {
        const mat = child.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.45 + Math.sin(t * 5.0 + data.phase) * 0.15;
      }
    }
  });

  return (
    <group ref={particlesRef}>
      {particleData.map((data, i) => (
        <mesh key={i} scale={data.scale}>
          {/* Energy crystals shape using Dodecahedron for premium specular feel */}
          <dodecahedronGeometry args={[0.018, 0]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.5}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
};

/**
 * Animated holographic chamber behind Eve.
 * Strong enough to be visible, but abstract enough to avoid the old planet/star look.
 */
const TechnicalBackdrop: React.FC = () => {
  const haloRef = useRef<THREE.Group>(null);
  const sweepRef = useRef<THREE.Group>(null);
  const gateRef = useRef<THREE.Group>(null);
  const nodeMat = React.useMemo(() => (
    new THREE.MeshBasicMaterial({
      color: '#00f2ff',
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  ), []);
  const dataLines = React.useMemo(() => ([
    { y: 1.02, width: 2.15, phase: 0.1, speed: 0.36, opacity: 0.34 },
    { y: 0.68, width: 2.55, phase: 1.6, speed: 0.28, opacity: 0.26 },
    { y: 0.24, width: 2.18, phase: 2.8, speed: 0.42, opacity: 0.32 },
    { y: -0.22, width: 2.44, phase: 4.2, speed: 0.31, opacity: 0.24 },
    { y: -0.68, width: 1.92, phase: 5.4, speed: 0.48, opacity: 0.31 }
  ]), []);
  const orbitNodes = React.useMemo(() => ([
    { radius: 1.04, angle: 0.18, size: 0.034 },
    { radius: 1.36, angle: 1.7, size: 0.024 },
    { radius: 1.68, angle: 2.78, size: 0.028 },
    { radius: 1.28, angle: 4.35, size: 0.022 },
    { radius: 1.52, angle: 5.52, size: 0.026 }
  ]), []);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (haloRef.current) {
      haloRef.current.rotation.z = t * 0.035;
      haloRef.current.scale.setScalar(1 + Math.sin(t * 0.7) * 0.025);
    }
    if (gateRef.current) {
      gateRef.current.rotation.z = Math.sin(t * 0.22) * 0.035;
    }
    if (sweepRef.current) {
      sweepRef.current.children.forEach((child, index) => {
        const line = dataLines[index];
        child.position.x = Math.sin(t * line.speed + line.phase) * 0.82;
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = line.opacity + (Math.sin(t * 1.4 + line.phase) + 1) * 0.08;
      });
    }
  });

  return (
    <group position={[0, 0.02, -1.72]}>
      <mesh position={[0, 0, -0.12]}>
        <planeGeometry args={[3.5, 3.85]} />
        <meshBasicMaterial
          color="#005e78"
          transparent
          opacity={0.16}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <group ref={sweepRef} position={[0, 0, -0.01]}>
        {dataLines.map((line, index) => (
          <mesh key={index} position={[0, line.y, 0]} rotation={[0, 0, index % 2 === 0 ? 0.05 : -0.06]}>
            <planeGeometry args={[line.width, 0.018]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={line.opacity}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
      </group>

      <group ref={gateRef}>
        {[-1.28, -0.86, 0.86, 1.28].map((x, index) => (
          <mesh key={x} position={[x, 0, -0.03]}>
            <planeGeometry args={[0.028, 3.35 - index % 2 * 0.34]} />
            <meshBasicMaterial
              color={index < 2 ? '#00f2ff' : '#8af7ff'}
              transparent
              opacity={index % 2 === 0 ? 0.19 : 0.13}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
      </group>

      <group ref={haloRef}>
        {[0.86, 1.14, 1.48, 1.78].map((radius, index) => (
          <mesh key={radius} rotation={[0, 0, index * 0.18]}>
            <ringGeometry args={[radius, radius + 0.012, 128]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.28 - index * 0.045}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
        <mesh>
          <ringGeometry args={[0.58, 0.592, 96]} />
          <meshBasicMaterial
            color="#8af7ff"
            transparent
            opacity={0.27}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        {orbitNodes.map((node, index) => (
          <mesh
            key={index}
            position={[
              Math.cos(node.angle) * node.radius,
              Math.sin(node.angle) * node.radius,
              0.01
            ]}
            material={nodeMat}
          >
            <circleGeometry args={[node.size, 24]} />
          </mesh>
        ))}
      </group>

      <mesh position={[0, 0, -0.08]}>
        <circleGeometry args={[1.28, 96]} />
        <meshBasicMaterial
          color="#00f2ff"
          transparent
          opacity={0.07}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {[
        [0, -0.94, 0]
      ].map((position, index) => (
        <mesh key={index} position={position as [number, number, number]}>
          <planeGeometry args={[1.55, 0.014]} />
          <meshBasicMaterial
            color="#8af7ff"
            transparent
            opacity={0.28}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
};

/**
 * 3D Hologram Projection platform and light cone visualizer.
 * Fully interactive and reactive to speech and emotional state.
 * Fixed to a premium cyan hue (#00f2ff) to align perfectly with the EVEFLOW brand.
 * Confines the light cone strictly below the avatar's body, stretching to touch her base dynamically.
 */
const HologramProjection: React.FC<HologramProjectionProps> = ({ emotion, isSpeaking, avatarId = 'eve' }) => {
  const beamRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const baseRef = useRef<THREE.Group>(null);
  
  // Cybernetic rotative diagnostic ring groups
  const ringGroup1Ref = useRef<THREE.Group>(null);
  const ringGroup2Ref = useRef<THREE.Group>(null);
  const ringGroup3Ref = useRef<THREE.Group>(null);

  // Permanently fixed to signature premium cyan to preserve brand identity and theme consistency
  const stateColor = React.useMemo(() => new THREE.Color('#00f2ff'), []);
  const isThinking = emotion === 'thinking';

  // Custom ShaderMaterial to generate a smooth, high-fidelity opacity gradient fading towards the top
  const coneMaterial = React.useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        color: { value: stateColor },
        opacity: { value: 0.42 },
      },
      vertexShader: `
        varying vec3 vLocalPosition;
        void main() {
          vLocalPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying vec3 vLocalPosition;
        void main() {
          // Normalizing local Y from -0.3 (bottom) to 0.3 (top) for a total height of 0.6
          float factor = (vLocalPosition.y + 0.3) / 0.6;
          // Smooth progressive fade out to absolute transparency at the top
          float grad = clamp(1.0 - factor, 0.0, 1.0);
          // Cubic curve for ultra-soft, premium cinematic light scattering
          grad = pow(grad, 1.6);
          gl_FragColor = vec4(color, grad * opacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [stateColor]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    
    // Dynamic tracking of avatar's float baseline to keep perfect visual contact
    const isEve = avatarId === 'eve';
    const avatarY = isEve
      ? Math.sin(t * 1.5) * 0.06 + 0.27
      : Math.sin(t * 1.4) * 0.05 + 0.27;
      
    // The bottom of the avatar shell is approximately Y_avatar - 0.59
    const yBottomLocal = (avatarY + 0.1) - 0.59;
    
    // Lens source is at Y = -0.80 local (aligned to the new flat holographic emitter lens)
    const yLensLocal = -0.80;
    const currentHeight = yBottomLocal - yLensLocal;
    const currentCenterY = yLensLocal + currentHeight / 2;

    // Scale vertically relative to the default geometry height of 0.6
    if (beamRef.current) {
      beamRef.current.scale.y = currentHeight / 0.6;
      beamRef.current.position.y = currentCenterY;
    }
    
    // Volumetric base flicker intensity simulation (high-fidelity holographic noise) - Boosted for pronounced cyan look
    let baseFlicker = 0.42 + Math.sin(t * 7.5) * 0.05 + Math.cos(t * 3.2) * 0.025;
    
    if (isThinking) {
      baseFlicker += Math.sin(t * 22.0) * 0.035;
    }

    if (isSpeaking) {
      const voiceFrequencyOscillation = Math.sin(t * 18.0) * 0.08 + Math.abs(Math.cos(t * 12.0)) * 0.05;
      baseFlicker += voiceFrequencyOscillation;
    }

    // Volumetric soft cone opacity adjustment through custom shader uniforms
    if (beamRef.current && beamRef.current.material) {
      const mat = beamRef.current.material as THREE.ShaderMaterial;
      if (mat.uniforms && mat.uniforms.opacity && mat.uniforms.color) {
        mat.uniforms.opacity.value = baseFlicker;
        mat.uniforms.color.value.lerp(stateColor, 0.08);
      }
    }
    
    // Smooth cybernetic diagnostics rotations
    if (ringGroup1Ref.current) ringGroup1Ref.current.rotation.z = t * 0.16;
    if (ringGroup2Ref.current) ringGroup2Ref.current.rotation.z = -t * 0.10;
    if (ringGroup3Ref.current) ringGroup3Ref.current.rotation.z = t * 0.06;
    if (baseRef.current) baseRef.current.scale.setScalar(1 + Math.sin(t * 2.2) * 0.018);

    // Glow plate adjustment - Pulsing emission intensity simulated via opacity for BasicMaterial
    if (glowRef.current && glowRef.current.material) {
      const mat = glowRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.70 + Math.sin(t * 5.0) * 0.15;
    }
  });

  return (
    <group position={[0, -0.1, 0]}>
      {/* 1. Volumetric hologram light cone - Dynamically scaled and positioned to touch EVE's bottom */}
      <mesh ref={beamRef} position={[0, -0.50, 0]}>
        <cylinderGeometry args={[0.34, 0.15, 0.6, 48, 1, true]} />
        <primitive object={coneMaterial} attach="material" />
      </mesh>

      {/* High-fidelity upward particle flow synchronized to avatar bottom limit */}
      <HologramParticles color={stateColor} avatarId={avatarId} />

      {/* 2. Émetteur Holographique Pur (100% Lumineux & Intégré) */}
      <group position={[0, -0.05, 0]}>
        <group ref={baseRef}>
          <mesh position={[0, -0.93, 0]}>
            <cylinderGeometry args={[0.32, 0.38, 0.08, 72]} />
            <meshPhysicalMaterial
              color="#dff8ff"
              roughness={0.18}
              metalness={0.18}
              clearcoat={1}
              clearcoatRoughness={0.08}
              emissive="#4defff"
              emissiveIntensity={0.25}
            />
          </mesh>
          <mesh position={[0, -0.835, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.28, 72]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.48}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh position={[0, -0.828, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.25, 0.27, 72]} />
            <meshBasicMaterial
              color="#ffffff"
              transparent
              opacity={0.58}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh position={[0, -1.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.44, 72]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.13}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>

        <pointLight position={[0, -0.76, 0.35]} intensity={0.95} color="#00f2ff" distance={2.4} />
        {/* A. Lentille émissive centrale - Source principale de lumière */}
        <mesh
          ref={glowRef}
          position={[0, -0.80, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[0, 0.14, 32]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.88}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* B. Premier anneau concentrique de confinement d'énergie */}
        <mesh position={[0, -0.798, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.155, 0.16, 64]} />
          <meshBasicMaterial
            color="#00f2ff"
            transparent
            opacity={0.45}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* C. Anneau segmenté rotatif interne (Sens horaire) */}
        <group ref={ringGroup1Ref} position={[0, -0.796, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            <ringGeometry args={[0.18, 0.19, 32, 1, 0, Math.PI * 0.45]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.65}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[0, 0, Math.PI]}>
            <ringGeometry args={[0.18, 0.19, 32, 1, 0, Math.PI * 0.45]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.65}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>

        {/* D. Anneau segmenté rotatif externe (Sens anti-horaire) */}
        <group ref={ringGroup2Ref} position={[0, -0.794, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            <ringGeometry args={[0.22, 0.23, 32, 1, Math.PI * 0.2, Math.PI * 0.5]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.40}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[0, 0, Math.PI]}>
            <ringGeometry args={[0.22, 0.23, 32, 1, Math.PI * 0.2, Math.PI * 0.5]} />
            <meshBasicMaterial
              color="#00f2ff"
              transparent
              opacity={0.40}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>

        {/* E. Anneau de ciblage tech externe avec micro-graduations */}
        <group ref={ringGroup3Ref} position={[0, -0.792, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <mesh key={i} rotation={[0, 0, (i * Math.PI) / 3]}>
              <ringGeometry args={[0.26, 0.264, 16, 1, 0, Math.PI * 0.04]} />
              <meshBasicMaterial
                color="#00f2ff"
                transparent
                opacity={0.28}
                blending={THREE.AdditiveBlending}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </group>

        {/* F. Grand anneau de balayage de diagnostic extérieur pulsant */}
        <mesh position={[0, -0.798, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.31, 0.313, 64]} />
          <meshBasicMaterial
            color="#00f2ff"
            transparent
            opacity={0.18}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
};

export const ThreeCanvas: React.FC<ThreeCanvasProps> = ({ emotion, isSpeaking, avatarId = 'eve', isFloatingMode = false }) => {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        camera={{ position: isFloatingMode ? [0, 0.72, 3.7] : [0, 1.1, 5.8], fov: isFloatingMode ? 30 : 36 }}
        gl={{ alpha: true, antialias: true, premultipliedAlpha: false }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
        dpr={[1, 2]}
        style={{ background: 'transparent', backgroundColor: 'transparent' }}
      >
        {/* Soft ambient — dark space base */}
        <ambientLight intensity={0.6} color="#b0c8e8" />
        <hemisphereLight args={['#1a2a4a', '#050810', 0.8]} />

        {/* Main key light — warm white rim from top-right */}
        <directionalLight
          position={[5, 8, 5]}
          intensity={2.0}
          color="#e8f4ff"
        />

        {/* Cyan atmosphere rim */}
        <pointLight position={[-5, 3, 2]} intensity={1.0} color="#60c8e8" />

        {/* Desaturated blue fill */}
        <pointLight position={[4, -2, 2]} intensity={0.45} color="#8ab4d8" />

        {/* Soft white back fill to keep geometry readable */}
        <pointLight position={[0, 3, -4]} intensity={1.0} color="#ffffff" />

        <Suspense fallback={null}>
          <TechnicalBackdrop />
          <HologramProjection emotion={emotion} isSpeaking={isSpeaking} avatarId={avatarId} />
          <AvatarModelLoader avatarId={avatarId} emotion={emotion} isSpeaking={isSpeaking} />
        </Suspense>

        {/* OrbitControls calibrated to prevent clipping or losing focus */}
        <OrbitControls 
          enableZoom={true} 
          minDistance={isFloatingMode ? 2.4 : 4.8}
          maxDistance={isFloatingMode ? 4.7 : 6.8}
          enablePan={false} 
          autoRotate={false}
          maxPolarAngle={Math.PI / 1.7} 
          minPolarAngle={Math.PI / 2.8} 
        />
      </Canvas>
    </div>
  );
};
