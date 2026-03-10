import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// --- paths helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Projet root = remax-ai-builder/
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Static UI
app.use(express.static(path.join(__dirname, "public")));

// --- Global paths ---
const BROKERS_DIR = path.join(PROJECT_ROOT, "brokers");
const SITES_DIR = path.join(PROJECT_ROOT, "sites");

fs.mkdirSync(BROKERS_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });

// --- Helpers ---
function slugifyBrokerName(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function getBrokerPaths(brokerId) {
  const brokerDir = path.join(BROKERS_DIR, brokerId);
  const profilePath = path.join(brokerDir, "profile.json");
  const assetsDir = path.join(brokerDir, "assets");

  return { brokerDir, profilePath, assetsDir };
}

function ensureBrokerExists(brokerId) {
  const { brokerDir, profilePath, assetsDir } = getBrokerPaths(brokerId);

  fs.mkdirSync(brokerDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  if (!fs.existsSync(profilePath)) {
    const defaultProfile = {
      name: "",
      brand: "RE/MAX Crystal",
      city: "",
      territories: [],
      languages: ["fr", "en"],
      style: "modern",
      palette: {
        primary: "#D71920",
        secondary: "#1C1C1C"
      },
      services: ["achat", "vente", "investissement"],
      bio: "",
      testimonials: [],
      photos: [],
      logo: ""
    };

    fs.writeFileSync(profilePath, JSON.stringify(defaultProfile, null, 2), "utf8");
  }

  return { brokerDir, profilePath, assetsDir };
}

function readProfile(brokerId) {
  const { profilePath } = ensureBrokerExists(brokerId);

  if (!fs.existsSync(profilePath)) {
    throw new Error(`profile.json introuvable: ${profilePath}`);
  }

  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
}

function writeProfile(brokerId, profile) {
  const { profilePath } = ensureBrokerExists(brokerId);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
}

function safeExt(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
  return allowed.has(ext) ? ext : "";
}

// --- Multer storage (dynamic broker) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const brokerId = req.body.brokerId;
    if (!brokerId) return cb(new Error("brokerId manquant"));

    const { assetsDir } = ensureBrokerExists(brokerId);
    cb(null, assetsDir);
  },
  filename: function (req, file, cb) {
    const ext = safeExt(file.originalname);
    if (!ext) return cb(new Error("Type de fichier non supporté. (png/jpg/webp/svg)"));

    const kind = (req.body.kind || "photo").toLowerCase();
    const stamp = Date.now();
    const base = kind === "logo" ? "logo" : "photo";

    cb(null, `${base}_${stamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ================================
// CREATE BROKER
// ================================
app.post("/api/create-broker", (req, res) => {
  try {
    const { name } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: "Nom requis." });
    }

    const brokerId = slugifyBrokerName(name);
    ensureBrokerExists(brokerId);

    const profile = readProfile(brokerId);
    profile.name = name.trim();
    writeProfile(brokerId, profile);

    res.json({ ok: true, brokerId, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================================
// PROFILE
// ================================
app.get("/api/profile/:brokerId", (req, res) => {
  try {
    const brokerId = req.params.brokerId;
    const profile = readProfile(brokerId);
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/profile/update/:brokerId", (req, res) => {
  try {
    const brokerId = req.params.brokerId;
    const profile = req.body;
    writeProfile(brokerId, profile);
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================================
// UPLOAD
// ================================
app.post("/api/upload", upload.array("files", 10), (req, res) => {
  try {
    const brokerId = req.body.brokerId;
    const kind = (req.body.kind || "photo").toLowerCase();
    const files = req.files || [];

    if (!brokerId) {
      return res.status(400).json({ ok: false, error: "brokerId manquant." });
    }

    if (!files.length) {
      return res.status(400).json({ ok: false, error: "Aucun fichier reçu." });
    }

    const profile = readProfile(brokerId);

    const savedPaths = files.map((f) => `/assets/${brokerId}/${f.filename}`);

    if (kind === "logo") {
      profile.logo = savedPaths[0];
    } else {
      profile.photos = Array.isArray(profile.photos) ? profile.photos : [];
      profile.photos.push(...savedPaths);
    }

    writeProfile(brokerId, profile);

    res.json({ ok: true, kind, saved: savedPaths, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- expose assets ---
app.use("/assets", express.static(BROKERS_DIR));

// ================================
// CHAT PLACEHOLDER
// ================================
app.post("/api/chat", (req, res) => {
  const { message } = req.body || {};

  const reply = message
    ? `OK. J’ai noté: "${message}".`
    : `Écrivez-moi ce que vous voulez sur votre site.`;

  res.json({ ok: true, reply });
});

// ================================
// GENERATE WEBSITE
// ================================
app.post("/api/generate/:brokerId", async (req, res) => {
  try {
    const brokerId = req.params.brokerId;
    const generatorModule = await import(`../scripts/generate-with-claude.js?ts=${Date.now()}`);
    const { generateWithClaude } = generatorModule;

    const result = await generateWithClaude({
      rootDir: PROJECT_ROOT,
      brokerId
    });

    res.json({
      ok: true,
      message: "Site généré avec Claude",
      preview: result.preview
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message || "Erreur génération site"
    });
  }
});

// --- expose sites générés ---
app.use("/sites", express.static(SITES_DIR));

// --- server start ---
const PORT = process.env.PORT || 5050;

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`📁 Brokers dir: ${BROKERS_DIR}`);
  console.log(`🌐 Sites dir: ${SITES_DIR}`);
});
