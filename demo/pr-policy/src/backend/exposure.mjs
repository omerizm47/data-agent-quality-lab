export function calculateExposure(positions) {
  const exposures = positions.map(position => (position.actualMWh - position.nominatedMWh) * position.priceEurPerMWh);
  return {
    netExposureEur: exposures.reduce((total, exposure) => total + exposure, 0),
    grossExposureEur: exposures.reduce((total, exposure) => total + Math.abs(exposure), 0),
  };
}