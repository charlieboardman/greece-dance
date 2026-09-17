import { createAppAuth } from "@octokit/auth-app";

export function githubIntegration({ appId, installationId, privateKey, repository }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repository.");
  const auth = createAppAuth({ appId, installationId, privateKey });
  async function token() { return (await auth({ type: "installation" })).token; }
  return {
    remote: `https://github.com/${repository}.git`,
    credentials: async () => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${await token()}`).toString("base64")}` })
  };
}
