# Asset attribution

Every third-party asset served from `public/` is listed here with its source
and licence. `scripts/fetch-assets.py` downloads and processes the files; the
processed results are committed.

| Path | Source | Licence | Processing |
|---|---|---|---|
| `environment/sky.hdr` | [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) by Greg Zaal, Poly Haven, 2K | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Sun capped to luminance 12 so its energy comes from the scene's directional light |
| `textures/terrain/rough_*.jpg` | [Grass004](https://ambientcg.com/view?id=Grass004), ambientCG, 1K | CC0 1.0 | Colour turned into a mean-normalised linear detail map; NormalGL kept |
| `textures/terrain/fairway_*.jpg` | [Grass005](https://ambientcg.com/view?id=Grass005), ambientCG, 1K | CC0 1.0 | As above |
| `textures/terrain/green_*.jpg` | [Grass008](https://ambientcg.com/view?id=Grass008), ambientCG, 1K | CC0 1.0 | As above |
| `textures/terrain/sand_*.jpg` | [Ground101](https://ambientcg.com/view?id=Ground101), ambientCG, 1K | CC0 1.0 | As above |
| `models/*.glb` | Kenney Nature Kit; see `models/LICENSE.md` | CC0 1.0 | Unmodified |
