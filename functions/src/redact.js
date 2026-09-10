// Never let a license/device's hashed secret leave this backend, even to
// the admin panel - these strip it from any document before it's returned.

function redactLicense(licenseId, license) {
  const { licenseKeyHash, ...rest } = license;
  return { licenseId, ...rest };
}

function redactDevice(deviceId, device) {
  const { deviceSecretHash, ...rest } = device;
  return { deviceId, ...rest };
}

module.exports = { redactLicense, redactDevice };
