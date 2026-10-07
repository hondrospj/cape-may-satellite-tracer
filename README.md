# Coastline Studio — Cape May County

A browser-only satellite comparison, shoreline tracing and GIS export app for **October 16, 2025** and **February 28, 2026**. Designed for GitHub Pages, with no accounts, API keys, private data, or backend.

## Use

1. Choose a date and a town, or use **Compare side by side**. Both maps share their center and zoom.
2. Choose **Draw a new line**, click along the shoreline, and double-click or use **Finish line**. Undo a point with the button or Ctrl/Cmd+Z; Esc cancels.
3. Select a line to name it, edit vertices, zoom to it or delete it. Ctrl/Cmd+Z restores the most recently deleted line until reload.
4. Export all lines as GeoJSON, KML or CSV. GeoJSON is the lossless project backup and can be imported again. Traces are stored only in the current browser's local storage.
5. Export the active date's current extent as an annotated PNG, RGBA GeoTIFF, or a PNG + worldfile/projection/metadata ZIP.

On small screens, **Tools** opens the sidebar. Comparison stacks the maps vertically. Pinch and the +/− controls zoom. Geographic exports use WGS 84 longitude, latitude. Raster exports use EPSG:3857; worldfiles locate pixel centers, while GeoTIFF tiepoints locate pixel-area corners. Georeferenced raster exports exclude trace overlays and labels. The annotated PNG is a map illustration, not a georeferenced raster.

## Imagery and limits

`public/data/scenes.json` pins four real Sentinel-2 L2A scene assets from the public Earth Search STAC catalog. The complete returned STAC FeatureCollections are retained beside it. There are two adjacent UTM 18N tiles per day, captured around 16:02 UTC. The app fetches byte ranges of public cloud-optimized true-color GeoTIFFs, streaming just the needed raster blocks rather than downloading full scenes. The About dialog links to original COGs and source scene metadata.

The true-color source has 10 m pixels; extra zoom does not add detail. Displayed and exported map views are reprojected/resampled. Water level, waves, snow/ice, shadows, season and image registration affect the apparent waterline. These traces are manual interpretations and **not surveyed, tide-normalized shorelines or erosion measurements**. Tile-wide cloud percentages describe the full scenes rather than every local pixel. Outside the dated scene footprints, no substitute satellite basemap is shown. Internet and WebGL are required. Source outages are surfaced in the map and prevent exports.

Contains modified Copernicus Sentinel data (2025, 2026), hosted by Element 84 Earth Search.

## Develop and publish

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

Enable GitHub Pages with the GitHub Actions source. `.github/workflows/pages.yml` tests, builds and publishes on pushes to main. The Vite relative base allows a repository subpath. `dist` and local QA files are not committed. No scheduled jobs are needed for these fixed historical dates.

Tests cover source dates, import validation, KML/CSV coordinates, worldfile alignment, and a GeoTIFF color/georeferencing roundtrip. Browser QA also checks actual imagery rendering, comparison, drawing, editing, persistence and file export.
