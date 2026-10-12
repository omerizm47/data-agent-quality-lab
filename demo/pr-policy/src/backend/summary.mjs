export function summarizeExposure(portfolio) {
  return { netExposureEur: portfolio.netExposureEur, grossExposureEur: portfolio.grossExposureEur, synthetic: true };
}
