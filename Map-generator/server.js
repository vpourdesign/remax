import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import sharp from "sharp";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 5173);
const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || "";
const publicDir = path.join(__dirname, "public");
const outputDir = path.join(__dirname, "output");
const crystalLogoPath = path.join(__dirname, "logo-crystal.png");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/output", express.static(outputDir));

app.post("/api/generate-map", async (req, res) => {
  try {
    if (!mapboxToken) {
      return res.status(500).json({ error: "MAPBOX_ACCESS_TOKEN is missing." });
    }

    const address = String(req.body?.address || "").trim();
    const selectedPoiIds = Array.isArray(req.body?.selectedPoiIds)
      ? req.body.selectedPoiIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (!address) {
      return res.status(400).json({ error: "Address is required." });
    }

    await fs.mkdir(outputDir, { recursive: true });

    const place = await geocodeAddress(address);
    const pois = await fetchNearbyPois(place.center.lat, place.center.lon);
    const availablePois = buildAvailablePois(pois, place.center);
    const styledPois = selectedPoiIds.length
      ? selectPoisByIds(availablePois, selectedPoiIds)
      : selectFeaturedPois(availablePois);
    const zoom = computeFittingZoom({
      center: place.center,
      points: styledPois.map((poi) => ({ lat: poi.lat, lon: poi.lon })),
      width: 1000,
      height: 1250,
      padding: 180
    });

    const mapBuffer = await fetchMapImage({
      center: place.center,
      zoom,
      width: 1000,
      height: 1250
    });

    const composed = await composeNeighborhoodMap({
      mapBuffer,
      place,
      pois: styledPois,
      zoom,
      width: 1000,
      height: 1250
    });

    const slug = slugify(address);
    const fileName = `${Date.now()}-${slug}.png`;
    const filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, composed);

    res.json({
      ok: true,
      address: place.placeName,
      imageUrl: `/output/${fileName}`,
      pois: styledPois,
      availablePois,
      selectedPoiIds: styledPois.map((poi) => poi.id)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Map generation failed." });
  }
});

app.listen(port, () => {
  console.log(`Map Generator running on http://localhost:${port}`);
});

async function geocodeAddress(address) {
  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`);
  url.searchParams.set("limit", "1");
  url.searchParams.set("language", "fr");
  url.searchParams.set("access_token", mapboxToken);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Mapbox geocoding failed (${response.status}).`);
  }

  const data = await response.json();
  const feature = data.features?.[0];
  if (!feature) {
    throw new Error("Address not found.");
  }

  return {
    placeName: feature.place_name_fr || feature.place_name,
    displayTitle: buildDisplayTitle(feature),
    center: {
      lon: feature.center[0],
      lat: feature.center[1]
    }
  };
}

async function fetchNearbyPois(lat, lon) {
  const query = `
[out:json][timeout:25];
(
  node(around:1800,${lat},${lon})["leisure"="park"];
  way(around:1800,${lat},${lon})["leisure"="park"];
  relation(around:1800,${lat},${lon})["leisure"="park"];

  node(around:2200,${lat},${lon})["amenity"="school"];
  way(around:2200,${lat},${lon})["amenity"="school"];
  relation(around:2200,${lat},${lon})["amenity"="school"];

  node(around:2500,${lat},${lon})["shop"~"supermarket|mall|department_store|convenience|bakery|retail"];
  way(around:2500,${lat},${lon})["shop"~"supermarket|mall|department_store|convenience|bakery|retail"];
  relation(around:2500,${lat},${lon})["shop"~"supermarket|mall|department_store|convenience|bakery|retail"];
  node(around:2500,${lat},${lon})["amenity"="marketplace"];
  way(around:2500,${lat},${lon})["amenity"="marketplace"];
  relation(around:2500,${lat},${lon})["amenity"="marketplace"];
);
out center tags;
`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8"
    },
    body: query
  });

  if (!response.ok) {
    throw new Error(`Overpass POI lookup failed (${response.status}).`);
  }

  const data = await response.json();
  return (data.elements || []).map((element) => {
    const poiLat = element.lat ?? element.center?.lat;
    const poiLon = element.lon ?? element.center?.lon;
    const tags = element.tags || {};

    return {
      lat: poiLat,
      lon: poiLon,
      name: tags.name || inferPoiLabel(tags),
      tags
    };
  }).filter((poi) => Number.isFinite(poi.lat) && Number.isFinite(poi.lon));
}

function buildAvailablePois(rawPois, center) {
  const categorized = rawPois.map((poi) => ({
    ...poi,
    id: buildPoiId(poi),
    category: resolvePoiCategory(poi.tags),
    distanceKm: haversineKm(center.lat, center.lon, poi.lat, poi.lon),
    importanceScore: poiImportanceScore(poi, center)
  })).filter((poi) => poi.category);

  const deduped = [];
  for (const poi of categorized.sort((a, b) => a.distanceKm - b.distanceKm)) {
    const duplicate = deduped.some((item) =>
      item.category === poi.category &&
      item.name.toLowerCase() === poi.name.toLowerCase()
    );
    if (!duplicate) deduped.push(poi);
  }

  const categoryOrder = ["park", "school", "shop"];
  return categoryOrder.flatMap((category) =>
    deduped
      .filter((poi) => poi.category === category)
      .sort((a, b) => {
        if (b.importanceScore !== a.importanceScore) return b.importanceScore - a.importanceScore;
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, category === "shop" ? 8 : 6)
  );
}

function selectFeaturedPois(availablePois) {
  const categoryOrder = ["park", "school", "shop"];
  const picked = [];

  for (const category of categoryOrder) {
    const subset = availablePois
      .filter((poi) => poi.category === category)
      .sort((a, b) => {
        if (category === "shop" && b.importanceScore !== a.importanceScore) {
          return b.importanceScore - a.importanceScore;
        }
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, 8);

    for (const poi of subset) {
      const tooClose = picked.some((existing) => haversineKm(existing.lat, existing.lon, poi.lat, poi.lon) < 0.18);
      if (!tooClose) picked.push(poi);
      if (picked.filter((item) => item.category === category).length >= 3) break;
    }
  }

  return picked.slice(0, 9);
}

function selectPoisByIds(availablePois, selectedPoiIds) {
  const idSet = new Set(selectedPoiIds);
  return availablePois
    .filter((poi) => idSet.has(poi.id))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 12);
}

function resolvePoiCategory(tags) {
  if (tags.leisure === "park") return "park";
  if (tags.amenity === "school") return "school";
  if (tags.shop || tags.amenity === "marketplace") return "shop";
  return null;
}

function inferPoiLabel(tags) {
  if (tags.leisure === "park") return "Parc";
  if (tags.amenity === "school") return "École";
  if (tags.shop || tags.amenity === "marketplace") return "Commerce";
  return "Point d'intérêt";
}

function poiImportanceScore(poi) {
  const category = resolvePoiCategory(poi.tags);
  if (category !== "shop") {
    return Number((10 - Math.min(poi.distanceKm || 0, 9)).toFixed(3));
  }

  const name = String(poi.name || "").toLowerCase();
  const shop = String(poi.tags?.shop || "").toLowerCase();
  const amenity = String(poi.tags?.amenity || "").toLowerCase();
  let score = 0;

  if (shop === "mall" || shop === "department_store" || amenity === "marketplace") score += 12;
  if (shop === "supermarket") score += 10;
  if (shop === "retail") score += 8;
  if (shop === "bakery") score += 5;
  if (shop === "convenience") score += 3;

  if (/(place|centre|center|plaza|galeries|carrefour|promenades|marché|marche)/i.test(name)) score += 9;
  if (/(iga|metro|walmart|costco|maxi|super c|provigo|place rosemere|place ros[eè]mere)/i.test(name)) score += 8;

  score += Math.max(0, 6 - (poi.distanceKm || 0) * 2.2);
  return Number(score.toFixed(3));
}

function buildPoiId(poi) {
  return crypto
    .createHash("sha1")
    .update(`${poi.name}|${poi.lat.toFixed(5)}|${poi.lon.toFixed(5)}|${resolvePoiCategory(poi.tags) || ""}`)
    .digest("hex")
    .slice(0, 12);
}

async function fetchMapImage({ center, zoom, width, height }) {
  const styleId = "light-v11";
  const url = `https://api.mapbox.com/styles/v1/mapbox/${styleId}/static/${center.lon},${center.lat},${zoom},0/${width}x${height}?access_token=${encodeURIComponent(mapboxToken)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mapbox static map failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function composeNeighborhoodMap({ mapBuffer, place, pois, zoom, width, height }) {
  const overlay = buildOverlaySvg({ place, pois, zoom, width, height });
  const composites = [{ input: Buffer.from(overlay), top: 0, left: 0 }];

  if (existsSync(crystalLogoPath)) {
    const logoBadge = await buildCrystalLogoBuffer();
    if (logoBadge) {
      composites.push({
        input: logoBadge,
        left: 48,
        top: height - 66
      });
    }
  }

  return sharp(mapBuffer).composite(composites).png().toBuffer();
}

async function buildCrystalLogoBuffer() {
  try {
    const logoImage = sharp(crystalLogoPath);
    const logoMeta = await logoImage.metadata();
    const width = Number(logoMeta.width) || 1005;
    const height = Number(logoMeta.height) || 162;
    const croppedHeight = Math.max(1, Math.min(height, Math.floor(height * 0.8)));

    return await sharp(crystalLogoPath)
      .extract({
        left: 0,
        top: 0,
        width,
        height: croppedHeight
      })
      .trim({ threshold: 24 })
      .resize({ width: 170, height: 42, fit: "contain", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (error) {
    console.warn("Logo crop fallback:", error.message);
    try {
      return await sharp(crystalLogoPath)
        .trim({ threshold: 24 })
        .resize({ width: 170, height: 42, fit: "contain", withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch (fallbackError) {
      console.warn("Logo processing skipped:", fallbackError.message);
      return null;
    }
  }
}

function buildOverlaySvg({ place, pois, zoom, width, height }) {
  const bgNoiseId = crypto.randomUUID().replace(/-/g, "");
  const categories = {
    park: { label: "Parcs", color: "#2F8F62", icon: "tree" },
    school: { label: "Écoles", color: "#3D6DDB", icon: "school" },
    shop: { label: "Commerces", color: "#F18C38", icon: "shop" }
  };
  const homeProjected = projectPoint({
    lat: place.center.lat,
    lon: place.center.lon,
    centerLat: place.center.lat,
    centerLon: place.center.lon,
    zoom,
    width,
    height
  });

  const pointLayouts = layoutPoiCallouts(
    pois.map((poi) => {
      const projected = projectPoint({
        lat: poi.lat,
        lon: poi.lon,
        centerLat: place.center.lat,
        centerLon: place.center.lon,
        zoom,
        width,
        height
      });
      const label = poi.name.length > 26 ? `${poi.name.slice(0, 24)}…` : poi.name;
      return {
        ...poi,
        projected,
        label
      };
    }),
    width,
    height
  );

  const markers = pointLayouts.map((poi) => {
    const projected = poi.projected;
    const x = projected.x;
    const y = projected.y;
    const style = categories[poi.category];
    const icon = renderIcon(style.icon, style.color);
    if (!poi.box) {
      return `
        <g transform="translate(${x - 17},${y - 17})">
          ${icon}
        </g>
      `;
    }
    const label = escapeXml(poi.label);
    const labelWidth = poi.box.width;
    const labelHeight = poi.box.height;
    const labelX = poi.box.x;
    const labelY = poi.box.y;
    const anchor = getLabelAnchor({ x, y, labelX, labelY, labelWidth, labelHeight });

    return `
      <g>
        <line x1="${x}" y1="${y}" x2="${anchor.x}" y2="${anchor.y}" stroke="${style.color}" stroke-width="2" stroke-linecap="round" opacity="0.88"/>
        <g transform="translate(${x - 17},${y - 17})">
          ${icon}
        </g>
        <g transform="translate(${labelX},${labelY})">
          <rect width="${labelWidth}" height="${labelHeight}" rx="19" fill="rgba(9,18,30,0.86)" stroke="rgba(255,255,255,0.16)"/>
          <text x="18" y="25" fill="#F5F8FF" font-size="16" font-family="system-ui, sans-serif" font-weight="700">${label}</text>
        </g>
      </g>
    `;
  }).join("");
  const homeMarker = `
    <g transform="translate(${homeProjected.x - 22},${homeProjected.y - 54})">
      <path d="M22 0C12.6 0 5 7.6 5 17c0 12.8 14.8 28.5 16.2 30a1.1 1.1 0 0 0 1.6 0C24.2 45.5 39 29.8 39 17 39 7.6 31.4 0 22 0Z" fill="#E54B4B"/>
      <circle cx="22" cy="17" r="10.5" fill="#FFFFFF"/>
      <path d="M16 18.2h12v8.8H16z" fill="#E54B4B"/>
      <path d="M14.6 17.6 22 11l7.4 6.6" fill="none" stroke="#E54B4B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M20 27v-4.5h4V27" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  `;

  const summary = buildCategorySummary(pois, categories);
  const addressTitle = escapeXml(place.displayTitle || place.placeName);
  const titleWidth = estimateTextWidth(addressTitle, 28, 0.58);
  const panelWidth = Math.max(390, Math.min(width - 96, titleWidth + 104));
  const panelHeight = 162;

  return `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="rgba(5,12,22,0.35)"/>
      </filter>
      <filter id="${bgNoiseId}">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="saturate" values="0"/>
        <feComponentTransfer>
          <feFuncA type="table" tableValues="0 0.04"/>
        </feComponentTransfer>
      </filter>
      <linearGradient id="heroFade" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(7,20,34,0.72)"/>
        <stop offset="100%" stop-color="rgba(7,20,34,0.18)"/>
      </linearGradient>
      <linearGradient id="footerFade" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="rgba(7,20,34,0.82)"/>
        <stop offset="100%" stop-color="rgba(7,20,34,0.20)"/>
      </linearGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#heroFade)"/>
    <rect width="${width}" height="${height}" filter="url(#${bgNoiseId})"/>

    <g filter="url(#shadow)">
      <rect x="48" y="48" width="${panelWidth}" height="${panelHeight}" rx="34" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.22)"/>
      <text x="82" y="103" fill="#D8E8FF" font-size="23" font-family="system-ui, sans-serif" font-weight="700" letter-spacing="2">Attraits à proximité</text>
      <text x="82" y="145" fill="#FFFFFF" font-size="28" font-family="system-ui, sans-serif" font-weight="700">${addressTitle}</text>
    </g>

    ${markers}
    ${homeMarker}

    <g filter="url(#shadow)">
      <rect x="48" y="${height - 278}" width="${width - 96}" height="176" rx="30" fill="url(#footerFade)" stroke="rgba(255,255,255,0.16)"/>
      ${summary}
    </g>
  </svg>`;
}

function buildCategorySummary(pois, categories) {
  const order = ["park", "school", "shop"];
  const columnX = [94, 392, 690];
  const maxTextWidth = 210;
  return order.map((key, index) => {
    const items = pois.filter((poi) => poi.category === key).slice(0, 3);
    const x = columnX[index] || 82 + index * 294;
    const style = categories[key];
    const list = items.map((poi, i) => {
      const y = 44 + i * 28;
      const distance = `${poi.distanceKm.toFixed(1)} km`;
      const line = fitLegendText(`${poi.name} · ${distance}`, maxTextWidth, 18);
      return `
        <text x="${x + 34}" y="${1028 + y}" fill="#E8F0FF" font-size="18" font-family="system-ui, sans-serif">${escapeXml(line)}</text>
      `;
    }).join("");

    return `
      <g>
        <circle cx="${x + 12}" cy="998" r="12" fill="${style.color}"/>
        <text x="${x + 34}" y="1005" fill="#FFFFFF" font-size="22" font-family="system-ui, sans-serif" font-weight="700">${style.label}</text>
        ${list}
      </g>
    `;
  }).join("");
}

function layoutPoiCallouts(points, width, height) {
  const placed = [];
  const sorted = [...points].sort((a, b) => a.distanceKm - b.distanceKm);
  const iconZones = sorted.map((point) => ({
    x: point.projected.x - 24,
    y: point.projected.y - 24,
    width: 48,
    height: 48,
    point
  }));
  const reservedZones = [
    { x: 40, y: 40, width: 520, height: 190 },
    { x: 40, y: height - 284, width: width - 80, height: 186 },
    { x: 40, y: height - 96, width: 240, height: 70 }
  ];
  const attempts = [
    { dx: 8, dy: -50 },
    { dx: -176, dy: -50 },
    { dx: 8, dy: 16 },
    { dx: -176, dy: 16 },
    { dx: 14, dy: -88 },
    { dx: -188, dy: -88 },
    { dx: 14, dy: 48 },
    { dx: -188, dy: 48 },
    { dx: 22, dy: -118 },
    { dx: -198, dy: -118 },
    { dx: 22, dy: 78 },
    { dx: -198, dy: 78 }
  ];

  return sorted.map((point) => {
    const boxWidth = Math.max(118, Math.min(232, estimateTextWidth(point.label, 16, 0.56) + 34));
    const boxHeight = 38;
    let best = null;

    for (const attempt of attempts) {
      const candidate = {
        x: clamp(point.projected.x + attempt.dx, 24, width - boxWidth - 24),
        y: clamp(point.projected.y + attempt.dy, 180, height - 310 - boxHeight)
      };
      const rect = { x: candidate.x, y: candidate.y, width: boxWidth, height: boxHeight };
      const overlapsPlaced = placed.some((other) => rectsOverlap(rect, other));
      const overlapsReserved = reservedZones.some((zone) => rectsOverlap(rect, zone));
      const overlapsIcons = iconZones.some((zone) => zone.point !== point && rectsOverlap(rect, zone, 10));
      if (!overlapsPlaced && !overlapsReserved && !overlapsIcons) {
        best = candidate;
        break;
      }
    }
    if (!best) {
      return { ...point, box: null };
    }

    const rect = { x: best.x, y: best.y, width: boxWidth, height: boxHeight };
    placed.push(rect);
    return { ...point, box: rect };
  });
}

function rectsOverlap(a, b, inset = 0) {
  return !(
    a.x + a.width + inset < b.x ||
    b.x + b.width + inset < a.x ||
    a.y + a.height + inset < b.y ||
    b.y + b.height + inset < a.y
  );
}

function getLabelAnchor({ x, y, labelX, labelY, labelWidth, labelHeight }) {
  const centerX = labelX + labelWidth / 2;
  const centerY = labelY + labelHeight / 2;
  const dx = x - centerX;
  const dy = y - centerY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return {
      x: dx > 0 ? labelX + labelWidth : labelX,
      y: clamp(y, labelY + 8, labelY + labelHeight - 8)
    };
  }

  return {
    x: clamp(x, labelX + 16, labelX + labelWidth - 16),
    y: dy > 0 ? labelY + labelHeight : labelY
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimateTextWidth(text, fontSize, ratio = 0.58) {
  return Math.ceil(String(text || "").length * fontSize * ratio);
}

function fitLegendText(text, maxWidth, fontSize) {
  const source = String(text || "").trim();
  if (!source) return "";
  if (estimateTextWidth(source, fontSize, 0.52) <= maxWidth) return source;

  let value = source;
  while (value.length > 1 && estimateTextWidth(`${value}…`, fontSize, 0.52) > maxWidth) {
    value = value.slice(0, -1).trimEnd();
  }
  return `${value}…`;
}

function buildDisplayTitle(feature) {
  const raw = String(feature.place_name_fr || feature.place_name || "").trim();
  const withoutCountry = raw.split(",").slice(0, 3).join(",").trim();
  const noPostal = withoutCountry.replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, "").replace(/\s+,/g, ",");

  const addressNumber = String(feature.address || feature.properties?.address || "").trim();
  const street = String(feature.text_fr || feature.text || "").trim();
  const cityContext = (feature.context || []).find((item) => item.id?.startsWith("place."));
  const city = String(cityContext?.text_fr || cityContext?.text || "").trim();
  const streetLine = [addressNumber, street].filter(Boolean).join(" ").trim();

  if (streetLine && city) {
    return `${streetLine}, ${city}`;
  }

  return noPostal.split(",").slice(0, 2).join(",").trim();
}

function renderIcon(type, color) {
  if (type === "tree") {
    return `
      <circle cx="17" cy="17" r="17" fill="${color}"/>
      <path d="M17 8L23 16H20L24 22H10L14 16H11L17 8Z" fill="#FFFFFF"/>
      <rect x="15.2" y="22" width="3.6" height="6" rx="1.8" fill="#FFFFFF"/>
    `;
  }
  if (type === "school") {
    return `
      <circle cx="17" cy="17" r="17" fill="${color}"/>
      <path d="M17 9L25 13.3L17 17.5L9 13.3L17 9Z" fill="#FFFFFF"/>
      <path d="M12 18.4V22.5C12 24.2 14.3 25.5 17 25.5C19.7 25.5 22 24.2 22 22.5V18.4L17 21.2L12 18.4Z" fill="#FFFFFF"/>
    `;
  }
  return `
    <circle cx="17" cy="17" r="17" fill="${color}"/>
    <path d="M10 14.5H24V24H10V14.5Z" fill="#FFFFFF"/>
    <path d="M13 11.5H21V14.5H13V11.5Z" fill="#FFFFFF"/>
    <path d="M14.4 18.2H19.6V24H14.4V18.2Z" fill="${color}"/>
  `;
}

function computeFittingZoom({ center, points, width, height, padding }) {
  if (!points.length) return 14.6;
  for (let zoom = 16.5; zoom >= 11; zoom -= 0.2) {
    const allFit = points.every((point) => {
      const projected = projectPoint({
        lat: point.lat,
        lon: point.lon,
        centerLat: center.lat,
        centerLon: center.lon,
        zoom,
        width,
        height
      });
      return projected.x > padding && projected.x < width - padding && projected.y > padding && projected.y < height - padding;
    });
    if (allFit) return Number(zoom.toFixed(1));
  }
  return 11.5;
}

function projectPoint({ lat, lon, centerLat, centerLon, zoom, width, height }) {
  const scale = 512 * Math.pow(2, zoom);
  const point = mercatorProject(lat, lon, scale);
  const center = mercatorProject(centerLat, centerLon, scale);
  return {
    x: width / 2 + (point.x - center.x),
    y: height / 2 + (point.y - center.y)
  };
}

function mercatorProject(lat, lon, scale) {
  const x = ((lon + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
