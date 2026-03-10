import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});


function cleanClaudeOutput(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```html\s*/i, "");
  cleaned = cleaned.replace(/^```\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  const htmlStart = cleaned.search(/<!doctype html|<html/i);
  if (htmlStart > 0) {
    cleaned = cleaned.slice(htmlStart);
  }

  // Remove a dangling partial tag if Claude truncates output mid-token.
  const lastOpen = cleaned.lastIndexOf("<");
  const lastClose = cleaned.lastIndexOf(">");
  if (lastOpen > lastClose) {
    cleaned = cleaned.slice(0, lastOpen).trimEnd();
  }

  const hasHtmlOpen = /<html[\s>]/i.test(cleaned);
  const hasBodyOpen = /<body[\s>]/i.test(cleaned);
  const hasBodyClose = /<\/body>/i.test(cleaned);
  const hasHtmlClose = /<\/html>/i.test(cleaned);

  if (hasHtmlOpen && hasBodyOpen && !hasBodyClose) {
    cleaned = `${cleaned}\n</body>`;
  }

  if (hasHtmlOpen && !hasHtmlClose) {
    cleaned = `${cleaned}\n</html>`;
  }

  return cleaned.trim();
}

function stripMalformedOpenTagFragments(htmlText) {
  let source = String(htmlText || "");
  let previous = "";

  while (source !== previous) {
    previous = source;
    source = source.replace(/<[^<>\n]*?(?=<[a-z!/])/gi, "");
  }

  return source;
}

function ensureHtmlDocument(htmlText) {
  const source = String(htmlText || "").trim();
  if (!source) {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Site immobilier</title>
</head>
<body></body>
</html>`;
  }

  const hasHtml = /<html[\s>]/i.test(source);
  const hasHead = /<head[\s>]/i.test(source);
  const hasBody = /<body[\s>]/i.test(source);

  const headMatch = hasHtml && hasHead ? source.match(/<head[^>]*>([\s\S]*?)<\/head>/i) : null;
  const bodyMatch = hasHtml && hasBody ? source.match(/<body[^>]*>([\s\S]*?)<\/body>/i) : null;
  const headSource = headMatch ? headMatch[1] : source;
  const bodySource = bodyMatch ? bodyMatch[1] : source;

  const titles = [...source.matchAll(/<title[^>]*>[\s\S]*?<\/title>/gi)].map((m) => m[0]);
  const metas = [...source.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...source.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const styles = [...source.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]);
  const scripts = [...source.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0]).join("\n");

  const title = titles[0] || "<title>Site immobilier</title>";
  const uniqueHeadParts = [];
  const seenHead = new Set();
  for (const part of [
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    title,
    ...metas,
    ...links,
    ...styles
  ]) {
    const key = String(part).trim();
    if (!key || seenHead.has(key)) continue;
    seenHead.add(key);
    uniqueHeadParts.push(key);
  }

  const stripped = bodySource
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .trim();

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${uniqueHeadParts.join("\n  ")}
</head>
<body>
${stripped}
${scripts}
</body>
</html>`;
}

function validateHtml(html) {
  const required = ["<html", "<head", "<body", "</html>"];
  for (const token of required) {
    if (!html.toLowerCase().includes(token)) {
      throw new Error(`HTML incomplet: balise manquante ${token}`);
    }
  }

  const structuralIssue = detectMalformedHtmlStructure(html);
  if (structuralIssue) {
    throw new Error(structuralIssue);
  }
}

function detectMalformedHtmlStructure(html) {
  const source = String(html || "");
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== "<") continue;
    const nextClose = stripped.indexOf(">", i + 1);
    const nextOpen = stripped.indexOf("<", i + 1);

    if (nextClose === -1) {
      return "HTML malforme: balise non fermee detectee.";
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const fragment = stripped.slice(i, Math.min(nextOpen, i + 80)).replace(/\s+/g, " ").trim();
      return `HTML malforme: balise tronquee detectee (${fragment}).`;
    }
  }

  const tagsToBalance = ["a", "section", "div", "nav", "main", "footer", "form", "button"];
  for (const tag of tagsToBalance) {
    const opens = (stripped.match(new RegExp(`<${tag}(\\s|>)`, "gi")) || []).length;
    const closes = (stripped.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (opens !== closes) {
      return `HTML malforme: balises <${tag}> desequilibrees (${opens} ouvrantes / ${closes} fermantes).`;
    }
  }

  return "";
}

function repairCommonStructuralImbalances(html) {
  let repaired = String(html || "");
  if (!repaired.includes("</body>")) return repaired;
  const structuralTags = new Set(["section", "div", "form", "main", "nav", "footer"]);
  const stack = [];
  const stripped = repaired
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const tagRe = /<\/?([a-z0-9-]+)\b[^>]*>/gi;
  let match;

  while ((match = tagRe.exec(stripped)) !== null) {
    const full = match[0];
    const tag = String(match[1] || "").toLowerCase();
    if (!structuralTags.has(tag)) continue;
    if (/\/>$/.test(full)) continue;

    if (full.startsWith("</")) {
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
      continue;
    }

    stack.push(tag);
  }

  if (!stack.length) return repaired;
  const closers = stack.reverse().map((tag) => `</${tag}>`).join("\n");
  return repaired.replace("</body>", `${closers}\n</body>`);
}

function normalizeHex(hex, fallback = "#000000") {
  const value = String(hex || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return fallback;
}

function isLightColor(hex) {
  const value = normalizeHex(hex);
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance >= 0.92;
}

function findHeroBlock(html) {
  const source = String(html || "");
  const patterns = [
    /<(section|div)[^>]*id=["']hero["'][\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*class=["'][^"']*\bhero\b[^"']*["'][\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*class=["'][^"']*hero[^"']*["'][\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*class=["'][^"']*(hero-text|hero-copy|hero-content|hero-body)[^"']*["'][\s\S]*?<h1[\s\S]*?<\/h1>[\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*>[\s\S]*?<h1[\s\S]*?<\/h1>[\s\S]*?(?:hero-subtitle|hero-description|hero-content|hero-cta)[\s\S]*?<\/\1>/i,
    /<(section|div)[^>]*>[\s\S]*?<h1[\s\S]*?<\/h1>[\s\S]*?<\/\1>/i,
    /<section[^>]*>[\s\S]*?<h1[\s\S]*?<\/h1>[\s\S]*?<\/section>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[0];
  }

  return "";
}

function replaceHeroBlock(html, transform) {
  const heroBlock = findHeroBlock(html);
  if (!heroBlock) return html;
  const nextBlock = transform(heroBlock);
  if (!nextBlock || nextBlock === heroBlock) return html;
  return html.replace(heroBlock, nextBlock);
}

function injectIntoAboveFoldContent(html, marker) {
  const source = String(html || "");
  const patterns = [
    /(<div[^>]*class=["'][^"']*(hero-text|hero-copy|hero-content|hero-body)[^"']*["'][^>]*>)/i,
    /(<section[^>]*id=["']hero["'][^>]*>)/i,
    /(<section[^>]*class=["'][^"']*hero[^"']*["'][^>]*>)/i,
    /(<div[^>]*class=["'][^"']*(intro|banner|masthead)[^"']*["'][^>]*>)/i,
    /(<main[^>]*>)/i,
    /(<body[^>]*>)/i
  ];

  for (const pattern of patterns) {
    if (pattern.test(source)) {
      return source.replace(pattern, `$1\n${marker}`);
    }
  }

  return source;
}

function validateDesignConstraints({ html, primaryColor, territories, brokerName }) {
  const violations = [];
  const primary = normalizeHex(primaryColor, "#d71920");
  const primaryIsLight = isLightColor(primary);
  const source = html.toLowerCase();
  const hasVisualGuard = html.includes('data-generated-guard="visual-v2"');

  const hasGradient = /gradient\s*\(/i.test(html);
  const heroRuleWithWhiteBg = /\.hero[\s\S]{0,800}?background(?:-color)?\s*:\s*#(?:fff|ffffff|f5f5f5|f7f7f7|fafafa)/i.test(html);
  const bodyWhiteBg = /body[\s\S]{0,500}?background(?:-color)?\s*:\s*#(?:fff|ffffff|f5f5f5|f7f7f7|fafafa)/i.test(html);
  const servicesWhiteBg = /(?:\.services|#services|section\.services|section#services)[\s\S]{0,900}?background(?:-color)?\s*:\s*#(?:fff|ffffff|f5f5f5|f7f7f7|fafafa)/i.test(html);
  const heroVeryLightGradient = /\.hero[\s\S]{0,1200}?background[^;]*#(?:e[0-9a-f]{5}|f[0-9a-f]{5})/i.test(html);
  const servicesVeryLightGradient = /(?:\.services|#services|section\.services|section#services)[\s\S]{0,1200}?background[^;]*#(?:e[0-9a-f]{5}|f[0-9a-f]{5})/i.test(html);
  const primaryColorUsed = source.includes(primary);
  const hasContactForm = /<form[^>]+id=["']contact-form["']/i.test(html);
  const hasContactFields = /id=["']cf-name["']|id=["']cf-email["']|id=["']cf-phone["']|id=["']cf-message["']/i.test(html);
  const hasMortgageCalculator = /id=["']mortgage-calculator["']/i.test(html);
  const hasMortgageScript = /function\s+calculateMortgage|id=["']mortgageForm["']/i.test(html);
  const normalizedTerritories = Array.isArray(territories) ? territories.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean) : [];
  const territoryMentions = normalizedTerritories.filter((city) => source.includes(city)).length;
  const hasTerritoriesSection = /#territories|class=["'][^"']*territor/i.test(html);
  const hasSeoLocalLabel = /seo\s+local/i.test(source);
  const hasCrystalFooter = /id=["']footer-crystal["']/i.test(html);
  const hasFooterMenuRecall = /id=["']footer-crystal["'][\s\S]*menu du site|class=["'][^"']*fc-menu[^"']*["']/i.test(source);
  const hasFooterTerritoriesRecall = /id=["']footer-crystal["'][\s\S]*territoires desservis|class=["'][^"']*fc-territories[^"']*["']/i.test(source);
  const safeBrokerName = String(brokerName || "").trim().toLowerCase();
  const heroSource = findHeroBlock(html).toLowerCase();
  const navSectionMatch = html.match(/<nav[\s\S]*?<\/nav>/i);
  const navSource = (navSectionMatch ? navSectionMatch[0] : "").toLowerCase();
  const hasNav = Boolean(navSectionMatch);
  const hasHero = Boolean(findHeroBlock(html));
  const menuLinks = extractTopMenuLinks(html).map((l) => l.href.toLowerCase());
  const hasAboutSection = /id=["']about["']|class=["'][^"']*about[^"']*["']/i.test(html);
  const hasGallerySection = /id=["']gallery["']|class=["'][^"']*gallery[^"']*["']/i.test(html);

  if (!primaryIsLight && heroRuleWithWhiteBg) {
    violations.push("Hero background is white/light instead of primary-color based.");
  }

  if (!primaryIsLight && bodyWhiteBg) {
    violations.push("Body background defaults to white/light.");
  }

  if (!hasGradient) {
    violations.push("No gradients detected in generated CSS.");
  }

  if (!primaryIsLight && !primaryColorUsed) {
    violations.push("Primary color is not visibly used in generated CSS.");
  }

  if (!primaryIsLight && servicesWhiteBg) {
    violations.push("Services section uses a white/light flat background.");
  }

  if (!primaryIsLight && heroVeryLightGradient && !hasVisualGuard) {
    violations.push("Hero uses very light gradient tones instead of primary-led tones.");
  }

  if (!primaryIsLight && servicesVeryLightGradient && !hasVisualGuard) {
    violations.push("Services section uses very light gradient tones.");
  }

  if (!hasContactForm || !hasContactFields) {
    violations.push("Modern contact form is missing.");
  }

  if (!hasNav) {
    violations.push("Navigation is missing.");
  }

  if (!hasHero) {
    violations.push("Hero section is missing.");
  }

  if (!hasTerritoriesSection) {
    violations.push("Territories section layout is missing.");
  }

  if (normalizedTerritories.length && territoryMentions < Math.min(2, normalizedTerritories.length)) {
    violations.push("Territories content does not include selected cities clearly.");
  }

  if (hasSeoLocalLabel) {
    violations.push("Remove any SEO local section/label.");
  }

  if (!hasCrystalFooter || !hasFooterMenuRecall || !hasFooterTerritoriesRecall) {
    violations.push("Structured crystal footer is missing (logo + menu recall + territories).");
  }

  if (!hasMortgageCalculator || !hasMortgageScript) {
    violations.push("Mortgage calculator section is missing.");
  }

  if (safeBrokerName && (!heroSource || !heroSource.includes(safeBrokerName))) {
    violations.push("Broker name must appear in hero text for SEO.");
  }

  if (safeBrokerName && navSource.includes(safeBrokerName)) {
    violations.push("Broker name must not appear beside logo in navigation.");
  }

  if (normalizedTerritories.length) {
    const heroTerritoryMentions = normalizedTerritories.filter((city) => heroSource.includes(city)).length;
    const hasHeroTerritoriesMarker = /class=["'][^"']*hero-territories-line[^"']*["'][^>]*>[\s\S]*?<\/p>/i.test(html);
    if (heroTerritoryMentions < Math.min(2, normalizedTerritories.length) && !hasHeroTerritoriesMarker) {
      violations.push("Hero must include a marketing sentence mentioning served territories.");
    }
  }

  if (menuLinks.includes("#about") && !hasAboutSection) {
    violations.push("About section is referenced in menu but missing in page.");
  }

  if (menuLinks.includes("#gallery") && !hasGallerySection) {
    violations.push("Gallery section is referenced in menu but missing in page.");
  }

  return violations;
}

function hexToRgb(hex) {
  const value = normalizeHex(hex, "#000000");
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16)
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractTopMenuLinks(html) {
  const navMatch = html.match(/<nav[\s\S]*?<\/nav>/i);
  const navHtml = navMatch ? navMatch[0] : html;
  const links = [];
  const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(navHtml)) !== null) {
    const href = String(m[1] || "").trim();
    const label = String(m[2] || "").replace(/<[^>]*>/g, "").trim();
    if (!href || !label) continue;
    if (!href.startsWith("#")) continue;
    links.push({ href, label });
  }

  if (links.length) return links.slice(0, 8);
  return [
    { href: "#services", label: "Services" },
    { href: "#territories", label: "Territoires" },
    { href: "#about", label: "A propos" },
    { href: "#contact", label: "Contact" }
  ];
}

function injectVisualGuardCss(html, { primaryColor, secondaryColor }) {
  if (!html.includes("</head>")) return html;
  if (html.includes("data-generated-guard=\"visual-v2\"")) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const p = hexToRgb(primary);
  const s = hexToRgb(secondary);
  const textColor = isLightColor(primary) ? "#0b0f16" : "#f7f9ff";

  const guardCss = `
<style data-generated-guard="visual-v2">
:root {
  --guard-primary: ${primary};
  --guard-secondary: ${secondary};
  --guard-text: ${textColor};
}

/* Enforce non-flat, non-white opening sections */
.hero,
#hero,
section.hero,
[data-section="hero"],
main > section:first-of-type,
body > section:first-of-type {
  background:
    radial-gradient(circle at 18% 20%, rgba(${p.r}, ${p.g}, ${p.b}, 0.34), transparent 44%),
    radial-gradient(circle at 84% 78%, rgba(${s.r}, ${s.g}, ${s.b}, 0.22), transparent 52%),
    linear-gradient(135deg, var(--guard-primary) 0%, var(--guard-secondary) 115%) !important;
  color: var(--guard-text) !important;
}

.hero + section,
#hero + section,
section.hero + section,
main > section:nth-of-type(2),
body > section:nth-of-type(2),
section#services,
section.services,
.services {
  background:
    radial-gradient(circle at 78% 24%, rgba(${p.r}, ${p.g}, ${p.b}, 0.24), transparent 42%),
    linear-gradient(160deg, rgba(${s.r}, ${s.g}, ${s.b}, 0.92), rgba(${p.r}, ${p.g}, ${p.b}, 0.78)) !important;
  color: #eef3ff !important;
}

/* Keep hero image premium and controlled */
.hero-image,
#hero .hero-image,
.hero__image,
.hero-media {
  max-width: min(46vw, 620px) !important;
  width: 100% !important;
  margin-inline: auto !important;
}

.hero-image img,
#hero .hero-image img,
.hero__image img,
.hero-media img {
  width: 100% !important;
  max-height: min(70vh, 720px) !important;
  object-fit: cover !important;
  border-radius: 20px !important;
}
</style>`;

  return html.replace("</head>", `${guardCss}\n</head>`);
}

function injectAdaptiveNavForDarkLogo(html, { forceLightNav }) {
  if (!html.includes("</body>")) return html;
  if (html.includes('data-generated-guard="nav-contrast-v1"')) return html;

  const block = `
<script data-generated-guard="nav-contrast-v1-script">
(function () {
  const style = document.createElement('style');
  style.setAttribute('data-generated-guard', 'nav-contrast-v1');
  style.textContent = [
    'body.stable-white-nav nav, body.stable-white-nav .nav, body.stable-white-nav header nav, body.stable-white-nav .site-header, body.stable-white-nav .navbar { background: rgba(255, 255, 255, 0.98) !important; border-color: rgba(20, 34, 56, 0.12) !important; color: #0f1f35 !important; box-shadow: 0 10px 32px rgba(15, 31, 53, 0.08) !important; }',
    'body.stable-white-nav nav, body.stable-white-nav .nav, body.stable-white-nav .navbar { top: 0 !important; left: 0 !important; right: 0 !important; margin: 0 !important; width: 100% !important; border-radius: 0 !important; }',
    'body.stable-white-nav nav a, body.stable-white-nav .nav a, body.stable-white-nav .site-header a, body.stable-white-nav .navbar a, body.stable-white-nav nav button, body.stable-white-nav .nav button { color: #0f1f35 !important; }',
    'body.stable-white-nav nav .nav-cta, body.stable-white-nav .nav .nav-cta, body.stable-white-nav nav .safe-nav-cta, body.stable-white-nav .navbar .nav-cta { color: #ffffff !important; }',
    'body.stable-white-nav nav .btn, body.stable-white-nav .nav .btn, body.stable-white-nav .site-header .btn, body.stable-white-nav .navbar .btn { border-color: rgba(20, 34, 56, 0.18) !important; }'
  ].join('\\n');
  document.head.appendChild(style);
  const forceLightNav = ${forceLightNav ? "true" : "false"};
  document.body.classList.add('stable-white-nav');
  if (forceLightNav) document.body.classList.add('logo-dark-nav');
})();
</script>
`;

  return html.replace("</body>", `${block}\n</body>`);
}

function buildSafeFallbackShell({ profile, territories, images, logo }) {
  const brokerName = escapeHtml(String(profile?.name || "RE/MAX Crystal").trim());
  const primary = normalizeHex(profile?.palette?.primary, "#0b2f7a");
  const secondary = normalizeHex(profile?.palette?.secondary, "#3f7cff");
  const safeTerritories = (Array.isArray(territories) ? territories : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  const territoryLine = escapeHtml(buildTerritoriesMarketingLine(safeTerritories) || safeTerritories.join(" • "));
  const territoriesText = escapeHtml(safeTerritories.join(" • ") || "Territoires desservis");
  const nonLogoImages = (Array.isArray(images) ? images : []).filter((src) => !/logo/i.test(src));
  const heroImage = escapeHtml(nonLogoImages[0] || "");
  const galleryImages = nonLogoImages.slice(0, 4);
  const logoSrc = logo ? escapeHtml(logo) : "";
  const bio = escapeHtml(String(profile?.bio || "").trim() || "Approche locale, execution rigoureuse et mise en valeur haut de gamme de chaque propriete.");
  const services = Array.isArray(profile?.services) && profile.services.length
    ? profile.services.slice(0, 3)
    : ["Achat", "Vente", "Investissement"];
  const serviceCards = services.map((service, index) => {
    const label = escapeHtml(String(service));
    const desc = [
      "Accompagnement stratégique, analyse du marché et sélection ciblée pour trouver la bonne propriété.",
      "Positionnement, marketing visuel et négociation structurée pour maximiser la valeur de vente.",
      "Lecture locale du marché, opportunités ciblées et vision long terme pour bâtir un portefeuille."
    ][index] || "Accompagnement premium pensé pour un projet immobilier ambitieux et bien exécuté.";
    return `<article class="safe-card"><span class="safe-card-index">0${index + 1}</span><h3>${label}</h3><p>${escapeHtml(desc)}</p></article>`;
  }).join("");
  const territoryCards = safeTerritories.map((city, index) => `
    <article class="safe-territory-card">
      <span class="safe-territory-index">0${index + 1}</span>
      <h3>${escapeHtml(city)}</h3>
      <p>Connaissance fine du marché local, lecture de quartier, positionnement précis et accompagnement humain.</p>
    </article>
  `).join("");
  const gallery = galleryImages.length ? `
  <section id="gallery" class="safe-gallery">
    <div class="safe-shell">
      <span class="safe-kicker">Photos</span>
      <h2>Photos</h2>
      <div class="safe-gallery-slider" data-parallax="0.08">
        <button class="safe-gallery-nav prev" type="button" aria-label="Photo precedente">‹</button>
        <div class="safe-gallery-track">
          ${galleryImages.map((src, index) => `<figure class="safe-gallery-slide${index === 0 ? " is-active" : ""}"><img src="${escapeHtml(src)}" alt="${brokerName}" /></figure>`).join("")}
        </div>
        <button class="safe-gallery-nav next" type="button" aria-label="Photo suivante">›</button>
      </div>
      <div class="safe-gallery-dots">
        ${galleryImages.map((_, index) => `<button class="safe-gallery-dot${index === 0 ? " is-active" : ""}" type="button" aria-label="Aller a la photo ${index + 1}"></button>`).join("")}
      </div>
    </div>
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brokerName} — RE/MAX Crystal</title>
  <style>
    :root {
      --safe-primary: ${primary};
      --safe-secondary: ${secondary};
      --safe-dark: #07111f;
      --safe-panel: rgba(255,255,255,0.08);
      --safe-text: #f3f6ff;
      --safe-muted: rgba(243,246,255,0.72);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: Inter, system-ui, sans-serif;
      color: var(--safe-text);
      background:
        radial-gradient(circle at 18% 22%, rgba(255,255,255,0.08), transparent 30%),
        radial-gradient(circle at 84% 20%, rgba(63,124,255,0.22), transparent 34%),
        linear-gradient(135deg, #07111f 0%, var(--safe-primary) 44%, var(--safe-secondary) 100%);
      overflow-x: hidden;
    }
    .safe-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      width: 100%;
      margin: 0;
      padding: 16px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255,255,255,0.98);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(15,31,53,0.12);
      box-shadow: 0 10px 32px rgba(15,31,53,0.08);
    }
    .safe-nav-brand { text-decoration: none; color: #0f1f35; font-weight: 800; }
    .safe-nav-brand img { height: 42px; width: auto; display: block; }
    .safe-nav-links { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .safe-nav-links a {
      color: #0f1f35;
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 10px 16px;
      border-radius: 999px;
    }
    .safe-nav-links a.safe-nav-cta { background: linear-gradient(135deg, var(--safe-secondary), #5b95ff); color: #fff; }
    .safe-hero {
      min-height: 100vh;
      display: flex;
      align-items: center;
      padding: 118px 0 72px;
    }
    .safe-shell { width: min(1240px, calc(100% - 36px)); margin: 0 auto; }
    .safe-hero-grid {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 46px;
      align-items: center;
    }
    .hero-broker-seo {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .hero-territories-line { font-size: 1rem; line-height: 1.6; color: var(--safe-muted); margin-bottom: 10px; }
    .safe-kicker {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.8);
      margin-bottom: 16px;
    }
    .safe-kicker::before { content: ""; width: 44px; height: 1px; background: rgba(255,255,255,0.4); }
    .safe-hero h1 {
      font-family: "Playfair Display", Georgia, serif;
      font-size: clamp(3.8rem, 7vw, 7.4rem);
      line-height: 0.94;
      letter-spacing: -0.04em;
      margin-bottom: 18px;
      max-width: 8ch;
    }
    .safe-hero p.safe-lead {
      font-size: 1.18rem;
      line-height: 1.75;
      color: var(--safe-muted);
      max-width: 38rem;
      margin-bottom: 24px;
    }
    .safe-hero-actions { display: flex; gap: 14px; flex-wrap: wrap; }
    .safe-btn {
      min-height: 52px;
      padding: 0 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      text-decoration: none;
      font-weight: 800;
    }
    .safe-btn-primary { background: linear-gradient(135deg, var(--safe-secondary), #61a0ff); color: #fff; }
    .safe-btn-ghost { border: 1px solid rgba(255,255,255,0.22); color: #fff; }
    .safe-hero-media { position: relative; min-width: 0; }
    .safe-hero-media img {
      width: min(100%, 540px);
      height: min(72vh, 700px);
      object-fit: cover;
      display: block;
      margin-left: auto;
      border-radius: 26px;
      box-shadow: 0 28px 90px rgba(0,0,0,0.34);
    }
    .safe-hero-badge {
      position: absolute;
      left: 24px;
      bottom: 24px;
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(7,17,31,0.66);
      border: 1px solid rgba(255,255,255,0.14);
      backdrop-filter: blur(12px);
    }
    section { padding: 84px 0; }
    .safe-section-dark { background: rgba(7,17,31,0.42); }
    .safe-section-light { background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(241,245,255,0.94)); color: #0f1f35; }
    .safe-section-light .safe-kicker, .safe-section-light h2, .safe-section-light p, .safe-section-light h3 { color: #0f1f35; }
    .safe-section-light .safe-kicker::before { background: rgba(15,31,53,0.34); }
    .safe-shell h2 {
      font-family: "Playfair Display", Georgia, serif;
      font-size: clamp(2.4rem, 5vw, 4rem);
      line-height: 1;
      margin-bottom: 14px;
    }
    .safe-section-sub { max-width: 40rem; color: var(--safe-muted); margin-bottom: 28px; line-height: 1.8; }
    .safe-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .safe-card, .safe-territory-card {
      padding: 28px;
      border-radius: 22px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(14px);
      min-width: 0;
    }
    .safe-card-index, .safe-territory-index { display: inline-block; margin-bottom: 12px; color: rgba(255,255,255,0.45); font-weight: 800; letter-spacing: 0.12em; }
    .safe-card h3, .safe-territory-card h3 { font-size: 1.5rem; margin-bottom: 10px; }
    .safe-card p, .safe-territory-card p { color: var(--safe-muted); line-height: 1.8; }
    .safe-territories-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .safe-about-grid { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 30px; align-items: center; }
    .safe-about-media img { width: 100%; height: 460px; object-fit: cover; display: block; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.18); }
    .safe-gallery-slider { position: relative; overflow: hidden; border-radius: 28px; min-height: 560px; box-shadow: 0 28px 80px rgba(0,0,0,0.28); }
    .safe-gallery-track { position: relative; min-height: 560px; }
    .safe-gallery-slide { position: absolute; inset: 0; opacity: 0; transition: opacity 0.55s ease; }
    .safe-gallery-slide.is-active { opacity: 1; }
    .safe-gallery-slide img { width: 100%; height: 560px; object-fit: cover; display: block; }
    .safe-gallery-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2;
      width: 52px;
      height: 52px;
      border: none;
      border-radius: 999px;
      background: rgba(7,17,31,0.48);
      color: #fff;
      font-size: 1.9rem;
      cursor: pointer;
      backdrop-filter: blur(12px);
    }
    .safe-gallery-nav.prev { left: 18px; }
    .safe-gallery-nav.next { right: 18px; }
    .safe-gallery-dots { display: flex; justify-content: center; gap: 10px; margin-top: 18px; }
    .safe-gallery-dot { width: 10px; height: 10px; border-radius: 999px; border: none; background: rgba(255,255,255,0.34); cursor: pointer; }
    .safe-gallery-dot.is-active { width: 34px; background: #fff; }
    @media (max-width: 980px) {
      .safe-nav { padding: 14px 18px; }
      .safe-nav-links { display: none; }
      .safe-hero-grid, .safe-cards, .safe-territories-grid, .safe-about-grid { grid-template-columns: 1fr; }
      .safe-hero-media img { margin: 0; width: 100%; height: 420px; }
      .safe-gallery-slider, .safe-gallery-track, .safe-gallery-slide img { min-height: 360px; height: 360px; }
    }
  </style>
  <script>
    (() => {
      const slider = document.querySelector('.safe-gallery-slider');
      const slides = slider ? [...slider.querySelectorAll('.safe-gallery-slide')] : [];
      const dots = [...document.querySelectorAll('.safe-gallery-dot')];
      if (slides.length > 1) {
        let index = 0;
        const sync = (next) => {
          index = (next + slides.length) % slides.length;
          slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
          dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
        };
        slider.querySelector('.safe-gallery-nav.prev')?.addEventListener('click', () => sync(index - 1));
        slider.querySelector('.safe-gallery-nav.next')?.addEventListener('click', () => sync(index + 1));
        dots.forEach((dot, i) => dot.addEventListener('click', () => sync(i)));
        setInterval(() => sync(index + 1), 5000);
      }
      const parallaxNodes = [...document.querySelectorAll('[data-parallax], .safe-hero-media, .safe-gallery-slider')];
      if (parallaxNodes.length) {
        let ticking = false;
        const update = () => {
          const y = window.scrollY || 0;
          parallaxNodes.forEach((node) => {
            const speed = Number(node.getAttribute('data-parallax') || 0.06);
            node.style.transform = 'translate3d(0,' + Math.max(-18, y * speed * -0.16).toFixed(2) + 'px,0)';
          });
          ticking = false;
        };
        window.addEventListener('scroll', () => {
          if (!ticking) {
            requestAnimationFrame(update);
            ticking = true;
          }
        }, { passive: true });
      }
    })();
  </script>
</head>
<body>
  <nav class="safe-nav">
    <a class="safe-nav-brand" href="#hero">${logoSrc ? `<img src="${logoSrc}" alt="RE/MAX Crystal" />` : brokerName}</a>
    <div class="safe-nav-links">
      <a href="#services">Services</a>
      <a href="#territories">Territoires</a>
      <a href="#about">A propos</a>
      <a href="#contact" class="safe-nav-cta">Me contacter</a>
    </div>
  </nav>
  <section id="hero" class="safe-hero">
    <div class="safe-shell safe-hero-grid">
      <div>
        <p class="hero-broker-seo">${brokerName}</p>
        <p class="hero-territories-line">${territoryLine}</p>
        <span class="safe-kicker">RE/MAX Crystal</span>
        <h1>${brokerName}</h1>
        <p class="safe-lead">${bio}</p>
        <div class="safe-hero-actions">
          <a href="#contact" class="safe-btn safe-btn-primary">Nous contacter</a>
          <a href="#services" class="safe-btn safe-btn-ghost">Services</a>
        </div>
      </div>
      ${heroImage ? `<div class="safe-hero-media"><img src="${heroImage}" alt="${brokerName}" /><div class="safe-hero-badge">RE/MAX Crystal</div></div>` : ""}
    </div>
  </section>
  <section id="services" class="safe-section-dark">
    <div class="safe-shell">
      <span class="safe-kicker">Services</span>
      <h2>Des services tailles pour l'excellence</h2>
      <p class="safe-section-sub">Un accompagnement clair, haut de gamme et structure pour chaque etape du projet immobilier.</p>
      <div class="safe-cards">${serviceCards}</div>
    </div>
  </section>
  <section id="territories" class="safe-section-dark">
    <div class="safe-shell">
      <span class="safe-kicker">Territoires</span>
      <h2>Territoires desservis</h2>
      <p class="safe-section-sub">${territoriesText}</p>
      <div class="safe-territories-grid">${territoryCards || `<article class="safe-territory-card"><h3>Territoires</h3><p>${territoriesText}</p></article>`}</div>
    </div>
  </section>
  <section id="about" class="safe-section-light">
    <div class="safe-shell safe-about-grid">
      ${nonLogoImages[1] ? `<div class="safe-about-media"><img src="${escapeHtml(nonLogoImages[1])}" alt="${brokerName}" /></div>` : ""}
      <div>
        <span class="safe-kicker">A propos</span>
        <h2>${brokerName}</h2>
        <p class="safe-section-sub">${bio}</p>
      </div>
    </div>
  </section>
  ${gallery}
</body>
</html>`;
}

function injectHeroSeoTuning(html, { brokerName }) {
  if (!html.includes("</body>")) return html;
  const name = String(brokerName || "").trim();
  if (!name) return html;

  let updated = html;
  const marker = `<p class="hero-broker-seo">${escapeHtml(name)}</p>`;

  const heroBlock = findHeroBlock(updated);
  if (heroBlock && !heroBlock.toLowerCase().includes(name.toLowerCase())) {
    updated = replaceHeroBlock(updated, (heroSection) => {
      if (/<div[^>]*class=["'][^"']*(hero-content|hero-text|hero-copy|hero-body)[^"']*["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<div[^>]*class=["'][^"']*(hero-content|hero-text|hero-copy|hero-body)[^"']*["'][^>]*>)/i, `$1\n${marker}`);
      }
      if (/<h1[^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<h1[^>]*>[\s\S]*?<\/h1>)/i, `$1\n${marker}`);
      }
      if (/<(section|div)[^>]*id=["']hero["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<(section|div)[^>]*id=["']hero["'][^>]*>)/i, `$1\n${marker}`);
      }
      if (/<(section|div)[^>]*class=["'][^"']*hero[^"']*["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<(section|div)[^>]*class=["'][^"']*hero[^"']*["'][^>]*>)/i, `$1\n${marker}`);
      }
      return `${marker}\n${heroSection}`;
    });
  }

  if (!/class=["'][^"']*hero-broker-seo[^"']*["']/i.test(updated)) {
    updated = injectIntoAboveFoldContent(updated, marker);
  }

  if (!updated.includes('data-generated-guard="hero-seo-v1"')) {
    const block = `
<style data-generated-guard="hero-seo-v1">
.hero .hero-broker-seo,
#hero .hero-broker-seo,
.hero-broker-seo {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
<script data-generated-guard="hero-seo-v1-script">
(function () {
  const hero = document.querySelector('.hero, #hero, section[class*="hero"]');
  if (!hero) return;
  const candidates = hero.querySelectorAll('.hero-subtitle, .hero-description, p');
  for (const p of candidates) {
    const txt = (p.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!txt) continue;
    if (txt.length > 190) {
      p.textContent = txt.slice(0, 187).replace(/[\\s,;:.!-]+$/, '') + '...';
      break;
    }
  }
})();
</script>`;
    updated = updated.replace("</body>", `${block}\n</body>`);
  }

  return updated;
}

function buildTerritoriesMarketingLine(territories) {
  const cities = (Array.isArray(territories) ? territories : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  if (!cities.length) return "";
  if (cities.length === 1) {
    return `Expertise locale de haut niveau a ${cities[0]}, pour vendre ou acheter avec confiance et impact.`;
  }
  const list = cities.slice(0, -1).join(", ");
  const last = cities[cities.length - 1];
  return `Presence forte a ${list} et ${last} pour propulser votre projet immobilier avec une strategie locale premium.`;
}

function injectHeroTerritoriesLine(html, { territories }) {
  if (!html.includes("</body>")) return html;
  const line = buildTerritoriesMarketingLine(territories);
  if (!line) return html;

  let updated = html;
  const escapedLine = escapeHtml(line);
  const marker = `<p class="hero-territories-line">${escapedLine}</p>`;

  const heroBlock = findHeroBlock(updated);
  if (heroBlock && !heroBlock.toLowerCase().includes(line.toLowerCase().slice(0, 24))) {
    updated = replaceHeroBlock(updated, (heroSection) => {
      if (/<p[^>]*class=["'][^"']*(hero-subtitle|hero-sub|hero-description)[^"']*["'][\s\S]*?<\/p>/i.test(heroSection)) {
        return heroSection.replace(/(<p[^>]*class=["'][^"']*(hero-subtitle|hero-sub|hero-description)[^"']*["'][\s\S]*?<\/p>)/i, `$1\n${marker}`);
      }
      if (/<div[^>]*class=["'][^"']*(hero-content|hero-text|hero-copy|hero-body)[^"']*["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<div[^>]*class=["'][^"']*(hero-content|hero-text|hero-copy|hero-body)[^"']*["'][^>]*>)/i, `$1\n${marker}`);
      }
      if (/<h1[^>]*>[\s\S]*?<\/h1>/i.test(heroSection)) {
        return heroSection.replace(/(<h1[^>]*>[\s\S]*?<\/h1>)/i, `$1\n${marker}`);
      }
      if (/<(section|div)[^>]*id=["']hero["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<(section|div)[^>]*id=["']hero["'][^>]*>)/i, `$1\n${marker}`);
      }
      if (/<(section|div)[^>]*class=["'][^"']*hero[^"']*["'][^>]*>/i.test(heroSection)) {
        return heroSection.replace(/(<(section|div)[^>]*class=["'][^"']*hero[^"']*["'][^>]*>)/i, `$1\n${marker}`);
      }
      return `${marker}\n${heroSection}`;
    });
  }

  if (!/class=["'][^"']*hero-territories-line[^"']*["']/i.test(updated)) {
    updated = injectIntoAboveFoldContent(updated, marker);
  }

  if (!updated.includes('data-generated-guard="hero-territories-v1"')) {
    const style = `
<style data-generated-guard="hero-territories-v1">
.hero .hero-territories-line,
#hero .hero-territories-line,
.hero-territories-line {
  margin: 0.35rem 0 1.2rem;
  font-size: 1.02rem;
  line-height: 1.5;
  font-weight: 600;
  opacity: 0.96;
}
</style>`;
    updated = updated.replace("</body>", `${style}\n</body>`);
  }

  return updated;
}

function injectNavBrokerNameRemoval(html, { brokerName }) {
  if (!html.includes("</body>")) return html;
  const name = String(brokerName || "").trim();
  if (!name) return html;
  if (html.includes('data-generated-guard="nav-broker-name-clean-v1"')) return html;

  const script = `
<script data-generated-guard="nav-broker-name-clean-v1">
(function () {
  const brokerName = ${JSON.stringify(name)};
  const normalized = brokerName.toLowerCase().trim();
  if (!normalized) return;
  const nav = document.querySelector('nav, .nav, .navbar, .site-header');
  if (!nav) return;

  const walker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
  const toClean = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.nodeValue || '').toLowerCase().trim();
    if (!text) continue;
    if (text === normalized || text.includes(normalized)) {
      toClean.push(node);
    }
  }
  toClean.forEach((n) => { n.nodeValue = ''; });
})();
</script>`;

  return html.replace("</body>", `${script}\n</body>`);
}

function injectContactForm(html, { primaryColor, secondaryColor }) {
  if (!html.includes("</body>")) return html;
  if (html.includes('id="contact-form"')) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const p = hexToRgb(primary);
  const s = hexToRgb(secondary);

  const block = `
<section id="contact" class="contact-modern">
  <div class="cf-wrap">
    <div class="cf-head">
      <span class="cf-kicker">Contact</span>
      <h2>Parlons de votre projet immobilier</h2>
      <p>Formulaire visuel uniquement pour le moment. Aucune soumission backend n'est connectee.</p>
    </div>
    <form id="contact-form" class="cf-grid" onsubmit="return false;">
      <label class="cf-field"><span>Nom complet</span><input id="cf-name" type="text" placeholder="Votre nom" /></label>
      <label class="cf-field"><span>Courriel</span><input id="cf-email" type="email" placeholder="vous@exemple.com" /></label>
      <label class="cf-field"><span>Telephone</span><input id="cf-phone" type="tel" placeholder="(514) 000-0000" /></label>
      <label class="cf-field"><span>Ville / Territoire</span><input id="cf-city" type="text" placeholder="Ex: Lorraine" /></label>
      <label class="cf-field cf-full"><span>Message</span><textarea id="cf-message" rows="5" placeholder="Decrivez votre besoin..."></textarea></label>
      <button id="cf-submit" class="cf-btn" type="button">Envoyer (bientot connecte)</button>
    </form>
  </div>
</section>
<style data-generated-guard="contact-v1">
.contact-modern { padding: 5rem 2rem; background: radial-gradient(circle at 12% 10%, rgba(${p.r}, ${p.g}, ${p.b}, 0.18), transparent 40%), linear-gradient(140deg, rgba(${s.r}, ${s.g}, ${s.b}, 0.95), rgba(${p.r}, ${p.g}, ${p.b}, 0.78)); color: #f4f8ff; }
.cf-wrap { max-width: 1180px; margin: 0 auto; }
.cf-kicker { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.8rem; font-weight: 700; opacity: 0.85; }
.cf-head h2 { margin: 0.6rem 0; font-size: clamp(2rem, 3vw, 2.8rem); }
.cf-head p { opacity: 0.9; margin-bottom: 1.2rem; }
.cf-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.cf-field { display: flex; flex-direction: column; gap: 0.45rem; }
.cf-field span { font-size: 0.9rem; opacity: 0.95; }
.cf-field input, .cf-field textarea { border-radius: 14px; border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.12); color: #fff; padding: 0.85rem 0.95rem; font-size: 1rem; }
.cf-field input::placeholder, .cf-field textarea::placeholder { color: rgba(255,255,255,0.7); }
.cf-field input:focus, .cf-field textarea:focus { outline: 2px solid rgba(255,255,255,0.35); outline-offset: 2px; }
.cf-full { grid-column: span 2; }
.cf-btn { grid-column: span 2; height: 52px; border: none; border-radius: 14px; background: linear-gradient(135deg, #ffffff, rgba(255,255,255,0.84)); color: #101a2a; font-weight: 700; cursor: pointer; }
@media (max-width: 860px) { .cf-grid { grid-template-columns: 1fr; } .cf-full, .cf-btn { grid-column: span 1; } }
</style>
`;

  if (html.includes("</footer>")) return html.replace("</footer>", `</footer>\n${block}`);
  return html.replace("</body>", `${block}\n</body>`);
}

function injectMortgageCalculator(html, { primaryColor, secondaryColor }) {
  if (!html.includes("</body>")) return html;
  if (html.includes('id="mortgage-calculator"')) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const p = hexToRgb(primary);
  const s = hexToRgb(secondary);

  const calculatorBlock = `
<section id="mortgage-calculator" class="mortgage-calculator">
  <div class="mc-container">
    <div class="mc-head">
      <span class="mc-kicker">Financement</span>
      <h2>Calculatrice hypothecaire</h2>
      <p>Estimez rapidement votre paiement mensuel selon votre budget et votre taux.</p>
    </div>
    <form id="mortgageForm" class="mc-grid" onsubmit="return false;">
      <label class="mc-field"><span>Prix de la propriete ($)</span><input id="mcPrice" type="number" min="0" step="1000" value="500000" /></label>
      <label class="mc-field"><span>Mise de fonds ($)</span><input id="mcDownPayment" type="number" min="0" step="1000" value="100000" /></label>
      <label class="mc-field"><span>Taux d'interet annuel (%)</span><input id="mcRate" type="number" min="0" step="0.01" value="4.99" /></label>
      <label class="mc-field"><span>Amortissement (annees)</span><input id="mcYears" type="number" min="1" max="40" step="1" value="25" /></label>
      <button id="mcCompute" class="mc-btn" type="button">Calculer</button>
    </form>
    <div class="mc-result">
      <div class="mc-card"><span>Paiement mensuel estime</span><strong id="mcMonthly">$0</strong></div>
      <div class="mc-meta"><p id="mcSummary">Ajustez les champs pour recalculer.</p></div>
    </div>
  </div>
</section>
<style data-generated-guard="mortgage-v1">
.mortgage-calculator { padding: 6rem 2rem; background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(242,246,255,0.96)); color: #10203a; }
.mc-container { max-width: 1180px; margin: 0 auto; }
.mc-head h2 { font-size: clamp(2rem, 3vw, 3rem); margin: 0.5rem 0; }
.mc-head p { color: rgba(16,32,58,0.72); margin-bottom: 1.5rem; }
.mc-kicker { text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700; font-size: 0.8rem; opacity: 0.85; color: ${secondary}; }
.mc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-top: 1rem; }
.mc-field { display: flex; flex-direction: column; gap: 0.45rem; }
.mc-field span { font-size: 0.9rem; color: rgba(16,32,58,0.84); }
.mc-field input { height: 52px; border-radius: 14px; border: 1px solid rgba(${s.r}, ${s.g}, ${s.b}, 0.22); background: #fff; color: #10203a; padding: 0 14px; font-size: 1rem; }
.mc-field input:focus { outline: 2px solid rgba(${s.r}, ${s.g}, ${s.b}, 0.22); outline-offset: 2px; }
.mc-btn { grid-column: span 2; height: 54px; border: none; border-radius: 14px; font-weight: 700; font-size: 1rem; cursor: pointer; color: #fff; background: linear-gradient(135deg, ${secondary}, ${primary}); }
.mc-result { margin-top: 1.3rem; display: grid; gap: 1rem; }
.mc-card { background: linear-gradient(145deg, rgba(${s.r}, ${s.g}, ${s.b}, 0.12), rgba(${p.r}, ${p.g}, ${p.b}, 0.08)); border: 1px solid rgba(${s.r}, ${s.g}, ${s.b}, 0.18); border-radius: 16px; padding: 1.2rem 1.1rem; }
.mc-card span, .mc-card strong, .mc-meta, .mc-meta p { color: #10203a; }
.mc-card strong { display: block; font-size: clamp(2rem, 3.2vw, 3rem); margin-top: 0.3rem; }
.mc-meta { opacity: 0.88; }
@media (max-width: 860px) { .mc-grid { grid-template-columns: 1fr; } .mc-btn { grid-column: span 1; } }
</style>
<script data-generated-guard="mortgage-v1-script">
function formatMoney(value) { return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(value || 0); }
function calculateMortgage() {
  const price = Number(document.getElementById('mcPrice')?.value || 0);
  const downPayment = Number(document.getElementById('mcDownPayment')?.value || 0);
  const rate = Number(document.getElementById('mcRate')?.value || 0);
  const years = Number(document.getElementById('mcYears')?.value || 25);
  const principal = Math.max(0, price - downPayment);
  const monthlyRate = rate / 100 / 12;
  const n = Math.max(1, years * 12);
  let monthly = 0;
  if (monthlyRate === 0) monthly = principal / n;
  else monthly = principal * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
  const monthlyEl = document.getElementById('mcMonthly');
  const summaryEl = document.getElementById('mcSummary');
  if (monthlyEl) monthlyEl.textContent = formatMoney(monthly);
  if (summaryEl) summaryEl.textContent = 'Montant finance: ' + formatMoney(principal) + ' · Taux: ' + rate.toFixed(2) + '% · Amortissement: ' + years + ' ans';
}
document.getElementById('mcCompute')?.addEventListener('click', calculateMortgage);
['mcPrice', 'mcDownPayment', 'mcRate', 'mcYears'].forEach((id) => { document.getElementById(id)?.addEventListener('input', calculateMortgage); });
calculateMortgage();
</script>
`;

  if (html.includes("</footer>")) return html.replace("</footer>", `</footer>\n${calculatorBlock}`);
  return html.replace("</body>", `${calculatorBlock}\n</body>`);
}

function injectCrystalFooter(html, { primaryColor, secondaryColor, territories, sharedLogoAvailable, brokerLogoPath, brokerName }) {
  if (!html.includes("</body>")) return html;
  if (html.includes('id="footer-crystal"')) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const p = hexToRgb(primary);
  const s = hexToRgb(secondary);
  const links = extractTopMenuLinks(html);
  const safeBrokerName = escapeHtml(brokerName || "RE/MAX Crystal");
  const safeTerritories = (Array.isArray(territories) ? territories : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .map(escapeHtml);
  const logoSrc = sharedLogoAvailable ? "assets/logo-crystal.png" : (brokerLogoPath || "");

  const menuItems = links
    .map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`)
    .join("");

  const territoryItems = safeTerritories.length
    ? safeTerritories.map((t) => `<li>${t}</li>`).join("")
    : "<li>Territoires a venir</li>";

  const footerBlock = `
<footer id="footer-crystal" class="footer-crystal">
  <div class="fc-wrap">
    <div class="fc-brand">
      ${logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="RE/MAX Crystal" class="fc-logo" />` : `<div class="fc-fallback">RE/MAX Crystal</div>`}
      <p class="fc-broker">${safeBrokerName}</p>
    </div>
    <div class="fc-col">
      <h4>Menu du site</h4>
      <ul class="fc-menu">${menuItems}</ul>
    </div>
    <div class="fc-col">
      <h4>Territoires desservis</h4>
      <ul class="fc-territories">${territoryItems}</ul>
    </div>
  </div>
</footer>
<style data-generated-guard="footer-crystal-v1">
.footer-crystal {
  padding: 4.2rem 2rem 2.4rem;
  background:
    radial-gradient(circle at 14% -10%, rgba(${p.r}, ${p.g}, ${p.b}, 0.24), transparent 40%),
    linear-gradient(145deg, #1b1d24, rgba(${s.r}, ${s.g}, ${s.b}, 0.95));
  color: #eef3ff;
}
.fc-wrap { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 2rem; }
.fc-logo { width: 220px; max-width: 100%; height: auto; object-fit: contain; margin-bottom: 0.85rem; filter: drop-shadow(0 8px 18px rgba(0,0,0,0.28)); }
.fc-fallback { font-size: 1.8rem; font-weight: 800; margin-bottom: 0.85rem; }
.fc-broker { opacity: 0.9; margin: 0; }
.fc-col h4 { margin: 0 0 0.85rem; font-size: 1.05rem; letter-spacing: 0.02em; }
.fc-col ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.5rem; }
.fc-col a { color: #f5f8ff; opacity: 0.9; text-decoration: none; }
.fc-col a:hover { opacity: 1; text-decoration: underline; }
.fc-territories li { opacity: 0.92; }
@media (max-width: 980px) { .fc-wrap { grid-template-columns: 1fr; } }
</style>
`;

  if (/<footer[\s\S]*?<\/footer>/i.test(html)) {
    return html.replace(/<footer[\s\S]*?<\/footer>/i, footerBlock);
  }
  return html.replace("</body>", `${footerBlock}\n</body>`);
}

function injectMissingAboutSection(html, { bio, brokerName, territories, primaryColor, secondaryColor }) {
  if (!html.includes("</body>")) return html;
  if (/id=["']about["']|class=["'][^"']*about[^"']*["']/i.test(html)) return html;
  if (!extractTopMenuLinks(html).some((l) => l.href.toLowerCase() === "#about")) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const safeBio = escapeHtml(String(bio || "").trim() || "Approche personnalisee, ancrage local et execution rigoureuse a chaque etape.");
  const safeBroker = escapeHtml(String(brokerName || "").trim() || "RE/MAX Crystal");
  const cityText = (Array.isArray(territories) ? territories : []).filter(Boolean).map(escapeHtml).join(" • ") || "Territoires desservis";

  const section = `
<section id="about" class="about-auto">
  <div class="about-auto-wrap">
    <span class="about-auto-kicker">A propos</span>
    <h2>${safeBroker}</h2>
    <p>${safeBio}</p>
    <div class="about-auto-tags">${cityText}</div>
  </div>
</section>
<style data-generated-guard="about-auto-v1">
.about-auto { padding: 5rem 2rem; background: linear-gradient(150deg, ${secondary}, ${primary}); color: #eef4ff; }
.about-auto-wrap { max-width: 1100px; margin: 0 auto; }
.about-auto-kicker { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; font-weight: 700; opacity: 0.82; }
.about-auto h2 { margin: 0.65rem 0 1rem; font-size: clamp(2rem, 3.2vw, 3rem); }
.about-auto p { margin: 0; max-width: 760px; font-size: 1.05rem; line-height: 1.8; opacity: 0.95; }
.about-auto-tags { margin-top: 1.15rem; font-weight: 700; opacity: 0.9; }
</style>
`;

  return html.replace("</body>", `${section}\n</body>`);
}

function injectMissingGallerySection(html, { images, primaryColor, secondaryColor }) {
  if (!html.includes("</body>")) return html;
  if (!extractTopMenuLinks(html).some((l) => l.href.toLowerCase() === "#gallery")) return html;

  const galleryImages = (Array.isArray(images) ? images : [])
    .filter((src) => /\.(jpg|jpeg|png|webp)$/i.test(src))
    .slice(0, 4);

  if (!galleryImages.length) return html;

  const primary = normalizeHex(primaryColor, "#d71920");
  const secondary = normalizeHex(secondaryColor, "#1c1c1c");
  const slides = galleryImages.map((src, idx) => `<figure class="gallery-auto-slide${idx === 0 ? " is-active" : ""}"><img src="${escapeHtml(src)}" alt="Photos" /></figure>`).join("");
  const dots = galleryImages.map((_, idx) => `<button class="gallery-auto-dot${idx === 0 ? " is-active" : ""}" type="button" aria-label="Photo ${idx + 1}"></button>`).join("");

  const section = `
<section id="gallery" class="gallery-auto">
  <div class="gallery-auto-wrap">
    <div class="gallery-auto-head">
      <span class="gallery-auto-kicker">Photos</span>
      <h2>Photos</h2>
    </div>
    <div class="gallery-auto-slider" data-parallax="0.08">
      <button class="gallery-auto-nav prev" type="button" aria-label="Photo precedente">‹</button>
      <div class="gallery-auto-track">${slides}</div>
      <button class="gallery-auto-nav next" type="button" aria-label="Photo suivante">›</button>
    </div>
    <div class="gallery-auto-dots">${dots}</div>
  </div>
</section>
<style data-generated-guard="gallery-auto-v1">
.gallery-auto { padding: 5rem 2rem; background: radial-gradient(circle at 18% 20%, rgba(255,255,255,0.08), transparent 36%), linear-gradient(145deg, ${primary}, ${secondary}); color: #f4f8ff; }
.gallery-auto-wrap { max-width: 1200px; margin: 0 auto; }
.gallery-auto-head { margin-bottom: 1.4rem; }
.gallery-auto-kicker { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; font-weight: 700; opacity: 0.82; }
.gallery-auto-head h2 { margin: 0.65rem 0 0; font-size: clamp(2rem, 3.2vw, 3rem); }
.gallery-auto-slider { position: relative; overflow: hidden; border-radius: 22px; box-shadow: 0 16px 50px rgba(0,0,0,0.2); }
.gallery-auto-track { position: relative; min-height: 560px; }
.gallery-auto-slide { position: absolute; inset: 0; opacity: 0; transition: opacity 0.55s ease; }
.gallery-auto-slide.is-active { opacity: 1; }
.gallery-auto-slide img { width: 100%; height: 560px; object-fit: cover; display: block; }
.gallery-auto-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: 52px; height: 52px; border-radius: 999px; border: none; background: rgba(7,17,31,0.48); color: #fff; font-size: 1.9rem; cursor: pointer; backdrop-filter: blur(12px); }
.gallery-auto-nav.prev { left: 18px; }
.gallery-auto-nav.next { right: 18px; }
.gallery-auto-dots { display: flex; justify-content: center; gap: 10px; margin-top: 16px; }
.gallery-auto-dot { width: 10px; height: 10px; border-radius: 999px; border: none; background: rgba(255,255,255,0.34); cursor: pointer; }
.gallery-auto-dot.is-active { width: 34px; background: #fff; }
@media (max-width: 860px) { .gallery-auto-track, .gallery-auto-slide img { min-height: 320px; height: 320px; } }
</style>
<script data-generated-guard="gallery-auto-v1-script">
(() => {
  const root = document.querySelector('.gallery-auto');
  if (!root) return;
  const slides = [...root.querySelectorAll('.gallery-auto-slide')];
  const dots = [...root.querySelectorAll('.gallery-auto-dot')];
  if (slides.length < 2) return;
  let index = 0;
  const sync = (next) => {
    index = (next + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle('is-active', i === index));
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
  };
  root.querySelector('.gallery-auto-nav.prev')?.addEventListener('click', () => sync(index - 1));
  root.querySelector('.gallery-auto-nav.next')?.addEventListener('click', () => sync(index + 1));
  dots.forEach((dot, i) => dot.addEventListener('click', () => sync(i)));
  setInterval(() => sync(index + 1), 5000);
})();
</script>
`;

  if (/<(section|div)[^>]*(id=["']gallery["']|class=["'][^"']*gallery[^"']*["'])[\s\S]*?<\/(section|div)>/i.test(html)) {
    return html.replace(/<(section|div)[^>]*(id=["']gallery["']|class=["'][^"']*gallery[^"']*["'])[\s\S]*?<\/(section|div)>/i, section);
  }
  return html.replace("</body>", `${section}\n</body>`);
}

function injectParallaxEnhancements(html) {
  if (!html.includes("</body>")) return html;
  if (html.includes('data-generated-guard="parallax-v1"')) return html;

  const block = `
<style data-generated-guard="parallax-v1">
[data-parallax-ready] { will-change: transform; transition: transform 0.12s linear; }
</style>
<script data-generated-guard="parallax-v1-script">
(() => {
  const candidates = [
    '.hero-image',
    '.hero-image-frame',
    '.hero-media',
    '.safe-hero-media',
    '#gallery .gallery-auto-slider',
    '#gallery .safe-gallery-slider',
    '.gallery-item',
    '.gallery-auto',
    '.safe-card',
    '.service-card'
  ];
  const nodes = [...document.querySelectorAll(candidates.join(','))].slice(0, 8);
  if (!nodes.length) return;
  nodes.forEach((node, index) => {
    node.setAttribute('data-parallax-ready', 'true');
    node.setAttribute('data-parallax-speed', String(0.025 + (index % 3) * 0.015));
  });
  let ticking = false;
  const update = () => {
    const y = window.scrollY || 0;
    nodes.forEach((node) => {
      const speed = Number(node.getAttribute('data-parallax-speed') || 0.04);
      const offset = Math.max(-22, Math.min(22, y * speed * -0.2));
      node.style.transform = 'translate3d(0,' + offset.toFixed(2) + 'px,0)';
    });
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
})();
</script>`;

  return html.replace("</body>", `${block}\n</body>`);
}


function stableHash(input) {
  const value = String(input || "");
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function buildCreativeDNA(brokerId) {
  const hash = stableHash(brokerId);

  const heroCompositions = [
    "split-left-copy-right-portrait",
    "split-right-copy-left-portrait",
    "stacked-copy-over-framed-image",
    "editorial-offset-grid-with-floating-photo"
  ];

  const navigationStyles = [
    "glass-floating-nav",
    "minimal-solid-nav-with-thin-border",
    "dark-premium-nav",
    "centered-brand-nav-with-offset-cta"
  ];

  const sectionTransitions = [
    "angled-color-block-dividers",
    "soft-gradient-fade-transitions",
    "layered-overlay-transitions",
    "editorial-band-transitions"
  ];

  const cardSystems = [
    "frosted-glass-cards",
    "dark-elevated-cards",
    "gradient-outline-cards",
    "editorial-flat-cards-with-bold-borders"
  ];

  const motionProfiles = [
    "calm-fade-and-rise",
    "snappy-depth-hover",
    "cinematic-parallax-lite",
    "editorial-stagger-reveal"
  ];

  return {
    seed: hash,
    heroComposition: heroCompositions[hash % heroCompositions.length],
    navigationStyle: navigationStyles[(hash >> 3) % navigationStyles.length],
    sectionTransition: sectionTransitions[(hash >> 6) % sectionTransitions.length],
    cardSystem: cardSystems[(hash >> 9) % cardSystems.length],
    motionProfile: motionProfiles[(hash >> 12) % motionProfiles.length]
  };
}


export async function generateWithClaude({ rootDir, brokerId }) {
  const profilePath = path.join(rootDir, "brokers", brokerId, "profile.json");
  const assetsDir = path.join(rootDir, "brokers", brokerId, "assets");
  const outputDir = path.join(rootDir, "sites", brokerId);
  const sharedAssetsDir = path.join(rootDir, "assets");
  const sharedLogoPath = path.join(sharedAssetsDir, "logo-crystal.png");

  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  fs.mkdirSync(assetsDir, { recursive: true });

  const territories = Array.isArray(profile.territories)
    ? profile.territories.map((t) => String(t || "").trim()).filter(Boolean)
    : [];
  const serviceDescription = String(profile?.bio || "").trim();
  const serviceDescriptionWordCount = serviceDescription
    ? serviceDescription.split(/\s+/).filter(Boolean).length
    : 0;
  const allowExtraSections = serviceDescriptionWordCount >= 35;

  let images = [];
  if (fs.existsSync(assetsDir)) {
    images = fs.readdirSync(assetsDir)
      .filter(file => /\.(jpg|jpeg|png|webp|svg)$/i.test(file))
      .map(file => `assets/${file}`);
  }

  const logo = images.includes("assets/logo.png")
    ? "assets/logo.png"
    : (profile.logo ? profile.logo.replace(`/assets/${brokerId}/`, "assets/") : null);
  const sharedLogo = fs.existsSync(sharedLogoPath) ? "assets/logo-crystal.png" : null;
  const creativeDNA = buildCreativeDNA(brokerId);


  const prompt = `
You are an elite creative director and senior frontend developer.

Your job is to design a visually striking 2026-level real estate website.
This must look like a premium modern brand site, not a generic template.

BROKER CREATIVE DNA (must drive uniqueness):
${JSON.stringify(creativeDNA, null, 2)}

The site must feel like a combination of:
- Apple product pages
- modern Webflow award sites
- luxury real estate brands
- editorial magazine layouts

The design must feel EXPENSIVE, MODERN, and VISUALLY RICH.

Broker profile:
${JSON.stringify(profile, null, 2)}

Service description quality signal:
${JSON.stringify({
  text: serviceDescription,
  wordCount: serviceDescriptionWordCount,
  allowExtraSections
}, null, 2)}

Available local images:
${images.join("\n") || "none"}

Logo file:
${logo || "none"}

------------------------------------------------

VISUAL STYLE REQUIREMENTS

The site must include strong visual personality:

• colorful layered backgrounds
• subtle gradients
• radial glow effects
• editorial section transitions
• soft shadows
• floating visual elements
• elegant card designs
• generous whitespace
• animated hover states
• subtle parallax feeling (CSS only)

The site must NOT look like a basic bootstrap layout.

ABOVE-THE-FOLD QUALITY BAR (CRITICAL)

The first screen (navigation + hero + start of next section) must be visually striking.
Do NOT use plain white or flat light gray backgrounds above the fold.
Do NOT start with a generic white navbar on a white hero.

Required above the fold:
- layered gradient or cinematic background
- visible contrast blocks and depth
- premium typography scale with strong headline presence
- at least one accent glow, texture, or atmospheric overlay

If the opening looks minimal, plain, or template-like, redesign it to be more art-directed.

------------------------------------------------

TYPOGRAPHY

Use strong typography hierarchy.

Headlines must be LARGE and impactful.

Use a mix of:

• serif display font for hero titles
• clean sans-serif for body text

Examples:

Hero title:
font-size: 64px+

Section titles:
font-size: 40–48px

Body text:
18px

Spacing must feel luxurious.

------------------------------------------------

HERO SECTION (VERY IMPORTANT)

Desktop hero must use a split layout:

LEFT
- strong headline
- broker positioning statement
- CTA buttons

RIGHT
- portrait image

Never place text on top of the portrait.

Add background glow or gradient behind the portrait.

Example structure:

.hero
.hero-text
.hero-image

Hero must feel cinematic.

HERO COLOR RULE (MANDATORY):
- Hero background must be based on profile.palette.primary.
- Build a rich gradient from the primary color (lighter and darker tonal variants of the same hue).
- Do not use a plain white or light-gray hero background unless the selected primary color itself is white/light.
- Add layered effects in hero (radial glow, soft noise/overlay, or color bloom) derived from the primary color.
- Ensure text contrast remains accessible on top of the hero background.
- The exact primary color value must appear in CSS usage (buttons, accents, or hero layers), not only approximations.

HERO IMAGE SCALE RULE (MANDATORY):
- Hero image must be visually premium but controlled in size.
- Desktop: hero image column should stay around 38% to 48% width.
- Do NOT make hero image full-bleed or edge-to-edge.
- Do NOT let hero image dominate the entire fold height.
- Prefer framed composition: rounded corners, inner shadow/overlay, and breathing space around image.

HERO COPY RULE (MANDATORY):
- Keep hero copy concise: one short intro paragraph only.
- Avoid long quotes, long bios, or stacked text blocks in hero.
- Broker name must appear in hero text (visible plain text) for local SEO.
- Add one elegant marketing sentence in hero that explicitly mentions the served territories.
- Keep visual hierarchy clean and focused on headline + short supporting line + CTA.

NAV NAME RULE (MANDATORY):
- Do not display broker name next to the logo in top navigation.
- Broker name belongs in hero/section content, not in nav logo row.

HERO LOGO RULE (MANDATORY):
- Do not duplicate the broker/brand logo inside hero content if a logo already appears in top navigation/header.
- Keep logo usage clean and non-redundant.

NAV LOGO CONTRAST RULE (MANDATORY):
- If the provided logo is dark/low-luminance, use a light navigation background for contrast.
- If the logo is light, a darker nav is acceptable.
- Priority is logo readability in the header/nav.

------------------------------------------------

SECTIONS

Create these sections:

1. Navigation
2. Hero
3. Services
4. Territories
5. About
6. Gallery
7. Call-to-action
8. Footer

Each section must feel visually different.

Avoid flat white sections.

ADDITIONAL SECTIONS FROM SERVICE TEXT (MANDATORY):
- Base source is ONLY the service description text from broker profile.
- If allowExtraSections is false: create NO additional section beyond the 8 required sections.
- If allowExtraSections is true: create 1 to 3 additional sections maximum, inspired by the described service/values.
- Additional sections must be directly grounded in the provided text (no fabricated topics).
- Good examples: methodology, client process, differentiators, promises, working style, value pillars.
- Never exceed 3 additional sections.

------------------------------------------------

BACKGROUND DESIGN

Use modern layered backgrounds.

Examples:

soft gradients
radial glow
editorial shapes
grain textures
subtle patterns

Do NOT leave large empty white areas.
Avoid long runs of white sections, especially near the top of the page.
Pure white (#ffffff) can be used only as a small accent, not as dominant section background.
Never default to white backgrounds. White can be dominant only if user-selected primary color is white.

------------------------------------------------

CARDS

Service cards must feel premium:

• rounded corners
• soft shadows
• hover elevation
• subtle gradient borders

------------------------------------------------

GALLERY

Images must be used in a modern grid layout.

Use staggered grid or asymmetric grid.

Avoid boring 3-column layout.

------------------------------------------------

GLOBAL COMPOSITION RULE

The page must alternate visual rhythm:

- light section
- dark section
- layered section
- visual section
- strong CTA section

Do not stack multiple sections with the same white background and same centered heading structure.
Create contrast and rhythm across the full page.

UNIQUENESS RULE (MANDATORY):
- The final page must be visibly distinct per broker.
- Implement the exact CREATIVE DNA choices for hero composition, nav style, section transitions, card system, and motion profile.
- Avoid repeating the same component arrangement pattern across brokers.
- If two brokers have different CREATIVE DNA, their hero structure and section styling must differ clearly.

STARTING SECTIONS RULE (MANDATORY)

Section 1 (hero) and Section 2 (the section immediately after hero) must BOTH have distinctive visual treatment.
They must not both be light/white minimal blocks.
At least one of them must be dark or strongly color-layered with clear depth.
The other must still include gradients/overlays/cards with contrast.
Hard fail condition: if hero or section 2 looks flat white/light-gray, the output is invalid and must be redesigned.

------------------------------------------------

COLOR SYSTEM

Use the visual assets as the primary color source.

Priority order for color decisions:
1) logo colors
2) uploaded images (dominant tones + contrast)
3) broker palette (only to complete missing accents)

You must infer whether the site should lean light, dark, or mixed based on the logo + images.
If assets are dark/moody, use a darker direction.
If assets are bright/airy, use a lighter direction.
If assets are mixed, alternate dark and light sections with strong coherence.

Do not force white backgrounds by default.
Do not force black backgrounds by default.
Decide from assets first.

USER COLOR LOCK (MANDATORY):
- profile.palette.primary and profile.palette.secondary are user-selected and must be treated as the core brand colors.
- Use them across key UI elements (buttons, accents, links, overlays, section highlights).
- Build gradients and tonal variations from these two colors.
- Keep strong contrast/readability, but do not ignore or replace these two colors with unrelated defaults.

Palette:
${JSON.stringify(profile.palette, null, 2)}

Add complementary gradients.

Example:

linear-gradient()
radial-gradient()

SECTION VISUAL DIRECTION (VERY IMPORTANT)

Every major section must feel designed.
Do NOT make only one section visually rich and leave the others flat or white.

The following sections must ALL have strong visual treatment:
- hero
- services
- territories
- about
- gallery
- CTA

For every section, apply at least one of these:
- layered background gradients
- dark/light contrast blocks
- editorial color blocking
- subtle radial glows
- visual overlays
- shadow depth
- textured feeling
- premium card systems
- asymmetrical layout

Avoid generic empty white sections.
Avoid plain centered title + 3 cards on a blank background.
Avoid repetition.

Each section must feel distinct, premium, and intentionally art-directed.
The website should feel like a high-end editorial real estate brand, not a template.

SERVICES SECTION:
- must NOT be plain white with generic cards
- use a premium layout with stronger contrast
- cards should feel designed, with depth and visual richness
- use background treatment behind the section
- if Services is the second section after Hero, it must include a clear gradient/overlay treatment (not flat white or flat light gray)

TERRITORIES SECTION:
- must feel premium and atmospheric
- avoid simple plain tiles
- use elegant visual blocks, dark panels, gradients, layered layout, or editorial framing

GALLERY SECTION:
- use asymmetric or editorial grid
- not a standard boring equal grid

TERRITORIES SECTION MODE (MANDATORY):
- Do not use city photos in Territories.
- Present territories as modern textual UI elements (chips, cards, badges, editorial blocks).
- Each selected city must be visible by name in this section.
- Use premium typography, spacing, gradients, and contrast to make this section feel designed (not a plain bullet list).
- Do not add any "SEO local" label/title block.

CONTACT FORM (MANDATORY):
- Add a premium modern contact form section with strong visual design.
- Include fields: name, email, phone, message, preferred city/territory.
- Include a submit button and polished states (focus/hover), but do not connect to backend.
- The form is display-only for now (no functional integration required).

MORTGAGE CALCULATOR (MANDATORY):
- Include a dedicated mortgage calculator section in the final page.
- It must feel premium and match the selected primary/secondary palette.
- Include at least: property price, down payment, interest rate, amortization years, monthly payment output.
- Keep it client-side only (no backend connection).
- Section id must be: mortgage-calculator

CTA SECTION:
- must feel bold, premium, and visually memorable
- use strong contrast, rich background, and compelling layout

Do not use the same section pattern repeatedly.
Do not make multiple sections look like:
small red label + centered title + white background + simple grid.
That pattern may be used once only.
All other sections must introduce different composition and visual hierarchy.

------------------------------------------------

TECHNICAL REQUIREMENTS

• Responsive layout
• CSS grid
• smooth hover animations
• modern CSS only (no frameworks)

Include all CSS inside <style>

------------------------------------------------

OUTPUT FORMAT

Return ONLY raw HTML.

Do NOT wrap code in markdown.

Return a COMPLETE HTML document:

<!DOCTYPE html>
<html>
<head>
<body>
</body>
</html>

Do not truncate the output.

The final result must look like a premium modern real estate brand website.
`;

  let html = "";
  let lastViolations = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const correctiveBlock = lastViolations.length
      ? `

CRITICAL CORRECTIONS (previous output failed these checks):
${lastViolations.map((v) => `- ${v}`).join("\n")}

You must fix ALL listed issues in this new output.
`
      : "";

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      temperature: 0.7,
      messages: [
        {
          role: "user",
          content: `${prompt}${correctiveBlock}`
        }
      ]
    });

    const raw = message.content[0].text;
    html = cleanClaudeOutput(raw);
    html = stripMalformedOpenTagFragments(html);
    html = ensureHtmlDocument(html);
    html = repairCommonStructuralImbalances(html);

    const looksHeadCorrupted = /<body[\s\S]*<head[^>]*>/i.test(html) || /<body[\s\S]*<meta\b/i.test(html) || /<body[\s\S]*<link\b/i.test(html);
    const missingCoreChrome = !/<nav[\s\S]*?<\/nav>/i.test(html) || !findHeroBlock(html);
    if (looksHeadCorrupted || missingCoreChrome) {
      html = buildSafeFallbackShell({
        profile,
        territories,
        images,
        logo
      });
    }
    html = injectVisualGuardCss(html, {
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary
    });
    html = injectAdaptiveNavForDarkLogo(html, {
      forceLightNav: Boolean(logo && logo.includes("assets/logo.png"))
    });
    html = injectHeroSeoTuning(html, {
      brokerName: profile?.name
    });
    html = injectHeroTerritoriesLine(html, {
      territories
    });
    html = injectNavBrokerNameRemoval(html, {
      brokerName: profile?.name
    });
    html = injectContactForm(html, {
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary
    });
    html = injectMortgageCalculator(html, {
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary
    });
    html = injectMissingAboutSection(html, {
      bio: profile?.bio,
      brokerName: profile?.name,
      territories,
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary
    });
    html = injectMissingGallerySection(html, {
      images,
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary
    });
    html = injectParallaxEnhancements(html);
    html = injectCrystalFooter(html, {
      primaryColor: profile?.palette?.primary,
      secondaryColor: profile?.palette?.secondary,
      territories,
      sharedLogoAvailable: Boolean(sharedLogo),
      brokerLogoPath: logo,
      brokerName: profile?.name
    });

    try {
      validateHtml(html);
    } catch (err) {
      const message = err.message || "Generated HTML is incomplete.";
      if (/^HTML malforme|^HTML incomplet/i.test(message)) {
        html = buildSafeFallbackShell({
          profile,
          territories,
          images,
          logo
        });
        validateHtml(html);
        break;
      }
      lastViolations = [message];
      continue;
    }

    const violations = validateDesignConstraints({
      html,
      primaryColor: profile?.palette?.primary,
      territories,
      brokerName: profile?.name
    });

    if (!violations.length) {
      lastViolations = [];
      break;
    }

    lastViolations = violations;
  }

  if (lastViolations.length) {
    html = buildSafeFallbackShell({
      profile,
      territories,
      images,
      logo
    });
    validateHtml(html);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const siteAssetsDir = path.join(outputDir, "assets");
  fs.mkdirSync(siteAssetsDir, { recursive: true });

  images.forEach(img => {
    const filename = path.basename(img);
    const source = path.join(assetsDir, filename);
    const dest = path.join(siteAssetsDir, filename);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, dest);
    }
  });

  if (fs.existsSync(sharedLogoPath)) {
    fs.copyFileSync(sharedLogoPath, path.join(siteAssetsDir, "logo-crystal.png"));
  }

  const outputPath = path.join(outputDir, "index.html");
  fs.writeFileSync(outputPath, html, "utf8");

  return {
    outputPath,
    preview: `/sites/${brokerId}/`
  };
}
