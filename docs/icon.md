# The icon

<img src="../console/src/icon.svg" alt="" width="96">

StreamLine's icon is a current flowing past a record: cream streamlines bend
around a vinyl record with a peach label and climb across a black disc at 30
degrees. The name, drawn literally.

`console/src/icon.svg` is the one drawing. Everything else derives from it:

| Where | How |
|---|---|
| Device console, bridge console, WebFlasher | `vite.config.ts` inlines it as each page's favicon, and each page sets it before its name. |
| Home Assistant app | `make tools-icons` renders `ha-addon/icon.png` (128 px) and `ha-addon/logo.png` (250 px) with resvg. Run it after changing the drawing and commit what it writes. |
| README | Shows the SVG. |

## The drawing

The lines are true streamlines of uniform flow past a cylinder, where the
stream function `ψ = y (1 − a² / r²)` holds a constant value. The cylinder has
`a = 18` around a record of radius 14, and the lines sit at `ψ = 6, 17, 31`.
Each line is a chain of cubic Béziers through points on the curve, with the
curve's own slope at every point, rounded to 0.1 units. The lower half
mirrors the upper one.

The SVG holds the colors: a vinyl-black disc and record, cream streamlines,
and a peach label. The icon keeps them in both console themes; on a dark
page the disc's edge is faint, and the streamlines carry the shape.
