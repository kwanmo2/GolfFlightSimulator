# Model attribution

All models in this directory are from the [Kenney Nature Kit](https://kenney.nl/assets/nature-kit)
(version 2.1) by Kenney (www.kenney.nl) and are released under the
[Creative Commons CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
license (public domain). The `.glb` files are copied unmodified from the kit's
`Models/GLTF format` folder.

Only the geometry is used: `src/render/assetLibrary.ts` replaces the kit's
materials with vertex colours from `src/render/palette.ts`.

| Files | Role |
|---|---|
| `tree_default.glb`, `tree_oak.glb`, `tree_detailed.glb`, `tree_fat.glb` | Broadleaf trees |
| `tree_pineRoundA.glb`, `tree_pineTallA.glb`, `tree_pineDefaultA.glb` | Conifers |
| `plant_bush.glb`, `plant_bushLarge.glb` | Bushes in front of the tree lines |
| `grass.glb`, `grass_large.glb` | Rough grass clumps |
| `flower_yellowA.glb`, `flower_purpleA.glb` | Wildflowers in the far rough |
