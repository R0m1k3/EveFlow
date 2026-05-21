import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
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
}

export const ThreeCanvas: React.FC<ThreeCanvasProps> = ({ emotion, isSpeaking, avatarId = 'eve' }) => {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        camera={{ position: [0, 0.05, 6.2], fov: 36 }}
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

        {/* Cyan atmosphere rim — far enough to avoid harsh specular band on helmet */}
        <pointLight position={[-5, 3, 2]} intensity={1.0} color="#60c8e8" />

        {/* Desaturated blue fill — subtle depth without coloring the white lacquer */}
        <pointLight position={[4, -2, 2]} intensity={0.45} color="#8ab4d8" />

        {/* Soft white back fill to keep geometry readable */}
        <pointLight position={[0, 3, -4]} intensity={1.0} color="#ffffff" />

        <Suspense fallback={null}>
          <AvatarModelLoader avatarId={avatarId} emotion={emotion} isSpeaking={isSpeaking} />
        </Suspense>

        {/* OrbitControls calibrated to prevent clipping or losing focus */}
        <OrbitControls 
          enableZoom={true} 
          minDistance={5.2}
          maxDistance={7.2}
          enablePan={false} 
          autoRotate={false}
          maxPolarAngle={Math.PI / 1.7} 
          minPolarAngle={Math.PI / 2.8} 
        />
      </Canvas>
    </div>
  );
};
