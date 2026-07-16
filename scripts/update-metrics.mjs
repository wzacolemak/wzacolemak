import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.PROFILE_USER || "wzacolemak";
const TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!TOKEN) {
  throw new Error("GITHUB_TOKEN is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": `${USER}-profile-metrics`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function rest(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub REST ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload.data;
}

async function paginatedRepos() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const batch = await rest(`/users/${USER}/repos?type=owner&sort=updated&per_page=100&page=${page}`);
    repositories.push(...batch);
    if (batch.length < 100) return repositories;
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function yearsSince(date, now) {
  let years = now.getUTCFullYear() - date.getUTCFullYear();
  const beforeAnniversary =
    now.getUTCMonth() < date.getUTCMonth() ||
    (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return years;
}

function monthYear(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function truncate(value, limit = 40) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const languageColors = {
  TypeScript: "#3178c6",
  Go: "#00add8",
  HTML: "#e34c26",
  "C++": "#f34b7d",
  "C#": "#178600",
  Python: "#3572a5",
  Java: "#b07219",
  JavaScript: "#f1e05a",
  C: "#555555",
  Rust: "#dea584",
  Kotlin: "#a97bff",
  Shell: "#89e051",
};

const fallbackColors = ["#0969da", "#8250df", "#1f883d", "#bf8700", "#cf222e", "#57606a"];

function colorFor(language, index) {
  return languageColors[language] || fallbackColors[index % fallbackColors.length];
}

const now = new Date();

const profileData = await graphql(
  `query Profile($login: String!) {
    user(login: $login) {
      createdAt
      avatarUrl(size: 64)
      followers { totalCount }
      following { totalCount }
      organizations(first: 100) { totalCount }
      starredRepositories { totalCount }
      watching { totalCount }
    }
  }`,
  { login: USER },
);

const profile = profileData.user;
const createdAt = new Date(profile.createdAt);
const avatarResponse = await fetch(profile.avatarUrl, { headers });
if (!avatarResponse.ok) {
  throw new Error(`Unable to download avatar: ${avatarResponse.status}`);
}
const avatarType = avatarResponse.headers.get("content-type") || "image/png";
const avatarBase64 = Buffer.from(await avatarResponse.arrayBuffer()).toString("base64");
const avatarDataUri = `data:${avatarType};base64,${avatarBase64}`;
const activity = {
  commits: 0,
  pullRequests: 0,
  issues: 0,
  reviews: 0,
};

let rangeStart = new Date(createdAt);
while (rangeStart < now) {
  const nextYear = new Date(rangeStart);
  nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
  const rangeEnd = nextYear < now ? new Date(nextYear.getTime() - 1000) : now;
  const contributionData = await graphql(
    `query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
        }
      }
    }`,
    { login: USER, from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
  );
  const totals = contributionData.user.contributionsCollection;
  activity.commits += totals.totalCommitContributions;
  activity.pullRequests += totals.totalPullRequestContributions;
  activity.issues += totals.totalIssueContributions;
  activity.reviews += totals.totalPullRequestReviewContributions;
  rangeStart = new Date(rangeEnd.getTime() + 1000);
}

const commentedSearch = await rest(`/search/issues?q=${encodeURIComponent(`commenter:${USER}`)}&per_page=1`);
activity.commentedItems = commentedSearch.total_count;

const repositories = await paginatedRepos();
const languageBytes = new Map();

for (const repository of repositories) {
  try {
    const languages = await rest(`/repos/${USER}/${encodeURIComponent(repository.name)}/languages`);
    for (const [language, bytes] of Object.entries(languages)) {
      languageBytes.set(language, (languageBytes.get(language) || 0) + bytes);
    }
  } catch (error) {
    console.warn(`Skipping language data for ${repository.name}: ${error.message}`);
  }
}

const totalLanguageBytes = [...languageBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
const languages = [...languageBytes.entries()]
  .map(([name, bytes]) => ({
    name,
    bytes,
    percent: totalLanguageBytes ? (bytes / totalLanguageBytes) * 100 : 0,
  }))
  .sort((a, b) => b.bytes - a.bytes);

const topLanguages = languages.slice(0, 6);
const topPercent = topLanguages.reduce((sum, language) => sum + language.percent, 0);
const otherPercent = Math.max(0, 100 - topPercent);

let barX = 24;
const barWidth = 432;
const barSegments = [
  ...topLanguages.map((language, index) => ({
    percent: language.percent,
    color: colorFor(language.name, index),
  })),
  ...(otherPercent >= 0.05 ? [{ percent: otherPercent, color: "#8c959f" }] : []),
]
  .map((segment) => {
    const width = (segment.percent / 100) * barWidth;
    const result = `<rect x="${barX.toFixed(2)}" y="352" width="${width.toFixed(2)}" height="14" fill="${segment.color}" />`;
    barX += width;
    return result;
  })
  .join("\n    ");

const legendPositions = [
  [29, 395, 41, 400, 208],
  [29, 423, 41, 428, 208],
  [29, 451, 41, 456, 208],
  [251, 395, 263, 400, 456],
  [251, 423, 263, 428, 456],
  [251, 451, 263, 456, 456],
];

const languageLegend = topLanguages
  .map((language, index) => {
    const [cx, cy, tx, ty, px] = legendPositions[index];
    return `<circle cx="${cx}" cy="${cy}" r="4" fill="${colorFor(language.name, index)}" /><text class="body" x="${tx}" y="${ty}">${xml(language.name)}</text><text class="small" x="${px}" y="${ty}" text-anchor="end">${language.percent.toFixed(1)}%</text>`;
  })
  .join("\n  ");

const snapshotDate = now.toISOString().slice(0, 10);
const repositoryCount = repositories.length;
const joinedYears = yearsSince(createdAt, now);

const leftSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="500" viewBox="0 0 480 500" role="img" aria-labelledby="title desc">
  <title id="title">${xml(USER)} GitHub activity and languages</title>
  <desc id="desc">Accumulated GitHub activity, community statistics and language distribution.</desc>
  <style>
    svg { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .canvas { fill: #ffffff; }
    .title { fill: #24292f; font-size: 20px; font-weight: 700; }
    .heading { fill: #24292f; font-size: 16px; font-weight: 600; }
    .body { fill: #57606a; font-size: 13px; }
    .strong { fill: #24292f; font-size: 13px; font-weight: 600; }
    .small { fill: #57606a; font-size: 12px; }
    .rule { stroke: #d8dee4; }
    .muted-bar { fill: #d8dee4; }
    @media (prefers-color-scheme: dark) {
      .canvas { fill: #0d1117; }
      .title, .heading, .strong { fill: #f0f6fc; }
      .body, .small { fill: #8b949e; }
      .rule { stroke: #30363d; }
      .muted-bar { fill: #30363d; }
    }
  </style>
  <rect class="canvas" width="480" height="500" />
  <defs>
    <clipPath id="avatar"><circle cx="24" cy="30" r="10" /></clipPath>
    <clipPath id="language-bar"><rect x="24" y="352" width="432" height="14" rx="7" /></clipPath>
  </defs>

  <image href="${avatarDataUri}" x="14" y="20" width="20" height="20" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" />
  <text class="title" x="42" y="36">${xml(USER)}</text>
  <text class="body" x="24" y="60">Joined GitHub ${joinedYears} years ago · ${formatNumber(repositoryCount)} public repositories · ${formatNumber(profile.followers.totalCount)} followers</text>

  <line class="rule" x1="24" y1="82" x2="456" y2="82" />
  <text class="heading" x="24" y="112">Activity</text>
  <text class="small" x="92" y="112">accumulated since joining GitHub</text>
  <circle cx="30" cy="137" r="4" fill="#0969da" /><text class="strong" x="42" y="142">${formatNumber(activity.commits)} commits</text>
  <circle cx="178" cy="137" r="4" fill="#8250df" /><text class="strong" x="190" y="142">${formatNumber(activity.pullRequests)} pull requests</text>
  <circle cx="348" cy="137" r="4" fill="#1a7f37" /><text class="strong" x="360" y="142">${formatNumber(activity.issues)} issues</text>
  <circle cx="30" cy="166" r="4" fill="#bf8700" /><text class="strong" x="42" y="171">${formatNumber(activity.commentedItems)} commented items</text>
  <circle cx="178" cy="166" r="4" fill="#57606a" /><text class="strong" x="190" y="171">${formatNumber(activity.reviews)} reviews</text>

  <line class="rule" x1="24" y1="194" x2="456" y2="194" />
  <text class="heading" x="24" y="224">Community stats</text>
  <circle cx="30" cy="249" r="4" fill="#1f883d" /><text class="strong" x="42" y="254">${formatNumber(profile.organizations.totalCount)} organizations</text>
  <circle cx="178" cy="249" r="4" fill="#0969da" /><text class="strong" x="190" y="254">${formatNumber(profile.following.totalCount)} following</text>
  <circle cx="321" cy="249" r="4" fill="#bf8700" /><text class="strong" x="333" y="254">${formatNumber(profile.starredRepositories.totalCount)} starred</text>
  <circle cx="30" cy="278" r="4" fill="#8250df" /><text class="strong" x="42" y="283">${formatNumber(profile.watching.totalCount)} watching</text>
  <circle cx="178" cy="278" r="4" fill="#57606a" /><text class="strong" x="190" y="283">${formatNumber(profile.followers.totalCount)} followers</text>

  <line class="rule" x1="24" y1="306" x2="456" y2="306" />
  <text class="heading" x="24" y="336">${formatNumber(languages.length)} Languages</text>
  <text class="small" x="136" y="336">most used by tracked file bytes</text>
  <rect class="muted-bar" x="24" y="352" width="432" height="14" rx="7" />
  <g clip-path="url(#language-bar)">
    ${barSegments}
  </g>
  ${languageLegend}
  <text class="small" x="24" y="486">Snapshot generated ${snapshotDate}</text>
</svg>
`;

const featuredRepositories = repositories
  .filter((repository) => repository.name.toLowerCase() !== USER.toLowerCase())
  .slice(0, 2);

const projectRows = featuredRepositories
  .map((repository, index) => {
    const y = 405 + index * 43;
    const color = colorFor(repository.language || "Other", index + 1);
    const language = repository.language || "Repository";
    return `<circle cx="30" cy="${y}" r="4" fill="${color}" /><text class="name" x="42" y="${y + 5}">${xml(truncate(repository.name))}</text><text class="small" x="42" y="${y + 23}">${xml(language)} · updated ${xml(monthYear(repository.updated_at))}</text>`;
  })
  .join("\n  ");

const rightSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="500" viewBox="0 0 480 500" role="img" aria-labelledby="title desc">
  <title id="title">${xml(USER)} profile highlights and projects</title>
  <desc id="desc">Public GitHub profile highlights and recently updated projects.</desc>
  <style>
    svg { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .canvas { fill: #ffffff; }
    .title { fill: #24292f; font-size: 20px; font-weight: 700; }
    .heading { fill: #24292f; font-size: 16px; font-weight: 600; }
    .name { fill: #0969da; font-size: 14px; font-weight: 600; }
    .body { fill: #57606a; font-size: 13px; }
    .small { fill: #57606a; font-size: 12px; }
    .rule { stroke: #d8dee4; }
    @media (prefers-color-scheme: dark) {
      .canvas { fill: #0d1117; }
      .title, .heading { fill: #f0f6fc; }
      .name { fill: #58a6ff; }
      .body, .small { fill: #8b949e; }
      .rule { stroke: #30363d; }
    }
  </style>
  <rect class="canvas" width="480" height="500" />

  <text class="title" x="24" y="36">Profile highlights</text>
  <text class="body" x="24" y="60">A compact public GitHub snapshot</text>
  <line class="rule" x1="24" y1="82" x2="456" y2="82" />
  <circle cx="42" cy="112" r="11" fill="#0969da" /><text x="42" y="117" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700">R</text>
  <text class="name" x="64" y="109">Repository builder</text><text class="body" x="64" y="128">${formatNumber(repositoryCount)} public repositories</text>
  <line class="rule" x1="24" y1="148" x2="456" y2="148" />
  <circle cx="42" cy="178" r="11" fill="#8250df" /><text x="42" y="183" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700">P</text>
  <text class="name" x="64" y="175">Polyglot</text><text class="body" x="64" y="194">${formatNumber(languages.length)} programming languages detected</text>
  <line class="rule" x1="24" y1="214" x2="456" y2="214" />
  <circle cx="42" cy="244" r="11" fill="#1f883d" /><text x="42" y="249" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700">C</text>
  <text class="name" x="64" y="241">Community member</text><text class="body" x="64" y="260">Member of ${formatNumber(profile.organizations.totalCount)} organizations</text>
  <line class="rule" x1="24" y1="280" x2="456" y2="280" />
  <circle cx="42" cy="310" r="11" fill="#bf8700" /><text x="42" y="315" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="700">★</text>
  <text class="name" x="64" y="307">Curator</text><text class="body" x="64" y="326">Starred ${formatNumber(profile.starredRepositories.totalCount)} public repositories</text>
  <line class="rule" x1="24" y1="350" x2="456" y2="350" />
  <text class="heading" x="24" y="380">Featured projects</text>
  ${projectRows}
  <text class="small" x="24" y="492">Snapshot generated ${snapshotDate}</text>
</svg>
`;

const summary = {
  user: USER,
  activity,
  community: {
    organizations: profile.organizations.totalCount,
    following: profile.following.totalCount,
    followers: profile.followers.totalCount,
    starred: profile.starredRepositories.totalCount,
    watching: profile.watching.totalCount,
  },
  languages: topLanguages.map(({ name, percent }) => ({ name, percent: Number(percent.toFixed(1)) })),
  featuredRepositories: featuredRepositories.map(({ name }) => name),
};

if (DRY_RUN) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  await writeFile("metrics.left.svg", leftSvg);
  await writeFile("metrics.right.svg", rightSvg);

  const version = now.toISOString().replaceAll(/\D/g, "").slice(0, 12);
  const readme = await readFile("README.md", "utf8");
  const refreshedReadme = readme
    .replace(/metrics\.left\.svg\?v=[^"\s]+/, `metrics.left.svg?v=${version}`)
    .replace(/metrics\.right\.svg\?v=[^"\s]+/, `metrics.right.svg?v=${version}`);
  await writeFile("README.md", refreshedReadme);
  console.log(JSON.stringify(summary, null, 2));
}
