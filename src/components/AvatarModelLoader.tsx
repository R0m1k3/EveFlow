import React, { useEffect, useMemo, useState } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { EveModel } from './EveModel';
import { EveAvatar, EveEmotion, EmotionService } from '../services/emotionService';

interface AvatarModelLoaderProps {
  avatarId: EveAvatar;
  emotion: EveEmotion;
  isSpeaking: boolean;
}

type AvatarManifest = Partial<Record<Exclude<EveAvatar, 'eve'>, string | null>>;

const AVATAR_MANIFEST_PATH = '/avatars/avatar-manifest.json';

const LoadedGlbAvatar: React.FC<{
  path: string;
  avatarId: EveAvatar;
  emotion: EveEmotion;
  isSpeaking: boolean;
}> = ({ path, avatarId, emotion, isSpeaking }) => {
  const gltf = useLoader(GLTFLoader, path);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  useEffect(() => {
    const style = EmotionService.getEmotionStyle(emotion, avatarId);
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = false;
      child.receiveShadow = false;

      const materialName = Array.isArray(child.material)
        ? child.material.map((material) => material.name).join(' ')
        : child.material?.name || '';

      if (/eye|led|visor|screen|emissive/i.test(`${child.name} ${materialName}`)) {
        const eyeMaterial = new THREE.MeshBasicMaterial({
          color: new THREE.Color(style.eyeColor),
          transparent: true,
          opacity: 0.96
        });
        child.material = eyeMaterial;
      }
    });
  }, [avatarId, emotion, scene]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    scene.position.y = Math.sin(t * 1.4) * 0.05 + 0.22;
    scene.rotation.y = Math.sin(t * 0.45) * 0.05;

    if (isSpeaking) {
      scene.rotation.z = Math.sin(t * 8) * 0.025;
    } else {
      scene.rotation.z = THREE.MathUtils.lerp(scene.rotation.z, 0, 0.12);
    }
  });

  return <primitive object={scene} scale={0.48} />;
};

export const AvatarModelLoader: React.FC<AvatarModelLoaderProps> = ({ avatarId, emotion, isSpeaking }) => {
  const [assetPath, setAssetPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAssetPath(null);

    if (avatarId === 'eve') return;

    fetch(AVATAR_MANIFEST_PATH, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AvatarManifest>;
      })
      .then((manifest) => {
        if (cancelled || !manifest) return;
        const nextAssetPath = manifest[avatarId];
        setAssetPath(typeof nextAssetPath === 'string' && nextAssetPath.trim() ? nextAssetPath : null);
      })
      .catch(() => {
        if (!cancelled) setAssetPath(null);
      });

    return () => {
      cancelled = true;
    };
  }, [avatarId]);

  if (avatarId !== 'eve' && assetPath) {
    return <LoadedGlbAvatar path={assetPath} avatarId={avatarId} emotion={emotion} isSpeaking={isSpeaking} />;
  }

  return <EveModel emotion={emotion} isSpeaking={isSpeaking} avatarId="eve" />;
};
