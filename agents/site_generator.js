export async function generateSite(profile) {
  const {
    name = "Courtier immobilier",
    city = "Montréal",
    services = [],
    bio = "",
    photos = [],
    logo = "",
    palette = {}
  } = profile;

  const primary = palette.primary || "#D71920";

  const heroPhoto = photos.length
    ? photos[0]
    : "https://images.unsplash.com/photo-1560518883-ce09059eeffa";

  const servicesHTML = services.map(service => `
    <div class="card">
      <h3>${service}</h3>
      <p>Service immobilier professionnel pour ${service} à ${city}.</p>
    </div>
  `).join("");

  const galleryHTML = photos.map(photo => `
    <img src="${photo}" class="gallery-img" />
  `).join("");

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name} | Courtier immobilier</title>
  <style>
    body{
      margin:0;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:#0b0f14;
      color:white;
    }
    .container{
      max-width:1200px;
      margin:auto;
      padding:40px;
    }
    .hero{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:40px;
      min-height:70vh;
    }
    .hero img{
      width:50%;
      border-radius:20px;
      object-fit:cover;
    }
    .hero-text{
      max-width:500px;
    }
    h1{
      font-size:48px;
      margin-bottom:20px;
    }
    h2{
      font-size:32px;
      margin-bottom:24px;
    }
    .cta{
      background:${primary};
      padding:15px 30px;
      border:none;
      border-radius:10px;
      color:white;
      font-size:18px;
      cursor:pointer;
    }
    .section{
      padding:80px 0;
    }
    .cards{
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
      gap:30px;
    }
    .card{
      background:#121822;
      padding:30px;
      border-radius:15px;
      border:1px solid rgba(255,255,255,0.06);
    }
    .gallery{
      display:grid;
      grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
      gap:20px;
    }
    .gallery-img{
      width:100%;
      border-radius:12px;
      min-height:220px;
      object-fit:cover;
    }
    .footer{
      text-align:center;
      padding:40px;
      color:#aaa;
      border-top:1px solid rgba(255,255,255,0.08);
    }
    .muted{
      color:#b7c0c8;
      font-size:20px;
      margin-bottom:24px;
    }
    @media (max-width: 900px){
      .hero{
        flex-direction:column;
      }
      .hero img{
        width:100%;
      }
      h1{
        font-size:38px;
      }
    }
  </style>
</head>
<body>

  <div class="container hero">
    <div class="hero-text">
      ${logo ? `<img src="${logo}" style="max-width:150px;margin-bottom:20px;" />` : ""}
      <h1>${name}</h1>
      <p class="muted">Courtier immobilier à ${city}</p>
      <button class="cta">Évaluer ma propriété</button>
    </div>

    <img src="${heroPhoto}" alt="${name}" />
  </div>

  <div class="container section">
    <h2>Services</h2>
    <div class="cards">
      ${servicesHTML || `
        <div class="card">
          <h3>Service immobilier</h3>
          <p>Accompagnement stratégique pour vos projets immobiliers à ${city}.</p>
        </div>
      `}
    </div>
  </div>

  <div class="container section">
    <h2>Galerie</h2>
    <div class="gallery">
      ${galleryHTML || `<p>Aucune photo ajoutée pour le moment.</p>`}
    </div>
  </div>

  <div class="container section">
    <h2>À propos</h2>
    <p>${bio || `${name} accompagne ses clients dans leurs projets immobiliers à ${city}.`}</p>
  </div>

  <div class="footer">
    © ${new Date().getFullYear()} ${name}
  </div>

</body>
</html>
`;
}