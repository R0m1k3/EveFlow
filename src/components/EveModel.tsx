import React, { useRef, useEffect } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { EveEmotion, EveAvatar, EmotionService } from '../services/emotionService';

interface EveModelProps {
  emotion: EveEmotion;
  isSpeaking: boolean;
  avatarId?: EveAvatar;
}

const createSmoothGeometry = (geometry: THREE.BufferGeometry, tolerance = 0.01) => {
  const smoothGeometry = geometry.clone();
  smoothGeometry.deleteAttribute('normal');
  smoothGeometry.deleteAttribute('uv');
  if (smoothGeometry.hasAttribute('color')) {
    smoothGeometry.deleteAttribute('color');
  }
  if (smoothGeometry.hasAttribute('uv2')) {
    smoothGeometry.deleteAttribute('uv2');
  }

  const mergedGeometry = mergeVertices(smoothGeometry, tolerance);
  mergedGeometry.computeVertexNormals();
  mergedGeometry.computeBoundingBox();
  mergedGeometry.computeBoundingSphere();

  return mergedGeometry;
};

const createVisorShaderMaterial = () => {
  return new THREE.ShaderMaterial({
    uniforms: {
      eyeColor: { value: new THREE.Color('#00f2ff') },
      eyeScaleY: { value: 0.75 },
      eyeRotation: { value: 0 },
      eyeOffsetX: { value: 0 },
      eyeOffsetY: { value: 0 },
      speakingPulse: { value: 0 },
      thinkingVal: { value: 0 },
      uTime: { value: 0 }
    },
    vertexShader: `
      varying vec3 vLocalPosition;
      varying vec3 vNormal;

      void main() {
        vLocalPosition = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 eyeColor;
      uniform float eyeScaleY;
      uniform float eyeRotation;
      uniform float eyeOffsetX;
      uniform float eyeOffsetY;
      uniform float speakingPulse;
      uniform float thinkingVal;
      uniform float uTime;

      varying vec3 vLocalPosition;
      varying vec3 vNormal;

      vec2 rotateAround(vec2 point, vec2 center, float angle) {
        float c = cos(angle);
        float s = sin(angle);
        vec2 localPoint = point - center;
        return vec2(
          localPoint.x * c - localPoint.y * s,
          localPoint.x * s + localPoint.y * c
        ) + center;
      }

      float eyeMask(vec2 point, vec2 center, float width, float height, float angle) {
        vec2 rotatedPoint = rotateAround(point, center, angle);
        vec2 normalizedPoint = (rotatedPoint - center) / vec2(width, height);
        float distanceFromCenter = dot(normalizedPoint, normalizedPoint);
        return 1.0 - smoothstep(0.64, 0.92, distanceFromCenter);
      }

      float eyeGlow(vec2 point, vec2 center, float width, float height, float angle) {
        vec2 rotatedPoint = rotateAround(point, center, angle);
        vec2 normalizedPoint = (rotatedPoint - center) / vec2(width, height);
        float distanceFromCenter = dot(normalizedPoint, normalizedPoint);
        return 1.0 - smoothstep(0.82, 1.85, distanceFromCenter);
      }

      void main() {
        vec2 facePoint = vLocalPosition.xy;
        float eyeHeight = max(0.11, 0.18 * eyeScaleY + speakingPulse);
        vec2 leftCenter = vec2(-0.72 + eyeOffsetX, 8.56 + eyeOffsetY);
        vec2 rightCenter = vec2(0.72 + eyeOffsetX, 8.56 + eyeOffsetY);

        float leftEye = eyeMask(facePoint, leftCenter, 0.43, eyeHeight, eyeRotation);
        float rightEye = eyeMask(facePoint, rightCenter, 0.43, eyeHeight, -eyeRotation);
        float leftGlow = eyeGlow(facePoint, leftCenter, 0.49, eyeHeight * 1.35, eyeRotation);
        float rightGlow = eyeGlow(facePoint, rightCenter, 0.49, eyeHeight * 1.35, -eyeRotation);

        float eye = max(leftEye, rightEye);
        float glow = max(leftGlow, rightGlow);
        float core = eyeMask(facePoint, leftCenter + vec2(0.0, 0.01), 0.25, eyeHeight * 0.42, eyeRotation)
          + eyeMask(facePoint, rightCenter + vec2(0.0, 0.01), 0.25, eyeHeight * 0.42, -eyeRotation);

        vec3 viewLight = normalize(vec3(-0.35, 0.42, 1.0));
        float highlight = pow(max(dot(normalize(vNormal), viewLight), 0.0), 16.0) * 0.23;
        float rim = pow(1.0 - abs(vNormal.z), 2.0) * 0.08;

        // Lueur de calcul douce pendant la réflexion (remplace les bandes dures)
        float scanline = 0.0;
        if (thinkingVal > 0.05) {
          // Bandes très espacées et très graduelles — effet data-pulse discret
          float wave = sin(vLocalPosition.y * 2.5 - uTime * 4.0) * 0.5 + 0.5;
          scanline = smoothstep(0.55, 0.95, wave) * thinkingVal * 0.45;
          // Respiration lente (pas de scintillement haute fréquence agressif)
          scanline *= (0.85 + 0.15 * sin(uTime * 2.2));
        }

        vec3 color = vec3(0.002, 0.004, 0.006);
        color += vec3(highlight + rim);
        color += eyeColor * glow * 0.13;
        color += eyeColor * eye * 1.85;
        color += vec3(0.88, 1.0, 1.0) * clamp(core, 0.0, 1.0) * 0.55;
        color += eyeColor * scanline * 0.85;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
};

/**
 * Calculates local 3D vertex deformation offsets for Eve's arms based on current emotion,
 * time, and side/height falloff coordinates.
 */
const getEmotionalArmOffset = (
  side: number,
  shoulderFalloff: number,
  t: number,
  emotion: EveEmotion,
  isSpeaking: boolean
): { dx: number; dy: number; dz: number } => {
  let dx = 0;
  let dy = 0;
  let dz = 0;

  // 1. Base speaking gesticulation wave
  const talkAmp = isSpeaking ? 1.0 : 0.0;
  // Dynamic talking wave: faster and wider
  const talkX = talkAmp * side * Math.sin(t * 12) * 0.12 * shoulderFalloff;
  const talkY = talkAmp * Math.abs(Math.cos(t * 12)) * 0.12 * shoulderFalloff;
  const talkZ = talkAmp * Math.sin(t * 10 + side) * 0.08 * shoulderFalloff;

  // 2. Emotional posture offset and secondary oscillations
  switch (emotion) {
    case 'happy': {
      // Fast, excited bouncing and outward waving
      const bounceX = side * (Math.sin(t * 8.5) * 0.18 + 0.1) * shoulderFalloff;
      const bounceY = Math.abs(Math.sin(t * 13)) * 0.26 * shoulderFalloff;
      const bounceZ = Math.sin(t * 11 + side) * 0.08 * shoulderFalloff;
      
      // Joyous gesticulation is fast
      dx = bounceX + talkX * 1.3;
      dy = bounceY + talkY * 1.3;
      dz = bounceZ + talkZ * 1.3;
      break;
    }
    case 'sad': {
      // Heavy, lifeless drooping arms, slightly pulled in close to the body
      const droopX = -side * 0.16 * shoulderFalloff;
      const droopY = -0.32 * shoulderFalloff; // Sags downwards
      const droopZ = Math.sin(t * 0.6) * 0.015 * shoulderFalloff; // Barely breathing
      
      // When sad, talking gesticulation is extremely muted and slow
      dx = droopX + talkX * 0.25;
      dy = droopY + talkY * 0.25;
      dz = droopZ + talkZ * 0.25;
      break;
    }
    case 'thinking': {
      // Asymmetric pose: Right arm (side > 0) raised high to think/touch helmet,
      // Left arm (side < 0) hanging restfully.
      if (side > 0) {
        // Right arm raised towards helmet
        const thinkX = -side * 0.18 * shoulderFalloff; // Brought inward
        const thinkY = (1.18 + Math.sin(t * 2.2) * 0.04) * shoulderFalloff; // High vertical reach
        const thinkZ = (0.38 + Math.cos(t * 2.2) * 0.04) * shoulderFalloff; // Pushed forward
        
        dx = thinkX + talkX * 0.15; // Raised arm barely moves during speech
        dy = thinkY + talkY * 0.15;
        dz = thinkZ + talkZ * 0.15;
      } else {
        // Left arm relaxed, drifting slowly
        const restX = -side * 0.04 * shoulderFalloff;
        const restY = -0.12 * shoulderFalloff;
        const restZ = Math.sin(t * 1.4) * 0.035 * shoulderFalloff;
        
        dx = restX + talkX * 0.8;
        dy = restY + talkY * 0.8;
        dz = restZ + talkZ * 0.8;
      }
      break;
    }
    case 'angry': {
      // Rigid, tensed arms, pushed slightly outwards, high-freq anger trembling
      const stiffX = side * 0.14 * shoulderFalloff;
      const stiffY = -0.08 * shoulderFalloff;
      const tremble = Math.sin(t * 28) * 0.028 * shoulderFalloff; // Furious shaking
      const stiffZ = tremble;

      // Anger talking is abrupt, stiff and aggressive
      dx = stiffX + talkX * 0.6;
      dy = stiffY + talkY * 0.6;
      dz = stiffZ + talkZ * 0.6;
      break;
    }
    case 'surprised': {
      // Arms immediately thrown upwards and wide (shock reflex)
      const shockX = side * 0.32 * shoulderFalloff;
      const shockY = (0.42 + Math.sin(t * 16) * 0.08) * shoulderFalloff; // Fast jitter
      const shockZ = -0.16 * shoulderFalloff; // Recoil

      // Speech gesticulation is fast but overwhelmed by shock
      dx = shockX + talkX * 0.8;
      dy = shockY + talkY * 0.8;
      dz = shockZ + talkZ * 0.8;
      break;
    }
    case 'neutral':
    default: {
      // Gentle breathing floating cycle
      const breatheX = side * Math.sin(t * 1.5) * 0.02 * shoulderFalloff;
      const breatheY = Math.abs(Math.sin(t * 1.5)) * 0.03 * shoulderFalloff;
      const breatheZ = Math.sin(t * 1.5 + side) * 0.03 * shoulderFalloff;

      dx = breatheX + talkX;
      dy = breatheY + talkY;
      dz = breatheZ + talkZ;
      break;
    }
  }

  return { dx, dy, dz };
};

export const EveModel: React.FC<EveModelProps> = ({ emotion, isSpeaking, avatarId = 'eve' }) => {
  const modelRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Object3D | null>(null);
  const visorRef = useRef<THREE.Object3D | null>(null);
  const eyesRef = useRef<THREE.Object3D | null>(null);
  const visorMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const mainBodyMeshRef = useRef<THREE.Mesh | null>(null);

  const mainBodyBasePositionsRef = useRef<Float32Array | null>(null);
  const armsRef = useRef<THREE.Mesh[]>([]);
  
  // Perfect pivot reference and center memory for neck-like head rotation
  const headGroupRef = useRef<THREE.Group | null>(null);
  const headCenterRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Charger les matériaux et le modèle OBJ depuis le répertoire public
  const materials = useLoader(MTLLoader, './Eve/EVE.mtl');
  const obj = useLoader(OBJLoader, './Eve/EVE.obj', (loader) => {
    materials.preload();
    loader.setMaterials(materials);
  });

  // Cloner le modèle pour éviter les interférences si réutilisé
  const clonedObj = React.useMemo(() => obj.clone(), [obj]);

  useEffect(() => {
    if (!clonedObj) return;

    // Reset references to avoid old instances
    const headMeshes: THREE.Mesh[] = [];
    const visorMeshes: THREE.Mesh[] = [];
    const eyesMeshes: THREE.Mesh[] = [];
    const armsMeshes: THREE.Mesh[] = [];
    const bodyMeshes: THREE.Mesh[] = [];

    headRef.current = null;
    visorRef.current = null;
    eyesRef.current = null;
    armsRef.current = [];
    headGroupRef.current = null;
    visorMaterialRef.current = null;
    mainBodyMeshRef.current = null;
    mainBodyBasePositionsRef.current = null;

    // Remove helper covers from previous dev/StrictMode effect passes.
    [
      'eveBodyCollarSeamCover',
      'eveNeckSeamCover',
      'eveLeftShoulderSeamCover',
      'eveRightShoulderSeamCover'
    ].forEach((helperName) => {
      const helper = clonedObj.getObjectByName(helperName);
      if (helper?.parent) {
        helper.parent.remove(helper);
      }
    });

    // 1. Classify meshes to assign control references and extract original textures
    clonedObj.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        const lowerName = (child.name || '').toLowerCase();

        // Hide weapons accessories completely (as requested: only the character)
        if (lowerName.includes('gun')) {
          child.visible = false;
          return;
        }

        if (lowerName.includes('head')) {
          headMeshes.push(child);
        } else if (lowerName.includes('visor') || lowerName.includes('visiere') || lowerName.includes('screen') || lowerName.includes('ecran')) {
          visorMeshes.push(child);
        } else if (lowerName.includes('eye') || lowerName.includes('yeux')) {
          eyesMeshes.push(child);
        } else if (lowerName.includes('upperbody')) {
          bodyMeshes.push(child);
        } else if (lowerName.includes('arm')) {
          armsMeshes.push(child);
        } else {
          bodyMeshes.push(child);
        }
      }
    });
    const resolvedHeadMesh = headMeshes[0] || null;
    const resolvedVisorMesh = visorMeshes[0] || null;

    const existingGroup = clonedObj.getObjectByName('headGroup');

    // 2. Build High-Fidelity Retro-Futuristic space-age materials
    
    // A. White lacquer glossy material for body parts, limbs and helmet shell.
    // Specular dispersion values (higher roughness and low metalness) are optimized
    // alongside a light emissive fill to diffuse self-shadows and mask assembly lines.
    const whiteLacquerMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.14,
      metalness: 0.14,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0.16,
      reflectivity: 0.92,
      depthWrite: true,
      transparent: false
    });

    const seamCoverMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.14,
      metalness: 0.14,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0.16,
      reflectivity: 0.92,
      depthWrite: true,
      transparent: false
    });
    bodyMeshes.forEach((mesh) => {
      // Weld nearby vertices to resolve seams perfectly
      mesh.geometry = createSmoothGeometry(mesh.geometry, 0.08);
      mesh.material = whiteLacquerMaterial;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      if ((mesh.name || '').toLowerCase() === 'eve') {
        mainBodyMeshRef.current = mesh;
        mainBodyBasePositionsRef.current = new Float32Array(mesh.geometry.getAttribute('position').array);
      }
    });

    if (resolvedHeadMesh) {
      // Smooth out head geometry specifically to erase forehead seams and curves
      resolvedHeadMesh.geometry = createSmoothGeometry(resolvedHeadMesh.geometry, 0.08);
      // Dedicated head material: higher emissive to fill shadow gaps at seam edges
      resolvedHeadMesh.material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#ffffff'),
        roughness: 0.12,
        metalness: 0.12,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        emissive: new THREE.Color('#ffffff'),
        emissiveIntensity: 0.28,
        reflectivity: 0.95,
        depthWrite: true,
        transparent: false,
      });
      resolvedHeadMesh.castShadow = false;
      resolvedHeadMesh.receiveShadow = false;
    }

    armsRef.current = [];
    armsMeshes.forEach((mesh) => {
      // Apply smooth geometry and white lacquer material to the floating arms
      mesh.geometry = createSmoothGeometry(mesh.geometry, 0.07);
      mesh.material = whiteLacquerMaterial;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // Store base coordinates for dynamic relative offset animations
      mesh.userData.initialPosition = mesh.position.clone();
      mesh.userData.initialRotation = mesh.rotation.clone();
      mesh.userData.basePositions = new Float32Array(mesh.geometry.getAttribute('position').array);

      armsRef.current.push(mesh);
    });

    // B. Glossy black acrylic plastic cosmonaut visor (fully opaque black shield)
    if (resolvedVisorMesh) {
      resolvedVisorMesh.geometry.computeVertexNormals();
      const visorMaterial = createVisorShaderMaterial();
      visorMaterialRef.current = visorMaterial;

      resolvedVisorMesh.material = visorMaterial;
      resolvedVisorMesh.renderOrder = 2; // Render after the head shell
    }

    // C. Hide the low-resolution texture eyes. Clean Eve-style eyes are generated below.
    eyesMeshes.forEach((mesh) => {
      mesh.visible = false;
    });

    // 3. Compute local bounding box of the whole model to standardize height
    const localBox = new THREE.Box3();
    clonedObj.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        if (!child.geometry.boundingBox) {
          child.geometry.computeBoundingBox();
        }
        if (child.geometry.boundingBox) {
          localBox.union(child.geometry.boundingBox);
        }
      }
    });

    const size = new THREE.Vector3();
    localBox.getSize(size);
    const center = new THREE.Vector3();
    localBox.getCenter(center);

    // Normalize height conservatively so the avatar stays inside the right panel.
    const targetHeight = 1.18;
    const scaleFactor = targetHeight / (size.y || 1);
    clonedObj.scale.setScalar(scaleFactor);

    // Center model pivot perfectly at [0, 0, 0] in global workspace
    clonedObj.position.x = -center.x * scaleFactor;
    clonedObj.position.y = -center.y * scaleFactor;
    clonedObj.position.z = -center.z * scaleFactor;

    // Collar ring — wider tube to fully bridge body-to-neck gap
    const bodyCollar = new THREE.Mesh(
      new THREE.TorusGeometry(1.66, 0.14, 28, 160),
      seamCoverMaterial
    );
    bodyCollar.name = 'eveBodyCollarSeamCover';
    bodyCollar.position.set(0, 6.43, -0.04);
    bodyCollar.rotation.x = Math.PI / 2;
    bodyCollar.scale.z = 0.88;
    bodyCollar.renderOrder = 1;
    bodyCollar.castShadow = false;
    bodyCollar.receiveShadow = false;
    clonedObj.add(bodyCollar);

    // Neck cylinder — fills the gap between collar ring and helmet base
    const neckCover = new THREE.Mesh(
      new THREE.CylinderGeometry(0.56, 0.70, 0.52, 36, 1, false),
      seamCoverMaterial
    );
    neckCover.name = 'eveNeckSeamCover';
    neckCover.position.set(0, 7.05, -0.04);
    neckCover.renderOrder = 1;
    neckCover.castShadow = false;
    neckCover.receiveShadow = false;
    clonedObj.add(neckCover);

    // Shoulder caps — larger and deeper to fully cover arm-body junction
    const shoulderGeometry = new THREE.SphereGeometry(0.42, 40, 24);
    const leftShoulderCover = new THREE.Mesh(shoulderGeometry, seamCoverMaterial);
    const rightShoulderCover = new THREE.Mesh(shoulderGeometry.clone(), seamCoverMaterial);
    leftShoulderCover.name = 'eveLeftShoulderSeamCover';
    rightShoulderCover.name = 'eveRightShoulderSeamCover';
    leftShoulderCover.position.set(-2.58, 5.9, 0.03);
    rightShoulderCover.position.set(2.58, 5.9, 0.03);
    leftShoulderCover.scale.set(0.72, 0.88, 0.56);
    rightShoulderCover.scale.set(0.72, 0.88, 0.56);
    leftShoulderCover.renderOrder = 1;
    rightShoulderCover.renderOrder = 1;
    leftShoulderCover.castShadow = false;
    rightShoulderCover.castShadow = false;
    leftShoulderCover.receiveShadow = false;
    rightShoulderCover.receiveShadow = false;
    clonedObj.add(leftShoulderCover, rightShoulderCover);

    // 4. Construct the synchronized Head Group with perfect pivots and local translations
    if (resolvedHeadMesh) {
      // A. Calculate local center of head geometry
      const headGeom = resolvedHeadMesh.geometry;
      if (!headGeom.boundingBox) {
        headGeom.computeBoundingBox();
      }
      const headCenter = new THREE.Vector3();
      if (headGeom.boundingBox) {
        headGeom.boundingBox.getCenter(headCenter);
      }
      headCenterRef.current.copy(headCenter);

      // B. Create head group and place it at headCenter (in clonedObj local space)
      const headGroup = new THREE.Group();
      headGroup.name = "headGroup";
      headGroup.position.copy(headCenter);
      clonedObj.add(headGroup);
      headGroupRef.current = headGroup;

      // C. Position Head: Keep geometry intact to maintain perfect Blender-defined coordinates, position relative to headGroup
      headGroup.add(resolvedHeadMesh);
      resolvedHeadMesh.position.set(-headCenter.x, -headCenter.y, -headCenter.z);

      // D. Position Visor: Keep geometry intact for absolute precision, and position at headCenter
      if (resolvedVisorMesh) {
        headGroup.add(resolvedVisorMesh);
        resolvedVisorMesh.position.set(-headCenter.x, -headCenter.y, -headCenter.z);
      }

      headRef.current = resolvedHeadMesh;
      visorRef.current = resolvedVisorMesh;
      eyesRef.current = null;

      if (existingGroup?.parent && existingGroup !== headGroup) {
        existingGroup.parent.remove(existingGroup);
      }
    }
  }, [clonedObj, avatarId]);

  // Boucle de rendu pour animer Eve en temps réel (Animations fluides R3F)
  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    
    // Style émotionnel actuel
    const emoStyle = EmotionService.getEmotionStyle(emotion, avatarId);
    
    // 1. Animation globale de flottaison (Lévitation magnétique)
    if (modelRef.current) {
      // Oscillation en hauteur stabilisée autour de y = 0.22 (remonté pour un centrage élégant)
      modelRef.current.position.y = Math.sin(t * 1.5) * 0.06 + 0.22;
      // Légère rotation sur elle-même (mouvement de veille)
      modelRef.current.rotation.y = Math.sin(t * 0.5) * 0.05;
    }

    // 2. Animation de la tête flottante autonome (incluant la visière et les yeux)
    if (headGroupRef.current && headCenterRef.current) {
      const headCenter = headCenterRef.current;
      
      // Flottaison déphasée par rapport au corps pour accentuer l'effet magnétique
      let headY = Math.sin(t * 1.8) * 0.02 + 0.01;
      
      // Orientation naturelle vers la souris pour donner vie au robot
      const mouseX = state.pointer.x * 0.25;
      const mouseY = state.pointer.y * 0.2;
      
      let targetRotY = THREE.MathUtils.lerp(headGroupRef.current.rotation.y, mouseX, 0.1);
      let targetRotX = THREE.MathUtils.lerp(headGroupRef.current.rotation.x, -mouseY + 0.05, 0.1);
      let targetRotZ = 0;
      let headZOffset = 0;

      // Inclinaisons émotionnelles ultra-expressives
      if (emotion === 'sad') {
        // Tête très baissée et abattue
        targetRotX = THREE.MathUtils.lerp(targetRotX, 0.35, 0.1);
        targetRotZ = THREE.MathUtils.lerp(headGroupRef.current.rotation.z, 0.12, 0.1);
        headY -= 0.02; // Tête enfoncée dans les épaules
      } else if (emotion === 'thinking') {
        // Tête inclinée sur le côté (curieuse) ET léger balancement pendulaire (swaying)
        const sway = Math.sin(t * 3.5) * 0.04;
        targetRotZ = THREE.MathUtils.lerp(headGroupRef.current.rotation.z, -0.22 + sway, 0.1);
        // Micro-mouvements de tête (hochement pensif vertical et balayage horizontal lent)
        headY += Math.sin(t * 4.5) * 0.005;
      } else if (emotion === 'angry') {
        // Tête très penchée en avant (froncée/agacée) avec micro-tremblements horizontaux
        targetRotX = THREE.MathUtils.lerp(targetRotX, 0.22, 0.1);
        const angerTremble = Math.sin(t * 22) * 0.015;
        targetRotY = THREE.MathUtils.lerp(headGroupRef.current.rotation.y, mouseX + angerTremble, 0.1);
      } else if (emotion === 'happy') {
        // Excitation joyeuse : petits hochements de tête rapides (bobbing)
        const joyBob = Math.sin(t * 6.5) * 0.03;
        targetRotX = THREE.MathUtils.lerp(targetRotX, joyBob - mouseY + 0.02, 0.1);
        targetRotZ = THREE.MathUtils.lerp(headGroupRef.current.rotation.z, Math.cos(t * 4.0) * 0.025, 0.1);
      } else if (emotion === 'surprised') {
        // Recul brusque de surprise de la tête et inclinaison vers le haut
        targetRotX = THREE.MathUtils.lerp(targetRotX, -0.25 - mouseY, 0.1);
        targetRotZ = THREE.MathUtils.lerp(headGroupRef.current.rotation.z, Math.sin(t * 10) * 0.01, 0.1);
        headY += 0.025; // Tête étirée
        headZOffset -= 0.05; // Recul
      } else {
        targetRotZ = THREE.MathUtils.lerp(headGroupRef.current.rotation.z, 0, 0.1);
      }

      // Appliquer les transformations au Groupe Tête (tout bouge et pivote en parfait accord autour du pivot naturel)
      headGroupRef.current.position.set(
        headCenter.x,
        headCenter.y + headY,
        headCenter.z + headZOffset
      );
      headGroupRef.current.rotation.set(targetRotX, targetRotY, targetRotZ);
    }

    // 3. Animation des Yeux LED (Expressions d'émotion + Clignotement + Parole + Micro-saccades de veille)
    if (visorMaterialRef.current) {
      // Clignotement naturel toutes les 4.2 secondes
      const isBlinking = t % 4.2 < 0.15;
      
      // A. Taille verticale des yeux
      let targetScaleY = isBlinking ? 0.02 : emoStyle.eyeScaleY;
      
      // Respiration des yeux (micro-pulsation de veille) : oscillation subtile à ~0.38Hz
      if (!isBlinking) {
        targetScaleY += Math.sin(t * 2.4) * 0.018;
      }

      // Effet de parole : si Eve parle, ses yeux oscillent légèrement en hauteur au rythme de sa voix
      if (isSpeaking && !isBlinking) {
        targetScaleY += Math.sin(t * 18) * 0.08;
      }

      // B. Position des yeux (micro-saccades autonomes de veille + émotions)
      let targetEyeOffsetY = 0;
      let targetEyeOffsetX = 0;

      if (emotion === 'surprised') {
        targetEyeOffsetY = 0.05;
      } else if (emotion === 'sad') {
        targetEyeOffsetY = -0.04;
      } else if (emotion === 'thinking') {
        // Balayage lent et pensif
        targetEyeOffsetY = Math.sin(t * 2.6) * 0.025;
        targetEyeOffsetX = Math.cos(t * 1.8) * 0.04;
        // Pulsation LED de calcul intense : les yeux vibrent légèrement en taille à haute fréquence (15 rad/s)
        if (!isBlinking) {
          targetScaleY += Math.sin(t * 15.0) * 0.05;
        }
      } else {
        // Mode veille standard : génération de micro-saccades oculaires pseudo-aléatoires toutes les 2.8 secondes
        const saccadeCycle = Math.floor(t * 0.35); // change toutes les ~2.8s
        
        // Micro-saccades horizontales et verticales basées sur des fréquences non harmoniques
        const rawSaccadeX = Math.sin(saccadeCycle * 17.31 + 2.5) * Math.cos(saccadeCycle * 7.89);
        const rawSaccadeY = Math.cos(saccadeCycle * 13.17 - 1.2) * Math.sin(saccadeCycle * 5.43);
        
        // Limitation des décalages pour garder un aspect centré et naturel
        targetEyeOffsetX = rawSaccadeX * 0.045; // max ±0.045
        targetEyeOffsetY = rawSaccadeY * 0.025; // max ±0.025
        
        // Ajout d'une très légère dérive continue (bruit oculaire de veille)
        targetEyeOffsetX += Math.sin(t * 0.8) * 0.008;
        targetEyeOffsetY += Math.cos(t * 0.5) * 0.005;
      }

      visorMaterialRef.current.uniforms.eyeColor.value.set(emoStyle.eyeColor);
      visorMaterialRef.current.uniforms.eyeScaleY.value = targetScaleY;
      visorMaterialRef.current.uniforms.eyeRotation.value = emoStyle.eyeRotation;
      visorMaterialRef.current.uniforms.eyeOffsetX.value = targetEyeOffsetX;
      visorMaterialRef.current.uniforms.eyeOffsetY.value = targetEyeOffsetY;
      visorMaterialRef.current.uniforms.speakingPulse.value = isSpeaking ? 0.025 : 0;

      // Mise à jour des uniforms uTime et de la valeur de transition de réflexion
      visorMaterialRef.current.uniforms.uTime.value = t;
      let targetThinkingVal = emotion === 'thinking' ? 1.0 : 0.0;
      visorMaterialRef.current.uniforms.thinkingVal.value = THREE.MathUtils.lerp(
        visorMaterialRef.current.uniforms.thinkingVal.value,
        targetThinkingVal,
        0.08
      );
    }

    // 4. Animation dynamique des bras (déformation vertex organique selon l'émotion et la parole)
    if (mainBodyMeshRef.current && mainBodyBasePositionsRef.current) {
      const geometry = mainBodyMeshRef.current.geometry;
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const base = mainBodyBasePositionsRef.current;

      for (let i = 0; i < position.count; i += 1) {
        const index = i * 3;
        const baseX = base[index];
        const baseY = base[index + 1];
        const baseZ = base[index + 2];
        const isArmRegion = Math.abs(baseX) > 2.05 && baseY > 1.0 && baseY < 6.25;

        if (isArmRegion) {
          const side = Math.sign(baseX);
          const shoulderFalloff = THREE.MathUtils.clamp((6.25 - baseY) / 4.8, 0, 1);
          const offset = getEmotionalArmOffset(side, shoulderFalloff, t, emotion, isSpeaking);
          position.setXYZ(
            i,
            baseX + offset.dx,
            baseY + offset.dy,
            baseZ + offset.dz
          );
        } else {
          position.setXYZ(i, baseX, baseY, baseZ);
        }
      }

      position.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    if (armsRef.current.length > 0) {
      armsRef.current.forEach((mesh) => {
        // Neutralize global transformation to let vertex deformation do the work perfectly in the same coordinate space
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);

        const base = mesh.userData.basePositions as Float32Array;
        if (!base) return;

        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position') as THREE.BufferAttribute;

        for (let i = 0; i < position.count; i += 1) {
          const index = i * 3;
          const baseX = base[index];
          const baseY = base[index + 1];
          const baseZ = base[index + 2];
          const isArmRegion = Math.abs(baseX) > 2.05 && baseY > 1.0 && baseY < 6.25;

          if (isArmRegion) {
            const side = Math.sign(baseX);
            const shoulderFalloff = THREE.MathUtils.clamp((6.25 - baseY) / 4.8, 0, 1);
            const offset = getEmotionalArmOffset(side, shoulderFalloff, t, emotion, isSpeaking);
            position.setXYZ(
              i,
              baseX + offset.dx,
              baseY + offset.dy,
              baseZ + offset.dz
            );
          } else {
            position.setXYZ(i, baseX, baseY, baseZ);
          }
        }

        position.needsUpdate = true;
        geometry.computeVertexNormals();
      });
    }

  });

  return (
    <group ref={modelRef} scale={1.0} position={[0, -0.28, 0]}>
      <primitive object={clonedObj} />
    </group>
  );
};
