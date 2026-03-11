const form = document.getElementById("map-form");
const addressInput = document.getElementById("address");
const statusEl = document.getElementById("status");
const resultEmpty = document.getElementById("result-empty");
const resultCard = document.getElementById("result-card");
const resultImage = document.getElementById("result-image");
const resultTitle = document.getElementById("result-title");
const downloadLink = document.getElementById("download-link");
const poiSummary = document.getElementById("poi-summary");
const poiSelector = document.getElementById("poi-selector");
const regenerateBtn = document.getElementById("regenerate-btn");

const state = {
  address: "",
  availablePois: [],
  selectedPoiIds: []
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = addressInput.value.trim();
  if (!address) return;

  state.address = address;
  await generateMap({ address });
});

regenerateBtn.addEventListener("click", async () => {
  if (!state.address) return;
  const selectedPoiIds = getCheckedPoiIds();
  if (!selectedPoiIds.length) {
    setStatus("Sélectionne au moins un lieu.", true);
    return;
  }
  state.selectedPoiIds = selectedPoiIds;
  await generateMap({ address: state.address, selectedPoiIds });
});

async function generateMap(payload) {
  setStatus("Génération en cours...");
  regenerateBtn.disabled = true;

  try {
    const response = await fetch("/api/generate-map", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Impossible de générer la carte.");
    }

    state.availablePois = data.availablePois || [];
    state.selectedPoiIds = data.selectedPoiIds || [];

    resultEmpty.classList.add("hidden");
    resultCard.classList.remove("hidden");
    resultImage.src = data.imageUrl;
    resultTitle.textContent = data.address;
    downloadLink.href = data.imageUrl;
    downloadLink.download = data.imageUrl.split("/").pop();
    poiSummary.innerHTML = (data.pois || [])
      .map((poi) => `<span class="poi-pill">${labelForCategory(poi.category)} · ${escapeHtml(poi.name)}</span>`)
      .join("");

    renderPoiSelector(state.availablePois, state.selectedPoiIds);
    setStatus("Carte générée.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    regenerateBtn.disabled = false;
  }
}

function renderPoiSelector(availablePois, selectedPoiIds) {
  const order = ["park", "school", "shop"];
  poiSelector.innerHTML = order.map((category) => {
    const items = availablePois.filter((poi) => poi.category === category);
    if (!items.length) return "";

    return `
      <section class="selector-group">
        <div class="selector-group-head">
          <span class="selector-dot ${category}"></span>
          <h4>${groupLabelForCategory(category)}</h4>
        </div>
        <div class="selector-list">
          ${items.map((poi) => `
            <label class="selector-item">
              <input type="checkbox" value="${escapeHtml(poi.id)}" ${selectedPoiIds.includes(poi.id) ? "checked" : ""} />
              <span class="selector-copy">
                <strong>${escapeHtml(poi.name)}</strong>
                <small>${poi.distanceKm.toFixed(1)} km</small>
              </span>
            </label>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");
}

function getCheckedPoiIds() {
  return Array.from(poiSelector.querySelectorAll('input[type="checkbox"]:checked'))
    .map((input) => input.value);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function labelForCategory(category) {
  if (category === "park") return "Parc";
  if (category === "school") return "École";
  if (category === "shop") return "Commerce";
  return "Attrait";
}

function groupLabelForCategory(category) {
  if (category === "park") return "Parcs";
  if (category === "school") return "Écoles";
  if (category === "shop") return "Commerces";
  return "Attraits";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
