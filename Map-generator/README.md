# Map Generator

Simple portal that takes a full address and generates a designed 4:5 neighborhood map image.

## Stack

- Geocoding + static basemap: Mapbox
- Nearby POIs: Overpass / OpenStreetMap
- Image composition: Sharp + SVG overlay
- UI: simple static HTML/CSS/JS

## Setup

1. Copy `.env.example` to `.env`
2. Set `MAPBOX_ACCESS_TOKEN`
3. Install dependencies:

```bash
npm install
```

4. Run:

```bash
npm run dev
```

5. Open:

```text
http://localhost:5173
```
