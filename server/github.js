import { createAppAuth } from "@octokit/auth-app";

export function githubIntegration({ appId, installationId, privateKey, repository }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repository.");
  const [owner] = repository.split("/");
  const auth = createAppAuth({ appId, installationId, privateKey });
  async function token() { return (await auth({ type: "installation" })).token; }
  async function api(endpoint, options = {}) {
    const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
      ...options, signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await token()}`,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }
    });
    if (!response.ok) throw new Error(`GitHub API failed (${response.status}).`);
    return response.json();
  }
  return {
    remote: `https://github.com/${repository}.git`,
    credentials: async () => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${await token()}`).toString("base64")}` }),
    pullRequests: {
      async ensure({ branch, base, title, body }) {
        const existing = await api(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`);
        const pr = existing[0] || await api("/pulls", { method: "POST", body: JSON.stringify({ head: branch, base, title, body }) });
        return { url: pr.html_url, number: pr.number };
      }
    }
  };
}
