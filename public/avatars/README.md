Place premium avatar assets here.

Expected files:

- `retrobot-space-explorer.glb` for Nova
- `aegis.glb` for Aegis

The selected Retrobot Space Explorer asset may be distributed as FBX. If so, convert it to GLB before placing it here. Recommended Blender export settings:

- Format: glTF Binary (`.glb`)
- Include: selected object(s), materials, textures, animations
- Transform: +Y up / glTF default
- Compression: optional, only after verifying the model renders correctly

If the file is missing, EveFlow falls back to the existing Eve model.

To activate an installed model, update `avatar-manifest.json` after placing the file here:

```json
{
  "nova": "/avatars/retrobot-space-explorer.glb",
  "aegis": "/avatars/aegis.glb"
}
```
