/**
 * Complete list of commercial AWS regions (excludes GovCloud and China).
 * Source: https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html
 * 34 regions as of 2025.
 *
 * AWS_REGION_GROUPS — array of { label, regions[] } for <optgroup> rendering.
 * AWS_REGION_CODES  — flat array of region codes for quick membership checks.
 */

export const AWS_REGION_GROUPS = [
  {
    label: 'US East',
    regions: [
      { code: 'us-east-1', name: 'US East (N. Virginia)' },
      { code: 'us-east-2', name: 'US East (Ohio)' },
    ],
  },
  {
    label: 'US West',
    regions: [
      { code: 'us-west-1', name: 'US West (N. California)' },
      { code: 'us-west-2', name: 'US West (Oregon)' },
    ],
  },
  {
    label: 'Africa',
    regions: [
      { code: 'af-south-1', name: 'Africa (Cape Town)' },
    ],
  },
  {
    label: 'Asia Pacific',
    regions: [
      { code: 'ap-east-1',     name: 'Asia Pacific (Hong Kong)' },
      { code: 'ap-south-2',    name: 'Asia Pacific (Hyderabad)' },
      { code: 'ap-southeast-3', name: 'Asia Pacific (Jakarta)' },
      { code: 'ap-southeast-5', name: 'Asia Pacific (Malaysia)' },
      { code: 'ap-southeast-4', name: 'Asia Pacific (Melbourne)' },
      { code: 'ap-south-1',    name: 'Asia Pacific (Mumbai)' },
      { code: 'ap-southeast-6', name: 'Asia Pacific (New Zealand)' },
      { code: 'ap-northeast-3', name: 'Asia Pacific (Osaka)' },
      { code: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
      { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
      { code: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
      { code: 'ap-east-2',     name: 'Asia Pacific (Taipei)' },
      { code: 'ap-southeast-7', name: 'Asia Pacific (Thailand)' },
      { code: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
    ],
  },
  {
    label: 'Canada',
    regions: [
      { code: 'ca-central-1', name: 'Canada (Central)' },
      { code: 'ca-west-1',    name: 'Canada West (Calgary)' },
    ],
  },
  {
    label: 'Europe',
    regions: [
      { code: 'eu-central-1', name: 'Europe (Frankfurt)' },
      { code: 'eu-west-1',    name: 'Europe (Ireland)' },
      { code: 'eu-west-2',    name: 'Europe (London)' },
      { code: 'eu-south-1',   name: 'Europe (Milan)' },
      { code: 'eu-west-3',    name: 'Europe (Paris)' },
      { code: 'eu-south-2',   name: 'Europe (Spain)' },
      { code: 'eu-north-1',   name: 'Europe (Stockholm)' },
      { code: 'eu-central-2', name: 'Europe (Zurich)' },
    ],
  },
  {
    label: 'Israel',
    regions: [
      { code: 'il-central-1', name: 'Israel (Tel Aviv)' },
    ],
  },
  {
    label: 'Mexico',
    regions: [
      { code: 'mx-central-1', name: 'Mexico (Central)' },
    ],
  },
  {
    label: 'Middle East',
    regions: [
      { code: 'me-south-1',   name: 'Middle East (Bahrain)' },
      { code: 'me-central-1', name: 'Middle East (UAE)' },
    ],
  },
  {
    label: 'South America',
    regions: [
      { code: 'sa-east-1', name: 'South America (São Paulo)' },
    ],
  },
];

/** Flat array of all region codes for quick membership checks. */
export const AWS_REGION_CODES = AWS_REGION_GROUPS.flatMap((g) => g.regions.map((r) => r.code));
