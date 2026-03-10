const fs = require("fs");

function updateProfile(broker, updates) {

  const path = `../brokers/${broker}/profile.json`

  const profile = JSON.parse(fs.readFileSync(path))

  const newProfile = {
    ...profile,
    ...updates
  }

  fs.writeFileSync(path, JSON.stringify(newProfile, null, 2))
}

module.exports = { updateProfile }