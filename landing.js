// City/service picker. Fetches networks.json (the "bible") and renders a
// tile for every city, then every service that city has data for — nothing
// here is hardcoded to a particular city or mode, so adding e.g. Kochi or a
// bus service later is purely a networks.json + data file change.

async function loadNetworks() {
  const cityGrid = document.getElementById("city-grid");
  try {
    const res = await fetch("networks.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    cityGrid.innerHTML = `<p class="empty-state">Couldn't load the list of cities. Check your connection and try again.</p>`;
    return null;
  }
}

function renderCityTiles(networks) {
  const cityGrid = document.getElementById("city-grid");
  const cityIds = Object.keys(networks);

  if (cityIds.length === 0) {
    cityGrid.innerHTML = `<p class="empty-state">No cities available yet.</p>`;
    return;
  }

  cityGrid.innerHTML = cityIds
    .map((cityId) => `<button type="button" class="tile" data-city="${cityId}">${networks[cityId].name}</button>`)
    .join("");

  cityGrid.querySelectorAll(".tile").forEach((tile) => {
    tile.addEventListener("click", () => showServices(networks, tile.dataset.city));
  });
}

function showServices(networks, cityId) {
  const city = networks[cityId];
  const serviceGrid = document.getElementById("service-grid");
  const heading = document.getElementById("service-step-heading");
  const serviceIds = Object.keys(city.services);

  heading.textContent = `${city.name} — choose a service`;

  if (serviceIds.length === 0) {
    serviceGrid.innerHTML = `<p class="empty-state">No services available yet for ${city.name}.</p>`;
  } else {
    serviceGrid.innerHTML = serviceIds
      .map((serviceId) => {
        const service = city.services[serviceId];
        return `<a class="tile" href="network.html?data=${encodeURIComponent(service.data)}">
          <span class="tile-icon">${service.icon || ""}</span>
          <span>${service.label}</span>
        </a>`;
      })
      .join("");
  }

  document.getElementById("city-step").hidden = true;
  document.getElementById("service-step").hidden = false;
}

document.addEventListener("DOMContentLoaded", async () => {
  const networks = await loadNetworks();
  if (!networks) return;

  renderCityTiles(networks);

  document.getElementById("back-to-cities").addEventListener("click", () => {
    document.getElementById("service-step").hidden = true;
    document.getElementById("city-step").hidden = false;
  });
});
