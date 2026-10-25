/**
 * Which cloud an icon diagram should use when the person did not say: a cheap look at the repositories' files for
 * infrastructure code (CDK, SAM, CloudFormation, Terraform providers, Bicep, Helm, Kubernetes manifests, ...).
 * Reads at most a few hundred small files and never throws. The default when nothing is found is AWS (DEFAULT_CLOUD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLOUDS, DEFAULT_CLOUD, type Cloud } from './drawio.ts';

export interface CloudGuess {
  cloud: Cloud;
  /** True when something in the repositories pointed to it; false when the default was used. */
  detected: boolean;
  /** Short reasons ("cdk.json", "provider azurerm in infra/main.tf"), most telling first. */
  signals: string[];
  scores: Record<Cloud, number>;
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__', '.terraform', 'vendor', '.next', 'cdk.out']);
const MAX_FILES = 600;
const MAX_DEPTH = 4;
const MAX_READ = 200_000;

const BY_NAME: [RegExp, Cloud, number, string][] = [
  [/^cdk\.json$/, 'aws', 5, 'cdk.json'],
  [/^samconfig\.(?:toml|yaml)$/, 'aws', 5, 'samconfig'],
  [/^serverless\.ya?ml$/, 'aws', 2, 'serverless.yml'],
  [/^buildspec\.ya?ml$/, 'aws', 3, 'buildspec.yml'],
  [/^appspec\.ya?ml$/, 'aws', 2, 'appspec.yml'],
  [/^cdk\.context\.json$/, 'aws', 2, 'cdk.context.json'],
  [/\.(?:template\.json|template\.ya?ml)$/, 'aws', 3, 'CloudFormation template'],
  [/^(?:main|template)\.bicep$|\.bicep$/, 'azure', 5, 'Bicep file'],
  [/^azure-pipelines\.ya?ml$/, 'azure', 4, 'azure-pipelines.yml'],
  [/^azure\.ya?ml$/, 'azure', 3, 'azure.yaml'],
  [/^host\.json$/, 'azure', 2, 'host.json (Azure Functions)'],
  [/^function\.json$/, 'azure', 2, 'function.json (Azure Functions)'],
  [/^app\.ya?ml$/, 'gcp', 2, 'app.yaml (App Engine)'],
  [/^cloudbuild\.ya?ml$/, 'gcp', 4, 'cloudbuild.yaml'],
  [/^firebase\.json$/, 'gcp', 3, 'firebase.json'],
  [/^\.gcloudignore$/, 'gcp', 3, '.gcloudignore'],
  [/^Chart\.ya?ml$/, 'kubernetes', 5, 'Helm chart'],
  [/^kustomization\.ya?ml$/, 'kubernetes', 5, 'kustomization.yaml'],
  [/^skaffold\.ya?ml$/, 'kubernetes', 3, 'skaffold.yaml'],
];

const BY_DIR: [RegExp, Cloud, number, string][] = [
  [/^(?:k8s|kubernetes|manifests|helm|charts)$/, 'kubernetes', 2, 'a Kubernetes folder'],
  [/^(?:lambda|lambdas)$/, 'aws', 1, 'a lambda folder'],
  [/^(?:cdk|infra-cdk|\w+_cdk)$/, 'aws', 2, 'a CDK folder'],
];

const CONTENT: { re: RegExp; cloud: Cloud; weight: number; what: string; files: RegExp }[] = [
  { re: /provider\s+"aws"|hashicorp\/aws|resource\s+"aws_/, cloud: 'aws', weight: 4, what: 'Terraform AWS provider', files: /\.tf$/ },
  { re: /provider\s+"azurerm"|hashicorp\/azurerm|resource\s+"azurerm_/, cloud: 'azure', weight: 4, what: 'Terraform azurerm provider', files: /\.tf$/ },
  { re: /provider\s+"google(?:-beta)?"|hashicorp\/google|resource\s+"google_/, cloud: 'gcp', weight: 4, what: 'Terraform Google provider', files: /\.tf$/ },
  { re: /provider\s+"kubernetes"|resource\s+"kubernetes_/, cloud: 'kubernetes', weight: 2, what: 'Terraform Kubernetes provider', files: /\.tf$/ },
  { re: /AWSTemplateFormatVersion|AWS::Serverless|AWS::[A-Z][A-Za-z0-9]+::[A-Z]/, cloud: 'aws', weight: 4, what: 'CloudFormation or SAM resources', files: /\.(?:ya?ml|json)$/ },
  { re: /aws-cdk-lib|aws_cdk|software\.amazon\.awscdk|@aws-cdk\//, cloud: 'aws', weight: 4, what: 'AWS CDK', files: /(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|setup\.py|pom\.xml|build\.gradle|\.csproj)$/ },
  { re: /\bboto3\b|@aws-sdk\/|aws-sdk\b/, cloud: 'aws', weight: 1, what: 'AWS SDK', files: /(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml)$/ },
  { re: /azure-functions|@azure\/|azure-identity|azure-storage|Microsoft\.Azure/, cloud: 'azure', weight: 2, what: 'Azure SDK', files: /(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|\.csproj)$/ },
  { re: /google-cloud-|@google-cloud\/|firebase-admin|com\.google\.cloud/, cloud: 'gcp', weight: 2, what: 'Google Cloud SDK', files: /(?:package\.json|requirements[\w.-]*\.txt|pyproject\.toml|pom\.xml)$/ },
  { re: /^apiVersion:\s*\S+[\s\S]{0,200}?^kind:\s*(?:Deployment|StatefulSet|DaemonSet|Service|Ingress|CronJob|Pod)\b/m, cloud: 'kubernetes', weight: 3, what: 'Kubernetes manifest', files: /\.ya?ml$/ },
];

export function detectCloud(dirs: string[]): CloudGuess {
  const scores = Object.fromEntries(CLOUDS.map((c) => [c, 0])) as Record<Cloud, number>;
  const signals: { text: string; cloud: Cloud; weight: number }[] = [];
  const add = (cloud: Cloud, weight: number, text: string) => {
    scores[cloud] += weight;
    if (!signals.some((s) => s.text === text)) signals.push({ text, cloud, weight });
  };
  let seen = 0;
  const walk = (root: string, dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/');
      if (e.isDirectory()) {
        for (const [re, cloud, w, what] of BY_DIR) if (re.test(e.name)) add(cloud, w, `${what} (${rel}/)`);
        walk(root, path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile() || ++seen > MAX_FILES) continue;
      for (const [re, cloud, w, what] of BY_NAME) if (re.test(e.name)) add(cloud, w, `${what} (${rel})`);
      const rules = CONTENT.filter((c) => c.files.test(e.name));
      if (!rules.length) continue;
      try {
        const file = path.join(dir, e.name);
        if (fs.statSync(file).size > MAX_READ * 5) continue;
        const text = fs.readFileSync(file, 'utf8').slice(0, MAX_READ);
        for (const c of rules) if (c.re.test(text)) add(c.cloud, c.weight, `${c.what} (${rel})`);
      } catch {
        /* unreadable: skip */
      }
    }
  };
  for (const d of dirs) walk(d, d, 0);
  const ranked = [...CLOUDS].sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0];
  const detected = scores[top] > 0 && scores[top] > (scores[ranked[1]] ?? 0);
  const cloud = detected ? top : scores[top] > 0 && top !== 'generic' ? top : DEFAULT_CLOUD;
  return {
    cloud,
    detected: scores[cloud] > 0,
    signals: signals.filter((s) => s.cloud === cloud).sort((a, b) => b.weight - a.weight).slice(0, 5).map((s) => s.text),
    scores,
  };
}
