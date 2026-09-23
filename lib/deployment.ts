export function getDeployedSha(env: Record<string, string | undefined> = process.env): string | null {
  return env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? env.NEXT_PUBLIC_GIT_SHA ?? env.GITHUB_SHA ?? null;
}
